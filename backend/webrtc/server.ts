/*

Implementation for the WebSocket signaling server.
- Maintains connection with client and updates state changes in the space.
- Communicates with the coordinator on client join events.

In the future, there should be another service to allow scaling these
horizontally and manage communication between servers.

*/

import { Coordinator, MemberData, MemberState, TransportMetadata } from "./coordinator.ts";

import https from "node:https";
import { Server as BaseServer, Socket as BaseSocket } from "socket.io";
import mediasoup from "mediasoup";
import mediasoupClient from "mediasoup-client";


interface Member {
  id: number;
  data: MemberData;
  state: MemberState;
  producerMetadata: TransportMetadata;
}

interface Space {
  uuid: string;
  rtpCapabilities: mediasoup.types.RtpCapabilities;
  members: Map<number, Member>;
}


type SpaceEventType = "end";

interface ServerToClientEvents {

  connectionSuccessful: () => void;

  connectionFailed: (error: { message: string }) => void;

  spaceInitialData: (
    data: {
      rtpCapabilities: mediasoup.types.RtpCapabilities,
      members: Map<number, Member>,
    }
  ) => void;

  spaceEvent: (
    event: {
      type: SpaceEventType,
    }
  ) => void;

  spaceMemberEvent: (
    event: {
      memberId: number,
      newState: MemberState,
    }
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
  memberIdToSpace: Map<number, Space>

  _prepareSpaceResolvers: Map<string, (() => void)[]>
  _prepareMemberResolvers: Map<string, ((memberId: number) => void)[]>

  constructor(server: Server, coordinator: Coordinator) {
    this.server = server;
    this.coordinator = coordinator;

    this.connections = new Map();
    this.memberIdToSocket = new Map();

    this.spaces = new Map();
    this.members = new Map();
    this.memberIdToSpace = new Map();

    this._prepareSpaceResolvers = new Map();
    this._prepareMemberResolvers = new Map();

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
      socket.emit("spaceInitialData", {
        rtpCapabilities: space.rtpCapabilities,
        members: space.members,
      });
      this.connections.get(socketId)!.memberId = memberId;
      // It is important to set this below here because this map will be used 
      // to broadcast updates, and we want to make sure no updates were missed
      // after the spaceInitialData event.
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

    const key = "prepareSpace:" + uuid;
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

    const key = "prepareMember:" + socketId;
    return new Promise((resolve) => {
      const map = this._prepareMemberResolvers;
      if (!map.has(key)) {
        map.set(key, []);
      }
      map.get(key)!.push(resolve);
    });
  }

  updateMember(memberId: number, update: Partial<MemberState>) {
    const member = this.members.get(memberId);
    if (member === undefined) {
      throw new Error("member not found");
    }
    member.state = { ...member.state, ...update };

    this.memberIdToSpace.get(memberId)!.members.forEach((_, id) => {
      this.memberIdToSocket.get(id)!.emit("spaceMemberEvent", {
        memberId, newState: member.state
      });
    });
  }

  deleteMember(memberId: number) {
    // TODO
  }
}

