import type { IMessageBus, QueueConsumerCallback } from "./bus.ts";
import { RouterAllocator } from "./router-allocator.ts";
import { TransportAllocator } from "./transport-allocator.ts";
import { SpaceService } from "./space-service.ts";
import { MemberService } from "./member-service.ts";
import { SpaceUpdateDispatcher } from "./space-update-dispatcher.ts";
import { InMemoryStore } from "./in-memory-store.ts";
import { ProcessCounterIdGenerator } from "./id-gen-process.ts";
import type { Space, Member } from "./domain.ts";
import { RoundRobinStrategy, type IAllocationStrategy } from "./allocation-strategy.ts";
import { ChannelPreAllocator } from "./channel-pre-allocator.ts";


/**
 * The central service that orchestrates spaces, members, and the resources
 * associated with them.
 *
 * TODO: Many of the methods here and in the subservices still violate the idea
 * of physical separation between the coordinator, the signaling servers, the
 * HTTP servers, and the SFU workers. It is an ongoing effort to discover and
 * flag these violations.
 *
 * TODO(coordinator-mediation): Many of the subservices owned by this class are
 * tightly coupled because they directly call each other's methods. We should
 * have a publish-subscribe mechanism in place, similar to `boost::signals2`,
 * to replace these direct references.
 *
 * TODO: In the future, this service will also perform creation and destruction
 * of server and worker instances.
 */
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

    const spaceStore = new InMemoryStore<string, Space>();
    const memberStore = new InMemoryStore<number, Member>();
    const routerIdGen = new ProcessCounterIdGenerator();
    const transportIdGen = new ProcessCounterIdGenerator();
    const memberIdGen = new ProcessCounterIdGenerator();

    this.transportAllocator = new TransportAllocator(
      bus,
      // This closure lets `TransportAllocator` be constructed before
      // `SpaceService`.
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

  /** Starts sub-services and registers the join allocation handler. */
  start() {
    this.spaceService.start();
    this.memberService.start();
    this.spaceUpdateDispatcher.start();

    this._cancelTryJoin = this.bus.consume(
      "tryJoinSpaceRequest", this.onTryJoinSpaceRequest.bind(this));
  }

  /** Handles HTTP join preflight requests by returning a signaling server URL. */
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
