/*

Implementation of the SFU worker.
- Receives and sends RTP packets from and to client via WebRTC.
- Routes RTP packets between clients in the same space.
- Facilitates transport to other media-related workers.

*/

import { Coordinator, type QueueConsumerCallback } from "./coordinator.ts";
import { getPublicIpAddress } from "./utils/network.ts";

import mediasoup from "mediasoup";


interface Router {
  id: number;
  mediasoupRouter: mediasoup.types.Router;
  webRtcProducerTransports: Map<string, mediasoup.types.WebRtcTransport>;
  webRtcConsumerTransports: Map<string, mediasoup.types.WebRtcTransport>;
}


export class SfuWorker {
  mediasoupWorker: mediasoup.types.Worker
  coordinator: Coordinator

  routers: Map<number, Router>

  constructor(worker: mediasoup.types.Worker, coordinator: Coordinator) {
    this.mediasoupWorker = worker;
    this.coordinator = coordinator;

    this.routers = new Map();

    this.coordinator.consume("newRouterRequest", this.onNewRouterRequest);
    
  }

  static async create(
    rtcPortRange: { min: number, max: number },
    coordinator: Coordinator,
    onDied: (err: Error) => void,
  ) {
    const worker = await mediasoup.createWorker({
      rtcMinPort: rtcPortRange.min,
      rtcMaxPort: rtcPortRange.max,
    });

    worker.on("died", onDied);

    return new SfuWorker(worker, coordinator);
  }

  onNewRouterRequest: QueueConsumerCallback<"newRouterRequest"> =
    async ({ assignedId }, ack, nack) => {
      try {
        await this.createRouter(assignedId);
        ack();
      } catch (err: any) {
        nack(err);
      }
    }
  
  onNewWebRtcTransportRequest: QueueConsumerCallback<"newWebRtcTransportRequest"> =
    async ({ routerId, isProducer }, ack, nack) => {
      const router = this.routers.get(routerId);
      if (router === undefined) {
        nack(new Error("router not found"));
        return;
      }

      try {
        // Create the transport
        const transportOptions: mediasoup.types.WebRtcTransportOptions = {
          listenIps: [
            {
              ip: "0.0.0.0",
              announcedIp: await getPublicIpAddress(),
            }
          ],
          enableUdp: true,
          enableTcp: true,
          preferUdp: true,
        };
        const transport = await router.mediasoupRouter.createWebRtcTransport(
          transportOptions);

        // TODO: Handle events emitted by the transport

        // Register this transport
        if (isProducer) {
          router.webRtcProducerTransports.set(transport.id, transport);
        } else {
          router.webRtcConsumerTransports.set(transport.id, transport);
        }

        // Send back the transport parameters
        ack({
          options: {
            id: transport.id,
            iceParameters: transport.iceParameters,
            iceCandidates: transport.iceCandidates,
            dtlsParameters: transport.dtlsParameters,
          }
        });
      } catch (err: any) {
        nack(err);
      }
    }

  async createRouter(assignedRouterId: number) {
    // TODO: Not sure what the router options should be
    const mediasoupRouter = await this.mediasoupWorker.createRouter();
    const router: Router = {
      id: assignedRouterId,
      mediasoupRouter,
      webRtcProducerTransports: new Map(),
      webRtcConsumerTransports: new Map(),
    };
    this.routers.set(assignedRouterId, router);
  }
}

