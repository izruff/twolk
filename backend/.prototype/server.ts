import type {
  IMessageBus, QueueConsumerCallback,
} from "./bus.ts";
import type {
  IClientChannel, IClientChannelAcceptor,
} from "./client-channel-port.ts";
import { SocketIoChannelAcceptor } from "./client-channel-socketio.ts";
import type {
  SpaceData, MemberData, MemberState, ClientSideSpace, ClientSideMember,
} from "./domain.ts";
import { MemberSession } from "./member-session.ts";
import type { IStore } from "./store-port.ts";
import { InMemoryStore } from "./in-memory-store.ts";
import { createNodeHttpServer, type TlsOptions } from "./utils/tls.ts";

import { Server as BaseServer, type ServerOptions } from "socket.io";
import mediasoup from "mediasoup";
import mediasoupClient from "mediasoup-client";


/** Signaling-server-local member mirror. */
export interface Member {
  id: number;
  owningSpace: Space;

  data: MemberData;
  state: MemberState;
}

/** Signaling-server-local space mirror used for client snapshots. */
export interface Space {
  uuid: string;
  data: SpaceData;
  members: Map<number, Member>;

  // TODO: Model router capabilities per transport if spaces can span routers.
  // The current mirror assumes one router capability set per space.
  routerRtpCapabilities: mediasoup.types.RtpCapabilities;
}

type MemberEventType = "spaceInit" | "transportParams";

interface MemberEventContentMap extends Record<MemberEventType, any> {
  spaceInit: {
    receivingMemberId: number,
    routerRtpCapabilities: mediasoup.types.RtpCapabilities,
    clientSideSpace: ClientSideSpace,
  };
  transportParams: {
    memberId: number,
    options: mediasoupClient.types.TransportOptions,
  };
}

type SpaceWideEventType = "memberJoin" | "memberLeave" | "memberStateUpdate"
  | "spaceClose";

interface SpaceWideEventContentMap extends Record<SpaceWideEventType, any> {
  memberJoin: {
    member: ClientSideMember,
  };
  memberLeave: {
    memberId: number,
  };
  memberStateUpdate: {
    memberId: number,
    newState: MemberState,
  };
  spaceClose: {};
}


/** Server-to-client event contract emitted through `IClientChannel`. */
export interface ServerToClientEvents {

  connectionSuccessful: () => void;

  connectionFailed: (error: { message: string }) => void;

  memberEvent: <K extends keyof MemberEventContentMap>(
    type: K,
    content: MemberEventContentMap[K]
  ) => void;

  spaceWideEvent: <K extends keyof SpaceWideEventContentMap>(
    type: K,
    content: SpaceWideEventContentMap[K]
  ) => void;

  createWebRtcTransportAck: (cId: string) => void;
  resendSpaceInitAck: (cId: string) => void;

  transportProducerConnectAck: (cId: string) => void;
  transportProducerProduceAck: (cId: string, producerId: string) => void;
  transportConsumerConnectAck: (cId: string) => void;
  transportConsumerConsumeAck: (
    cId: string,
    consumerId: string,
    producerId: string,
    kind: mediasoup.types.MediaKind,
    rtpParameters: mediasoup.types.RtpParameters,
  ) => void;
  transportConsumerResumeAck: (cId: string) => void;
  updateMemberStateAck: (cId: string) => void;
}


/** Client-to-server event contract consumed by `MemberSession`. */
export interface ClientToServerEvents {

  /** Client-side transport allocation retry or readiness check. */
  createWebRtcTransport: (
    args: { consumesFromMemberId?: number },
    cId: string,
  ) => Promise<void>;

  resendSpaceInit: (cId: string) => Promise<void>;

  transportProducerConnect: (
    args: {
      dtlsParameters: mediasoup.types.DtlsParameters,
    },
    cId: string,
  ) => Promise<void>;

  transportProducerProduce: (
    args: {
      kind: mediasoup.types.MediaKind,
      rtpParameters: mediasoup.types.RtpParameters,
    },
    cId: string,
  ) => Promise<void>;

