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
its router), and "ended" (last subscriber left). The first subscribe
allocates the primary router and promotes initialized -> running; the last
unsubscribe demotes running -> ended. Subscribing to a missing or ended
space is rejected.

*/

import { randomUUID } from "node:crypto";

import type {
  IMessageBus, QueueConsumerCallback,
} from "./bus.ts";
import type { RouterAllocator } from "./router-allocator.ts";
import type { Space, SpaceData } from "./domain.ts";
import type { IStore } from "./store-port.ts";


export class SpaceService {
  bus: IMessageBus
  routerAllocator: RouterAllocator

  spaces: IStore<string, Space>

  spaceSubscriptions: Map<number, Set<string>> = new Map()
  spaceToSubscribedMap: Map<string, Set<number>> = new Map()

  _cancelConsumers: (() => void)[] = []

  constructor(
    bus: IMessageBus,
    routerAllocator: RouterAllocator,
    spaceStore: IStore<string, Space>,
  ) {
    this.bus = bus;
    this.routerAllocator = routerAllocator;
    this.spaces = spaceStore;
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

  // Creates a space with caller-supplied data and a freshly generated uuid.
  // It starts "initialized"; the router is allocated lazily on the first
  // subscribe.
  create(data: SpaceData): string {
    const uuid = randomUUID();
    const space: Space = {
      uuid, status: "initialized", primaryRouter: null,
      data: structuredClone(data),
      members: new Map(),
    };
    this.spaces.set(uuid, space);
    return uuid;
  }

  // Ends a space (running -> ended) once it is empty and no server is
  // subscribed to it. Called both when the last member leaves
  // (member-service) and when the last server unsubscribes. The space
  // record is kept around so it can still be read as "ended".
  // TODO: This logic is only for spaces ended upon last member leaving.
  // We need to handle other kinds of spaces in the future.
  endIfEmpty(uuid: string) {
    const space = this.spaces.get(uuid);
    if (space === undefined) {
      return;
    }
    if (space.members.size === 0 && !this.hasSubscribers(uuid)) {
      if (space.status === "running") {
        space.status = "ended";
      } else {
        // A space reaching zero subscribers should always be "running".
        console.log("warning: ending space " + uuid +
          " with unexpected status " + space.status);
      }
    }
  }

  onCreateSpaceRequest: QueueConsumerCallback<"createSpaceRequest"> =
    ({ data }, ack, _nack) => {
      const uuid = this.create(data);
      ack({ uuid });
    };

  onReadSpaceRequest: QueueConsumerCallback<"readSpaceRequest"> =
    ({ uuid }, ack, nack) => {
      const space = this.spaces.get(uuid);
      if (space === undefined) {
        nack(new Error("space not found"));
        return;
      }
      ack({ data: structuredClone(space.data) });
    };

  onSubscribeToSpaceRequest: QueueConsumerCallback<"subscribeToSpaceRequest"> =
    ({ serverId, uuid }, ack, nack) => {
      const space = this.spaces.get(uuid);
      if (space === undefined) {
        nack(new Error("space not found"));
        return;
      }
      if (space.status !== "initialized" && space.status !== "running") {
        // Ended (or any non-joinable status): cannot subscribe.
        nack(new Error("space is not joinable"));
        return;
      }

      // Callback function to subscribe and ack after the space is ready
      const subscribeAndAckFn = () => {
        if (space.primaryRouter === null ||
          space.primaryRouter.rtpCapabilities === null) {
            // This should not happen because routerAllocator.allocate waits
            // for router allocation to finish before calling this function.
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
      }

      if (space.status === "initialized") {
        // First subscribe: promote to running and allocate the router.
        // For now, we assume each space uses exactly one router, and only
        // one worker is present. In the future, we might want multiple
        // routers per space for load balancing.
        space.status = "running";
        this.routerAllocator.allocate(space)
          .then((_) => {
            subscribeAndAckFn();
          })
          .catch((e: Error) => {
            // TODO: Need retry mechanism
            throw new Error("newRouterRequest nacked: " + e.message);
          });
      } else {
        // Already running: the router is allocated.
        subscribeAndAckFn();
      }
    }

  onUnsubscribeFromSpaceRequest: QueueConsumerCallback<"unsubscribeFromSpaceRequest"> =
    ({ serverId, uuid }, ack, nack) => {
      const space = this.spaces.get(uuid);
      if (space === undefined) {
        nack(new Error("space not found"));
        return;
      }

      this.unsubscribe(serverId, uuid);
      this.endIfEmpty(uuid);

      ack();
    };
}
