/*

Manages members of spaces.

Owns:
- the `members` map (memberId → Member)
- the member-id counter

Handles the bus requests `addMemberRequest` and `removeMemberRequest`.
Adding a member triggers the producer + N consumer transport allocations
for the producer/consumer mesh. Removing a member tears down its
transports and (if it was the last member and nobody is subscribed) asks
the SpaceService to remove the empty space.

*/

import type {
  IMessageBus, QueueConsumerCallback,
} from "./bus.ts";
import type { RouterAllocator } from "./router-allocator.ts";
import type { TransportAllocator } from "./transport-allocator.ts";
import type { SpaceService } from "./space-service.ts";
import type { Member, MemberData, MemberState, Space } from "./domain.ts";
import type { IStore } from "./store-port.ts";


export class MemberService {
  bus: IMessageBus
  spaceService: SpaceService
  routerAllocator: RouterAllocator
  transportAllocator: TransportAllocator

  members: IStore<number, Member>

  _cancelConsumers: (() => void)[] = []

  // TODO: Phase 7 replaces these statics with an injected IIdGenerator.
  static MAX_COUNTER = Number.MAX_SAFE_INTEGER
  static _idCounter = 0

  constructor(
    bus: IMessageBus,
    spaceService: SpaceService,
    routerAllocator: RouterAllocator,
    transportAllocator: TransportAllocator,
    memberStore: IStore<number, Member>,
  ) {
    this.bus = bus;
    this.spaceService = spaceService;
    this.routerAllocator = routerAllocator;
    this.transportAllocator = transportAllocator;
    this.members = memberStore;
  }

  start() {
    this._cancelConsumers.push(
      this.bus.consume("addMemberRequest", this.onAddMemberRequest.bind(this)),
      this.bus.consume("removeMemberRequest", this.onRemoveMemberRequest.bind(this)),
    );
  }

  _getNewId(): number {
    const id = MemberService._idCounter;
    MemberService._idCounter = (MemberService._idCounter + 1) % MemberService.MAX_COUNTER;
    return id;
  }

  get(id: number): Member | undefined {
    return this.members.get(id);
  }

  add(data: MemberData, initialState: MemberState, space: Space): Member {
    const id = this._getNewId();
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

  remove(id: number) {
    const member = this.members.get(id);
    if (member === undefined) {
      return;
    }
    member.owningSpace.members.delete(id);
    this.members.delete(id);
  }

  onAddMemberRequest: QueueConsumerCallback<"addMemberRequest"> =
    ({ spaceUuid, memberData, memberState }, ack, nack) => {
      // TODO: Replace 0 with actual signaling server ID
      const serverId = 0;
      if (!this.spaceService.isSubscribed(serverId, spaceUuid)) {
        nack(new Error("signaling server not subscribed to space"));
        return;
      }

      const space = this.spaceService.get(spaceUuid);
      if (space === undefined) {
        nack(new Error("space not found"));
        return;
      }

      // Make sure to allocate router first
      this.routerAllocator.allocate(space)
        .then((router) => {
          const newMember = this.add(memberData, memberState, space);

          // Allocate transports asynchronously
          // First we allocate the producer transport for the new member
          this.transportAllocator.allocate(router, newMember, undefined)
            .then((newMemberTransport) => {
              newMember.producer = newMemberTransport;
              // For every other member in the space:
              //  - allocate a consumer transport for them to consume from
              //    the new member (worker will buffer the consume until the
              //    new member's producer is actually producing).
              //  - allocate a consumer transport for the new member to
              //    consume from them (their producer may or may not be
              //    producing yet; the worker buffer handles both cases).
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
        this.transportAllocator.remove(member.producer.id);
      }
      member.memberToConsumerMap.forEach((transport) => {
        this.transportAllocator.remove(transport.id);
      });

      // Clean up member
      this.remove(id);

      // Clean up space if it has met ending conditions and no server is
      // subscribed to it.
      // TODO: This logic is only for spaces removed upon last member leaving.
      // We need to handle other kinds of spaces in the future.
      if (space.members.size === 0 && !this.spaceService.hasSubscribers(space.uuid)) {
        this.spaceService.remove(space.uuid);
      }

      ack();

      // TODO: Notify other members about the removal.
      // Currently, we only have one signaling server, so this is not needed.
    };
}
