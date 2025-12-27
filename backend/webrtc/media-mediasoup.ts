/*

Mediasoup adapter for the media-layer port. Wraps the mediasoup server
SDK so `SfuWorker` only sees `IMediaWorker` / `IMediaRouter` / etc.

All mediasoup-specific config (listen IPs, codecs, port range, ICE
preferences) is contained here. The port surface has none of it.

*/

import mediasoup from "mediasoup";

import type {
  IMediaWorker, IMediaRouter, IMediaTransport,
  IMediaProducer, IMediaConsumer,
  MediaKind, RtpCapabilities, RtpParameters,
  DtlsParameters, TransportInitParams,
} from "./media-port.ts";
import { getPublicIpAddress } from "./utils/network.ts";


const MEDIA_CODECS: mediasoup.types.RouterRtpCodecCapability[] = [
  {
    kind: "audio",
    mimeType: "audio/opus",
    clockRate: 48000,
    channels: 2,
  },
];


export class MediasoupMediaWorker implements IMediaWorker {
  worker: mediasoup.types.Worker

  constructor(worker: mediasoup.types.Worker) {
    this.worker = worker;
  }

  static async create(
    rtcPortRange: { min: number, max: number },
  ): Promise<MediasoupMediaWorker> {
    const worker = await mediasoup.createWorker({
      rtcMinPort: rtcPortRange.min,
      rtcMaxPort: rtcPortRange.max,
    });
    return new MediasoupMediaWorker(worker);
  }

  onDied(callback: (err: Error) => void): void {
    this.worker.on("died", callback);
  }

  async createRouter(): Promise<IMediaRouter> {
    const router = await this.worker.createRouter({ mediaCodecs: MEDIA_CODECS });
    return new MediasoupRouterAdapter(router);
  }
}


class MediasoupRouterAdapter implements IMediaRouter {
  router: mediasoup.types.Router

  constructor(router: mediasoup.types.Router) {
    this.router = router;
  }

  get rtpCapabilities(): RtpCapabilities {
    return this.router.rtpCapabilities;
  }

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


class MediasoupTransportAdapter implements IMediaTransport {
  transport: mediasoup.types.WebRtcTransport

  constructor(transport: mediasoup.types.WebRtcTransport) {
    this.transport = transport;
  }

  get params(): TransportInitParams {
    return {
      id: this.transport.id,
      iceParameters: this.transport.iceParameters,
      iceCandidates: this.transport.iceCandidates,
      dtlsParameters: this.transport.dtlsParameters,
    };
  }

  async connect(dtlsParameters: DtlsParameters): Promise<void> {
    await this.transport.connect({ dtlsParameters });
  }

  async produce(kind: MediaKind, rtpParameters: RtpParameters): Promise<IMediaProducer> {
    const producer = await this.transport.produce({ kind, rtpParameters });
    return new MediasoupProducerAdapter(producer);
  }

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


class MediasoupProducerAdapter implements IMediaProducer {
  producer: mediasoup.types.Producer

  constructor(producer: mediasoup.types.Producer) {
    this.producer = producer;
  }

  get id(): string {
    return this.producer.id;
  }
}


class MediasoupConsumerAdapter implements IMediaConsumer {
  consumer: mediasoup.types.Consumer

  constructor(consumer: mediasoup.types.Consumer) {
    this.consumer = consumer;
  }

  get id(): string {
    return this.consumer.id;
  }

  get producerId(): string {
    return this.consumer.producerId;
  }

  get kind(): MediaKind {
    return this.consumer.kind;
  }

  get rtpParameters(): RtpParameters {
    return this.consumer.rtpParameters;
  }

  async resume(): Promise<void> {
    await this.consumer.resume();
  }
}
