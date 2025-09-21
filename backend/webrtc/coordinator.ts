/*

Implementation of the coordinator service.
- Keep track of active spaces and their members.
- Allocate resources to members trying to join a space.

In the future, it should also handle scaling the SFU workers horizontally,
managing load distribution and RTP packet transfer between two workers, and
implementing router migration policies from one worker to another.

Small note: A lot of these functions are not too complicated due to the
fact that TypeScript runs on single-threaded event loop, so we don't have
to worry about race conditions and order of operations too much.

*/

import mediasoup from "mediasoup";
import mediasoupClient from "mediasoup-client";


export interface SpaceData {
  rtpCapabilities: mediasoup.types.RtpCapabilities,
}

interface Space {
  uuid: string;
  primaryRouter: Router;
  data: SpaceData;
  members: Map<number, Member>
}

export interface MemberData {
  name: string;
}

export interface MemberState {
  // Maintained by both backend and client
  isMuted: boolean;

  // Maintained by backend only
  transportIsConnected: boolean;
}

interface Member {
  id: number;
  space: Space;
  router: Router;
  data: MemberData;
  state: MemberState;
  producer: Transport;
  memberToConsumerMap: Map<number, Transport>;
}

interface Router {
  id: number;
  space: Space;
}

type TransportStatus = "unallocated" | "allocated" | "connected";

export interface TransportMetadata {
  options: mediasoupClient.types.TransportOptions;
}

interface Transport {
  id: number;
  router: Router;
  consumesFromTransportId?: number;
  status: TransportStatus;
  metadata?: TransportMetadata;
}

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
  newRouterRequest: void;
  newWebRtcTransportRequest: {
    options: mediasoupClient.types.TransportOptions,
  };
  subscribeToSpaceRequest: {
    data: SpaceData,
  };
  addMemberRequest: {
    id: number,
  };
  removeMemberRequest: void;
  unsubscribeFromSpaceRequest: void;
  spaceUpdateStream: void;
  transportUpdateStream: void;
}

// Maybe not the best way to do this? Ideally, the queue types should be defined before the other two.
type QueueTypes = keyof QueuePayloadTypeMap & keyof QueueResponseTypeMap;

export type QueueConsumerCallback<K extends QueueTypes> = (
  payload: QueuePayloadTypeMap[K], ack: (resp: QueueResponseTypeMap[K]) => void, nack: (e: Error) => void
) => void | Promise<void>;

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


export class Coordinator {
  /*
  This is a mock implementation of the coordinator service. In reality, this service
  should be a separate microservice that communicates with the signaling server
  and SFU workers via gRPC bidirectional streaming.
  
  The `queueConsumerCallbacks` map was meant to simulate message queues that the
  coordinator service would publish to/consume from. Originally, it was meant as a
  message broker simulator, but after some thinking, our needs are more aligned to a
  request-response pattern that goes both ways; gRPC would be better suited for this.

  Instead of changing the code to fit gRPC right away, we keep this as is for now,
  but make it so that we can send messages both ways.
  */

  spaces: Map<string, Space>
  members: Map<number, Member>
  routers: Map<number, Router>
  transports: Map<number, Transport>

  queueConsumerCallbacks: QueueConsumerCallbackCollection

  // These should be okay because these resources are not permanent and the
  // traffic should not exceed this maximum limit.
  static MAX_COUNTER = Number.MAX_SAFE_INTEGER
  static _routerIdCounter = 0
  static _memberIdCounter = 0
  static _transportIdCounter = 0

  constructor() {
    this.spaces = new Map();
    this.members = new Map();
    this.routers = new Map();
    this.transports = new Map();

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

    this.consume("subscribeToSpaceRequest", this.onSubscribeToSpaceRequest);
    this.consume("addMemberRequest", this.onAddMemberRequest);
    this.consume("removeMemberRequest", this.onRemoveMemberRequest);
    this.consume("unsubscribeFromSpaceRequest", this.onUnsubscribeFromSpaceRequest);
    this.consume("spaceUpdateStream", this.onSpaceUpdate);
    this.consume("transportUpdateStream", this.onTransportUpdate);
  }

