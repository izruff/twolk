/*

Allocates and tracks WebRTC transports on behalf of members.

Owns the `transports` map and the transport-id counter. Allocation goes
through the bus as `newWebRtcTransportRequest` to whichever worker
handles it. On the worker's ack the transport is marked allocated, the
member-to-consumer map is updated for consumer transports, and (if any
signaling server is subscribed to the space) a `C:transportParamsEvent`
is published so the client can build its mediasoup-client transport.

The "is space subscribed?" check is supplied as a callback to avoid a
direct dependency on the space service; the eventual SpaceService can be
substituted by passing its `isSubscribed` method.

*/

import type { IMessageBus } from "./bus.ts";
import type { Member, Router, Transport } from "./domain.ts";
import type { IIdGenerator } from "./id-gen-port.ts";


export class TransportAllocator {
  bus: IMessageBus
  // Whether any signaling server is subscribed to this space — if so, the
  // C:transportParamsEvent broadcast goes out (and any subscribed server
  // will pick it up via its consume on spaceUpdateStream). Supplied as a
  // callback to avoid a direct dependency on SpaceService.
  hasSpaceSubscribers: (spaceUuid: string) => boolean

  idGen: IIdGenerator

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
      // Only a producer transport should be tracked as the member's
      // producer; a consumer transport is tracked via
      // memberToConsumerMap once the worker acks.
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
            // Nothing for now
          }, (_e: Error) => {
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

  async remove(transportId: number): Promise<void> {
    // TODO: Need to send message to SFU worker to deallocate.
    this.transports.delete(transportId);
  }
}
