/*

Implementation of the SFU worker.
- Receives and sends RTP packets from and to client via WebRTC.
- Routes RTP packets between clients in the same space.
- Facilitates transport to other media-related workers.

*/

import { Coordinator, type QueueConsumerCallback, type QueueResponseTypeMap } from "./coordinator.ts";
import { getPublicIpAddress } from "./utils/network.ts";

import mediasoup from "mediasoup";

const MEDIA_CODECS: mediasoup.types.RouterRtpCodecCapability[] = [
  {
    kind: "audio",
    mimeType: "audio/opus",
    clockRate: 48000,
    channels: 2,
  },
]


interface Router {
  id: number;
  mediasoupRouter: mediasoup.types.Router;
  webRtcProducerTransports: Map<number, WebRtcTransport>;
  webRtcConsumerTransports: Map<number, WebRtcTransport>;
  webRtcProducers: Map<number, mediasoup.types.Producer>;
  webRtcConsumers: Map<number, mediasoup.types.Consumer>;
  producerToConsumersSet: Map<number, Set<number>>;
}

interface Transport<T extends mediasoup.types.Transport> {
  id: number;
  mediasoupTransport: T;
  router: Router;
}

type WebRtcTransport = Transport<mediasoup.types.WebRtcTransport>;

interface PendingConsume {
  consumerTransport: WebRtcTransport;
  producingTransport: WebRtcTransport;
  rtpCapabilities: mediasoup.types.RtpCapabilities;
  ack: (resp: QueueResponseTypeMap["transportUpdateStream"]) => void;
  nack: (e: Error) => void;
}


export class SfuWorker {
  mediasoupWorker: mediasoup.types.Worker
  coordinator: Coordinator

  routers: Map<number, Router>
  transports: Map<number, Transport<mediasoup.types.Transport>>

  // Consume requests received before the producing transport has a producer.
  // Keyed by producing transport id; flushed when that producer is created.
  pendingConsumes: Map<number, PendingConsume[]>

