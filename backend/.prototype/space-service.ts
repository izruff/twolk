import { randomUUID } from "node:crypto";

import type {
  IMessageBus, QueueConsumerCallback,
} from "./bus.ts";
import type { RouterAllocator } from "./router-allocator.ts";
import type { Space, SpaceData, SpaceStatus } from "./domain.ts";
import type { IStore } from "./store-port.ts";
import type { SpaceLifecyclePolicy } from "./space-lifecycle-policy.ts";
import { SubscriptionDrivenPolicy } from "./subscription-driven-policy.ts";


/**
 * Builds a lifecycle policy from a config or request policy type using
 * default settings.
 *
 * TODO: This is subject to change as we add more policies and extend them.
 */
export function defaultPolicyFactory(type: string): SpaceLifecyclePolicy {
  if (type === "subscription-driven") return new SubscriptionDrivenPolicy();
  throw new Error("unknown space lifecycle policy type: " + type);
}


/**
 * Coordinator-side subservice that manages coordinator-side spaces.
 *
 * This service maintains space records, handles creation of spaces, defines
 * the behavior of lifecycle transitions, and handles subscription requests.
 */
export class SpaceService {
  bus: IMessageBus
  // TODO: This is subject for removal; see the TODO in `applyTransition()`.
  routerAllocator: RouterAllocator
  // TODO: This is subject to change as we add more policies and extend them.
  policyFactory: (type: string) => SpaceLifecyclePolicy

  spaces: IStore<string, Space>

  spaceSubscriptions: Map<number, Set<string>> = new Map()
  spaceToSubscribedMap: Map<string, Set<number>> = new Map()

  _cancelConsumers: (() => void)[] = []

  constructor(
    bus: IMessageBus,
    routerAllocator: RouterAllocator,
    spaceStore: IStore<string, Space>,
    policyFactory: (type: string) => SpaceLifecyclePolicy = defaultPolicyFactory,
  ) {
    this.bus = bus;
    this.routerAllocator = routerAllocator;
    this.spaces = spaceStore;
    this.policyFactory = policyFactory;
  }

  /** Registers bus consumers handled by this service. */
  start() {
    this._cancelConsumers.push(
      this.bus.consume("createSpaceRequest",
        this.onCreateSpaceRequest.bind(this)),
      this.bus.consume("readSpaceRequest",
        this.onReadSpaceRequest.bind(this)),
      this.bus.consume("subscribeToSpaceRequest",
        this.onSubscribeToSpaceRequest.bind(this)),
      this.bus.consume("unsubscribeFromSpaceRequest",
        this.onUnsubscribeFromSpaceRequest.bind(this)),
    );
  }

  /** Returns the coordinator-side space record. */
  get(uuid: string): Space | undefined {
    return this.spaces.get(uuid);
  }

  /** Returns true when any signaling server is subscribed to the space. */
  hasSubscribers(uuid: string): boolean {
    return this.spaceToSubscribedMap.has(uuid);
  }

  /** Returns true when a specific signaling server mirrors a space. */
  isSubscribed(serverId: number, uuid: string): boolean {
    if (!this.spaceSubscriptions.has(serverId)) {
      return false;
    }
    return this.spaceSubscriptions.get(serverId)!.has(uuid);
  }

  /** Records that a signaling server now mirrors a space. */
  subscribe(serverId: number, uuid: string) {
    if (!this.spaceSubscriptions.has(serverId)) {
      this.spaceSubscriptions.set(serverId, new Set());
    }
    this.spaceSubscriptions.get(serverId)!.add(uuid);

    if (!this.spaceToSubscribedMap.has(uuid)) {
      this.spaceToSubscribedMap.set(uuid, new Set());
    }
    this.spaceToSubscribedMap.get(uuid)!.add(serverId);
  }

  /** Removes a signaling server subscription for a space. */
  unsubscribe(serverId: number, uuid: string) {
    if (this.spaceSubscriptions.has(serverId)) {
      const set = this.spaceSubscriptions.get(serverId)!;
      set.delete(uuid);
      if (set.size === 0) {
        this.spaceSubscriptions.delete(serverId);
      }
    }

    if (this.spaceToSubscribedMap.has(uuid)) {
      const set = this.spaceToSubscribedMap.get(uuid)!;
      set.delete(serverId);
      if (set.size === 0) {
        this.spaceToSubscribedMap.delete(uuid);
      }
    }
  }

  /**
   * Creates a space with the requested lifecycle policy.
   *
   * TODO: This is subject to change as we add more policies and extend them.
   */
  create(data: SpaceData, policyType: string): string {
    const uuid = randomUUID();
    const policy = this.policyFactory(policyType);
    const space: Space = {
      uuid, status: "initialized", primaryRouter: null,
      data: structuredClone(data),
      members: new Map(),
      policy,
    };
    this.spaces.set(uuid, space);
    policy.onCreated(uuid, (to) => this.applyTransition(space, to));
    return uuid;
  }

