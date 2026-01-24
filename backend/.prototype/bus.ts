/**
 * Message bus port and in-process adapter for prototype services.
 *
 * The message bus allows initiation and simulation of inter-service
 * communication. It simulates communication with a publish-subscribe pattern
 * that synchronously invokes consumer callbacks followed by ack/nack.
 * Pub-sub queues with their payload and response formats are declared here,
 * as they are the bus wire contract between services.
 *
 * `InProcessBus` is a single-threaded in-memory bus implementation for
 * this prototype. This is only suitable for prototyping; a real implementation
 * would use existing protocols and infrastructure, in particular gRPC and a
 * message broker.
 *
 * The design of the bus interface reflects the asynchronous and decoupled
 * nature of a real messaging network. Using this queue pattern not only
 * induces this property, but also resembles the protocols and APIs of gRPC and
 * message brokers, which will ease development later on.
 *
 * Note that there is currently no standardized format for implementing
 * queue types and their payload/response shapes. A queue may be used for more
 * than one related operations or used in both directions. The bus also cannot
 * selectively fan out messages; if this is a requirement, each consumer must
 * filter messages by some target ID or enum field in the payload.
 *
 * TODO(mediasoup-decoupling): A lot of the types here still depend on
 * `mediasoup`. We need to decouple them and use the types which will be
 * defined in `media-port.ts` in the future.
 *
 * @module
 */

import type mediasoup from "mediasoup";
import type mediasoupClient from "mediasoup-client";

import type {
  SpaceData, SpaceStatus, MemberData, MemberState, ClientSideSpace
} from "./domain.ts";


/**
 * Payload shape for each bus queue.
 */
export type QueuePayloadTypeMap = {
  /** HTTP request to create a coordinator-side space. */
  createSpaceRequest: {
    data: SpaceData,
    policyType: string,
  };
  /** HTTP request to read public state for a coordinator-side space. */
  readSpaceRequest: {
    uuid: string,
  };
  /** Coordinator request for one assigned worker to create a media router. */
  newRouterRequest: {
    assignedId: number,
    workerId: number,
  };
  /** Coordinator request for the worker owning a router to create a transport. */
  newWebRtcTransportRequest: {
    routerId: number,
    assignedId: number,
    isProducer: boolean,
  };
  /** Signaling server request to mirror and subscribe to a coordinator-side space. */
  subscribeToSpaceRequest: {
    serverId: number,
    uuid: string,
  };
  /** Signaling server request to add a member to a coordinator-side space. */
  addMemberRequest: {
    serverId: number,
    spaceUuid: string,
    memberData: MemberData,
    memberState: MemberState,
  };
  /** Signaling server request to remove a member from a coordinator-side space. */
  removeMemberRequest: {
    id: number,
  }
  /** Signaling server request to stop mirroring a coordinator-side space. */
  unsubscribeFromSpaceRequest: {
    serverId: number,
    uuid: string,
  };
  /** HTTP request to pre-allocate a signaling server for a joining client. */
  tryJoinSpaceRequest: {
    spaceUuid: string,
  };
  /** Bidirectional update stream between signaling servers and coordinator. */
  spaceUpdateStream: { uuid: string } & {
    [K in SpaceUpdateTypes]: { type: K; payload: SpaceUpdatePayloadTypeMap[K] }
  }[SpaceUpdateTypes];
  /** Bidirectional update stream between coordinator and SFU workers. */
  transportUpdateStream: { id: number } & {
    [K in TransportUpdateTypes]: { type: K; payload: TransportUpdatePayloadTypeMap[K] }
  }[TransportUpdateTypes];
}

/**
 * Response shape for each bus queue, used as the single parameter for ack
 * callbacks in that queue.
 *
 * A `void` response simply means no parameters are expected for the ack;
 * the consumer still has to call `ack()`.
 */