  transportConsumerConnect: (
    args: {
      dtlsParameters: mediasoup.types.DtlsParameters,
      sourceMemberId: number,
    },
    cId: string,
  ) => Promise<void>;

  transportConsumerConsume: (
    args: {
      rtpCapabilities: mediasoup.types.RtpCapabilities,
      sourceMemberId: number,
    },
    cId: string,
  ) => Promise<void>;

  // TODO: Include consumer ID so resume can target a specific consumer.
  transportConsumerResume: (
    args: { sourceMemberId: number },
    cId: string,
  ) => Promise<void>;

  // TODO: Restrict updates to client-sourced member state fields.
  updateMemberState: (
    args: { newState: Partial<MemberState> },
    cId: string,
  ) => Promise<void>;
}


type Channel = IClientChannel<ClientToServerEvents, ServerToClientEvents>;
type Acceptor = IClientChannelAcceptor<ClientToServerEvents, ServerToClientEvents>;


/** Builds the client-facing space projection from a signaling mirror. */
export function getClientSideSpace(space: Space): ClientSideSpace {
  const clientSideMembers = Array.from(space.members.values()).map(
    (member) => getClientSideMember(member));
  return {
    uuid: space.uuid,
    data: space.data,
    members: clientSideMembers,
  };
}

function getClientSideMember(member: Member): ClientSideMember {
  return {
    id: member.id,
    data: member.data,
    state: member.state,
  };
}


/**
 * Signaling server facade for client channels.
 *
 * The server accepts client channel connections, creates and manages member
 * sessions, and keeps a local mirror of coordinator space and member state for
 * channels it owns.
 *
 * TODO: Route member and state broadcasts through the coordinator so multiple
 * signaling servers can stay in sync.
 *
 * TODO(mediasoup-decoupling): A lot of the types here still depend on
 * `mediasoup`. We need to decouple them and use the types which will be
 * defined in `media-port.ts` in the future.
 */
export class SignalingServer {
  serverId: number
  acceptor: Acceptor
  bus: IMessageBus

  memberIdToChannel: Map<number, Channel>

  spaces: IStore<string, Space>
  members: IStore<number, Member>

  /** Cancellation handle for the bus subscription registered in `start()`. */
  _cancelConsumer: (() => void) | null = null

  /** Deregisters this signaling server from the bus. */
  _deregisterServer: (() => void) | null = null

  constructor(
    serverId: number,
    serverUrl: string,
    acceptor: Acceptor,
    bus: IMessageBus,
    spaceStore: IStore<string, Space>,
    memberStore: IStore<number, Member>,
  ) {
    this.serverId = serverId;
    this.acceptor = acceptor;
    this.bus = bus;
    this.spaces = spaceStore;
    this.members = memberStore;
    this.memberIdToChannel = new Map();

    // Announce this server so ChannelPreAllocator can route join requests.
    this._deregisterServer = bus.registerSignalingServer(serverId, serverUrl);
  }

  /**
   * Builds the default Socket.IO-backed signaling server.
   *
   * The returned instance does not listen until `start()` is called. Passing
   * TLS options creates an HTTPS server and a `wss` URL; null creates HTTP and
   * a `ws` URL.
   */
  static create(serverId: number, tlsOptions: TlsOptions | null,
    ioOptions: Partial<ServerOptions>, port: number, bus: IMessageBus): SignalingServer {
    const httpServer = createNodeHttpServer(tlsOptions);
    const io = new BaseServer(httpServer, ioOptions);
    const acceptor: Acceptor = new SocketIoChannelAcceptor(io, httpServer, port);
    const protocol = tlsOptions ? "wss" : "ws";
    const serverUrl = `${protocol}://localhost:${port}`;
    return new SignalingServer(
      serverId, serverUrl, acceptor, bus,
      new InMemoryStore<string, Space>(),
      new InMemoryStore<number, Member>(),
    );
  }

  /** Starts accepting channels and listening for coordinator space updates. */
  start() {
    this.acceptor.onChannel((channel) => {
      const session = new MemberSession(channel, this.bus, this);
      session.start();
    });
    this.acceptor.start();

    this._cancelConsumer = this.bus.consume(
      "spaceUpdateStream", this.onSpaceUpdate.bind(this));
  }

