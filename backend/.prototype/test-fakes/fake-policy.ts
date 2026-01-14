/*

Fake SpaceLifecyclePolicy for backend tests.

All hooks are no-ops; no automatic transitions occur. Tests drive status
changes explicitly by calling `triggerTransition(to)`, which invokes the
`transition` callback supplied by SpaceService.onCreated. Awaiting it
ensures all side effects (e.g. router allocation) have completed before
assertions run.

*/

import type { SpaceLifecyclePolicy } from "../space-lifecycle-policy.ts";
import type { SpaceStatus } from "../domain.ts";


export class FakePolicy implements SpaceLifecyclePolicy {
  private _transition: ((to: SpaceStatus) => Promise<void>) | null = null;

  onCreated(_spaceId: string, transition: (to: SpaceStatus) => Promise<void>): void {
    this._transition = transition;
  }

  onSubscribe(
    _spaceId: string,
    _currentStatus: SpaceStatus,
    _subscriberCount: number,
    _memberCount: number,
  ): SpaceStatus | undefined {
    return undefined;
  }

  onUnsubscribe(
    _spaceId: string,
    _currentStatus: SpaceStatus,
    _subscriberCount: number,
    _memberCount: number,
  ): SpaceStatus | undefined {
    return undefined;
  }

  onMemberLeft(
    _spaceId: string,
    _currentStatus: SpaceStatus,
    _subscriberCount: number,
    _memberCount: number,
  ): SpaceStatus | undefined {
    return undefined;
  }

  onEnded(_spaceId: string): void {}

  // Test helper: trigger a transition and wait for its side effects.
  async triggerTransition(to: SpaceStatus): Promise<void> {
    if (this._transition === null) {
      throw new Error("FakePolicy: onCreated has not been called yet");
    }
    await this._transition(to);
  }
}