  constructor(worker: mediasoup.types.Worker, coordinator: Coordinator) {
    this.mediasoupWorker = worker;
    this.coordinator = coordinator;

    this.routers = new Map();
    this.transports = new Map();
    this.pendingConsumes = new Map();

    this.coordinator.consume("newRouterRequest", this.onNewRouterRequest.bind(this));
    this.coordinator.consume("newWebRtcTransportRequest", this.onNewWebRtcTransportRequest.bind(this));
    this.coordinator.consume("transportUpdateStream", this.onTransportUpdate.bind(this));

    // For debugging; print contents of all maps every 5 seconds
    // setInterval(() => {
    //   console.log("=== SFU Worker State ===");
    //   console.log("Routers:", this.routers);
    //   console.log("Transports:", this.transports);
    // }, 5000);
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

  // TODO: Refactor this so the router handles this logic instead of calling this
  // inside the transport update handler.
  _attemptConsuming<T extends mediasoup.types.Transport>(
    consumerTransport: Transport<T>, producerTransport: Transport<T>,
    rtpCapabilities: mediasoup.types.RtpCapabilities): Promise<mediasoup.types.Consumer | null> {
    // The mediasoup producer has to be already created, and needs to belong to
    // the same router as consumerTransport. If not, return null so the caller
    // can buffer the request until the producer is ready.
    const router = consumerTransport.router;
    if (!router.webRtcProducers.has(producerTransport.id)) {
      return Promise.resolve(null);
    }
    const producer = router.webRtcProducers.get(producerTransport.id)!;
    return consumerTransport.mediasoupTransport.consume({
      producerId: producer.id,
      rtpCapabilities,
      // https://mediasoup.org/documentation/v3/mediasoup/api/#transport-consume
      paused: true,
    })
      .then((consumer) => {
        router.webRtcConsumers.set(consumerTransport.id, consumer);
        // TODO: Handle events like "transportclose" and "producerclose"
        return consumer;
      });
  }

  _consumeAndAck(consumerTransport: WebRtcTransport,
    producingTransport: WebRtcTransport,
    rtpCapabilities: mediasoup.types.RtpCapabilities,
    ack: (resp: QueueResponseTypeMap["transportUpdateStream"]) => void,
    nack: (e: Error) => void) {
    this._attemptConsuming(consumerTransport, producingTransport, rtpCapabilities)
      .then((consumer) => {
        if (consumer === null) {
          nack(new Error("producer disappeared before consume could complete"));
          return;
        }
        ack({
          id: consumer.id,
          producerId: consumer.producerId,
          kind: consumer.kind,
          rtpParameters: consumer.rtpParameters,
        });
      })
      .catch((err) => nack(err));
  }

  onNewRouterRequest: QueueConsumerCallback<"newRouterRequest"> =
    async ({ assignedId }, ack, nack) => {
      try {
        const router = await this.createRouter(assignedId);
        ack({ rtpCapabilities: router.mediasoupRouter.rtpCapabilities });
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
      if (type.startsWith("W:")) return;

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
        console.log(`Received C:transportProducerProduceEvent from transport ${id}:`, payload);
        const { kind, rtpParameters } = payload;
        transport.mediasoupTransport.produce({ kind, rtpParameters })
          .then((producer) => {
            transport.router.webRtcProducers.set(id, producer);

            // TODO: Handle events like "transportclose"
            ack({ id: producer.id });

            // Flush any consume requests that arrived before this producer
            // existed.
            const pending = this.pendingConsumes.get(id);
            if (pending !== undefined) {
              this.pendingConsumes.delete(id);
              pending.forEach((p) => {
                this._consumeAndAck(p.consumerTransport, p.producingTransport,
                  p.rtpCapabilities, p.ack, p.nack);
              });
            }
          })
          .catch((err) => nack(err));

      } else if (type === "C:transportConsumerConsumeEvent") {
        console.log(`Received C:transportConsumerConsumeEvent from transport ${id}:`, payload);
        console.log("Current transports:", this.transports);
        const { rtpCapabilities, producingTransportId } = payload;
        const producingTransport = this.transports.get(producingTransportId);
        if (producingTransport === undefined) {
          nack(new Error("producing transport not found"));
          return;
        }

        if (producingTransport.router !== transport.router) {
          nack(new Error("producing and consuming transport belong to " +
            "different routers"));
          return;
        }

        const map = transport.router.producerToConsumersSet;
        if (!map.has(producingTransportId)) {
          map.set(producingTransportId, new Set());
        }
        map.get(producingTransportId)!.add(id);

        // If the producer for `producingTransportId` hasn't been created yet,
        // buffer this consume request and let the produce handler flush it.
        if (!transport.router.webRtcProducers.has(producingTransportId)) {
          if (!this.pendingConsumes.has(producingTransportId)) {
            this.pendingConsumes.set(producingTransportId, []);
          }
          this.pendingConsumes.get(producingTransportId)!.push({
            consumerTransport: transport as WebRtcTransport,
            producingTransport: producingTransport as WebRtcTransport,
            rtpCapabilities,
            ack,
            nack,
          });
          return;
        }

        this._consumeAndAck(transport as WebRtcTransport,
          producingTransport as WebRtcTransport, rtpCapabilities, ack, nack);
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

  async createRouter(assignedRouterId: number): Promise<Router> {
    // TODO: Not sure what the router options should be
    const mediasoupRouter = await this.mediasoupWorker.createRouter({ mediaCodecs: MEDIA_CODECS });
    const router: Router = {
      id: assignedRouterId,
      mediasoupRouter,
      webRtcProducerTransports: new Map(),
      webRtcConsumerTransports: new Map(),
      webRtcProducers: new Map(),
      webRtcConsumers: new Map(),
      producerToConsumersSet: new Map(),
    };
    this.routers.set(assignedRouterId, router);
    return router;
  }
}

