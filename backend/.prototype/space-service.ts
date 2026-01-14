/*

Manages the coordinator's view of spaces and which signaling servers
have subscribed to them.

Owns:
- the `spaces` map (uuid → Space)
- `spaceSubscriptions` (serverId → set of uuids) and the inverse
  `spaceToSubscribedMap` (uuid → set of serverIds)

Handles the bus requests `createSpaceRequest`, `readSpaceRequest`,
`subscribeToSpaceRequest`, and `unsubscribeFromSpaceRequest`. Spaces are
created explicitly via `createSpaceRequest` (forwarded from the HTTP
server); subscribing no longer creates them.

A space moves through three statuses: "initialized" (created, nobody has
joined), "running" (at least one subscribe has promoted it and allocated
its router), and "ended" (last subscriber left). Subscribing to a missing
or ended space is rejected.

Each space carries a SpaceLifecyclePolicy that decides when status
transitions occur. applyTransition owns all side effects of every
transition so policies never need to touch infrastructure directly.

*/

import { randomUUID } from "node:crypto";

import type {
  IMessageBus, QueueConsumerCallback,
} from "./bus.ts";
import type { RouterAllocator } from "./router-allocator.ts";
import type { Space, SpaceData, SpaceStatus } from "./domain.ts";
import type { IStore } from "./store-port.ts";
import type { SpaceLifecyclePolicy } from "./space-lifecycle-policy.ts";
import { SubscriptionDrivenPolicy } from "./subscription-driven-policy.ts";


export function defaultPolicyFactory(type: string): SpaceLifecyclePolicy {
  if (type === "subscription-driven") return new SubscriptionDrivenPolicy();
  throw new Error("unknown space lifecycle policy type: " + type);
}


export class SpaceService {
  bus: IMessageBus
  routerAllocator: RouterAllocator
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

  get(uuid: string): Space | undefined {
    return this.spaces.get(uuid);
  }

  hasSubscribers(uuid: string): boolean {
    return this.spaceToSubscribedMap.has(uuid);
  }

  isSubscribed(serverId: number, uuid: string): boolean {
    if (!this.spaceSubscriptions.has(serverId)) {
      return false;
    }
    return this.spaceSubscriptions.get(serverId)!.has(uuid);
  }

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

  // Creates a space with the given data and lifecycle policy. The policy's
  // onCreated hook is called immediately with a transition callback so
  // timer-based policies can schedule transitions before any client joins.
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

  // Central method for all status transitions. Owns every side effect:
  // - initialized → running: allocates the primary router.
  // - running → ended: deallocates the router and notifies the policy.
  // Policies call the transition callback (supplied via onCreated) instead
  // of touching these side effects directly.
  async applyTransition(space: Space, to: SpaceStatus): Promise<void> {
    if (space.status === to) return;

    if (to === "running" && space.status === "initialized") {
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

  // Called by MemberService after a member is removed. Delegates the
  // "should the space end?" decision to the space's lifecycle policy.
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

          // Deep-copy the objects instead of sharing reference (only because
          // we are simulating everything in one process).
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
