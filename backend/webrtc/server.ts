/*

Implementation for the WebSocket signaling server.
- Maintains connection with client and updates state changes in the space.
- Communicates with the coordinator on client join events.

The server no longer talks to Socket.IO directly. New connections come in
as `IClientChannel` instances from an `IClientChannelAcceptor`; per-channel
state (join handshake, listeners, lifetime) is owned by `MemberSession`.
The server itself keeps the cross-channel mirror of coordinator state
(spaces, members) plus the `memberId → channel` registry used for
outbound broadcasts.

In the future, there should be another service to allow scaling these
horizontally and manage communication between servers.

Small note: A lot of these functions are not too complicated due to the
fact that TypeScript runs on single-threaded event loop, so we don't have
to worry about race conditions and order of operations too much.

*/

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

import https from "node:https";
import { Server as BaseServer, type ServerOptions } from "socket.io";
import mediasoup from "mediasoup";
import mediasoupClient from "mediasoup-client";


interface Member {
  id: number;
  owningSpace: Space;

  data: MemberData;
  state: MemberState;
}

export interface Space {
  uuid: string;
  data: SpaceData;
  members: Map<number, Member>;

  // TODO: Right now, we make simplified assumptions about transport router allocation.
  // We assume that the routerRtpCapabilities we receive are the same for all transports
  // in the space. In reality, routerRtpCapabilities can differ between transports, and
  // we have not made guarantees on where each transport will get allocated.
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


export interface ClientToServerEvents {

  // This is for client-side checks/retries
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

  // TODO: For better failure handling, we should have the client send the
  // consumerId rather than just memberId, since we assume the consumer might
  // fail at any time.
  transportConsumerResume: (
    args: { sourceMemberId: number },
    cId: string,
  ) => Promise<void>;

  // TODO: We should restrict to client-sourced states only
  updateMemberState: (
    args: { newState: Partial<MemberState> },
    cId: string,
  ) => Promise<void>;
}


type Channel = IClientChannel<ClientToServerEvents, ServerToClientEvents>;
type Acceptor = IClientChannelAcceptor<ClientToServerEvents, ServerToClientEvents>;


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


export class SignalingServer {
  serverId: number
  acceptor: Acceptor
  bus: IMessageBus

  memberIdToChannel: Map<number, Channel>

  spaces: IStore<string, Space>
  members: IStore<number, Member>

  // Cancellation handle for the bus subscription registered in start().
  _cancelConsumer: (() => void) | null = null

  constructor(
    serverId: number,
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
  }

  // Builds the underlying HTTPS + socket.io servers and the Socket.IO
  // channel acceptor but does not listen on the port yet — that happens
  // in start(). Lets callers configure or swap collaborators before
  // binding to the network.
  static create(serverId: number, httpsOptions: https.ServerOptions,
    ioOptions: Partial<ServerOptions>, port: number, bus: IMessageBus): SignalingServer {
    const httpsServer = https.createServer(httpsOptions);
    const io = new BaseServer(httpsServer, ioOptions);
    const acceptor: Acceptor = new SocketIoChannelAcceptor(io, httpsServer, port);
    return new SignalingServer(
      serverId, acceptor, bus,
      new InMemoryStore<string, Space>(),
      new InMemoryStore<number, Member>(),
    );
  }

  // Wires the channel handler, binds the HTTPS port, and subscribes to
  // coordinator updates. Must be called once after construction.
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

  // Called by MemberSession after a successful prepareMember + spaceInit
  // emission, atomically with the spaceInit so no broadcast is missed.
  registerChannel(memberId: number, channel: Channel) {
    this.memberIdToChannel.set(memberId, channel);
  }

  // Called by MemberSession on channel close. Idempotent.
  unregisterChannel(memberId: number) {
    this.memberIdToChannel.delete(memberId);
  }

  getSpace(uuid: string): Space | undefined {
    return this.spaces.get(uuid);
  }

