import type {
  IMessageBus, QueueConsumerCallback, QueueResponseTypeMap,
} from "./bus.ts";
import type { SpaceService } from "./space-service.ts";
import type { TransportAllocator } from "./transport-allocator.ts";

type TransportUpdateAck = Exclude<QueueResponseTypeMap["transportUpdateStream"], void>;


/**
 * Coordinator-side subservice that dispatches space and transport update
 * stream messages between other connected services.
 *
 * TODO: Replace the long event branch with per-event handlers so validation,
 * worker command publishing, and response mapping can be tested separately.
 */
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

  /** Registers bus consumers handled by this dispatcher. */
  start() {
    this._cancelConsumers.push(
      this.bus.consume("spaceUpdateStream", this.onSpaceUpdate.bind(this)),
      this.bus.consume("transportUpdateStream", this.onTransportUpdate.bind(this)),
    );
  }

  /** Handles signaling-server-originated space update events. */
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

        // Notify the SFU worker to connect the producer transport.
        if (transport.status !== "connected") {
          this.bus.publish("transportUpdateStream", {
            id: transport.id,
            type: "C:transportConnectEvent",
            payload: {
              dtlsParameters: payload.data.dtlsParameters,
            },
          }, () => {
            transport.status = "connected";
            ack();
          }, (e: Error) => {
            // TODO: Add retry or client-visible recovery for worker nacks.
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
        // TODO: Decide whether produce requires connected coordinator status.
        // The current prototype allows produce after allocation because the
        // worker is authoritative and client event ordering can race.
        if (transport === null || transport.status === "unallocated") {
          nack(new Error("transport not allocated"));
          return;
        }

        // Notify the SFU worker to start producing.
        this.bus.publish("transportUpdateStream", {
          id: transport.id,
          type: "C:transportProducerProduceEvent",
          payload: {
            kind: payload.data.kind,
            rtpParameters: payload.data.rtpParameters,
          },
        }, (resp) => {
          // TODO: Split transport update response types by event.
          ack({ id: (resp as TransportUpdateAck).id });
          // Notify subscribed signaling servers that this producer can be
          // consumed.
          if (this.spaceService.hasSubscribers(uuid)) {
            this.bus.publish("spaceUpdateStream", {
              uuid,
              type: "C:producerConnectedEvent",
              payload: {
                memberId: payload.memberId,
              },
            }, () => {
              // Notification ack is not used.
            }, (_e: Error) => {
              // TODO: Add recovery for missed best-effort producer events.
            });
          }
        }, (e: Error) => {
          // TODO: Add retry or client-visible recovery for worker nacks.
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

        // Notify the SFU worker to connect the consumer transport.
        if (transport.status !== "connected") {
          this.bus.publish("transportUpdateStream", {
            id: transport.id,
            type: "C:transportConnectEvent",
            payload: {
              dtlsParameters: payload.data.dtlsParameters,
            },
          }, () => {
            transport.status = "connected";
            ack();
          }, (e: Error) => {
            // TODO: Add retry or client-visible recovery for worker nacks.
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
        // TODO: Decide whether consume requires connected coordinator status.
        // The current prototype allows consume after allocation because the
        // worker can buffer until the producer exists.
        if (transport === undefined || transport.status === "unallocated") {
          nack(new Error("transport not allocated"));
          return;
        }

        // Notify the SFU worker to start consuming.
        this.bus.publish("transportUpdateStream", {
          id: transport.id,
          type: "C:transportConsumerConsumeEvent",
          payload: {
            rtpCapabilities: payload.data.rtpCapabilities,
            // TODO: Validate sourceMember.producer before publishing.
            producingTransportId: sourceMember.producer!.id,
          },
        }, (resp) => {
          // TODO: Split transport update response types by event.
          ack({
            id: (resp as TransportUpdateAck).id,
            producerId: (resp as TransportUpdateAck).producerId,
            kind: (resp as TransportUpdateAck).kind,
            rtpParameters: (resp as TransportUpdateAck).rtpParameters,
          });
        }, (e: Error) => {
          // TODO: Add retry or client-visible recovery for worker nacks.
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
        // TODO: Decide whether resume requires connected coordinator status.
        // The current prototype lets the worker validate the consumer.
        if (transport === undefined || transport.status === "unallocated") {
          nack(new Error("transport not allocated"));
          return;
        }

        // Notify the SFU worker to resume consuming.
        // See https://mediasoup.org/documentation/v3/mediasoup/api/#transport-consume
        this.bus.publish("transportUpdateStream", {
          id: transport.id,
          type: "C:transportConsumerResumeEvent",
          payload: {},
        }, () => {
          ack();
        }, (e: Error) => {
          // TODO: Add retry or client-visible recovery for worker nacks.
          nack(new Error(
            "transportUpdate for C:transportConsumerResumeEvent nacked: " +
            e.message));
        });

      } else {
        nack(new Error("unexpected error: unknown space update type"));
      }
    }

  /** Handles worker-originated transport updates. */
  onTransportUpdate: QueueConsumerCallback<"transportUpdateStream"> =
    ({ id, type, payload }, ack, nack) => {
      if (type.startsWith("C:")) return;

      const transport = this.transportAllocator.get(id);
      if (transport === undefined) {
        nack(new Error("transport not found"));
        return;
      }

      if (false) {
        // No worker-originated transport updates are defined yet.
      } else {
        nack(new Error("unexpected error: unknown transport update type"));
      }
    }
}
