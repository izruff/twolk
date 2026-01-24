import type { SpaceLifecyclePolicy } from "./space-lifecycle-policy.ts";
import type { SpaceStatus } from "./domain.ts";


/**
 * Ends spaces after both signaling subscriptions and members reach zero.
 *
 * Transition rules:
 *
 * - `initialized -> running` when a signaling server subscribes.
 * - `running -> ended` when the space has no subscribed signaling servers and
 *   no members.
 */
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
