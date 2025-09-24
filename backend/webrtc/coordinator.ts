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
  name: string;
}

interface Space {
  uuid: string;
  // TODO: This should be a map in the future
  primaryRouter: Router | null;
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
  owningSpace: Space;
  data: MemberData;
  state: MemberState;
  producer: Transport | null;
  memberToConsumerMap: Map<number, Transport>;
}

interface Router {
  id: number;
  owningSpace: Space;
  transports: Map<number, Transport>;
}

type TransportStatus = "unallocated" | "allocated" | "connected";

export interface TransportMetadata {
  options: mediasoupClient.types.TransportOptions;
}

interface Transport {
  id: number;
  owningMember: Member;
  owningRouter: Router;
  consumesFromTransportId?: number;
  status: TransportStatus;
  metadata?: TransportMetadata;
}

export type ClientSideSpace = Omit<Space, "primaryRouter" | "members"> & {
  members: Map<number, ClientSideMember>;
};

export type ClientSideMember = Omit<Member,
  "owningSpace" | "producer" | "memberToConsumerMap">;

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
    clientSideSpace: ClientSideSpace;
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

  // TODO: Need to also track servers in the future

  spaces: Map<string, Space>
  members: Map<number, Member>
  routers: Map<number, Router>
  transports: Map<number, Transport>

  queueConsumerCallbacks: QueueConsumerCallbackCollection

  spaceSubscriptions: Map<number, Set<string>>
  spaceToSubscribedMap: Map<string, Set<number>>


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

    this.spaceSubscriptions = new Map();
    this.spaceToSubscribedMap = new Map();

    this.consume("subscribeToSpaceRequest", this.onSubscribeToSpaceRequest);
    this.consume("addMemberRequest", this.onAddMemberRequest);
    this.consume("removeMemberRequest", this.onRemoveMemberRequest);
    this.consume("unsubscribeFromSpaceRequest", this.onUnsubscribeFromSpaceRequest);
    this.consume("spaceUpdateStream", this.onSpaceUpdate);
    this.consume("transportUpdateStream", this.onTransportUpdate);
  }

  _getNewTransportId() {
    const id = Coordinator._transportIdCounter;
    Coordinator._transportIdCounter = (Coordinator._transportIdCounter + 1) % Coordinator.MAX_COUNTER;
    return id;
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

  _subscribeToSpace(serverId: number, uuid: string) {
    if (!this.spaceSubscriptions.has(serverId)) {
      this.spaceSubscriptions.set(serverId, new Set());
    }
    this.spaceSubscriptions.get(serverId)!.add(uuid);

    if (!this.spaceToSubscribedMap.has(uuid)) {
      this.spaceToSubscribedMap.set(uuid, new Set());
    }
    this.spaceToSubscribedMap.get(uuid)!.add(serverId);
  }

  _unsubscribeFromSpace(serverId: number, uuid: string) {
    if (this.spaceSubscriptions.has(serverId)) {
      const set = this.spaceSubscriptions.get(serverId)!;
      set.delete(uuid);
      if (set.size === 0) {
        this.spaceSubscriptions.delete(serverId);
      }
    }

    if (this.spaceToSubscribedMap.has(uuid)) {
      const set = this.spaceToSubscribedMap.get(uuid)!;
      set.delete(serverId);
      if (set.size === 0) {
        this.spaceToSubscribedMap.delete(uuid);
      }
    }
  }

  _isSubscribedToSpace(serverId: number, uuid: string) {
    if (!this.spaceSubscriptions.has(serverId)) {
      return false;
    }
    return this.spaceSubscriptions.get(serverId)!.has(uuid);
  }

  _addSpace(uuid: string) {
    const space: Space = {
      uuid, primaryRouter: null,
      data: {
        name: "PLACEHOLDER",  // TODO: Need to retrieve data from DB
      },
      members: new Map(),
    };
    this.spaces.set(uuid, space);
    return space;
  }

  _removeSpace(uuid: string) {
    const space = this.spaces.get(uuid);
    if (space === undefined) {
      return;
    }

    // Clean up associated routers (which also cleans up transports)
    if (space.primaryRouter !== null) {
      this._removeRouter(space.primaryRouter.id);
    }

    // Clean up associated members
    space.members.forEach((member) => {
      this._removeMember(member.id);
    });

    this.spaces.delete(uuid);
  }

  _addMember(data: MemberData, initialState: MemberState, space: Space): Member {
    const id = this._getNewMemberId();
    const member: Member = {
      id, owningSpace: space,
      data, state: initialState,
      producer: null,
      memberToConsumerMap: new Map(),
    };
    this.members.set(member.id, member);
    space.members.set(member.id, member);
    return member;
  }

  _removeMember(id: number) {
    const member = this.members.get(id);
    if (member === undefined) {
      return;
    }
    member.owningSpace.members.delete(id);
    this.members.delete(id);
  }

  async _allocateTransport(router: Router, member: Member,
    consumesFromTransportId?: number): Promise<Transport> {
    // Create the transport object
    const id = this._getNewTransportId();
    const transport: Transport = {
      id, owningRouter: router, owningMember: member,
      consumesFromTransportId, status: "unallocated"
    };
    this.transports.set(id, transport);
    router.transports.set(id, transport);
    member.producer = transport;

    // Return the transport once it is successfully allocated, or an error occurred
    // while allocating.
    return new Promise<Transport>((resolve, reject) => {
      this.publish("newWebRtcTransportRequest", {
        routerId: transport.owningRouter.id,
        assignedId: transport.id,
        isProducer: transport.consumesFromTransportId === undefined,
      }, ({ options }) => {
        transport.metadata = { options };
        transport.status = "allocated";

        // TODO: Get list of all subscribed servers instead of just 0
        const spaceUuid = transport.owningRouter.owningSpace.uuid;
        if (this._isSubscribedToSpace(0, spaceUuid)) {
          this.publish("spaceUpdateStream", {
            uuid: spaceUuid,
            type: "C:transportParamsEvent",
            payload: {
              memberId: transport.owningMember.id,
              options: transport.metadata.options,
            },
          }, () => {
            resolve(transport);
          }, (e: Error) => {
            // Since this event is just a notification, we resolve anyway.
            // TODO: Client should handle retry (implement in signaling server).
            resolve(transport);
          });
        } else {
          resolve(transport);
        }
      }, (e: Error) => {
        // TODO: Need retry mechanism
        reject(new Error("newWebRtcTransportRequest nacked: " + e.message));
      });
    });
  }

  async _removeTransport(transportId: number) {
    // TODO: Need to send message to SFU worker to deallocate.
    this.transports.delete(transportId);
  }

  // When we scale the workers, we might need this to distribute members across
  // multiple resources. For now, we just allocate one router for each space;
  // we call this the primary router.
  async _allocateRouter(space: Space): Promise<Router> {
    if (space.primaryRouter === null) {
      // Create the router object
      const id = this._getNewRouterId();
      const router: Router = {
        id, owningSpace: space,
        transports: new Map(),
      }
      this.routers.set(id, router);

      // Return the router once it is successfully allocated, or an error
      // occurred while allocating.
      return new Promise<Router>((resolve, reject) => {
        this.publish("newRouterRequest", { assignedId: router.id }, () => {
          space.primaryRouter = router;
          resolve(router);
        }, (e: Error) => {
          reject(new Error("newRouterRequest nacked: " + e.message));
        })
      })
    } else {
      return space.primaryRouter;
    }
  }

  async _removeRouter(routerId: number) {
    const router = this.routers.get(routerId);
    if (router === undefined) {
      return;
    }

    // Clean up associated transports
    router.transports.forEach((transport) => {
      this._removeTransport(transport.id);
    });

    // TODO: Need to send message to SFU worker to deallocate.
    this.routers.delete(routerId);
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
      // Callback function to subscribe and ack after the space is ready
      const subscribeAndAckFn = () => {
        // TODO: Replace 0 with actual signaling server ID
        this._subscribeToSpace(0, uuid);

        const space = this.spaces.get(uuid)!;

        // Deep-copy the objects instead of sharing reference (only because
        // we are simulating everything in one process).
        ack({
          clientSideSpace: {
            uuid: space.uuid,
            data: structuredClone(space.data),
            members: new Map<number, ClientSideMember>(
              Array.from(space.members.entries()).map(([id, member]) => [
                id, { id, data: structuredClone(member.data),
                  state: structuredClone(member.state) }])
            ),
          }
        });
      }

      // TODO: This logic is only for spaces created upon joining.
      // We need to handle other kinds of spaces in the future.
      if (!this.spaces.has(uuid)) {
        const space = this._addSpace(uuid);

        // Allocate a router for this space. For now, we assume each space uses
        // exactly one router, and only one worker is present. In the future,
        // we might want to have multiple routers per space for load balancing.
        this._allocateRouter(space)
          .then((_) => {
            subscribeAndAckFn();
          })
          .catch((e: Error) => {
            // TODO: Need retry mechanism
            throw new Error("newRouterRequest nacked: " + e.message);
          });
      } else {
        subscribeAndAckFn();
      }
    }

  onAddMemberRequest: QueueConsumerCallback<"addMemberRequest"> =
    ({ spaceUuid, memberData, memberState }, ack, nack) => {
      // TODO: Replace 0 with actual signaling server ID
      const serverId = 0;
      if (!this._isSubscribedToSpace(serverId, spaceUuid)) {
        nack(new Error("signaling server not subscribed to space"));
        return;
      }

      const space = this.spaces.get(spaceUuid);
      if (space === undefined) {
        nack(new Error("space not found"));
        return;
      }

      // Make sure to allocate router first
      this._allocateRouter(space)
        .then((router) => {
          const newMember = this._addMember(memberData, memberState, space);

          // Allocate transports asynchronously
          // First we allocate the producer transport for the new member
          this._allocateTransport(router, newMember, undefined)
            .then((newMemberTransport) => {
              newMember.producer = newMemberTransport;
              // Then we allocate consumer transports for all other members
              space.members.forEach((other) => {
                if (other.id !== newMember.id) {
                  this._allocateTransport(router, other, newMemberTransport.id)
                    .then((transport) => {
                      newMember.memberToConsumerMap.set(other.id, transport);
                    })
                    .catch((e: any) => {
                      // TODO: Handle errors; we can just let the client retry.
                      console.log("failed to allocate consumer transport: " +
                        e.message);
                    });
                }
              });
            })
            .catch((e: any) => {
              // TODO: Handle errors; we can just let the client retry.
              console.log("failed to allocate producer transport: " + e.message);
            });

          ack({ id: newMember.id });
        })
        .catch((e: any) => {
          nack(new Error("failed to allocate router: " + e.message));
        });

      // TODO: Notify other members about the new member.
      // Currently, we only have one signaling server, so this is not needed.
    };

  onRemoveMemberRequest: QueueConsumerCallback<"removeMemberRequest"> =
    ({ id }, ack, nack) => {
      const member = this.members.get(id);
      if (member === undefined) {
        nack(new Error("member not found"));
        return;
      }

      const space = member.owningSpace;

      // Clean up transports associated with this member
      if (member.producer !== null) {
        this._removeTransport(member.producer.id);
      }
      member.memberToConsumerMap.forEach((transport) => {
        this._removeTransport(transport.id);
      });

      // Clean up member
      this._removeMember(id);

      // Clean up space if it has met ending conditions and no server is
      // subscribed to it.
      // TODO: This logic is only for spaces removed upon last member leaving.
      // We need to handle other kinds of spaces in the future.
      if (space.members.size === 0 && !this.spaceToSubscribedMap.has(space.uuid)) {
        this._removeSpace(space.uuid);
      }

      ack();

      // TODO: Notify other members about the removal.
      // Currently, we only have one signaling server, so this is not needed.
    };

  onUnsubscribeFromSpaceRequest: QueueConsumerCallback<"unsubscribeFromSpaceRequest"> =
    ({ uuid }, ack, nack) => {
      const space = this.spaces.get(uuid);
      if (space === undefined) {
        nack(new Error("space not found"));
        return;
      }

      // TODO: Replace 0 with actual signaling server ID
      this._unsubscribeFromSpace(0, uuid);

      // Clean up space if it has met ending conditions and no server is
      // subscribed to it.
      // TODO: This logic is only for spaces removed upon last member leaving.
      // We need to handle other kinds of spaces in the future.
      if (space.members.size === 0 && !this.spaceToSubscribedMap.has(space.uuid)) {
        this._removeSpace(space.uuid);
      }

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
        if (transport === null || transport.status == "unallocated") {
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
        if (transport === null || transport.status != "connected") {
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
          // TODO: Get list of all subscribed servers instead of just 0
          if (this._isSubscribedToSpace(0, uuid)) {
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
            });
          }
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
            producingTransportId: sourceMember.producer!.id,  // This should exist
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
