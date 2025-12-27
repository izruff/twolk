/*

Routes S:* events (from signaling server) into the right
C:transportUpdate calls on the worker, and reflects worker acks back to
the space as the appropriate C:* event.

Each S: event corresponds to a step in the per-member transport/produce/
consume handshake. The handler typically:
  1. resolves the member + transport from the space
  2. publishes a worker-bound transport update with the same payload
  3. acks (and sometimes publishes a follow-up notification) on worker ack

The dispatcher reads state through SpaceService and TransportAllocator;
it doesn't own any state of its own.

*/

import type {
  IMessageBus, QueueConsumerCallback,
} from "./bus.ts";
import type { SpaceService } from "./space-service.ts";
import type { TransportAllocator } from "./transport-allocator.ts";


export class SpaceUpdateDispatcher {
  bus: IMessageBus
  spaceService: SpaceService
  transportAllocator: TransportAllocator

  _cancelConsumers: (() => void)[] = []

  constructor(
    bus: IMessageBus,
    spaceService: SpaceService,
    transportAllocator: TransportAllocator,
  ) {
    this.bus = bus;
    this.spaceService = spaceService;
    this.transportAllocator = transportAllocator;
  }

  start() {
    this._cancelConsumers.push(
      this.bus.consume("spaceUpdateStream", this.onSpaceUpdate.bind(this)),
      this.bus.consume("transportUpdateStream", this.onTransportUpdate.bind(this)),
    );
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
          // Notify the space members about the new producer. Any
          // subscribed signaling server will pick this up from its
          // consume on spaceUpdateStream.
          if (this.spaceService.hasSubscribers(uuid)) {
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
