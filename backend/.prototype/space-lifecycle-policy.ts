/*

Interface for controlling when a space transitions between statuses:
  "initialized" → "running" → "ended"

Each hook returns the desired next status, or undefined to leave the
current status unchanged. The `onCreated` hook receives a `transition`
callback that policies can hold onto for asynchronous triggers (e.g. a
timer-based policy that schedules the transition at a future timestamp).

*/

import type { SpaceStatus } from "./domain.ts";


export interface SpaceLifecyclePolicy {
  // Called once when the space is created. Receives a transition callback
  // that can be stored and called later to trigger an async transition.
  onCreated(spaceId: string, transition: (to: SpaceStatus) => Promise<void>): void;

  // Called when a signaling server subscribes to the space.
  onSubscribe(
    spaceId: string,
    currentStatus: SpaceStatus,
    subscriberCount: number,
    memberCount: number,
  ): SpaceStatus | undefined;

  // Called when a signaling server unsubscribes from the space.
  onUnsubscribe(
    spaceId: string,
    currentStatus: SpaceStatus,
    subscriberCount: number,
    memberCount: number,
  ): SpaceStatus | undefined;

  // Called when a member leaves the space.
  onMemberLeft(
    spaceId: string,
    currentStatus: SpaceStatus,
    subscriberCount: number,
    memberCount: number,
  ): SpaceStatus | undefined;

  // Called after the space transitions to "ended".
  onEnded(spaceId: string): void;
}
