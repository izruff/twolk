/*

Composition root for the coordinator-side services.

In the future, the coordinator service should also handle scaling the SFU
workers horizontally, managing load distribution and RTP packet transfer
between two workers, and implementing router migration policies from one
worker to another. For now, this class is responsible for assembling the
sub-services and starting them in the right order.

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
- ChannelPreAllocator    — picks which signaling server a new client
                           should connect to; updated whenever servers
                           register or deregister via the bus.

*/

import type { IMessageBus, QueueConsumerCallback } from "./bus.ts";
import { RouterAllocator } from "./router-allocator.ts";
import { TransportAllocator } from "./transport-allocator.ts";
import { SpaceService } from "./space-service.ts";
import { MemberService } from "./member-service.ts";
import { SpaceUpdateDispatcher } from "./space-update-dispatcher.ts";
import { InMemoryStore } from "./in-memory-store.ts";
import { ProcessCounterIdGenerator } from "./id-gen-process.ts";
import type { Space, Member } from "./domain.ts";
import {
  ChannelPreAllocator,
  RoundRobinStrategy,
  type IAllocationStrategy,
} from "./channel-pre-allocator.ts";


export class Coordinator {
  bus: IMessageBus

  routerAllocator: RouterAllocator
  transportAllocator: TransportAllocator
  spaceService: SpaceService
  memberService: MemberService
  spaceUpdateDispatcher: SpaceUpdateDispatcher
  channelPreAllocator: ChannelPreAllocator

  _cancelTryJoin: (() => void) | null = null

  constructor(
    bus: IMessageBus,
    serverAllocationStrategy: IAllocationStrategy = new RoundRobinStrategy(),
    workerAllocationStrategy: IAllocationStrategy = new RoundRobinStrategy(),
  ) {
    this.bus = bus;

    // The "is this space subscribed?" check is supplied as a closure so
    // TransportAllocator can be built before SpaceService — resolved
    // lazily at call time once `this.spaceService` is set.
    const spaceStore = new InMemoryStore<string, Space>();
    const memberStore = new InMemoryStore<number, Member>();
    const routerIdGen = new ProcessCounterIdGenerator();
    const transportIdGen = new ProcessCounterIdGenerator();
    const memberIdGen = new ProcessCounterIdGenerator();

    this.transportAllocator = new TransportAllocator(
      bus,
      (uuid) => this.spaceService.hasSubscribers(uuid),
      transportIdGen,
    );
    this.routerAllocator = new RouterAllocator(
      bus, this.transportAllocator, routerIdGen, workerAllocationStrategy);
    this.spaceService = new SpaceService(bus, this.routerAllocator, spaceStore);
    this.memberService = new MemberService(
      bus, this.spaceService, this.routerAllocator, this.transportAllocator,
      memberStore, memberIdGen);
    this.spaceUpdateDispatcher = new SpaceUpdateDispatcher(
      bus, this.spaceService, this.transportAllocator);

    this.channelPreAllocator = new ChannelPreAllocator(serverAllocationStrategy);
    bus.onSignalingServerConnected((serverId, serverUrl) => {
      this.channelPreAllocator.onServerConnected(serverId, serverUrl);
    });
    bus.onSignalingServerDisconnected((serverId) => {
      this.channelPreAllocator.onServerDisconnected(serverId);
    });
  }

  // Starts every sub-service. Must be called once after construction;
  // each sub-service is inert until then.
  start() {
    this.spaceService.start();
    this.memberService.start();
    this.spaceUpdateDispatcher.start();

    this._cancelTryJoin = this.bus.consume(
      "tryJoinSpaceRequest", this.onTryJoinSpaceRequest.bind(this));
  }

  onTryJoinSpaceRequest: QueueConsumerCallback<"tryJoinSpaceRequest"> =
    ({ spaceUuid }, ack, nack) => {
      const space = this.spaceService.get(spaceUuid);
      if (space === undefined || space.status === "ended") {
        nack(new Error("space not found or not joinable"));
        return;
      }
      try {
        const serverUrl = this.channelPreAllocator.allocate();
        ack({ serverUrl });
      } catch (e: any) {
        nack(e);
      }
    };
}