  _getNewRouterId() {
    const id = Coordinator._routerIdCounter;
    Coordinator._routerIdCounter = (Coordinator._routerIdCounter + 1) % Coordinator.MAX_COUNTER;
    return id;
  }

  _getNewMemberId() {
    const id = Coordinator._memberIdCounter;
    Coordinator._memberIdCounter = (Coordinator._memberIdCounter + 1) % Coordinator.MAX_COUNTER;
    return id;
  }

  _createNewTransport(router: Router, consumesFromTransportId?: number) {
    const id = Coordinator._transportIdCounter;
    Coordinator._transportIdCounter = (Coordinator._transportIdCounter + 1) % Coordinator.MAX_COUNTER;

    const transport: Transport = { id, router, consumesFromTransportId, status: "unallocated" };
    this.transports.set(id, transport);
    return transport;
  }

  async _allocateTransport(transport: Transport) {
    return new Promise<void>((resolve) => {
      this.publish("newWebRtcTransportRequest", {
        routerId: transport.router.id,
        assignedId: transport.id,
        isProducer: transport.consumesFromTransportId === undefined,
      }, ({ options }) => {
        transport.metadata = { options };
        transport.status = "allocated";

        this.publish("spaceUpdateStream", {
          uuid: transport.router.space.uuid,
          type: "C:transportParamsEvent",
          payload: {
            memberId: transport.router.space.primaryRouter.id,
            options: transport.metadata.options,
          },
        }, () => {
          resolve();
        }, (e: Error) => {
          // Since this event is just a notification, we resolve anyway.
          // TODO: Client should handle retry (implement in signaling server).
          resolve();
        });
      }, (e: Error) => {
        // TODO: Need retry mechanism
        throw new Error("newWebRtcTransportRequest nacked: " + e.message);
      });
    });
  }

  // When we scale the workers, we might need this to distribute members across
  // multiple resources. For now, we just allocate one router for each space;
  // we call this the primary router.
  _allocateRouter(space: Space): Router {
    return space.primaryRouter;
  }

  // Attaches a callback to consume messages from a queue, i.e. subscribes to the
  // queue. In gRPC terms, this is basically listening to a bidirectional stream,
  // and ack() or nack() are used to send responses.
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

  // Publishes to a queue. In gRPC terms, this is basically sending messages to a
  // bidirectional stream, and listening for responses via the provided onAck()
  // and onNack() callbacks.
  publish<K extends QueueTypes>(
    queueName: K, payload: QueuePayloadTypeMap[K],
    onAck: (resp: QueueResponseTypeMap[K]) => void,
    onNack: (e: Error) => void,
  ) {
    this.queueConsumerCallbacks[queueName].forEach((callback) => {
      callback(payload, onAck, onNack);
    });
  }

  onSubscribeToSpaceRequest: QueueConsumerCallback<"subscribeToSpaceRequest"> =
    ({ uuid }, ack, nack) => {
      // Allocate a router for this space. For now, we assume each space uses
      // exactly one router, and only one worker is present.
      const assignedId = this._getNewRouterId();

      this.publish("newRouterRequest", { assignedId }, () => {
        // Deep-copy the object instead of sharing reference
        const space = this.routers.get(assignedId)!.space;
        ack({ data: structuredClone(space.data) });
      }, (e: Error) => {
        // TODO: Need retry mechanism
        throw new Error("newRouterRequest nacked: " + e.message);
      });
    }