export type QueueResponseTypeMap = {
  /** Space creation response with the assigned UUID. */
  createSpaceRequest: {
    uuid: string,
  };
  /** Public space metadata and lifecycle state. */
  readSpaceRequest: {
    data: SpaceData,
    status: SpaceStatus,
  };
  /** Media router capabilities returned by the assigned SFU worker. */
  newRouterRequest: {
    rtpCapabilities: mediasoup.types.RtpCapabilities,
  };
  /** Transport initialization parameters returned by the SFU worker. */
  newWebRtcTransportRequest: {
    options: mediasoupClient.types.TransportOptions,
  };
  /** Current client-facing space state returned to a subscribing server. */
  subscribeToSpaceRequest: {
    clientSideSpace: ClientSideSpace;
    routerRtpCapabilities: mediasoup.types.RtpCapabilities;
  };
  /** Member creation response with the assigned member ID. */
  addMemberRequest: {
    id: number,
  };
  removeMemberRequest: void;
  unsubscribeFromSpaceRequest: void;
  /** Signaling server URL assigned to a joining client. */
  tryJoinSpaceRequest: {
    serverUrl: string,
  };
  /** Optional media data returned for produce and consume client acks. */
  // TODO: It is a good idea to rethink this design; we cannot easily enforce
  // the presence of these optional fields for each relevant event type, and
  // it is not very scalable.
  spaceUpdateStream: void | {
    id: string,
    producerId?: string,
    kind?: mediasoup.types.MediaKind,
    rtpParameters?: mediasoup.types.RtpParameters,
  };
  transportUpdateStream: void | {
    id: string,
    producerId?: string,
    kind?: mediasoup.types.MediaKind,
    rtpParameters?: mediasoup.types.RtpParameters,
  };
}

/** Queue names present in both payload and response contracts. */
export type QueueTypes = keyof QueuePayloadTypeMap & keyof QueueResponseTypeMap;

/** Consumer callback registered for one queue. */
export type QueueConsumerCallback<K extends QueueTypes> = (
  payload: QueuePayloadTypeMap[K], ack: (resp: QueueResponseTypeMap[K]) => void, nack: (e: Error) => void
) => void;

type QueueConsumerCallbackCollection = {
  [K in QueueTypes]: Set<QueueConsumerCallback<K>>;
};


/**
 * Space update payloads sent from signaling servers to the coordinator.
 */
export type SpaceUpdateSPayloadTypeMap = {
  /** Connects a member producer transport. */
  "S:memberProducerConnectEvent": {
    memberId: number,
    data: {
      dtlsParameters: mediasoup.types.DtlsParameters,
    },
  };
  /** Starts producing media on a member producer transport. */
  "S:memberProducerProduceEvent": {
    memberId: number,
    data: {
      kind: mediasoup.types.MediaKind,
      rtpParameters: mediasoup.types.RtpParameters,
    },
  };
  /** Connects a member consumer transport to a source member. */
  "S:memberConsumerConnectEvent": {
    memberId: number,
    data: {
      dtlsParameters: mediasoup.types.DtlsParameters,
      sourceMemberId: number,
    },
  };
  /** Starts consuming media from a source member. */
  "S:memberConsumerConsumeEvent": {
    memberId: number,
    data: {
      rtpCapabilities: mediasoup.types.RtpCapabilities,
      sourceMemberId: number,
    },
  };
  /**
   * Resumes a paused consumer.
   *
   * @see https://mediasoup.org/documentation/v3/mediasoup/api/#transport-consume
   */
  "S:memberConsumerResumeEvent": {
    memberId: number,
    data: {
      sourceMemberId: number,
    },
  };
};

/**
 * Space update payloads sent from the coordinator to signaling servers.
 */
export type SpaceUpdateCPayloadTypeMap = {
  /** Provides transport initialization parameters to the owning client. */
  "C:transportParamsEvent": {
    memberId: number,
    consumesFromMemberId?: number,
    options: mediasoupClient.types.TransportOptions,
  };
  /** Announces that a producer has connected and can be consumed. */
  "C:producerConnectedEvent": {
    memberId: number,
  };
};

