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
  type SpaceUpdateSTypes,
} from "./coordinator.ts";

import https from "node:https";
import { Server as BaseServer, Socket as BaseSocket } from "socket.io";
import mediasoup from "mediasoup";
import mediasoupClient from "mediasoup-client";


interface Member {
  id: number;
  space: Space;
  data: MemberData;
  state: MemberState;
}

interface Space {
  uuid: string;
  data: SpaceData;
  members: Map<number, Member>;
}

type ClientSideMember = Omit<Member, "space">;


type MemberEventType = "spaceInit" | "transportParams";

interface MemberEventContentMap extends Record<MemberEventType, any> {
  spaceInit: {
    data: SpaceData,
    members: Map<number, ClientSideMember>,
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

}


interface ClientToServerEvents {

  disconnect: () => void;

  // TODO: Implement this; the transport is already created when calling
  // `prepareMember` but this one is for client-side checks/retries
  createWebRtcTransport: (
    args: { asProducer: boolean },
  ) => Promise<void>;

  transportProducerConnect: (
    args: { dtlsParameters: mediasoup.types.DtlsParameters },
  ) => Promise<void>;

  transportProducerProduce: (
    args: {
      kind: mediasoup.types.MediaKind,
      rtpParameters: mediasoup.types.RtpParameters,
    },
  ) => Promise<void>;

  transportConsumerConnect: (
    args: {
      dtlsParameters: mediasoup.types.DtlsParameters,
      sourceMemberId: number,
    },
  ) => Promise<void>;

  transportConsumerConsume: (
    args: {
      rtpCapabilities: mediasoup.types.RtpCapabilities,
      sourceMemberId: number,
    },
  ) => Promise<void>;

  transportConsumerResume: (
    args: { sourceMemberId: number },
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


const FORWARD_ONLY_CLIENT_TO_SERVER_EVENTS_MAP: Map<keyof ClientToServerEvents,
  SpaceUpdateSTypes> = new Map([
    ["transportProducerConnect", "S:memberProducerConnectEvent"],
    ["transportProducerProduce", "S:memberProducerProduceEvent"],
    ["transportConsumerConnect", "S:memberConsumerConnectEvent"],
    ["transportConsumerConsume", "S:memberConsumerConsumeEvent"],
    ["transportConsumerResume", "S:memberConsumerResumeEvent"],
  ]);


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

  async onConnection(socket: Socket) {
    this.connections.set(socket.id, { socket });

    socket.on("disconnect", () => {
      const memberId = this.connections.get(socket.id)?.memberId;
      if (memberId !== undefined) {
        this.memberIdToSocket.delete(memberId);
        this.deleteMember(memberId);
      }
      this.connections.delete(socket.id);
    })

    // Prepare space and member
    const spaceUuid = socket.data.spaceUuid;
    const socketId = socket.id;
    try {
      await this.prepareSpace(spaceUuid);
      socket.emit("connectionSuccessful");

      const memberId = await this.prepareMember(spaceUuid, socketId,
        socket.data.memberData, {
          isMuted: false,
          transportIsConnected: false,
        });

      const space = this.spaces.get(spaceUuid)!;

      // Start listening to WebSocket messages

      socket.on("createWebRtcTransport", async ({ asProducer }) => {
        // TODO: Implement this; we need the coordinator server to listen to
        // a new type of space update.
      })

      // For all these message types, the signaling server simply forwards it
      // to the coordinator.
      FORWARD_ONLY_CLIENT_TO_SERVER_EVENTS_MAP.forEach((spaceUpdateType,
        clientEventType) => {
          // TODO: We probably should change the way we implement typing here
          // @ts-ignore ('data' implicitly has 'any' type)
          socket.on(clientEventType, async (data) => {
            this.coordinator.publish("spaceUpdateStream", {
              uuid: spaceUuid,
              type: spaceUpdateType,
              payload: { memberId, data },
            }, () => {
              // Do nothing for now
            }, (e: Error) => {
              // TODO: Need retry mechanism, then notify client on failure
              throw new Error("failed to forward event: " + e.message);
            });
          });
        });

      // This message also serves as confirmation that the client can start
      // sending messages back to the server.
      socket.emit("memberEvent", "spaceInit", {
        data: space.data,
        members: space.members,
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
        ({ data }) => {
          if (!this.spaces.has(uuid)) {
            this.spaces.set(uuid, { uuid, data, members: new Map() });
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
            const member: Member = {
              id, space, data: memberData, state: memberState
            };
            this.members.set(id, member);
            this.spaces.get(spaceUuid)!.members.set(id, member);

            // Notify other members in the space
            space.members.forEach((_, otherId) => {
              if (otherId !== id) {
                this.memberIdToSocket.get(otherId)!.emit("spaceWideEvent",
                  "memberJoin", getClientSideMember(member));
              }
            });
          }
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

    // Notify other members in the space
    this.members.get(memberId)!.space.members.forEach((_, id) => {
      this.memberIdToSocket.get(id)!.emit("spaceWideEvent", "memberStateUpdate", {
        memberId, newState: member.state
      });
    });
  }

  async deleteMember(memberId: number): Promise<void> {
    if (!this.members.has(memberId)) {
      return Promise.resolve();
    }

    const promise = new Promise<void>((resolve) => {
      this.coordinator.publish("removeMemberRequest", { id: memberId },
        () => {
          if (this.members.has(memberId)) {
            const space = this.members.get(memberId)!.space;
            space.members.delete(memberId);
            this.members.delete(memberId);

            // Notify other members in the space
            space.members.forEach((_, otherId) => {
              if (otherId !== memberId) {
                this.memberIdToSocket.get(otherId)!.emit("spaceWideEvent",
                  "memberLeave", memberId);
              }
            });
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
          if (this.spaces.has(spaceUuid)) {
            this.spaces.delete(spaceUuid);
          }
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
        socket.emit("memberEvent", "transportParams", {
          memberId: payload.memberId,
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