  onAddMemberRequest: QueueConsumerCallback<"addMemberRequest"> =
    ({ spaceUuid, memberData, memberState }, ack, nack) => {
      const id = this._getNewMemberId();

      const space = this.spaces.get(spaceUuid)!;
      const router = this._allocateRouter(space);

      const newMemberTransport = this._createNewTransport(router, undefined);
      const newMember: Member = {
        id, space, router, data: memberData, state: memberState,
        producer: newMemberTransport,
        memberToConsumerMap: new Map(),
      };

      const otherMemberTransports: Transport[] = [];
      space.members.forEach((other) => {
        if (other.id !== id) {
          const transport = this._createNewTransport(router, newMemberTransport.id);
          otherMemberTransports.push(transport);
          newMember.memberToConsumerMap.set(other.id, transport);
        }
      });

      this.members.set(id, newMember);
      space.members.set(id, newMember);

      // Allocate transports asynchronously
      // TODO: Handle errors; we can just let the client retry.
      this._allocateTransport(newMemberTransport).then(() => {
        const allocateOtherPromises = otherMemberTransports.map((transport) =>
          this._allocateTransport(transport));
        return Promise.all(allocateOtherPromises);
      });

      ack({ id });
    };

  onRemoveMemberRequest: QueueConsumerCallback<"removeMemberRequest"> =
    ({ id }, ack, nack) => {
      const member = this.members.get(id);
      if (member === undefined) {
        nack(new Error("member not found"));
        return;
      }

      this.transports.forEach((transport) => {
        if (transport.router.id === member.router.id) {
          this.transports.delete(transport.id);
        }
      });

      // TODO: These transports will require some cleanup.
      this.transports.delete(member.producer.id);
      member.memberToConsumerMap.forEach((transport) => {
        this.transports.delete(transport.id);
      });

      member.space.members.delete(id);
      this.members.delete(id);

      ack();
    };

  onUnsubscribeFromSpaceRequest: QueueConsumerCallback<"unsubscribeFromSpaceRequest"> =
    ({ uuid }, ack, nack) => {
      const space = this.spaces.get(uuid);
      if (space === undefined) {
        nack(new Error("space not found"));
        return;
      }
      if (space.members.size > 0) {
        nack(new Error("space still not empty"));
        return;
      }

      // TODO: Clean up routers associated to the space

      this.spaces.delete(uuid);

      ack();
    };

