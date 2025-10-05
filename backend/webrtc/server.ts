/*

Implementation for the WebSocket signaling server.
- Maintains connection with client and updates state changes in the space.
- Communicates with the coordinator on client join events.

In the future, there should be another service to allow scaling these
horizontally and manage communication between servers.

Small note: A lot of these functions are not too complicated due to the
fact that TypeScript runs on single-threaded event loop, so we don't have
to worry about race conditions and order of operations too much.

*/

import {
  Coordinator, SpaceData, MemberData, MemberState, QueueConsumerCallback,
  type SpaceUpdateSTypes, type ClientSideSpace, type ClientSideMember
} from "./coordinator.ts";

import https from "node:https";
import { Server as BaseServer, Socket as BaseSocket } from "socket.io";
import mediasoup from "mediasoup";
import mediasoupClient from "mediasoup-client";


interface Member {
  id: number;
  owningSpace: Space;
  
  data: MemberData;
  state: MemberState;
}

interface Space {
  uuid: string;
  data: SpaceData;
  members: Map<number, Member>;
}

type MemberEventType = "spaceInit" | "transportParams";

interface MemberEventContentMap extends Record<MemberEventType, any> {
  spaceInit: {
    receivingMemberId: number,
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


interface ServerToClientEvents {

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


interface ClientToServerEvents {

  disconnect: () => void;

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

  updateMemberState: (
    args: { newState: Partial<MemberState> },
    cId: string,
  ) => Promise<void>;
}


interface InterServerEvents {
  // nothing here
}


interface SocketData {
  spaceUuid: string;
  memberData: MemberData;
}


type Server = BaseServer<ClientToServerEvents, ServerToClientEvents,
  InterServerEvents, SocketData>;

type Socket = BaseSocket<ClientToServerEvents, ServerToClientEvents>;

interface Connection {
  socket: Socket;
  memberId?: number;
}


const FORWARD_AND_ACK_LISTEN_EVENTS_MAP: Map<keyof ClientToServerEvents,
  SpaceUpdateSTypes> = new Map([
    ["transportProducerConnect", "S:memberProducerConnectEvent"],
    ["transportProducerProduce", "S:memberProducerProduceEvent"],
    ["transportConsumerConnect", "S:memberConsumerConnectEvent"],
    ["transportConsumerConsume", "S:memberConsumerConsumeEvent"],
    ["transportConsumerResume", "S:memberConsumerResumeEvent"],
  ]);


function getClientSideSpace(space: Space): ClientSideSpace {
  const clientSideMembers = new Map<number, ClientSideMember>(
    Array.from(space.members.values()).map(
      (member) => [member.id, getClientSideMember(member)]));
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
  server: Server
  coordinator: Coordinator

  connections: Map<string, Connection>
  memberIdToSocket: Map<number, Socket>

  spaces: Map<string, Space>
  members: Map<number, Member>

  constructor(server: Server, coordinator: Coordinator) {
    this.server = server;
    this.coordinator = coordinator;

    this.connections = new Map();
    this.memberIdToSocket = new Map();

    this.spaces = new Map();
    this.members = new Map();

    this.server.on("connection", this.onConnection);

    this.coordinator.consume("spaceUpdateStream", this.onSpaceUpdate);
  }

  static create(httpsOptions: https.ServerOptions, port: number,
    coordinator: Coordinator): SignalingServer {
    const httpsServer = https.createServer(httpsOptions);
    httpsServer.listen(port);

    const server = new BaseServer(httpsServer);

    return new SignalingServer(server, coordinator);
  }

  _addSpace(uuid: string, data: SpaceData): Space {
    const space: Space = { uuid, data, members: new Map() };
    this.spaces.set(uuid, space);
    return space;
  }

  _removeSpace(uuid: string) {
    this.spaces.delete(uuid);
  }

  _addMember(id: number, space: Space, data: MemberData,
    initialState: MemberState): Member {
    const member: Member = {
      id, owningSpace: space, data, state: initialState
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

  async onConnection(socket: Socket) {
    this.connections.set(socket.id, { socket });

    socket.on("disconnect", () => {
      const memberId = this.connections.get(socket.id)!.memberId;
      if (memberId !== undefined) {
        this.memberIdToSocket.delete(memberId);
        this.deleteMember(memberId);
      }
      this.connections.delete(socket.id);
    })

    // Prepare space and member
    const { spaceUuid, memberData, memberState } =
      socket.handshake.auth as {
        spaceUuid: string,
        memberData: MemberData,
        memberState: MemberState,
      };
    const socketId = socket.id;
    try {
      await this.prepareSpace(spaceUuid);
      socket.emit("connectionSuccessful");

      const memberId = await this.prepareMember(spaceUuid, socketId,
        memberData, {
          ...memberState,
          transportIsConnected: false,
        });

      const space = this.spaces.get(spaceUuid)!;

      // Start listening to WebSocket messages

      socket.on("createWebRtcTransport", async ({ consumesFromMemberId }, cId) => {
        // TODO: We're supposed to let the coordinator know to check if the
        // transport is being processed, and start processing if not.
      })

      socket.on("resendSpaceInit", async (cId) => {
        // TODO: Handle this; we don't need to tell the coordinator.
      })

      socket.on("updateMemberState", async ({ newState }, cId) => {
        try {
          this.updateMember(memberId, newState);
          socket.emit("updateMemberStateAck", cId);
        } catch (err: any) {
          // TODO: Need to handle failure properly
          socket.emit("updateMemberStateAck", cId);
        }
      });

      // For all these message types, the signaling server simply forwards it
      // to the coordinator.
      FORWARD_AND_ACK_LISTEN_EVENTS_MAP.forEach((spaceUpdateType,
        clientEventType) => {
          // TODO: We probably should change the way we implement typing here
          // @ts-ignore ('data' implicitly has 'any' type)
          socket.on(clientEventType, async (data, cId) => {
            this.coordinator.publish("spaceUpdateStream", {
              uuid: spaceUuid,
              type: spaceUpdateType,
              payload: { memberId, data },
            }, () => {
              // Acknowledge to the client
              socket.emit((clientEventType + "Ack") as keyof ServerToClientEvents, cId);
            }, (e: Error) => {
              // TODO: Need retry mechanism, then notify client on failure
              throw new Error("failed to forward event: " + e.message);
            });
          });
        });

      // This message also serves as confirmation that the client can start
      // sending messages back to the server.
      socket.emit("memberEvent", "spaceInit", {
        receivingMemberId: memberId,
        clientSideSpace: getClientSideSpace(space),
      });
      this.connections.get(socketId)!.memberId = memberId;

      // This map will be used to broadcast updates, and this insertion needs
      // to be performed with the memberEvent emission atomically; we want to
      // make sure no updates are missed.
      this.memberIdToSocket.set(memberId, socket);
    } catch (err: any) {
      console.log(err);
      socket.emit("connectionFailed", { message: "" });
    }
  }

  async prepareSpace(uuid: string): Promise<void> {
    if (this.spaces.has(uuid)) {
      return Promise.resolve();
    }

    const promise = new Promise<void>((resolve) => {
      this.coordinator.publish("subscribeToSpaceRequest", { uuid },
        ({ clientSideSpace }) => {
          if (!this.spaces.has(uuid)) {
            // Create the space and existing members object
            const space = this._addSpace(uuid, clientSideSpace.data);
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

  async prepareMember(spaceUuid: string, socketId: string,
    memberData: MemberData, memberState: MemberState): Promise<number> {
    if (!this.connections.has(socketId) || !this.spaces.has(spaceUuid)) {
      throw new Error("socket not found");
    }
    if (this.connections.get(socketId)!.memberId !== undefined) {
      // This should not happen since prepareMember is called only once
      console.log("warning: member already exists when calling prepareMember");
      return Promise.resolve(this.connections.get(socketId)!.memberId!);
    }

    const promise = new Promise<number>((resolve) => {
      this.coordinator.publish("addMemberRequest", {
        spaceUuid, memberData, memberState
      }, ({ id }) => {
        if (!this.members.has(id)) {
          const space = this.spaces.get(spaceUuid);
          if (space === undefined) {
            // This might happen if the space is already closed and the member
            // came in late, but I'm not too sure.
          } else {
            const member = this._addMember(id, space, memberData, memberState);

            // Notify other members in the space (whose sockets we own)
            // This new member will not receive this and instead will get the
            // spaceInit member event.
            space.members.forEach((_, otherId) => {
              if (otherId !== id && this.memberIdToSocket.has(otherId)) {
                this.memberIdToSocket.get(otherId)!.emit("spaceWideEvent",
                  "memberJoin", getClientSideMember(member));
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

    // Notify all members in the space (whose sockets we own)
    member.owningSpace.members.forEach((_, id) => {
      if (this.memberIdToSocket.has(id)) {
        this.memberIdToSocket.get(id)!.emit("spaceWideEvent", "memberStateUpdate", {
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
      this.coordinator.publish("removeMemberRequest", { id: memberId },
        () => {
          if (this.members.has(memberId)) {
            const space = this.members.get(memberId)!.owningSpace;
            this._removeMember(memberId);

            // Notify other members in the space (whose sockets we own)
            // This member will not receive this and the client should
            // disconnect on its own.
            space.members.forEach((_, otherId) => {
              if (otherId !== memberId && this.memberIdToSocket.has(otherId)) {
                this.memberIdToSocket.get(otherId)!.emit("spaceWideEvent",
                  "memberLeave", memberId);
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
      this.coordinator.publish("unsubscribeFromSpaceRequest",
        { uuid: spaceUuid },
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
      const space = this.spaces.get(uuid);
      if (space === undefined) {
        nack(new Error("space not found"));
        return;
      }

      if (type === "C:transportParamsEvent") {
        const socket = this.memberIdToSocket.get(payload.memberId);
        if (socket === undefined) {
          nack(new Error("socket not found"));
          return;
        }

        // Pass the transport parameters to the client
        // Send own memberId if producer, else send consumesFromMemberId
        socket.emit("memberEvent", "transportParams", {
          memberId: (payload.consumesFromMemberId ?? payload.memberId),
          options: payload.options,
        });

        ack();
      } else if (type === "C:producerConnectedEvent") {
        try {
          // Notify all other members that they can start consuming
          space.members.forEach((_, id) => {
            if (id !== payload.memberId) {
              this.updateMember(id, { transportIsConnected: true });
            }
          });
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
