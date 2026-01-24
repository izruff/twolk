import type {
  IMessageBus, QueueConsumerCallback,
} from "./bus.ts";
import type { RouterAllocator } from "./router-allocator.ts";
import type { TransportAllocator } from "./transport-allocator.ts";
import type { SpaceService } from "./space-service.ts";
import type { Member, MemberData, MemberState, Space } from "./domain.ts";
import type { IStore } from "./store-port.ts";
import type { IIdGenerator } from "./id-gen-port.ts";


/**
 * Coordinator-side subservice that manages coordinator-side members.
 *
 * This service stores member records and proxies of their associated media
 * resources. It performs member management operations and handles the
 * allocation of transports for each member and producer-consumer pairs.
 *
 * TODO: Currently, there is no mechanism for updating member states. This is
 * because they are being done exclusively in individual signaling servers.
 * We should add support for distributing member state updates once forwarding
 * of updates from the server is supported. See the TODOs in `server.ts`.
 *
 * TODO: This service is tightly coupled with some other subservices. We should
 * think about how to decouple them.
 */
export class MemberService {
  bus: IMessageBus
  spaceService: SpaceService
  routerAllocator: RouterAllocator
  transportAllocator: TransportAllocator
  idGen: IIdGenerator

  members: IStore<number, Member>

  _cancelConsumers: (() => void)[] = []

  constructor(
    bus: IMessageBus,
    spaceService: SpaceService,
    routerAllocator: RouterAllocator,
    transportAllocator: TransportAllocator,
    memberStore: IStore<number, Member>,
    idGen: IIdGenerator,
  ) {
    this.bus = bus;
    this.spaceService = spaceService;
    this.routerAllocator = routerAllocator;
    this.transportAllocator = transportAllocator;
    this.members = memberStore;
    this.idGen = idGen;
  }

  /** Registers bus consumers handled by this service. */
  start() {
    this._cancelConsumers.push(
      this.bus.consume("addMemberRequest", this.onAddMemberRequest.bind(this)),
      this.bus.consume("removeMemberRequest", this.onRemoveMemberRequest.bind(this)),
    );
  }

  /** Returns the coordinator-side member record. */
  get(id: number): Member | undefined {
    return this.members.get(id);
  }

  /** Adds a member to the service store and owning space. */
  add(data: MemberData, initialState: MemberState, space: Space): Member {
    const id = this.idGen.next();
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

  /** Removes a member from the service store and owning space. */
  remove(id: number) {
    const member = this.members.get(id);
    if (member === undefined) {
      return;
    }
    member.owningSpace.members.delete(id);
    this.members.delete(id);
  }

  onAddMemberRequest: QueueConsumerCallback<"addMemberRequest"> =
    ({ serverId, spaceUuid, memberData, memberState }, ack, nack) => {
      if (!this.spaceService.isSubscribed(serverId, spaceUuid)) {
        nack(new Error("signaling server not subscribed to space"));
        return;
      }

      const space = this.spaceService.get(spaceUuid);
      if (space === undefined) {
        nack(new Error("space not found"));
        return;
      }

      // Ensure the space has a router before allocating member transports.
      // TODO: This is also called in `SpaceService.applyTransition`. We need
      // to decide who has the responsibility of allocating a router for the
      // first time.
      this.routerAllocator.allocate(space)
        .then((router) => {
          const newMember = this.add(memberData, memberState, space);

          // Allocate the producer transport first, then start consumer mesh
          // allocations asynchronously.
          this.transportAllocator.allocate(router, newMember, undefined)
            .then((newMemberTransport) => {
              newMember.producer = newMemberTransport;
              // For every other member, allocate one consumer transport in
              // each direction when a source producer transport exists. The
              // worker buffers consume requests until producers are ready.
              space.members.forEach((other) => {
                if (other.id === newMember.id) return;
                this.transportAllocator.allocate(router, other, newMemberTransport.id)
                  .catch((e: any) => {
                    console.log("failed to allocate consumer transport for " +
                      `member ${other.id} consuming new member: ${e.message}`);
                  });
                if (other.producer !== null) {
                  this.transportAllocator.allocate(router, newMember, other.producer.id)
                    .catch((e: any) => {
                      console.log("failed to allocate consumer transport for " +
                        `new member consuming member ${other.id}: ${e.message}`);
                    });
                }
              });
            })
            .catch((e: any) => {
              // TODO: Roll back the member or expose a retryable join failure.
              console.log("failed to allocate producer transport: " + e.message);
            });

          ack({ id: newMember.id });
        })
        .catch((e: any) => {
          nack(new Error("failed to allocate router: " + e.message));
        });

      // TODO: Broadcast member joins across signaling servers through the coordinator.
    };

  onRemoveMemberRequest: QueueConsumerCallback<"removeMemberRequest"> =
    ({ id }, ack, nack) => {
      const member = this.members.get(id);
      if (member === undefined) {
        nack(new Error("member not found"));
        return;
      }

      const space = member.owningSpace;

      // Clean up transports associated with this member.
      if (member.producer !== null) {
        this.transportAllocator.remove(member.producer.id);
      }
      member.memberToConsumerMap.forEach((transport) => {
        this.transportAllocator.remove(transport.id);
      });

      // Clean up member.
      this.remove(id);

      // Let the lifecycle policy decide whether the space should end.
      this.spaceService.notifyMemberLeft(space.uuid);

      ack();

      // TODO: Broadcast member removals across signaling servers through the coordinator.
    };
}
