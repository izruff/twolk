/*

In-memory fake of IMediaWorker. Each transport / producer / consumer is
a plain object that satisfies the port interface; the state machine is
just "fields that get set when methods are called." No RTP, no
processes, no awaits longer than a microtask.

Test code can also reach into the public maps below (`producers`,
`consumers`, `transports`) to assert on what the worker did.

*/

import type {
  IMediaWorker, IMediaRouter, IMediaTransport,
  IMediaProducer, IMediaConsumer,
  MediaKind, RtpCapabilities, RtpParameters,
  DtlsParameters, TransportInitParams,
} from "../media-port.ts";


const FAKE_RTP_CAPABILITIES: RtpCapabilities = {
  codecs: [
    {
      kind: "audio",
      mimeType: "audio/opus",
      preferredPayloadType: 100,
      clockRate: 48000,
      channels: 2,
      parameters: {},
      rtcpFeedback: [],
    } as any,
  ],
  headerExtensions: [],
};

let _idCounter = 0;
function nextId(): string {
  return "fake-" + (_idCounter++).toString(36);
}


export class FakeMediaWorker implements IMediaWorker {
  routers: FakeMediaRouter[] = []
  _diedHandler: ((err: Error) => void) | null = null

  onDied(callback: (err: Error) => void): void {
    this._diedHandler = callback;
  }

  // Test helper — pretend the underlying worker died.
  triggerDied(err: Error = new Error("fake worker died")): void {
    this._diedHandler?.(err);
  }

  async createRouter(): Promise<IMediaRouter> {
    const router = new FakeMediaRouter();
    this.routers.push(router);
    return router;
  }
}


export class FakeMediaRouter implements IMediaRouter {
  rtpCapabilities: RtpCapabilities = FAKE_RTP_CAPABILITIES
  transports: FakeMediaTransport[] = []

  async createWebRtcTransport(): Promise<IMediaTransport> {
    const transport = new FakeMediaTransport(this);
    this.transports.push(transport);
    return transport;
  }
}


export class FakeMediaTransport implements IMediaTransport {
  router: FakeMediaRouter
  params: TransportInitParams

  connectedDtls: DtlsParameters | null = null
  producers: FakeMediaProducer[] = []
  consumers: FakeMediaConsumer[] = []

  constructor(router: FakeMediaRouter) {
    this.router = router;
    this.params = {
      id: nextId(),
      iceParameters: {} as any,
      iceCandidates: [],
      dtlsParameters: {} as any,
    };
  }

  async connect(dtlsParameters: DtlsParameters): Promise<void> {
    this.connectedDtls = dtlsParameters;
  }

  async produce(kind: MediaKind, rtpParameters: RtpParameters): Promise<IMediaProducer> {
    const producer = new FakeMediaProducer(kind, rtpParameters);
    this.producers.push(producer);
    return producer;
  }

  async consume(
    producerId: string,
    rtpCapabilities: RtpCapabilities,
    paused: boolean = false,
  ): Promise<IMediaConsumer> {
    const consumer = new FakeMediaConsumer(producerId, rtpCapabilities, paused);
    this.consumers.push(consumer);
    return consumer;
  }
}


export class FakeMediaProducer implements IMediaProducer {
  id: string
  kind: MediaKind
  rtpParameters: RtpParameters

  constructor(kind: MediaKind, rtpParameters: RtpParameters) {
    this.id = nextId();
    this.kind = kind;
    this.rtpParameters = rtpParameters;
  }
}


export class FakeMediaConsumer implements IMediaConsumer {
  id: string
  producerId: string
  kind: MediaKind = "audio"
  rtpParameters: RtpParameters

  // Test-visible bookkeeping
  paused: boolean
  rtpCapabilitiesUsed: RtpCapabilities

  constructor(producerId: string, rtpCapabilities: RtpCapabilities, paused: boolean) {
    this.id = nextId();
    this.producerId = producerId;
    this.rtpCapabilitiesUsed = rtpCapabilities;
    this.paused = paused;
    this.rtpParameters = {} as any;
  }

  async resume(): Promise<void> {
    this.paused = false;
  }
}
