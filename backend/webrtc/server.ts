/*

Implementation for the WebSocket signaling server.
- Maintains connection with client and updates state changes in the space.
- Communicates with the coordinator on client join events.

In the future, there should be another service to allow scaling these
horizontally and manage communication between servers.

*/

import {
  Coordinator, SpaceData, MemberData, MemberState, TransportMetadata,
  type QueuePayloadTypeMap,
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


class SignalingServer {
  server: Server
  coordinator: Coordinator

  connections: Map<string, Connection>
  memberIdToSocket: Map<number, Socket>

  spaces: Map<string, Space>
  members: Map<number, Member>

  _prepareSpaceResolvers: Map<string, (() => void)[]>
  _prepareMemberResolvers: Map<string, ((memberId: number) => void)[]>

  constructor(server: Server, coordinator: Coordinator) {
    this.server = server;
    this.coordinator = coordinator;

    this.connections = new Map();
    this.memberIdToSocket = new Map();

    this.spaces = new Map();
    this.members = new Map();

    this._prepareSpaceResolvers = new Map();
    this._prepareMemberResolvers = new Map();

    // No need for cancel callbacks since only one server is used currently
    this.coordinator.consume("openSpaceResult", this.onOpenSpaceResult);
    this.coordinator.consume("addMemberResult", this.onAddMemberResult);

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
    await this.coordinator.openSpace(uuid);

    const key = uuid;
    return new Promise((resolve) => {
      const map = this._prepareSpaceResolvers;
      if (!map.has(key)) {
        map.set(key, []);
      }
      map.get(key)!.push(resolve);
    });
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
    await this.coordinator.addMemberToSpace(spaceUuid, socketId,
      memberData, memberState);

    const key = socketId;
    return new Promise((resolve) => {
      const map = this._prepareMemberResolvers;
      if (!map.has(key)) {
        map.set(key, []);
      }
      map.get(key)!.push(resolve);
    });
  }

  onOpenSpaceResult({ uuid, data }: QueuePayloadTypeMap["openSpaceResult"],
    ack: () => void, nack: (e: Error) => void) {
    if (!this.spaces.has(uuid)) {
      this.spaces.set(uuid, { uuid, data, members: new Map() });
    }

    const resolvers = this._prepareSpaceResolvers.get(uuid);
    if (resolvers !== undefined) {
      resolvers.forEach((resolve) => { resolve(); });
    }

    ack();  // assume everything works as expected
  }

  onAddMemberResult({ id, spaceUuid, data, state, tempId }
    : QueuePayloadTypeMap["addMemberResult"], ack: () => void,
    nack: (e: Error) => void) {
    if (!this.members.has(id)) {
      const space = this.spaces.get(spaceUuid);
      if (space === undefined) {
        // This might happen if the space is already closed and the member
        // came in late, but I'm not too sure.
      } else {
        const member = { id, space, data, state };
        this.members.set(id, member);
        this.spaces.get(spaceUuid)!.members.set(id, member);
      }
    }

    const resolvers = this._prepareMemberResolvers.get(tempId);
    if (resolvers !== undefined) {
      resolvers.forEach((resolve) => { resolve(id); });
    }

    ack();  // assume everything works as expected
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

  deleteMember(memberId: number) {
    if (this.members.has(memberId)) {
      this.members.get(memberId)!.space.members.delete(memberId);
      this.members.delete(memberId);
    }
  }
}