/**
 * Combined space update payload map.
 *
 * The `S:` prefix marks events originating from signaling servers, while
 * the `C:` prefix marks events originating from the coordinator.
 */
export type SpaceUpdatePayloadTypeMap =
  SpaceUpdateSPayloadTypeMap & SpaceUpdateCPayloadTypeMap;

/** Space update types sent from signaling servers to the coordinator. */
export type SpaceUpdateSTypes = keyof SpaceUpdateSPayloadTypeMap;

/** Space update types sent from the coordinator to signaling servers. */
export type SpaceUpdateCTypes = keyof SpaceUpdateCPayloadTypeMap;

/** All space update types. */
export type SpaceUpdateTypes = keyof SpaceUpdatePayloadTypeMap;


/**
 * Transport update payloads sent from SFU workers to the coordinator.
 *
 * TODO: Add worker-originated close and failure events.
 */
export type TransportUpdateWPayloadTypeMap = {
};

/**
 * Transport update payloads sent from the coordinator to SFU workers.
 */
export type TransportUpdateCPayloadTypeMap = {
  /** Connects a producer or consumer transport using remote DTLS parameters. */
  "C:transportConnectEvent": {
    dtlsParameters: mediasoup.types.DtlsParameters,
  };
  /** Starts producing media on a producer transport. */
  "C:transportProducerProduceEvent": {
    kind: mediasoup.types.MediaKind,
    rtpParameters: mediasoup.types.RtpParameters,
  };
  /** Starts consuming media from an existing producer transport. */
  "C:transportConsumerConsumeEvent": {
    rtpCapabilities: mediasoup.types.RtpCapabilities,
    producingTransportId: number,
  };
  /**
   * Resumes a paused consumer.
   *
   * @see https://mediasoup.org/documentation/v3/mediasoup/api/#transport-consume
   */
  "C:transportConsumerResumeEvent": {};
};

/**
 * Combined transport update payload map.
 * The `W:` prefix marks events originating from SFU workers, while
 * the `C:` prefix marks events originating from the coordinator. Note that
 * currently there are no worker-originated events.
 */
export type TransportUpdatePayloadTypeMap =
  TransportUpdateWPayloadTypeMap & TransportUpdateCPayloadTypeMap;

/** Transport update types sent from SFU workers to the coordinator. */
export type TransportUpdateWTypes = keyof TransportUpdateWPayloadTypeMap;

/** Transport update types sent from the coordinator to SFU workers. */
export type TransportUpdateCTypes = keyof TransportUpdateCPayloadTypeMap;

/** All transport update types. */
export type TransportUpdateTypes = keyof TransportUpdatePayloadTypeMap;


/**
 * Bidirectional message bus between prototype services.
 *
 * Consumers attach to named queues through `consume()` and respond by calling
 * `ack()` or `nack()`. Calling `consume()` for each consumer-queue pair is
 * meant to be done once at setup.
 *
 * The act of establishing a connection between the coordinator and another
 * service is imitated through dedicated registration and subscription methods.
 * These methods each return a cancellation function that the caller should
 * call when a disconnection occurs.
 *
 * Publishers fan out to every current consumer of a queue, each calling the
 * same ack/nack callbacks passed to `publish()`.
 */
export interface IMessageBus {
  /** Subscribes to a queue and returns a cancellation function. */
  consume<K extends QueueTypes>(
    queueName: K, callback: QueueConsumerCallback<K>
  ): (() => void);

  /** Publishes a payload to all current consumers of a queue. */
  publish<K extends QueueTypes>(
    queueName: K, payload: QueuePayloadTypeMap[K],
    onAck: (resp: QueueResponseTypeMap[K]) => void,
    onNack: (e: Error) => void,
  ): void;

  /** Registers a signaling server. */
  registerSignalingServer(serverId: number, serverUrl: string): () => void;

