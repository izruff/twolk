/*

Implementation of the coordinator service.
- Keep track of active spaces and their members.
- Allocate resources to members trying to join a space.

In the future, it should also handle scaling the SFU workers horizontally,
managing load distribution and RTP packet transfer between two workers, and
implementing router migration policies from one worker to another.

The coordinator no longer owns the inter-service message broker — that has
moved to `bus.ts` and is injected as an `IMessageBus`. The wire contracts
(queue payloads, space/transport update events) live in `bus.ts`.

Small note: A lot of these functions are not too complicated due to the
fact that TypeScript runs on single-threaded event loop, so we don't have
to worry about race conditions and order of operations too much.

*/

import mediasoup from "mediasoup";
import mediasoupClient from "mediasoup-client";

import type {
  IMessageBus, QueueConsumerCallback,
} from "./bus.ts";


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
  // Changes made by the client
  isMuted: boolean;

  // Changes made by the server
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
  rtpCapabilities: mediasoup.types.RtpCapabilities | null;
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
  members: ClientSideMember[];
};

export type ClientSideMember = Omit<Member,
  "owningSpace" | "producer" | "memberToConsumerMap">;


export class Coordinator {
  // TODO: Need to also track servers in the future

  bus: IMessageBus

  spaces: Map<string, Space>
  members: Map<number, Member>
  routers: Map<number, Router>
  transports: Map<number, Transport>

  spaceSubscriptions: Map<number, Set<string>>
  spaceToSubscribedMap: Map<string, Set<number>>

  // Cancellation handles for the bus subscriptions registered in start().
  _cancelConsumers: (() => void)[] = []


  // These should be okay because these resources are not permanent and the
  // traffic should not exceed this maximum limit.
  static MAX_COUNTER = Number.MAX_SAFE_INTEGER
  static _routerIdCounter = 0
  static _memberIdCounter = 0
  static _transportIdCounter = 0

  constructor(bus: IMessageBus) {
    this.bus = bus;

    this.spaces = new Map();
    this.members = new Map();
    this.routers = new Map();
    this.transports = new Map();

    this.spaceSubscriptions = new Map();
    this.spaceToSubscribedMap = new Map();
  }