  _addSpace(uuid: string, data: SpaceData,
    routerRtpCapabilities: mediasoup.types.RtpCapabilities): Space {
    const space: Space = {
      uuid, data, members: new Map(), routerRtpCapabilities,
    };
    this.spaces.set(uuid, space);
    return space;
  }

  _removeSpace(uuid: string) {
    this.spaces.delete(uuid);
  }

  _addMember(id: number, space: Space, data: MemberData,
    initialState: MemberState): Member {
    const member: Member = {
      id, owningSpace: space, data, state: initialState,
    };
    this.members.set(id, member);
    space.members.set(id, member);
    return member;
  }

  _removeMember(id: number) {
    const member = this.members.get(id);
    if (member !== undefined) {
      member.owningSpace.members.delete(id);
      this.members.delete(id);
    }
  }

  /**
   * Registers a member channel after `spaceInit` is emitted.
   *
   * This ordering prevents broadcasts from reaching the client before the
   * initial snapshot.
   */
  registerChannel(memberId: number, channel: Channel) {
    this.memberIdToChannel.set(memberId, channel);
  }

  /** Removes a member channel registration. Idempotent. */
  unregisterChannel(memberId: number) {
    this.memberIdToChannel.delete(memberId);
  }

  /** Returns the local mirror for a subscribed space. */
  getSpace(uuid: string): Space | undefined {
    return this.spaces.get(uuid);
  }

  /** Subscribes this signaling server to a space and mirrors its state. */
  async prepareSpace(uuid: string): Promise<void> {
    if (this.spaces.has(uuid)) {
      return Promise.resolve();
    }

    const promise = new Promise<void>((resolve) => {
      this.bus.publish("subscribeToSpaceRequest", { serverId: this.serverId, uuid },
        ({ clientSideSpace, routerRtpCapabilities }) => {
          if (!this.spaces.has(uuid)) {
            // Mirror the space and its existing members locally.
            const space = this._addSpace(uuid, clientSideSpace.data,
              routerRtpCapabilities);
            clientSideSpace.members.forEach(({ id, data, state }) => {
              this._addMember(id, space, data, state);
            });
          } else {
            // Duplicate subscribe ack for a space this server already mirrors.
            console.log("warning: spaceUuid already exists when calling prepareSpace");
          }
          resolve();
        },
        (e: Error) => {
          // TODO: Add retry or client-visible join failure.
          throw new Error("failed to prepare space: " + e.message);
        });
    });

    return promise;
  }

  /** Adds a member through the coordinator and mirrors it locally. */
  async prepareMember(spaceUuid: string,
    memberData: MemberData, memberState: MemberState): Promise<number> {
    if (!this.spaces.has(spaceUuid)) {
      throw new Error("space not found");
    }

    const promise = new Promise<number>((resolve) => {
      this.bus.publish("addMemberRequest", {
        serverId: this.serverId, spaceUuid, memberData, memberState
      }, ({ id }) => {
        if (!this.members.has(id)) {
          const space = this.spaces.get(spaceUuid);
          if (space === undefined) {
            // TODO: Handle late add-member ack after local space removal.
          } else {
            const member = this._addMember(id, space, memberData, memberState);

            // Notify other local channels in the space. The new member receives
            // `spaceInit` instead of this broadcast.
            space.members.forEach((_, otherId) => {
              if (otherId !== id && this.memberIdToChannel.has(otherId)) {
                this.memberIdToChannel.get(otherId)!.emit("spaceWideEvent",
                  "memberJoin", { member: getClientSideMember(member) });
              }
            });

            // TODO: Forward member joins to other signaling servers.
          }
        } else {
          // Duplicate add-member ack for a member this server already mirrors.
          console.log("warning: memberId already exists when calling prepareMember");
        }
        resolve(id);
      }, (e: Error) => {
        // TODO: Add retry or client-visible join failure.
        throw new Error("failed to prepare member: " + e.message);
      })
    });

    return promise;
  }

