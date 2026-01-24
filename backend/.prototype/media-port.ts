/**
 * Media-layer port used by `SfuWorker`.
 *
 * This boundary describes only the media operations the worker needs:
 * creating routers, creating WebRTC transports, producing media, consuming
 * media, and resuming consumers. Runtime details such as mediasoup worker
 * options, listen IPs, codecs, and port ranges stay inside the adapter.
 *
 * TODO(mediasoup-decoupling): In addition to encapsulating the `mediasoup`-specific logic, the types
 * defined here should also be decoupled from `mediasoup`.
 *
 * TODO: We should investigate whether a function to resume a consumer is
 * necessary, or if this is a quirk of `mediasoup` transports.
 */

import type mediasoup from "mediasoup";

/** Media kind accepted by the underlying SFU implementation. */
export type MediaKind = mediasoup.types.MediaKind;

/** Router RTP capabilities sent to the browser client. */
export type RtpCapabilities = mediasoup.types.RtpCapabilities;

/** RTP parameters supplied by the browser client when producing media. */
export type RtpParameters = mediasoup.types.RtpParameters;

/** DTLS parameters used to connect a WebRTC transport. */
export type DtlsParameters = mediasoup.types.DtlsParameters;

/** ICE parameters needed to initialize a browser transport. */
export type IceParameters = mediasoup.types.IceParameters;

/** ICE candidate needed to initialize a browser transport. */
export type IceCandidate = mediasoup.types.IceCandidate;


/** Parameters the client needs to create its own mediasoup-client transport. */
export interface TransportInitParams {
  id: string;
  iceParameters: IceParameters;
  iceCandidates: IceCandidate[];
  dtlsParameters: DtlsParameters;
}

/** Produced media source created by a WebRTC transport. */
export interface IMediaProducer {
  readonly id: string;
}

/** Media consumer created for a member that subscribes to a producer. */
export interface IMediaConsumer {
  readonly id: string;
  readonly producerId: string;
  readonly kind: MediaKind;
  readonly rtpParameters: RtpParameters;

  /** Resumes forwarding media to the consumer. */
  resume(): Promise<void>;
}

/** WebRTC transport abstraction owned by a media router. */
export interface IMediaTransport {
  readonly params: TransportInitParams;

  /** Applies remote DTLS parameters and connects the transport. */
  connect(dtlsParameters: DtlsParameters): Promise<void>;

  /** Starts producing media on this transport. */
  produce(kind: MediaKind, rtpParameters: RtpParameters): Promise<IMediaProducer>;

  /** Creates a consumer for a producer reachable from this transport. */
  consume(
    producerId: string,
    rtpCapabilities: RtpCapabilities,
    paused?: boolean,
  ): Promise<IMediaConsumer>;
}

/** Media router abstraction for one coordinator router allocation. */
export interface IMediaRouter {
  readonly rtpCapabilities: RtpCapabilities;

  /** Creates a WebRTC transport on this router. */
  createWebRtcTransport(): Promise<IMediaTransport>;
}

/** Media worker abstraction wrapping the actual SFU worker process. */
export interface IMediaWorker {
  /** Creates a new media router. */
  createRouter(): Promise<IMediaRouter>;

  /** Registers a callback for worker death. */
  onDied(callback: (err: Error) => void): void;
}
