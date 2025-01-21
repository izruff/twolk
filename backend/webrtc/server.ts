/*

Implementation for the WebSocket signaling server.
- Maintains connection with client and updates state changes in the space.
- Communicates with the coordinator on client join events.

In the future, there should be another service to allow scaling these
horizontally and manage communication between servers.

*/

import { Coordinator, SpaceData, MemberData, MemberState } from "./coordinator.ts";

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


type MemberEventType = "spaceInit";

interface MemberEventContentMap extends Record<MemberEventType, any> {
  spaceInit: {
    data: SpaceData,
    members: Map<number, Member>,
  };
}

type SpaceWideEventType = "memberJoin" | "memberLeave" | "memberStateUpdate"
  | "spaceClose";

interface SpaceWideEventContentMap extends Record<SpaceWideEventType, any> {
  memberJoin: {
    member: Member,
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

  createWebRtcTransport: (
    args: { asProducer: boolean },
    callback: (options: mediasoupClient.types.TransportOptions) => void,
  ) => Promise<void>;

  transportConnect: (
    args: { dtlsParameters: mediasoup.types.DtlsParameters },
  ) => void;

  transportProduce: (
    args: {
      kind: mediasoup.types.MediaKind,
      rtpParameters: mediasoup.types.RtpParameters,
      appData: mediasoup.types.AppData,
    },
    callback: (id: string) => void,
  ) => void;

  transportRecvConnect: (
    args: { dtlsParameters: mediasoup.types.DtlsParameters },
  ) => Promise<void>;

  consume: (
    args: {
      rtpCapabilities: mediasoup.types.RtpCapabilities,
      producerId: number,
    },
    callback: (options: mediasoupClient.types.ConsumerOptions) => void,
  ) => Promise<void>;

  consumerResume: (
    args: { producerId: number },
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

    const spaceUuid = socket.data.spaceUuid;
    const socketId = socket.id;
    try {
      await this.prepareSpace(spaceUuid);
      socket.emit("connectionSuccessful");

      const memberId = await this.prepareMember(spaceUuid, socketId,
        socket.data.memberData, {});

      const space = this.spaces.get(socket.id)!;
      socket.emit("memberEvent", "spaceInit", {
        data: space.data,
        members: space.members,
      });
      this.connections.get(socketId)!.memberId = memberId;
      // It is important to set this below here because this map will be used 
      // to broadcast updates, and we want to make sure no updates were missed
      // after the memberEvent emission.
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
            this.members.get(memberId)!.space.members.delete(memberId);
            this.members.delete(memberId);
          }

          // TODO: Notify other members in the space

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
}
