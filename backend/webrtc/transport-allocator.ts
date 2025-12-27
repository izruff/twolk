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


export class TransportAllocator {
  bus: IMessageBus
  // TODO: Replace this callback with a direct SpaceService dependency once
  // SpaceService exists. The 0 below is also a placeholder server id;
  // Phase 7 will plumb real server ids.
  isSpaceSubscribed: (serverId: number, spaceUuid: string) => boolean

  transports: Map<number, Transport> = new Map()

  // TODO: Phase 7 replaces these statics with an injected IIdGenerator.
  static MAX_COUNTER = Number.MAX_SAFE_INTEGER
  static _idCounter = 0

  constructor(
    bus: IMessageBus,
    isSpaceSubscribed: (serverId: number, spaceUuid: string) => boolean,
  ) {
    this.bus = bus;
    this.isSpaceSubscribed = isSpaceSubscribed;
  }

  _getNewId() {
    const id = TransportAllocator._idCounter;
    TransportAllocator._idCounter = (TransportAllocator._idCounter + 1) % TransportAllocator.MAX_COUNTER;
    return id;
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

    const id = this._getNewId();
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
    console.log(`[${(new Date()).toISOString()}] Added unallocated transport ${id} (member=${member.id}, consumesFromTransportId=${consumesFromTransportId})`);

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
        if (this.isSpaceSubscribed(0, spaceUuid)) {
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