  // Registers bus consumers. Must be called once after construction;
  // the coordinator is inert until then.
  start() {
    this._cancelConsumers.push(
      this.bus.consume("subscribeToSpaceRequest", this.onSubscribeToSpaceRequest.bind(this)),
      this.bus.consume("addMemberRequest", this.onAddMemberRequest.bind(this)),
      this.bus.consume("removeMemberRequest", this.onRemoveMemberRequest.bind(this)),
      this.bus.consume("unsubscribeFromSpaceRequest", this.onUnsubscribeFromSpaceRequest.bind(this)),
      this.bus.consume("spaceUpdateStream", this.onSpaceUpdate.bind(this)),
      this.bus.consume("transportUpdateStream", this.onTransportUpdate.bind(this)),
    );

    // For debugging; print contents of all maps every 5 seconds
    // setInterval(() => {
    //   console.log("=== Coordinator State ===");
    //   console.log("Spaces:", this.spaces);
    //   console.log("Members:", this.members);
    //   console.log("Routers:", this.routers);
    //   console.log("Transports:", this.transports);
    // }, 5000);
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
    if (consumesFromTransportId !== undefined && !this.transports.has(consumesFromTransportId)) {
      throw new Error("producing transport not found");
    }

    // Create the transport object
    const id = this._getNewTransportId();
    const transport: Transport = {
      id, owningRouter: router, owningMember: member,
      consumesFromTransportId, status: "unallocated"
    };
    this.transports.set(id, transport);
    router.transports.set(id, transport);
    if (consumesFromTransportId === undefined) {
      // Only a producer transport should be tracked as the member's producer;
      // a consumer transport is tracked via memberToConsumerMap below.
      member.producer = transport;
    }
    console.log(`[${(new Date()).toISOString()}] Added unallocated transport ${id} (member=${member.id}, consumesFromTransportId=${consumesFromTransportId})`);

    // Return the transport once it is successfully allocated, or an error occurred
    // while allocating.
    return new Promise<Transport>((resolve, reject) => {
      this.bus.publish("newWebRtcTransportRequest", {
        routerId: transport.owningRouter.id,
        assignedId: transport.id,
        isProducer: transport.consumesFromTransportId === undefined,
      }, ({ options }) => {
        transport.metadata = { options };
        transport.status = "allocated";
        if (consumesFromTransportId !== undefined) {
          const producerTransport = this.transports.get(consumesFromTransportId)!;
          member.memberToConsumerMap.set(producerTransport.owningMember.id,
            this.transports.get(id)!);
        }
        console.log(`[${(new Date()).toISOString()}] Transport ${id} allocated`);

        resolve(transport);

        // TODO: Get list of all subscribed servers instead of just 0
        const spaceUuid = transport.owningRouter.owningSpace.uuid;
        if (this._isSubscribedToSpace(0, spaceUuid)) {
          let consumesFromMemberId: number | undefined = undefined;
          if (transport.consumesFromTransportId !== undefined) {
            const producingTransport = this.transports.get(
              transport.consumesFromTransportId);
            if (producingTransport !== undefined) {
              consumesFromMemberId = producingTransport.owningMember.id;
            }
          }
          this.bus.publish("spaceUpdateStream", {
            uuid: spaceUuid,
            type: "C:transportParamsEvent",
            payload: {
              memberId: transport.owningMember.id,
              consumesFromMemberId,
              options: transport.metadata.options,
            },
          }, () => {
            // Nothing for now
          }, (e: Error) => {
            // Since this event is just a notification, we ignore for now.
            // TODO: Client should handle retry (implement in signaling server).
          });
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
        rtpCapabilities: null,
        transports: new Map(),
      }
      this.routers.set(id, router);

      // Return the router once it is successfully allocated, or an error
      // occurred while allocating.
      return new Promise<Router>((resolve, reject) => {
        this.bus.publish("newRouterRequest", { assignedId: router.id },
          ({ rtpCapabilities }) => {
            router.rtpCapabilities = rtpCapabilities;
            space.primaryRouter = router;
            resolve(router);
          },
          (e: Error) => {
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

  onSubscribeToSpaceRequest: QueueConsumerCallback<"subscribeToSpaceRequest"> =
    ({ uuid }, ack, nack) => {
      // Callback function to subscribe and ack after the space is ready
      const subscribeAndAckFn = () => {
        const space = this.spaces.get(uuid)!;
        if (space.primaryRouter === null ||
          space.primaryRouter.rtpCapabilities === null) {
            // This should not happen because _allocateRouter waits for router
            // allocation to finish before calling this function.
            nack(new Error("space router not allocated yet"));
            return;
          }
        // TODO: Replace 0 with actual signaling server ID
        this._subscribeToSpace(0, uuid);

        // Deep-copy the objects instead of sharing reference (only because
        // we are simulating everything in one process).
        ack({
          clientSideSpace: {
            uuid: space.uuid,
            data: structuredClone(space.data),
            members: Array.from(space.members.entries()).map(
              ([id, member]) => ({
                id, data: structuredClone(member.data),
                state: structuredClone(member.state)
              })
            ),
          },
          routerRtpCapabilities: space.primaryRouter.rtpCapabilities,
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
              // For every other member in the space:
              //  - allocate a consumer transport for them to consume from the
              //    new member (worker will buffer the consume until the new
              //    member's producer is actually producing).
              //  - allocate a consumer transport for the new member to consume
              //    from them (their producer may or may not be producing yet;
              //    the worker buffer handles both cases).
              space.members.forEach((other) => {
                if (other.id === newMember.id) return;
                this._allocateTransport(router, other, newMemberTransport.id)
                  .catch((e: any) => {
                    console.log("failed to allocate consumer transport for " +
                      `member ${other.id} consuming new member: ${e.message}`);
                  });
                if (other.producer !== null) {
                  this._allocateTransport(router, newMember, other.producer.id)
                    .catch((e: any) => {
                      console.log("failed to allocate consumer transport for " +
                        `new member consuming member ${other.id}: ${e.message}`);
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
      if (type.startsWith("C:")) return;

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
          this.bus.publish("transportUpdateStream", {
            id: transport.id,
            type: "C:transportConnectEvent",
            payload: {
              dtlsParameters: payload.data.dtlsParameters,
            },
          }, () => {
            transport.status = "connected";
            console.log(`[${(new Date()).toISOString()}] Producer transport ${transport.id} connected`);
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
        // if (transport === null || transport.status != "connected") {
        //   nack(new Error("transport not connected"));
        //   return;
        // }
        if (transport === null || transport.status === "unallocated") {
          nack(new Error("transport not allocated"));
          return;
        }

        // Notify SFU worker to start producing
        this.bus.publish("transportUpdateStream", {
          id: transport.id,
          type: "C:transportProducerProduceEvent",
          payload: {
            kind: payload.data.kind,
            rtpParameters: payload.data.rtpParameters,
          },
        }, (resp) => {
          console.log("Producer started for member", payload.memberId);
          ack({ id: resp!.id });
          // Notify the space members about the new producer
          // TODO: Get list of all subscribed servers instead of just 0
          if (this._isSubscribedToSpace(0, uuid)) {
            console.log("Notifying space members about new producer for member", payload.memberId);
            this.bus.publish("spaceUpdateStream", {
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
          this.bus.publish("transportUpdateStream", {
            id: transport.id,
            type: "C:transportConnectEvent",
            payload: {
              dtlsParameters: payload.data.dtlsParameters,
            },
          }, () => {
            transport.status = "connected";
            console.log(`[${(new Date()).toISOString()}] Consumer transport ${transport.id} connected`);
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
        // if (transport === undefined || transport.status !== "connected") {
        //   nack(new Error("transport not connected"));
        //   return;
        // }
        if (transport === undefined || transport.status === "unallocated") {
          nack(new Error("transport not allocated"));
          return;
        }

        // Notify SFU worker to start consuming
        this.bus.publish("transportUpdateStream", {
          id: transport.id,
          type: "C:transportConsumerConsumeEvent",
          payload: {
            rtpCapabilities: payload.data.rtpCapabilities,
            producingTransportId: sourceMember.producer!.id,  // This should exist
          },
        }, (resp) => {
          ack({
            id: resp!.id,
            producerId: resp!.producerId,
            kind: resp!.kind,
            rtpParameters: resp!.rtpParameters,
          });
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
        // if (transport === undefined || transport.status !== "connected") {
        //   nack(new Error("transport not connected"));
        //   return;
        // }
        if (transport === undefined || transport.status === "unallocated") {
          nack(new Error("transport not allocated"));
          return;
        }

        // Notify SFU worker to resume consuming
        // https://mediasoup.org/documentation/v3/mediasoup/api/#transport-consume
        this.bus.publish("transportUpdateStream", {
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
      if (type.startsWith("C:")) return;

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
