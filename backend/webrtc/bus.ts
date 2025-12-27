/*

Message bus port and in-process adapter.

This is the seam between services (signaling server, coordinator, SFU worker).
Today everything runs in one process and `InProcessBus` is a glorified
callback registry. Later this same `IMessageBus` shape can sit in front of
gRPC bidirectional streams without any caller needing to change.

The wire contracts (`QueuePayloadTypeMap`, `QueueResponseTypeMap`, the
`SpaceUpdate*` and `TransportUpdate*` discriminated unions) live here too —
they describe what travels over the bus, independent of who's on either end.

*/

import type mediasoup from "mediasoup";
import type mediasoupClient from "mediasoup-client";

import type {
  MemberData, MemberState, ClientSideSpace
} from "./coordinator.ts";


// Most of these should have a message tag if we want to have more than one
// signaling server or SFU worker, but we only use one for now, so no tags
// needed.
// TODO: The payloads for the result queues all assume that they never fail.
// Currently, if something fails, the worker or signaling server throws an
// error or process exits.
export type QueuePayloadTypeMap = {
  // Requests from coordinator to create a new router for a space
  newRouterRequest: {
    assignedId: number,
  };
  newWebRtcTransportRequest: {
    routerId: number,
    assignedId: number,
    isProducer: boolean,
  };
  subscribeToSpaceRequest: {
    uuid: string,
  };
  addMemberRequest: {
    spaceUuid: string,
    memberData: MemberData,
    memberState: MemberState,
  };
  removeMemberRequest: {
    id: number,
  }
  unsubscribeFromSpaceRequest: {
    uuid: string,
  };
  spaceUpdateStream: { uuid: string } & {
    [K in SpaceUpdateTypes]: { type: K; payload: SpaceUpdatePayloadTypeMap[K] }
  }[SpaceUpdateTypes];
  transportUpdateStream: { id: number } & {
    [K in TransportUpdateTypes]: { type: K; payload: TransportUpdatePayloadTypeMap[K] }
  }[TransportUpdateTypes];
}

