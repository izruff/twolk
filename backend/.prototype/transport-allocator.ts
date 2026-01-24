/**
 * Allocates and tracks coordinator-side WebRTC transport records.
 *
 * Allocation creates local transport state, publishes
 * `newWebRtcTransportRequest`, then stores the worker-returned client
 * transport parameters. Producer transports are attached to `member.producer`.
 * Consumer transports are indexed by source member in `memberToConsumerMap`.
 *
 * When any signaling server is subscribed to the owning space, allocation also
 * publishes `C:transportParamsEvent` so the owning client can create its
 * mediasoup-client transport.
 */

import type { IMessageBus } from "./bus.ts";
import type { Member, Router, Transport } from "./domain.ts";
import type { IIdGenerator } from "./id-gen-port.ts";


/**
 * Coordinator-side transport allocator.
 *
 * This class owns transport IDs and metadata. SFU workers own the actual media
 * transports and are addressed through bus requests.
 *
 * TODO(coordinator-mediation): Currently, the transport allocator publishes
 * space updates in `allocate()`. This induces coupling with `SpaceService`
 * through `hasSpaceSubscribers`. To avoid this, we should delegate this job to
 * the coordinator; see the TODO in `Coordinator`.
 */
export class TransportAllocator {
  bus: IMessageBus
  idGen: IIdGenerator

  /**
   * Callback supplied by the constructor callee to check whether any signaling
   * server is subscribed to a space.
   *
   * TODO(coordinator-mediation): This function is subject for removal.
   */
  hasSpaceSubscribers: (spaceUuid: string) => boolean

  transports: Map<number, Transport> = new Map()

  constructor(
    bus: IMessageBus,
    hasSpaceSubscribers: (spaceUuid: string) => boolean,
    idGen: IIdGenerator,
  ) {
    this.bus = bus;
    this.hasSpaceSubscribers = hasSpaceSubscribers;
    this.idGen = idGen;
  }

  get(transportId: number): Transport | undefined {
    return this.transports.get(transportId);
  }

  /**
   * Allocates a producer or consumer transport for a member.
   *
   * If `consumesFromTransportId` is present, the transport being allocated
   * is a consumer transport that consumes from that existing producer
   * transport. Otherwise, it is a producer transport.
   *
   * TODO(coordinator-mediation): This function is subject to change.
   */
  async allocate(
    router: Router,
    member: Member,
    consumesFromTransportId?: number,
  ): Promise<Transport> {
    if (consumesFromTransportId !== undefined && !this.transports.has(consumesFromTransportId)) {
      throw new Error("producing transport not found");
    }

    const id = this.idGen.next();
    const transport: Transport = {
      id, owningRouter: router, owningMember: member,
      consumesFromTransportId, status: "unallocated",
    };
    this.transports.set(id, transport);
    router.transports.set(id, transport);
    if (consumesFromTransportId === undefined) {
      // Only a producer transport is tracked as the member producer. Consumer
      // transports are tracked in memberToConsumerMap after worker ack.
      member.producer = transport;
    }

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

        resolve(transport);

        const spaceUuid = transport.owningRouter.owningSpace.uuid;
        if (this.hasSpaceSubscribers(spaceUuid)) {
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
            // Notification ack is not used.
          }, (_e: Error) => {
            // TODO: Add retry or client-side recovery for missed params events.
          });
        }
      }, (e: Error) => {
        // TODO: Need retry mechanism
        reject(new Error("newWebRtcTransportRequest nacked: " + e.message));
      });
    });
  }

  /** Removes a transport from coordinator state. */
  async remove(transportId: number): Promise<void> {
    // TODO: Send a worker command to close the actual media transport.
    this.transports.delete(transportId);
  }
}
