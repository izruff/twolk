/*

Implementation for the WebSocket signaling server.
- Maintains connection with client and updates state changes in the space.
- Communicates with the coordinator on client join events.

In the future, there should be another service to allow scaling these
horizontally and manage communication between servers.

*/

import { Coordinator, MemberData, MemberState, TransportMetadata } from "./coordinator.ts";

import https from "node:https";
import { Server } from "socket.io";
import mediasoup from "mediasoup";
import mediasoupClient from "mediasoup-client";


type MemberEventType = "join" | "leave";

interface ServerToClientEvents {

  initializeSpace: (
    data: {
      rtpCapabilities: mediasoup.types.RtpCapabilities,
      memberDataMap: Map<number, MemberData>,
      memberInitialStateMap: Map<number, MemberState>,
      producerMetadataMap: Map<number, TransportMetadata>,
    }
  ) => void;

  producerEvent: (
    event: {
      memberId: number,
      type: MemberEventType,
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


export function createWsSignalingServer(
  httpsOptions: https.ServerOptions,
  port: number,
  coordinator: Coordinator,
) {
  const server = https.createServer(httpsOptions);
  server.listen(port);

  const io = new Server<
    ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData
  >(server);

  io.on("connection", async (socket) => {
    // TODO
  });

  return io;
}

