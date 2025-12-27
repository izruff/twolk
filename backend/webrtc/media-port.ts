/*

Media-layer port. Describes only what `SfuWorker` needs from whatever
SFU implementation sits underneath it — so the worker can be unit-tested
against a fake adapter, and so a future hand-rolled SFU can drop in
without touching the worker.

Notes:
- The data types (RtpCapabilities, DtlsParameters, …) keep their
  mediasoup shape because they ARE the wire format the browser-side
  mediasoup-client expects. Re-declaring them here would just duplicate
  shapes that have to stay byte-compatible anyway; the `import type`
  carries zero runtime cost.
- Mediasoup-specific construction options (`listenIps`, `enableUdp`,
  port range, codecs, etc.) deliberately do NOT appear on the port —
  they live inside the adapter.

*/

import type mediasoup from "mediasoup";

export type MediaKind = mediasoup.types.MediaKind;
export type RtpCapabilities = mediasoup.types.RtpCapabilities;
export type RtpParameters = mediasoup.types.RtpParameters;
export type DtlsParameters = mediasoup.types.DtlsParameters;
export type IceParameters = mediasoup.types.IceParameters;
export type IceCandidate = mediasoup.types.IceCandidate;


// What the client needs to set up its own mediasoup-client transport.
export interface TransportInitParams {
  id: string;
  iceParameters: IceParameters;
  iceCandidates: IceCandidate[];
  dtlsParameters: DtlsParameters;
}

export interface IMediaProducer {
  readonly id: string;
}

export interface IMediaConsumer {
  readonly id: string;
  readonly producerId: string;
  readonly kind: MediaKind;
  readonly rtpParameters: RtpParameters;
  resume(): Promise<void>;
}

export interface IMediaTransport {
  readonly params: TransportInitParams;
  connect(dtlsParameters: DtlsParameters): Promise<void>;
  produce(kind: MediaKind, rtpParameters: RtpParameters): Promise<IMediaProducer>;
  consume(
    producerId: string,
    rtpCapabilities: RtpCapabilities,
    paused?: boolean,
  ): Promise<IMediaConsumer>;
}

export interface IMediaRouter {
  readonly rtpCapabilities: RtpCapabilities;
  createWebRtcTransport(): Promise<IMediaTransport>;
}

export interface IMediaWorker {
  createRouter(): Promise<IMediaRouter>;
  onDied(callback: (err: Error) => void): void;
}