  async prepareSpace(uuid: string): Promise<void> {
    if (this.spaces.has(uuid)) {
      return Promise.resolve();
    }

    const promise = new Promise<void>((resolve) => {
      this.bus.publish("subscribeToSpaceRequest", { serverId: this.serverId, uuid },
        ({ clientSideSpace, routerRtpCapabilities }) => {
          if (!this.spaces.has(uuid)) {
            // Create the space and existing members object
            const space = this._addSpace(uuid, clientSideSpace.data,
              routerRtpCapabilities);
            clientSideSpace.members.forEach(({ id, data, state }) => {
              this._addMember(id, space, data, state);
            });
          } else {
            // This should not happen since subscribeToSpaceRequest is only sent
            // once, although this might change in the future.
            console.log("warning: spaceUuid already exists when calling prepareSpace");
          }
          resolve();
        },
        (e: Error) => {
          // TODO: Need retry mechanism
          throw new Error("failed to prepare space: " + e.message);
        });
    });

    return promise;
  }

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
            // This might happen if the space is already closed and the member
            // came in late, but I'm not too sure.
          } else {
            const member = this._addMember(id, space, memberData, memberState);

            // Notify other members in the space (whose channels we own)
            // This new member will not receive this and instead will get the
            // spaceInit member event.
            space.members.forEach((_, otherId) => {
              if (otherId !== id && this.memberIdToChannel.has(otherId)) {
                this.memberIdToChannel.get(otherId)!.emit("spaceWideEvent",
                  "memberJoin", { member: getClientSideMember(member) });
              }
            });

            // TODO: Forward the notification to other servers via coordinator
            // (this will be implemented later).
          }
        } else {
          // This should not happen since addMemberRequest is only sent once,
          // although this might change in the future.
          console.log("warning: memberId already exists when calling prepareMember");
        }
        resolve(id);
      }, (e: Error) => {
        // TODO: Need retry mechanism
        throw new Error("failed to prepare member: " + e.message);
      })
    });

    return promise;
  }

  updateMember(memberId: number, update: Partial<MemberState>) {
    const member = this.members.get(memberId);
    if (member === undefined) {
      throw new Error("member not found");
    }
    member.state = { ...member.state, ...update };

    // Notify all members in the space (whose channels we own)
    member.owningSpace.members.forEach((_, id) => {
      if (this.memberIdToChannel.has(id)) {
        this.memberIdToChannel.get(id)!.emit("spaceWideEvent", "memberStateUpdate", {
          memberId, newState: member.state
        });
      }
    });

    // TODO: Forward the notification to other servers via coordinator
    // (this will be implemented later).
  }

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

            // Notify other members in the space (whose channels we own)
            // This member will not receive this and the client should
            // disconnect on its own.
            space.members.forEach((_, otherId) => {
              if (otherId !== memberId && this.memberIdToChannel.has(otherId)) {
                this.memberIdToChannel.get(otherId)!.emit("spaceWideEvent",
                  "memberLeave", { memberId });
              }
            });

            // TODO: Forward the notification to other servers via coordinator
            // (this will be implemented later).
          } else {
            // This should not happen since deleteMember is called only once
            console.log("warning: member not found when calling deleteMember");
          }

          resolve();
        },
        (e: Error) => {
          // TODO: Need retry mechanism
          throw new Error("failed to delete member: " + e.message);
        });
    });

    return promise;
  }

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
          // TODO: Need retry mechanism
          throw new Error("failed to delete space: " + e.message);
        });
    });

    return promise;
  }

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
          nack(new Error("channel not found"));
          return;
        }

        // Pass the transport parameters to the client
        // Send own memberId if producer, else send consumesFromMemberId
        channel.emit("memberEvent", "transportParams", {
          memberId: (payload.consumesFromMemberId ?? payload.memberId),
          options: payload.options,
        });

        ack();
      } else if (type === "C:producerConnectedEvent") {
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
