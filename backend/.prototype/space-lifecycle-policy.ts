import type { SpaceStatus } from "./domain.ts";


/**
 * Policy port for deciding space lifecycle transitions.
 *
 * Spaces move through `initialized -> running -> ended`. A policy hook returns
 * the desired next status, or `undefined` when the current status should stay
 * unchanged.
 */
export interface SpaceLifecyclePolicy {
  /**
   * Called once after space creation.
   *
   * Policies may store `transition` to trigger asynchronous transitions, such
   * as scheduled starts or time-limited sessions.
   */
  onCreated(spaceId: string, transition: (to: SpaceStatus) => Promise<void>): void;

  /** Called before a signaling server subscription is recorded. */
  // TODO: This method is unusual because it is called before subscription
  // state is updated. We should consider either adding hooks for state change
  // failure, or changing it to an `onSubscribed` hook called after the state
  // change. However, if implementing the latter, we should first figure out
  // what to do with the call to `RouterAllocator.allocate()` in
  // `SpaceService.applyTransition()`.
  onSubscribe(
    spaceId: string,
    currentStatus: SpaceStatus,
    subscriberCount: number,
    memberCount: number,
  ): SpaceStatus | undefined;

  /** Called after a signaling server subscription is removed. */
  onUnsubscribe(
    spaceId: string,
    currentStatus: SpaceStatus,
    subscriberCount: number,
    memberCount: number,
  ): SpaceStatus | undefined;

  /** Called after a member is removed from the space. */
  onMemberLeft(
    spaceId: string,
    currentStatus: SpaceStatus,
    subscriberCount: number,
    memberCount: number,
  ): SpaceStatus | undefined;

  /** Called after `SpaceService` transitions the space to `ended`. */
  onEnded(spaceId: string): void;
}
