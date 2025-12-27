/*

Manages the coordinator's view of spaces and which signaling servers
have subscribed to them.

Owns:
- the `spaces` map (uuid → Space)
- `spaceSubscriptions` (serverId → set of uuids) and the inverse
  `spaceToSubscribedMap` (uuid → set of serverIds)

Handles the bus requests `subscribeToSpaceRequest` and
`unsubscribeFromSpaceRequest`. Subscribing implicitly creates a space the
first time it's referenced and allocates its primary router.

Removal is just dropping the space from the maps plus releasing its
router. Members tied to the space are *not* iterated here — callers
guarantee the space is empty before removing it.

*/

import type {
  IMessageBus, QueueConsumerCallback,
} from "./bus.ts";
import type { RouterAllocator } from "./router-allocator.ts";
import type { Space } from "./domain.ts";


export class SpaceService {
  bus: IMessageBus
  routerAllocator: RouterAllocator

  spaces: Map<string, Space> = new Map()

  spaceSubscriptions: Map<number, Set<string>> = new Map()
  spaceToSubscribedMap: Map<string, Set<number>> = new Map()

  _cancelConsumers: (() => void)[] = []

  constructor(bus: IMessageBus, routerAllocator: RouterAllocator) {
    this.bus = bus;
    this.routerAllocator = routerAllocator;
  }

  start() {
    this._cancelConsumers.push(
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

  add(uuid: string): Space {
    const space: Space = {
      uuid, primaryRouter: null,
      data: {
        name: "PLACEHOLDER",  // TODO: Need to retrieve data from DB
      },
      members: new Map(),
    };
    this.spaces.set(uuid, space);
    return space;
  }

  // Callers must ensure the space has no remaining members before removing it.
  remove(uuid: string) {
    const space = this.spaces.get(uuid);
    if (space === undefined) {
      return;
    }
    if (space.primaryRouter !== null) {
      this.routerAllocator.remove(space.primaryRouter.id);
    }
    this.spaces.delete(uuid);
  }

  onSubscribeToSpaceRequest: QueueConsumerCallback<"subscribeToSpaceRequest"> =
    ({ uuid }, ack, nack) => {
      // Callback function to subscribe and ack after the space is ready
      const subscribeAndAckFn = () => {
        const space = this.spaces.get(uuid)!;
        if (space.primaryRouter === null ||
          space.primaryRouter.rtpCapabilities === null) {
            // This should not happen because routerAllocator.allocate waits
            // for router allocation to finish before calling this function.
            nack(new Error("space router not allocated yet"));
            return;
          }
        // TODO: Replace 0 with actual signaling server ID
        this.subscribe(0, uuid);

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
      }

      // TODO: This logic is only for spaces created upon joining.
      // We need to handle other kinds of spaces in the future.
      if (!this.spaces.has(uuid)) {
        const space = this.add(uuid);

        // Allocate a router for this space. For now, we assume each space
        // uses exactly one router, and only one worker is present. In the
        // future, we might want to have multiple routers per space for
        // load balancing.
        this.routerAllocator.allocate(space)
          .then((_) => {
            subscribeAndAckFn();
          })
          .catch((e: Error) => {
            // TODO: Need retry mechanism
            throw new Error("newRouterRequest nacked: " + e.message);
          });
      } else {
        subscribeAndAckFn();
      }
    }

  onUnsubscribeFromSpaceRequest: QueueConsumerCallback<"unsubscribeFromSpaceRequest"> =
    ({ uuid }, ack, nack) => {
      const space = this.spaces.get(uuid);
      if (space === undefined) {
        nack(new Error("space not found"));
        return;
      }

      // TODO: Replace 0 with actual signaling server ID
      this.unsubscribe(0, uuid);

      // Clean up space if it has met ending conditions and no server is
      // subscribed to it.
      // TODO: This logic is only for spaces removed upon last member leaving.
      // We need to handle other kinds of spaces in the future.
      if (space.members.size === 0 && !this.hasSubscribers(uuid)) {
        this.remove(uuid);
      }

      ack();
    };
}