  /**
   * Applies a lifecycle transition and its infrastructure side effects.
   *
   * Transitions and their side effects:
   *
   * - `initialized -> running`: allocates the primary router.
   * - `running -> ended`: removes the primary router and notifies the
   *   lifecycle policy.
   *
   * Invalid transitions are ignored.
   */
  async applyTransition(space: Space, to: SpaceStatus): Promise<void> {
    if (space.status === to) return;

    if (to === "running" && space.status === "initialized") {
      // TODO: This is also called in `MemberService.onAddMemberRequest`.
      // We need to decide who has the responsibility of allocating a router
      // for the first time.
      await this.routerAllocator.allocate(space);
    } else if (to === "ended" && space.status === "running") {
      if (space.primaryRouter !== null) {
        await this.routerAllocator.remove(space.primaryRouter.id);
        space.primaryRouter = null;
      }
      space.policy.onEnded(space.uuid);
    } else {
      console.warn(
        `applyTransition: ignoring invalid transition ${space.status} → ${to}`);
      return;
    }

    space.status = to;
  }

  /** Lets the lifecycle policy react after `MemberService` removes a member. */
  notifyMemberLeft(uuid: string) {
    const space = this.spaces.get(uuid);
    if (space === undefined) return;

    const subscriberCount = this.spaceToSubscribedMap.get(uuid)?.size ?? 0;
    const desiredStatus = space.policy.onMemberLeft(
      uuid, space.status, subscriberCount, space.members.size);

    if (desiredStatus !== undefined) {
      this.applyTransition(space, desiredStatus).catch((e: Error) => {
        console.error("notifyMemberLeft: transition failed: " + e.message);
      });
    }
  }

  onCreateSpaceRequest: QueueConsumerCallback<"createSpaceRequest"> =
    ({ data, policyType }, ack, _nack) => {
      const uuid = this.create(data, policyType);
      ack({ uuid });
    };

  onReadSpaceRequest: QueueConsumerCallback<"readSpaceRequest"> =
    ({ uuid }, ack, nack) => {
      const space = this.spaces.get(uuid);
      if (space === undefined) {
        nack(new Error("space not found"));
        return;
      }
      ack({ data: structuredClone(space.data), status: space.status });
    };

  onSubscribeToSpaceRequest: QueueConsumerCallback<"subscribeToSpaceRequest"> =
    ({ serverId, uuid }, ack, nack) => {
      const space = this.spaces.get(uuid);
      if (space === undefined) {
        nack(new Error("space not found"));
        return;
      }
      if (space.status !== "initialized" && space.status !== "running") {
        nack(new Error("space is not joinable"));
        return;
      }

      const subscriberCount = this.spaceToSubscribedMap.get(uuid)?.size ?? 0;
      const desiredStatus = space.policy.onSubscribe(
        uuid, space.status, subscriberCount, space.members.size);

      const transitionPromise = desiredStatus !== undefined
        ? this.applyTransition(space, desiredStatus)
        : Promise.resolve();

      transitionPromise
        .then(() => {
          if (space.primaryRouter === null ||
            space.primaryRouter.rtpCapabilities === null) {
            nack(new Error("space router not allocated yet"));
            return;
          }
          this.subscribe(serverId, uuid);

          // Deep-copy so the signaling server mirror does not share references
          // with coordinator state in this single-process prototype.
          ack({
            clientSideSpace: {
              uuid: space.uuid,
              data: structuredClone(space.data),
              members: Array.from(space.members.entries()).map(
                ([id, member]) => ({
                  id, data: structuredClone(member.data),
                  state: structuredClone(member.state)
                })
              ),
            },
            routerRtpCapabilities: space.primaryRouter.rtpCapabilities,
          });
        })
        .catch((e: Error) => {
          nack(e);
        });
    }

  onUnsubscribeFromSpaceRequest: QueueConsumerCallback<"unsubscribeFromSpaceRequest"> =
    ({ serverId, uuid }, ack, nack) => {
      const space = this.spaces.get(uuid);
      if (space === undefined) {
        nack(new Error("space not found"));
        return;
      }

      this.unsubscribe(serverId, uuid);
      const subscriberCount = this.spaceToSubscribedMap.get(uuid)?.size ?? 0;
      const desiredStatus = space.policy.onUnsubscribe(
        uuid, space.status, subscriberCount, space.members.size);

      const transitionPromise = desiredStatus !== undefined
        ? this.applyTransition(space, desiredStatus)
        : Promise.resolve();

      transitionPromise.then(() => ack()).catch((e: Error) => nack(e));
    };
}
