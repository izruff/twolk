import { type MemberData, type MemberState } from "./member";
import { type SpaceData } from "./space";
import { SocketWrapper } from "./socket";
import { getRandomUUID } from "../utils/random";

import mediasoupClient from "mediasoup-client";
import { Socket } from "socket.io-client";


export interface ClientSideMember {
  id: number;
  data: MemberData;
  state: MemberState;
}

export interface ClientSideSpace {
  uuid: string;
  data: SpaceData;
  members: Map<number, ClientSideMember>;
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
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
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
    kind: mediasoupClient.types.MediaKind,
    rtpParameters: mediasoupClient.types.RtpParameters,
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
    args: { dtlsParameters: mediasoupClient.types.DtlsParameters },
    cId: string,
  ) => void;

  transportProducerProduce: (
    args: {
      kind: mediasoupClient.types.MediaKind,
      rtpParameters: mediasoupClient.types.RtpParameters,
    },
    cId: string,
  ) => void;

  transportConsumerConnect: (
    args: {
      dtlsParameters: mediasoupClient.types.DtlsParameters,
      sourceMemberId: number,
    },
    cId: string,
  ) => void;

  transportConsumerConsume: (
    args: {
      rtpCapabilities: mediasoupClient.types.RtpCapabilities,
      sourceMemberId: number,
    },
    cId: string,
  ) => void;

  transportConsumerResume: (
    args: { sourceMemberId: number },
    cId: string,
  ) => void;

  updateMemberState: (
    args: { newState: Partial<MemberState> },
    cId: string,
  ) => Promise<void>;
}


export type SignalingSocket = Socket<ServerToClientEvents, ClientToServerEvents>;


export class SignalingSocketWrapper extends SocketWrapper<SignalingSocket> {
  private connectedHandlers = new Set<() => void>();
  private disconnectedHandlers = new Set<() => void>();
  private failedHandlers = new Set<(error: { message: string }) => void>();

  private memberHandlers = new Map<MemberEventType, Set<(payload: MemberEventContentMap[MemberEventType]) => void>>();
  private spaceWideHandlers = new Map<SpaceWideEventType, Set<(payload: SpaceWideEventContentMap[SpaceWideEventType]) => void>>();

  status: "disconnected" | "connecting" | "connected"

  constructor(socket: SignalingSocket, spaceUuid: string, memberData: MemberData, memberState: MemberState) {
    super(socket);

    // The socket is supposed to be disconnected before being wrapped.
    if (this._socket.connected) {
      throw new Error("socket must be disconnected upon wrapping");
    }

    this._socket.auth = {
      spaceUuid,
      memberData,
      memberState,
    };

    this.status = "disconnected";
    this._socket.on("connect", this.handleConnect);
    this._socket.on("disconnect", this.handleDisconnect);
    this._socket.on("memberEvent", this.handleMemberEvent);
    this._socket.on("spaceWideEvent", this.handleSpaceWideEvent);
  }

  isConnected(): boolean {
    return this.status === "connected";
  }

  onConnected(handler: () => void): void {
    this.connectedHandlers.add(handler);
  }

  offConnected(handler: () => void): void {
    this.connectedHandlers.delete(handler);
  }

  onDisconnected(handler: () => void): void {
    this.disconnectedHandlers.add(handler);
  }

  offDisconnected(handler: () => void): void {
    this.disconnectedHandlers.delete(handler);
  }

  onFailed(handler: (error: { message: string }) => void): void {
    this.failedHandlers.add(handler);
  }

  offFailed(handler: (error: { message: string }) => void): void {
    this.failedHandlers.delete(handler);
  }

  onMemberEvent<K extends MemberEventType>(type: K, handler: (payload: MemberEventContentMap[K]) => void): void {
    const bucket = this.memberHandlers.get(type) ?? new Set();
    bucket.add(handler as (payload: MemberEventContentMap[MemberEventType]) => void);
    this.memberHandlers.set(type, bucket);
  }

  offMemberEvent<K extends MemberEventType>(type: K, handler: (payload: MemberEventContentMap[K]) => void): void {
    this.memberHandlers.get(type)?.delete(handler as (payload: MemberEventContentMap[MemberEventType]) => void);
  }

  onSpaceWideEvent<K extends SpaceWideEventType>(type: K, handler: (payload: SpaceWideEventContentMap[K]) => void): void {
    const bucket = this.spaceWideHandlers.get(type) ?? new Set();
    bucket.add(handler as (payload: SpaceWideEventContentMap[SpaceWideEventType]) => void);
    this.spaceWideHandlers.set(type, bucket);
  }

  offSpaceWideEvent<K extends SpaceWideEventType>(type: K, handler: (payload: SpaceWideEventContentMap[K]) => void): void {
    this.spaceWideHandlers.get(type)?.delete(handler as (payload: SpaceWideEventContentMap[SpaceWideEventType]) => void);
  }

  updateMemberState(newState: Partial<MemberState>): Promise<void> {
    const cId = getRandomUUID();
    this.emit("updateMemberState", { newState }, cId);

    const ackPromise = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("timeout waiting for updateMemberStateAck"));
      }, 5000);

      this.onceWithCondition("updateMemberStateAck",
        (ackCId: string) => ackCId === cId,
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        (_ackCId: string) => {
          resolve();
          clearTimeout(timeout);
        }
      );
    });

    return ackPromise;
  }

  private handleConnect = (): void => {
    this.status = "connecting";
    this.armConnectionOutcome();
  };

  private armConnectionOutcome(): void {
    this._socket.once("connectionSuccessful", this.handleConnectionSuccessful);
    this._socket.once("connectionFailed", this.handleConnectionFailed);
  }

  private disarmConnectionOutcome(): void {
    this._socket.off("connectionSuccessful", this.handleConnectionSuccessful);
    this._socket.off("connectionFailed", this.handleConnectionFailed);
  }

  private handleDisconnect = (): void => {
    this.status = "disconnected";
    this.disarmConnectionOutcome();
    this.disconnectedHandlers.forEach((h) => h());
  };

  private handleConnectionSuccessful = (): void => {
    this.status = "connected";
    this.disarmConnectionOutcome();
    this.connectedHandlers.forEach((h) => h());
  };

  private handleConnectionFailed = (error: { message: string }): void => {
    this.status = "disconnected";
    this.disarmConnectionOutcome();
    this.failedHandlers.forEach((h) => h(error));
  };

  private handleMemberEvent = <K extends MemberEventType>(
    type: K,
    content: MemberEventContentMap[K],
  ): void => {
    this.memberHandlers.get(type)?.forEach((h) => h(content));
  };

  private handleSpaceWideEvent = <K extends SpaceWideEventType>(
    type: K,
    content: SpaceWideEventContentMap[K],
  ): void => {
    this.spaceWideHandlers.get(type)?.forEach((h) => h(content));
  };
}
