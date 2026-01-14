/*

Subscription-driven lifecycle policy (the default).

Transitions:
- initialized → running: first signaling server subscribes.
- running → ended: last signaling server unsubscribes AND the space has
  no members, OR the last member leaves AND no signaling servers are
  subscribed.

*/

import type { SpaceLifecyclePolicy } from "./space-lifecycle-policy.ts";
import type { SpaceStatus } from "./domain.ts";


export class SubscriptionDrivenPolicy implements SpaceLifecyclePolicy {
  onCreated(_spaceId: string, _transition: (to: SpaceStatus) => Promise<void>): void {}

  onSubscribe(
    _spaceId: string,
    currentStatus: SpaceStatus,
    _subscriberCount: number,
    _memberCount: number,
  ): SpaceStatus | undefined {
    return currentStatus === "initialized" ? "running" : undefined;
  }

  onUnsubscribe(
    _spaceId: string,
    currentStatus: SpaceStatus,
    subscriberCount: number,
    memberCount: number,
  ): SpaceStatus | undefined {
    return this._shouldEnd(currentStatus, subscriberCount, memberCount);
  }

  onMemberLeft(
    _spaceId: string,
    currentStatus: SpaceStatus,
    subscriberCount: number,
    memberCount: number,
  ): SpaceStatus | undefined {
    return this._shouldEnd(currentStatus, subscriberCount, memberCount);
  }

  onEnded(_spaceId: string): void {}

  private _shouldEnd(
    currentStatus: SpaceStatus,
    subscriberCount: number,
    memberCount: number,
  ): SpaceStatus | undefined {
    if (currentStatus === "running" && subscriberCount === 0 && memberCount === 0) {
      return "ended";
    }
    return undefined;
  }
}