  /** Subscribes to signaling server registration events. */
  onSignalingServerConnected(cb: (serverId: number, serverUrl: string) => void): () => void;

  /** Subscribes to signaling server deregistration events. */
  onSignalingServerDisconnected(cb: (serverId: number) => void): () => void;

  /** Registers an SFU worker. */
  registerMediaWorker(workerId: number): () => void;

  /** Subscribes to SFU worker registration events. */
  onMediaWorkerConnected(cb: (workerId: number) => void): () => void;

  /** Subscribes to SFU worker deregistration events. */
  onMediaWorkerDisconnected(cb: (workerId: number) => void): () => void;
}


/**
 * In-process `IMessageBus` adapter.
 *
 * The adapter holds one callback set per queue and synchronously invokes every
 * current consumer during `publish`. This models service messaging without
 * adding a real broker to the prototype.
 */
export class InProcessBus implements IMessageBus {
  /** Registered consumers grouped by queue name. */
  queueConsumerCallbacks: QueueConsumerCallbackCollection;

  private _serverConnectedCbs = new Set<(id: number, url: string) => void>();
  private _serverDisconnectedCbs = new Set<(id: number) => void>();
  private _workerConnectedCbs = new Set<(id: number) => void>();
  private _workerDisconnectedCbs = new Set<(id: number) => void>();

  constructor() {
    // TODO: Automate these set instantiations from the queue type map.
    this.queueConsumerCallbacks = {
      createSpaceRequest: new Set(),
      readSpaceRequest: new Set(),
      newRouterRequest: new Set(),
      newWebRtcTransportRequest: new Set(),
      subscribeToSpaceRequest: new Set(),
      addMemberRequest: new Set(),
      removeMemberRequest: new Set(),
      unsubscribeFromSpaceRequest: new Set(),
      tryJoinSpaceRequest: new Set(),
      spaceUpdateStream: new Set(),
      transportUpdateStream: new Set(),
    };
  }

  consume<K extends QueueTypes>(
    queueName: K, callback: QueueConsumerCallback<K>
  ): (() => void) {
    const callbackSet = this.queueConsumerCallbacks[queueName];
    callbackSet.add(callback);

    const cancelCallback = () => {
      callbackSet.delete(callback);
    };
    return cancelCallback;
  }

  publish<K extends QueueTypes>(
    queueName: K, payload: QueuePayloadTypeMap[K],
    onAck: (resp: QueueResponseTypeMap[K]) => void,
    onNack: (e: Error) => void,
  ) {
    this.queueConsumerCallbacks[queueName].forEach((callback) => {
      callback(payload, onAck, onNack);
    });
  }

  registerSignalingServer(serverId: number, serverUrl: string): () => void {
    this._serverConnectedCbs.forEach((cb) => cb(serverId, serverUrl));
    return () => {
      this._serverDisconnectedCbs.forEach((cb) => cb(serverId));
    };
  }

  onSignalingServerConnected(cb: (id: number, url: string) => void): () => void {
    this._serverConnectedCbs.add(cb);
    return () => { this._serverConnectedCbs.delete(cb); };
  }

  onSignalingServerDisconnected(cb: (id: number) => void): () => void {
    this._serverDisconnectedCbs.add(cb);
    return () => { this._serverDisconnectedCbs.delete(cb); };
  }

  registerMediaWorker(workerId: number): () => void {
    this._workerConnectedCbs.forEach((cb) => cb(workerId));
    return () => {
      this._workerDisconnectedCbs.forEach((cb) => cb(workerId));
    };
  }

  onMediaWorkerConnected(cb: (id: number) => void): () => void {
    this._workerConnectedCbs.add(cb);
    return () => { this._workerConnectedCbs.delete(cb); };
  }

  onMediaWorkerDisconnected(cb: (id: number) => void): () => void {
    this._workerDisconnectedCbs.add(cb);
    return () => { this._workerDisconnectedCbs.delete(cb); };
  }
}