  onSpaceUpdate: QueueConsumerCallback<"spaceUpdateStream"> =
    ({ uuid, type, payload }, ack, nack) => {
      const space = this.spaces.get(uuid);
      if (space === undefined) {
        nack(new Error("space not found"));
        return;
      }

      if (type === "S:memberProducerConnectEvent") {
        const member = space.members.get(payload.memberId);
        if (member === undefined) {
          nack(new Error("member not found"));
          return;
        }

        const transport = member.producer;
        if (transport.status == "unallocated") {
          nack(new Error("transport not allocated"));
          return;
        }

        // Notify SFU worker to initiate transport connection
        if (transport.status !== "connected") {
          this.publish("transportUpdateStream", {
            id: transport.id,
            type: "C:transportConnectEvent",
            payload: {
              dtlsParameters: payload.data.dtlsParameters,
            },
          }, () => {
            transport.status = "connected";
            ack();
          }, (e: Error) => {
            // TODO: Need retry mechanism
            nack(new Error(
              "transportUpdate for C:transportConnectEvent nacked: " +
              e.message));
          });
        }

      } else if (type === "S:memberProducerProduceEvent") {
        const member = space.members.get(payload.memberId);
        if (member === undefined) {
          nack(new Error("member not found"));
          return;
        }

        const transport = member.producer;
        if (transport.status != "connected") {
          nack(new Error("transport not connected"));
          return;
        }

        // Notify SFU worker to start producing
        this.publish("transportUpdateStream", {
          id: transport.id,
          type: "C:transportProducerProduceEvent",
          payload: {
            kind: payload.data.kind,
            rtpParameters: payload.data.rtpParameters,
          },
        }, () => {
          ack();
          // Notify the space members about the new producer
          this.publish("spaceUpdateStream", {
            uuid,
            type: "C:producerConnectedEvent",
            payload: {
              memberId: payload.memberId,
            },
          }, () => {
            // Do nothing for now
          }, (e: Error) => {
            // Since this event is just a notification, we do nothing.
            // Client should treat this as a best-effort notification.
          })
        }, (e: Error) => {
          // TODO: Need retry mechanism
          nack(new Error(
            "transportUpdate for C:transportProducerProduceEvent nacked: " +
            e.message));
        });

      } else if (type === "S:memberConsumerConnectEvent") {
        const member = space.members.get(payload.memberId);
        if (member === undefined) {
          nack(new Error("member not found"));
          return;
        }

        const transport = member.memberToConsumerMap.get(
          payload.data.sourceMemberId);
        if (transport === undefined || transport.status == "unallocated") {
          nack(new Error("transport not allocated"));
          return;
        }

        // Notify SFU worker to initiate transport connection
        if (transport.status !== "connected") {
          this.publish("transportUpdateStream", {
            id: transport.id,
            type: "C:transportConnectEvent",
            payload: {
              dtlsParameters: payload.data.dtlsParameters,
            },
          }, () => {
            transport.status = "connected";
            ack();
          }, (e: Error) => {
            // TODO: Need retry mechanism
            nack(new Error(
              "transportUpdate for C:transportConnectEvent nacked: " +
              e.message));
          });
        }

      } else if (type === "S:memberConsumerConsumeEvent") {
        const member = space.members.get(payload.memberId);
        if (member === undefined) {
          nack(new Error("member not found"));
          return;
        }

        const sourceMember = space.members.get(payload.data.sourceMemberId);
        if (sourceMember === undefined) {
          nack(new Error("source member not found"));
          return;
        }

        const transport = member.memberToConsumerMap.get(
          payload.data.sourceMemberId);
        if (transport === undefined || transport.status !== "connected") {
          nack(new Error("transport not connected"));
          return;
        }

        // Notify SFU worker to start consuming
        this.publish("transportUpdateStream", {
          id: transport.id,
          type: "C:transportConsumerConsumeEvent",
          payload: {
            rtpCapabilities: payload.data.rtpCapabilities,
            producingTransportId: sourceMember.producer.id,
          },
        }, () => {
          ack();
        }, (e: Error) => {
          // TODO: Need retry mechanism
          nack(new Error(
            "transportUpdate for C:transportConsumerConsumeEvent nacked: " +
            e.message));
        });

      } else if (type === "S:memberConsumerResumeEvent") {
        const member = space.members.get(payload.memberId);
        if (member === undefined) {
          nack(new Error("member not found"));
          return;
        }

        const transport = member.memberToConsumerMap.get(
          payload.data.sourceMemberId);
        if (transport === undefined || transport.status !== "connected") {
          nack(new Error("transport not connected"));
          return;
        }

        // Notify SFU worker to resume consuming
        // https://mediasoup.org/documentation/v3/mediasoup/api/#transport-consume
        this.publish("transportUpdateStream", {
          id: transport.id,
          type: "C:transportConsumerResumeEvent",
          payload: {},
        }, () => {
          ack();
        }, (e: Error) => {
          // TODO: Need retry mechanism
          nack(new Error(
            "transportUpdate for C:transportConsumerResumeEvent nacked: " +
            e.message));
        });

      } else {
        nack(new Error("unexpected error: unknown space update type"));
      }
    }

  onTransportUpdate: QueueConsumerCallback<"transportUpdateStream"> =
    ({ id, type, payload }, ack, nack) => {
      const transport = this.transports.get(id);
      if (transport === undefined) {
        nack(new Error("transport not found"));
        return;
      }

      if (false) {
        // Currently no transport updates to handle
      } else {
        nack(new Error("unexpected error: unknown transport update type"));
      }
    }
}
