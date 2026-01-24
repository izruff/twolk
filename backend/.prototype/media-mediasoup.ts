/**
 * `mediasoup` implementation of the media-layer port.
 */

import mediasoup from "mediasoup";

import type {
  IMediaWorker, IMediaRouter, IMediaTransport,
  IMediaProducer, IMediaConsumer,
  MediaKind, RtpCapabilities, RtpParameters,
  DtlsParameters, TransportInitParams,
} from "./media-port.ts";
import { getPublicIpAddress } from "./utils/network.ts";


/** Audio codecs enabled for every mediasoup router in the prototype. */
const MEDIA_CODECS: mediasoup.types.RouterRtpCodecCapability[] = [
  {
    kind: "audio",
    mimeType: "audio/opus",
    clockRate: 48000,
    channels: 2,
  },
];


/** Wraps a mediasoup worker as an `IMediaWorker`. */
export class MediasoupMediaWorker implements IMediaWorker {
  worker: mediasoup.types.Worker

  constructor(worker: mediasoup.types.Worker) {
    this.worker = worker;
  }

  /** Creates a mediasoup worker constrained to the configured RTC port range. */
  static async create(
    rtcPortRange: { min: number, max: number },
  ): Promise<MediasoupMediaWorker> {
    const worker = await mediasoup.createWorker({
      rtcMinPort: rtcPortRange.min,
      rtcMaxPort: rtcPortRange.max,
    });
    return new MediasoupMediaWorker(worker);
  }

  /** Registers a callback for mediasoup worker death. */
  onDied(callback: (err: Error) => void): void {
    this.worker.on("died", callback);
  }

  /** Creates a mediasoup router with the prototype media codecs. */
  async createRouter(): Promise<IMediaRouter> {
    const router = await this.worker.createRouter({ mediaCodecs: MEDIA_CODECS });
    return new MediasoupRouterAdapter(router);
  }
}


/** Wraps a mediasoup router as an `IMediaRouter`. */
class MediasoupRouterAdapter implements IMediaRouter {
  router: mediasoup.types.Router

  constructor(router: mediasoup.types.Router) {
    this.router = router;
  }

  /** Router RTP capabilities forwarded to browser-side mediasoup-client. */
  get rtpCapabilities(): RtpCapabilities {
    return this.router.rtpCapabilities;
  }

  /** Creates a WebRTC transport with prototype ICE and transport settings. */
  async createWebRtcTransport(): Promise<IMediaTransport> {
    const transport = await this.router.createWebRtcTransport({
      listenIps: [
        {
          ip: "0.0.0.0",
          announcedIp: await getPublicIpAddress(),
        },
      ],
      enableUdp: true,
      enableTcp: true,
      preferUdp: true,
    });
    return new MediasoupTransportAdapter(transport);
  }
}


/** Wraps a mediasoup WebRTC transport as an `IMediaTransport`. */
class MediasoupTransportAdapter implements IMediaTransport {
  transport: mediasoup.types.WebRtcTransport

  constructor(transport: mediasoup.types.WebRtcTransport) {
    this.transport = transport;
  }

  /** Client transport initialization parameters. */
  get params(): TransportInitParams {
    return {
      id: this.transport.id,
      iceParameters: this.transport.iceParameters,
      iceCandidates: this.transport.iceCandidates,
      dtlsParameters: this.transport.dtlsParameters,
    };
  }

  /** Connects the mediasoup transport with remote DTLS parameters. */
  async connect(dtlsParameters: DtlsParameters): Promise<void> {
    await this.transport.connect({ dtlsParameters });
  }

  /** Creates a mediasoup producer on this transport. */
  async produce(kind: MediaKind, rtpParameters: RtpParameters): Promise<IMediaProducer> {
    const producer = await this.transport.produce({ kind, rtpParameters });
    return new MediasoupProducerAdapter(producer);
  }

  /** Creates a mediasoup consumer on this transport. */
  async consume(
    producerId: string,
    rtpCapabilities: RtpCapabilities,
    paused: boolean = false,
  ): Promise<IMediaConsumer> {
    const consumer = await this.transport.consume({
      producerId,
      rtpCapabilities,
      paused,
    });
    return new MediasoupConsumerAdapter(consumer);
  }
}


/** Wraps a mediasoup producer as an `IMediaProducer`. */
class MediasoupProducerAdapter implements IMediaProducer {
  producer: mediasoup.types.Producer

  constructor(producer: mediasoup.types.Producer) {
    this.producer = producer;
  }

  /** Mediasoup producer ID. */
  get id(): string {
    return this.producer.id;
  }
}


/** Wraps a mediasoup consumer as an `IMediaConsumer`. */
class MediasoupConsumerAdapter implements IMediaConsumer {
  consumer: mediasoup.types.Consumer

  constructor(consumer: mediasoup.types.Consumer) {
    this.consumer = consumer;
  }

  /** Mediasoup consumer ID. */
  get id(): string {
    return this.consumer.id;
  }

  /** Producer ID consumed by this consumer. */
  get producerId(): string {
    return this.consumer.producerId;
  }

  /** Media kind consumed by this consumer. */
  get kind(): MediaKind {
    return this.consumer.kind;
  }

  /** RTP parameters forwarded to the browser client. */
  get rtpParameters(): RtpParameters {
    return this.consumer.rtpParameters;
  }

  /** Resumes this mediasoup consumer. */
  async resume(): Promise<void> {
    await this.consumer.resume();
  }
}
