/*

Implementation of the coordinator service.
- Keep track of active spaces and their members.
- Allocate resources to members trying to join a space.

In the future, it should also handle scaling the SFU workers horizontally,
managing load distribution and RTP packet transfer between two workers, and
implementing router migration policies from one worker to another.

The coordinator is now a composition root for the smaller coordinator-side
services: RouterAllocator, TransportAllocator, SpaceService, MemberService.
The space/transport update event handlers still live here for the moment
and will move into SpaceUpdateDispatcher in the next commit.

Small note: A lot of these functions are not too complicated due to the
fact that TypeScript runs on single-threaded event loop, so we don't have
to worry about race conditions and order of operations too much.

*/

import type {
  IMessageBus, QueueConsumerCallback,
} from "./bus.ts";
import { RouterAllocator } from "./router-allocator.ts";
import { TransportAllocator } from "./transport-allocator.ts";
import { SpaceService } from "./space-service.ts";
import { MemberService } from "./member-service.ts";


export class Coordinator {
  // TODO: Need to also track servers in the future

  bus: IMessageBus

  routerAllocator: RouterAllocator
  transportAllocator: TransportAllocator
  spaceService: SpaceService
  memberService: MemberService

  _cancelConsumers: (() => void)[] = []

  constructor(bus: IMessageBus) {
    this.bus = bus;

    // The "is this space subscribed?" check is supplied as a closure so
    // TransportAllocator can be built before SpaceService — resolved
    // lazily at call time once `this.spaceService` is set.
    this.transportAllocator = new TransportAllocator(
      bus,
      (serverId, uuid) => this.spaceService.isSubscribed(serverId, uuid),
    );
    this.routerAllocator = new RouterAllocator(bus, this.transportAllocator);
    this.spaceService = new SpaceService(bus, this.routerAllocator);
    this.memberService = new MemberService(
      bus, this.spaceService, this.routerAllocator, this.transportAllocator);
  }

  // Registers bus consumers on every sub-service plus the two handlers
  // still owned by Coordinator. Must be called once after construction;
  // the coordinator is inert until then.
  start() {
    this.spaceService.start();
    this.memberService.start();

    this._cancelConsumers.push(
      this.bus.consume("spaceUpdateStream", this.onSpaceUpdate.bind(this)),
      this.bus.consume("transportUpdateStream", this.onTransportUpdate.bind(this)),
    );

    // For debugging; print contents of all maps every 5 seconds
    // setInterval(() => {
    //   console.log("=== Coordinator State ===");
    //   console.log("Spaces:", this.spaceService.spaces);
    //   console.log("Members:", this.memberService.members);
    //   console.log("Routers:", this.routerAllocator.routers);
    //   console.log("Transports:", this.transportAllocator.transports);
    // }, 5000);
  }

  onSpaceUpdate: QueueConsumerCallback<"spaceUpdateStream"> =
    ({ uuid, type, payload }, ack, nack) => {
      if (type.startsWith("C:")) return;

      const space = this.spaceService.get(uuid);
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
          if (this.spaceService.isSubscribed(0, uuid)) {
            console.log("Notifying space members about new producer for member", payload.memberId);
            this.bus.publish("spaceUpdateStream", {
              uuid,
              type: "C:producerConnectedEvent",
              payload: {
                memberId: payload.memberId,
              },
            }, () => {
              // Do nothing for now
            }, (_e: Error) => {
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

      const transport = this.transportAllocator.get(id);
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
