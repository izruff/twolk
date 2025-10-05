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
  webRtcProducerTransports: Map<number, WebRtcTransport>;
  webRtcConsumerTransports: Map<number, WebRtcTransport>;
  webRtcProducers: Map<number, mediasoup.types.Producer>;
  webRtcConsumers: Map<number, mediasoup.types.Consumer>;
}

interface Transport<T extends mediasoup.types.Transport> {
  id: number;
  mediasoupTransport: T;
  router: Router;
}

type WebRtcTransport = Transport<mediasoup.types.WebRtcTransport>;


export class SfuWorker {
  mediasoupWorker: mediasoup.types.Worker
  coordinator: Coordinator

  routers: Map<number, Router>
  transports: Map<number, Transport<mediasoup.types.Transport>>

  constructor(worker: mediasoup.types.Worker, coordinator: Coordinator) {
    this.mediasoupWorker = worker;
    this.coordinator = coordinator;

    this.routers = new Map();
    this.transports = new Map();

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
    async ({ routerId, assignedId, isProducer }, ack, nack) => {
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
        const mediasoupTransport = await router.mediasoupRouter.createWebRtcTransport(
          transportOptions);

        // TODO: Handle events emitted by the transport

        // Register this transport
        const transport: WebRtcTransport = {
          id: assignedId, mediasoupTransport, router
        };
        this.transports.set(assignedId, transport);
        if (isProducer) {
          router.webRtcProducerTransports.set(assignedId, transport);
        } else {
          router.webRtcConsumerTransports.set(assignedId, transport);
        }

        // Send back the transport parameters
        ack({
          options: {
            id: mediasoupTransport.id,
            iceParameters: mediasoupTransport.iceParameters,
            iceCandidates: mediasoupTransport.iceCandidates,
            dtlsParameters: mediasoupTransport.dtlsParameters,
          }
        });
      } catch (err: any) {
        nack(err);
      }
    }

  onTransportUpdate: QueueConsumerCallback<"transportUpdateStream"> =
    ({ id, type, payload }, ack, nack) => {
      const transport = this.transports.get(id);
      if (transport === undefined) {
        nack(new Error("transport not found"));
        return;
      }
      
      if (type === "C:transportConnectEvent") {
        const { dtlsParameters } = payload;
        transport.mediasoupTransport.connect({ dtlsParameters })
          .then(() => ack())
          .catch((err) => nack(err));

      } else if (type === "C:transportProducerProduceEvent") {
        const { kind, rtpParameters } = payload;
        transport.mediasoupTransport.produce({ kind, rtpParameters })
          .then((producer) => {
            transport.router.webRtcProducers.set(id, producer);
            // TODO: Handle events like "transportclose"
            ack({ id: producer.id });
          })
          .catch((err) => nack(err));

      } else if (type === "C:transportConsumerConsumeEvent") {
        const { rtpCapabilities, producingTransportId } = payload;
        const producingTransport = this.transports.get(producingTransportId);
        if (producingTransport === undefined) {
          nack(new Error("producing transport not found"));
          return;
        }

        transport.mediasoupTransport.consume({
          producerId: producingTransport.mediasoupTransport.id,
          rtpCapabilities,
          // https://mediasoup.org/documentation/v3/mediasoup/api/#transport-consume
          paused: true,
        })
          .then((consumer) => {
            transport.router.webRtcConsumers.set(id, consumer);
            // TODO: Handle events like "transportclose" and "producerclose"
            ack();
          })
          .catch((err) => nack(err));

      } else if (type === "C:transportConsumerResumeEvent") {
        const consumer = transport.router.webRtcConsumers.get(id);
        if (consumer === undefined) {
          nack(new Error("consumer not found"));
          return;
        }

        consumer.resume()
          .then(() => ack())
          .catch((err) => nack(err));

      } else {
        nack(new Error("unexpected error: unknown transport update type"));
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
      webRtcProducers: new Map(),
      webRtcConsumers: new Map(),
    };
    this.routers.set(assignedRouterId, router);
  }
}

