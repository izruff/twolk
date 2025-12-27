/*

Composition root for the coordinator-side services.

In the future, the coordinator service should also handle scaling the SFU
workers horizontally, managing load distribution and RTP packet transfer
between two workers, and implementing router migration policies from one
worker to another. For now, this class is responsible only for assembling
the sub-services and starting them in the right order.

Sub-services:
- RouterAllocator        — owns routers; publishes newRouterRequest.
- TransportAllocator     — owns transports; publishes
                           newWebRtcTransportRequest and
                           C:transportParamsEvent.
- SpaceService           — owns spaces and subscription state;
                           handles subscribe/unsubscribeToSpaceRequest.
- MemberService          — owns members; handles add/removeMemberRequest.
- SpaceUpdateDispatcher  — translates S:* space updates into worker
                           transportUpdateStream events and back.

*/

import type { IMessageBus } from "./bus.ts";
import { RouterAllocator } from "./router-allocator.ts";
import { TransportAllocator } from "./transport-allocator.ts";
import { SpaceService } from "./space-service.ts";
import { MemberService } from "./member-service.ts";
import { SpaceUpdateDispatcher } from "./space-update-dispatcher.ts";
import { InMemoryStore } from "./in-memory-store.ts";
import type { Space, Member } from "./domain.ts";


export class Coordinator {
  // TODO: Need to also track servers in the future

  bus: IMessageBus

  routerAllocator: RouterAllocator
  transportAllocator: TransportAllocator
  spaceService: SpaceService
  memberService: MemberService
  spaceUpdateDispatcher: SpaceUpdateDispatcher

  constructor(bus: IMessageBus) {
    this.bus = bus;

    // The "is this space subscribed?" check is supplied as a closure so
    // TransportAllocator can be built before SpaceService — resolved
    // lazily at call time once `this.spaceService` is set.
    const spaceStore = new InMemoryStore<string, Space>();
    const memberStore = new InMemoryStore<number, Member>();

    this.transportAllocator = new TransportAllocator(
      bus,
      (serverId, uuid) => this.spaceService.isSubscribed(serverId, uuid),
    );
    this.routerAllocator = new RouterAllocator(bus, this.transportAllocator);
    this.spaceService = new SpaceService(bus, this.routerAllocator, spaceStore);
    this.memberService = new MemberService(
      bus, this.spaceService, this.routerAllocator, this.transportAllocator,
      memberStore);
    this.spaceUpdateDispatcher = new SpaceUpdateDispatcher(
      bus, this.spaceService, this.transportAllocator);
  }

  // Starts every sub-service. Must be called once after construction;
  // each sub-service is inert until then.
  start() {
    this.spaceService.start();
    this.memberService.start();
    this.spaceUpdateDispatcher.start();

    // For debugging; print contents of all maps every 5 seconds
    // setInterval(() => {
    //   console.log("=== Coordinator State ===");
    //   console.log("Spaces:", this.spaceService.spaces);
    //   console.log("Members:", this.memberService.members);
    //   console.log("Routers:", this.routerAllocator.routers);
    //   console.log("Transports:", this.transportAllocator.transports);
    // }, 5000);
  }
}
