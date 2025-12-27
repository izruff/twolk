/*

Implementation of the SFU worker.
- Receives and sends RTP packets from and to client via WebRTC.
- Routes RTP packets between clients in the same space.
- Facilitates transport to other media-related workers.

The worker no longer talks to mediasoup directly. Everything goes
through the IMediaWorker / IMediaRouter / IMediaTransport / IMediaProducer
/ IMediaConsumer port; the runtime implementation (currently mediasoup,
eventually a hand-rolled SFU) is selected by the composition root.

*/

import type { IMessageBus, QueueConsumerCallback, QueueResponseTypeMap } from "./bus.ts";
import type {
  IMediaWorker, IMediaRouter, IMediaTransport,
  IMediaProducer, IMediaConsumer, RtpCapabilities,
} from "./media-port.ts";


interface Router {
  id: number;
  mediaRouter: IMediaRouter;
  webRtcProducerTransports: Map<number, WebRtcTransport>;
  webRtcConsumerTransports: Map<number, WebRtcTransport>;
  webRtcProducers: Map<number, IMediaProducer>;
  webRtcConsumers: Map<number, IMediaConsumer>;
  producerToConsumersSet: Map<number, Set<number>>;
}

interface WebRtcTransport {
  id: number;
  mediaTransport: IMediaTransport;
  router: Router;
}

interface PendingConsume {
  consumerTransport: WebRtcTransport;
  producingTransport: WebRtcTransport;
  rtpCapabilities: RtpCapabilities;
  ack: (resp: QueueResponseTypeMap["transportUpdateStream"]) => void;
  nack: (e: Error) => void;
}


export class SfuWorker {
  mediaWorker: IMediaWorker
  bus: IMessageBus

  routers: Map<number, Router>
  transports: Map<number, WebRtcTransport>

  // Consume requests received before the producing transport has a producer.
  // Keyed by producing transport id; flushed when that producer is created.
  pendingConsumes: Map<number, PendingConsume[]>

  // Cancellation handles for the bus subscriptions registered in start().
  _cancelConsumers: (() => void)[] = []

  constructor(mediaWorker: IMediaWorker, bus: IMessageBus) {
    this.mediaWorker = mediaWorker;
    this.bus = bus;

    this.routers = new Map();
    this.transports = new Map();
    this.pendingConsumes = new Map();
  }

  // Wires the death handler and registers bus consumers. Must be called
  // once after construction; the worker is inert until then.
  start(onDied: (err: Error) => void) {
    this.mediaWorker.onDied(onDied);

    this._cancelConsumers.push(
      this.bus.consume("newRouterRequest", this.onNewRouterRequest.bind(this)),
      this.bus.consume("newWebRtcTransportRequest", this.onNewWebRtcTransportRequest.bind(this)),
      this.bus.consume("transportUpdateStream", this.onTransportUpdate.bind(this)),
    );

    // For debugging; print contents of all maps every 5 seconds
    // setInterval(() => {
    //   console.log("=== SFU Worker State ===");
    //   console.log("Routers:", this.routers);
    //   console.log("Transports:", this.transports);
    // }, 5000);
  }

  // TODO: Refactor this so the router handles this logic instead of calling this
  // inside the transport update handler.
  _attemptConsuming(
    consumerTransport: WebRtcTransport,
    producerTransport: WebRtcTransport,
    rtpCapabilities: RtpCapabilities,
  ): Promise<IMediaConsumer | null> {
    // The producer has to be already created and belong to the same router
    // as consumerTransport. If not, return null so the caller can buffer
    // the request until the producer is ready.
    const router = consumerTransport.router;
    if (!router.webRtcProducers.has(producerTransport.id)) {
      return Promise.resolve(null);
    }
    const producer = router.webRtcProducers.get(producerTransport.id)!;
    // https://mediasoup.org/documentation/v3/mediasoup/api/#transport-consume
    return consumerTransport.mediaTransport.consume(producer.id, rtpCapabilities, true)
      .then((consumer) => {
        router.webRtcConsumers.set(consumerTransport.id, consumer);
        // TODO: Handle events like "transportclose" and "producerclose"
        return consumer;
      });
  }

  _consumeAndAck(consumerTransport: WebRtcTransport,
    producingTransport: WebRtcTransport,
    rtpCapabilities: RtpCapabilities,
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
        ack({ rtpCapabilities: router.mediaRouter.rtpCapabilities });
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
        const mediaTransport = await router.mediaRouter.createWebRtcTransport();

        // TODO: Handle events emitted by the transport

        // Register this transport
        const transport: WebRtcTransport = {
          id: assignedId, mediaTransport, router,
        };
        this.transports.set(assignedId, transport);
        if (isProducer) {
          router.webRtcProducerTransports.set(assignedId, transport);
        } else {
          router.webRtcConsumerTransports.set(assignedId, transport);
        }
        // Send back the transport parameters
        ack({ options: mediaTransport.params });
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
        transport.mediaTransport.connect(dtlsParameters)
          .then(() => ack())
          .catch((err) => nack(err));

      } else if (type === "C:transportProducerProduceEvent") {
        console.log(`Received C:transportProducerProduceEvent from transport ${id}:`, payload);
        const { kind, rtpParameters } = payload;
        transport.mediaTransport.produce(kind, rtpParameters)
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
            consumerTransport: transport,
            producingTransport: producingTransport,
            rtpCapabilities,
            ack,
            nack,
          });
          return;
        }

        this._consumeAndAck(transport, producingTransport, rtpCapabilities, ack, nack);
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
    const mediaRouter = await this.mediaWorker.createRouter();
    const router: Router = {
      id: assignedRouterId,
      mediaRouter,
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