  /** Updates local member state and broadcasts it to local channels. */
  updateMember(memberId: number, update: Partial<MemberState>) {
    const member = this.members.get(memberId);
    if (member === undefined) {
      throw new Error("member not found");
    }
    member.state = { ...member.state, ...update };

    // Notify all local channels in the space.
    member.owningSpace.members.forEach((_, id) => {
      if (this.memberIdToChannel.has(id)) {
        this.memberIdToChannel.get(id)!.emit("spaceWideEvent", "memberStateUpdate", {
          memberId, newState: member.state
        });
      }
    });

    // TODO: Forward member state updates to other signaling servers.
  }

  /** Removes a member through the coordinator and updates local mirrors. */
  async deleteMember(memberId: number): Promise<void> {
    if (!this.members.has(memberId)) {
      return Promise.resolve();
    }

    const promise = new Promise<void>((resolve) => {
      this.bus.publish("removeMemberRequest", { id: memberId },
        () => {
          if (this.members.has(memberId)) {
            const space = this.members.get(memberId)!.owningSpace;
            this._removeMember(memberId);

            // Notify other local channels in the space. The removed member
            // closes its own channel.
            space.members.forEach((_, otherId) => {
              if (otherId !== memberId && this.memberIdToChannel.has(otherId)) {
                this.memberIdToChannel.get(otherId)!.emit("spaceWideEvent",
                  "memberLeave", { memberId });
              }
            });

            // TODO: Forward member leaves to other signaling servers.

            // When this server has no members left in the space, unsubscribe so
            // the coordinator can end the space once all servers have left.
            if (space.members.size === 0) {
              this.deleteSpace(space.uuid).catch((e: Error) => {
                console.error("failed to delete space after last member left:", e.message);
              });
            }
          } else {
            // Duplicate delete-member ack for a member already removed locally.
            console.log("warning: member not found when calling deleteMember");
          }

          resolve();
        },
        (e: Error) => {
          // TODO: Add retry or forced local cleanup after coordinator failure.
          throw new Error("failed to delete member: " + e.message);
        });
    });

    return promise;
  }

  /** Unsubscribes from a space after this server has no local members in it. */
  async deleteSpace(spaceUuid: string): Promise<void> {
    if (!this.spaces.has(spaceUuid)) {
      return Promise.resolve();
    }
    if (this.spaces.get(spaceUuid)!.members.size > 0) {
      throw new Error("space still not empty");
    }

    const promise = new Promise<void>((resolve) => {
      this.bus.publish("unsubscribeFromSpaceRequest",
        { serverId: this.serverId, uuid: spaceUuid },
        () => {
          this._removeSpace(spaceUuid);
          resolve();
        },
        (e: Error) => {
          // TODO: Add retry or delayed local cleanup for failed unsubscribe.
          throw new Error("failed to delete space: " + e.message);
        });
    });

    return promise;
  }

  /** Handles coordinator-originated space update events for local channels. */
  onSpaceUpdate: QueueConsumerCallback<"spaceUpdateStream"> =
    ({ uuid, type, payload }, ack, nack) => {
      if (type.startsWith("S:")) return;

      const space = this.spaces.get(uuid);
      if (space === undefined) {
        nack(new Error("space not found"));
        return;
      }

      if (type === "C:transportParamsEvent") {
        const channel = this.memberIdToChannel.get(payload.memberId);
        if (channel === undefined) {
          // Member belongs to another signaling server.
          ack();
          return;
        }

        // Send own member ID for producer transports, otherwise source member ID.
        channel.emit("memberEvent", "transportParams", {
          memberId: (payload.consumesFromMemberId ?? payload.memberId),
          options: payload.options,
        });

        ack();
      } else if (type === "C:producerConnectedEvent") {
        if (!this.memberIdToChannel.has(payload.memberId)) {
          // Producer belongs to another signaling server.
          ack();
          return;
        }
        try {
          this.updateMember(payload.memberId, { transportIsConnected: true });
        } catch (err: any) {
          nack(err);
          return;
        }

        ack();
      } else {
        nack(new Error("unexpected error: unknown space update payload type"));
      }
    }
}