export type QueueResponseTypeMap = {
  newRouterRequest: {
    rtpCapabilities: mediasoup.types.RtpCapabilities,
  };
  newWebRtcTransportRequest: {
    options: mediasoupClient.types.TransportOptions,
  };
  subscribeToSpaceRequest: {
    clientSideSpace: ClientSideSpace;
    routerRtpCapabilities: mediasoup.types.RtpCapabilities;
  };
  addMemberRequest: {
    id: number,
  };
  removeMemberRequest: void;
  unsubscribeFromSpaceRequest: void;
  // The optional fields are populated for produce/consume responses so the
  // signaling server can forward them to the client's ack.
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

// Maybe not the best way to do this? Ideally, the queue types should be defined before the other two.
export type QueueTypes = keyof QueuePayloadTypeMap & keyof QueueResponseTypeMap;

export type QueueConsumerCallback<K extends QueueTypes> = (
  payload: QueuePayloadTypeMap[K], ack: (resp: QueueResponseTypeMap[K]) => void, nack: (e: Error) => void
) => void;

type QueueConsumerCallbackCollection = {
  [K in QueueTypes]: Set<QueueConsumerCallback<K>>;
};


// Space update stream messages
// Types that start with 'S' come from the signaling server to the coordinator
// Types that start with 'C' come from the coordinator to the signaling server

export type SpaceUpdateSPayloadTypeMap = {
  // Sent on an attempt to initiate producer transport connection
  "S:memberProducerConnectEvent": {
    memberId: number,
    data: {
      dtlsParameters: mediasoup.types.DtlsParameters,
    },
  };
  // Sent on an attempt to start producing media
  "S:memberProducerProduceEvent": {
    memberId: number,
    data: {
      kind: mediasoup.types.MediaKind,
      rtpParameters: mediasoup.types.RtpParameters,
    },
  };
  // Sent on an attempt to initiate consumer transport connection
  "S:memberConsumerConnectEvent": {
    memberId: number,
    data: {
      dtlsParameters: mediasoup.types.DtlsParameters,
      sourceMemberId: number,
    },
  };
  // Sent on an attempt to start consuming media
  "S:memberConsumerConsumeEvent": {
    memberId: number,
    data: {
      rtpCapabilities: mediasoup.types.RtpCapabilities,
      sourceMemberId: number,
    },
  };
  // Sent to resume a consumer that is consuming media
  // https://mediasoup.org/documentation/v3/mediasoup/api/#transport-consume
  "S:memberConsumerResumeEvent": {
    memberId: number,
    data: {
      sourceMemberId: number,
    },
  };
};

export type SpaceUpdateCPayloadTypeMap = {
  // Sent to provide transport parameters to client
  "C:transportParamsEvent": {
    memberId: number,
    consumesFromMemberId?: number,
    options: mediasoupClient.types.TransportOptions,
  };
  // Sent to notify that a producer has successfully connected and
  // other members can start consuming.
  "C:producerConnectedEvent": {
    memberId: number,
  };
};

export type SpaceUpdatePayloadTypeMap =
  SpaceUpdateSPayloadTypeMap & SpaceUpdateCPayloadTypeMap;

export type SpaceUpdateSTypes = keyof SpaceUpdateSPayloadTypeMap;
export type SpaceUpdateCTypes = keyof SpaceUpdateCPayloadTypeMap;
export type SpaceUpdateTypes = keyof SpaceUpdatePayloadTypeMap;


// Transport update stream messages
// Types that start with 'W' come from the SFU worker to the coordinator
// Types that start with 'C' come from the coordinator to the SFU worker

export type TransportUpdateWPayloadTypeMap = {
  // Currently no messages from worker to coordinator
};

export type TransportUpdateCPayloadTypeMap = {
  // Sent on an attempt to connect a producer/consumer transport to client
  "C:transportConnectEvent": {
    dtlsParameters: mediasoup.types.DtlsParameters,
  };
  // Sent on an attempt to start producing media
  "C:transportProducerProduceEvent": {
    kind: mediasoup.types.MediaKind,
    rtpParameters: mediasoup.types.RtpParameters,
  };
  // Sent on an attempt to start consuming media
  "C:transportConsumerConsumeEvent": {
    rtpCapabilities: mediasoup.types.RtpCapabilities,
    producingTransportId: number,
  };
  // Sent to resume a consumer that is consuming media
  // https://mediasoup.org/documentation/v3/mediasoup/api/#transport-consume
  "C:transportConsumerResumeEvent": {};
};

export type TransportUpdatePayloadTypeMap =
  TransportUpdateWPayloadTypeMap & TransportUpdateCPayloadTypeMap;

export type TransportUpdateWTypes = keyof TransportUpdateWPayloadTypeMap;
export type TransportUpdateCTypes = keyof TransportUpdateCPayloadTypeMap;
export type TransportUpdateTypes = keyof TransportUpdatePayloadTypeMap;


// Bidirectional, pub/sub-style message bus between services.
//
// `consume` attaches a callback to a queue; the returned function cancels the
// subscription. In gRPC terms, this is "listen to a bidirectional stream,"
// and `ack` / `nack` send the response.
//
// `publish` sends a payload to every current consumer of the queue. Each
// consumer is expected to respond exactly once via the supplied `onAck` /
// `onNack`. When more than one service is subscribed to the same queue the
// publisher receives multiple responses; today consumers use a prefix on the
// payload `type` field ("S:" / "C:" / "W:") to decide whether a given event
// is theirs and skip otherwise.
export interface IMessageBus {
  consume<K extends QueueTypes>(
    queueName: K, callback: QueueConsumerCallback<K>
  ): (() => void);

  publish<K extends QueueTypes>(
    queueName: K, payload: QueuePayloadTypeMap[K],
    onAck: (resp: QueueResponseTypeMap[K]) => void,
    onNack: (e: Error) => void,
  ): void;
}


// In-process adapter for `IMessageBus`. Holds one callback set per queue and
// synchronously fans out each publish to every current consumer. This is the
// same broker simulation that previously lived inside `Coordinator`.
export class InProcessBus implements IMessageBus {
  queueConsumerCallbacks: QueueConsumerCallbackCollection;

  constructor() {
    // TODO: Automate this set instantiations
    this.queueConsumerCallbacks = {
      newRouterRequest: new Set(),
      newWebRtcTransportRequest: new Set(),
      subscribeToSpaceRequest: new Set(),
      addMemberRequest: new Set(),
      removeMemberRequest: new Set(),
      unsubscribeFromSpaceRequest: new Set(),
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
}
