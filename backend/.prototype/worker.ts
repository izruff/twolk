import type { IMessageBus, QueueConsumerCallback, QueueResponseTypeMap } from "./bus.ts";
import type {
  IMediaWorker, IMediaRouter, IMediaTransport,
  IMediaProducer, IMediaConsumer, RtpCapabilities,
} from "./media-port.ts";


/** Worker-local media router state. */
interface Router {
  id: number;
  mediaRouter: IMediaRouter;
  webRtcProducerTransports: Map<number, WebRtcTransport>;
  webRtcConsumerTransports: Map<number, WebRtcTransport>;
  webRtcProducers: Map<number, IMediaProducer>;
  webRtcConsumers: Map<number, IMediaConsumer>;
  producerToConsumersSet: Map<number, Set<number>>;
}

/** Worker-local WebRTC transport state. */
interface WebRtcTransport {
  id: number;
  mediaTransport: IMediaTransport;
  router: Router;
}

/** Buffered consume request waiting for its producer to exist. */
interface PendingConsume {
  consumerTransport: WebRtcTransport;
  producingTransport: WebRtcTransport;
  rtpCapabilities: RtpCapabilities;
  ack: (resp: QueueResponseTypeMap["transportUpdateStream"]) => void;
  nack: (e: Error) => void;
}


/**
 * SFU worker facade for the prototype bus.
 *
 * This class owns worker-local router, transport, producer, and consumer maps.
 * It consumes messages from the bus targeted to a specific SFU worker and
 * delegates media work to it via the interfaces in `media-port.ts`.
 *
 * TODO: Add worker-side close commands and media event forwarding so
 * coordinator state can react to transport, producer, and consumer closure.
 */
export class SfuWorker {
  workerId: number
  mediaWorker: IMediaWorker
  bus: IMessageBus

  routers: Map<number, Router>
  transports: Map<number, WebRtcTransport>

  /** Consume requests keyed by producing transport ID until a producer exists. */
  pendingConsumes: Map<number, PendingConsume[]>

  /** Cancellation handles for bus subscriptions registered in `start()`. */
  _cancelConsumers: (() => void)[] = []

  /** Deregisters this worker from the bus. */
  _deregisterWorker: (() => void) | null = null

  constructor(workerId: number, mediaWorker: IMediaWorker, bus: IMessageBus) {
    this.workerId = workerId;
    this.mediaWorker = mediaWorker;
    this.bus = bus;

    this.routers = new Map();
    this.transports = new Map();
    this.pendingConsumes = new Map();

    // Announce this worker so RouterAllocator can include it in allocation.
    this._deregisterWorker = bus.registerMediaWorker(workerId);
  }

  /** Registers worker death handling and bus consumers. */
  start(onDied: (err: Error) => void) {
    this.mediaWorker.onDied(onDied);

    this._cancelConsumers.push(
      this.bus.consume("newRouterRequest", this.onNewRouterRequest.bind(this)),
      this.bus.consume("newWebRtcTransportRequest", this.onNewWebRtcTransportRequest.bind(this)),
      this.bus.consume("transportUpdateStream", this.onTransportUpdate.bind(this)),
    );
  }

  // TODO: Move consume creation and buffering to a router-level helper.
  _attemptConsuming(
    consumerTransport: WebRtcTransport,
    producerTransport: WebRtcTransport,
    rtpCapabilities: RtpCapabilities,
  ): Promise<IMediaConsumer | null> {
    // The producer must already exist on the same router. Return null so the
    // caller can buffer the request until production starts.
    const router = consumerTransport.router;
    if (!router.webRtcProducers.has(producerTransport.id)) {
      return Promise.resolve(null);
    }
    const producer = router.webRtcProducers.get(producerTransport.id)!;
    // See https://mediasoup.org/documentation/v3/mediasoup/api/#transport-consume
    return consumerTransport.mediaTransport.consume(producer.id, rtpCapabilities, true)
      .then((consumer) => {
        router.webRtcConsumers.set(consumerTransport.id, consumer);
        // TODO: Handle events like "transportclose" and "producerclose"
        return consumer;
      });
  }

  /** Creates a consumer and acknowledges the original transport update. */
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
    async ({ assignedId, workerId }, ack, nack) => {
      // Each worker handles only requests explicitly assigned to it.
      if (workerId !== this.workerId) return;
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
        // Router belongs to a different worker, so skip silently.
        return;
      }

      try {
        const mediaTransport = await router.mediaRouter.createWebRtcTransport();

        // TODO: Handle events emitted by the transport

        // Register this transport.
        const transport: WebRtcTransport = {
          id: assignedId, mediaTransport, router,
        };
        this.transports.set(assignedId, transport);
        if (isProducer) {
          router.webRtcProducerTransports.set(assignedId, transport);
        } else {
          router.webRtcConsumerTransports.set(assignedId, transport);
        }
        // Send back client transport parameters.
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
        // Transport belongs to a different worker, so skip silently.
        return;
      }

      if (type === "C:transportConnectEvent") {
        const { dtlsParameters } = payload;
        transport.mediaTransport.connect(dtlsParameters)
          .then(() => ack())
          .catch((err) => nack(err));

      } else if (type === "C:transportProducerProduceEvent") {
        const { kind, rtpParameters } = payload;
        transport.mediaTransport.produce(kind, rtpParameters)
          .then((producer) => {
            transport.router.webRtcProducers.set(id, producer);

            // TODO: Handle events like "transportclose"
            ack({ id: producer.id });

            // Flush consume requests that arrived before this producer existed.
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

        // If the producer for `producingTransportId` has not been created yet,
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
