/*

Unit tests for SpaceService — subscribe/unsubscribe bookkeeping and the
implicit space-create on first subscribe.

Wires SpaceService against a real InProcessBus and a real
RouterAllocator + TransportAllocator backed by a FakeMediaWorker, so
the router-allocation half of the subscribeToSpace flow runs end to
end without mediasoup.

*/

import { describe, it, expect } from "vitest";

import { InProcessBus } from "../bus.ts";
import { SpaceService } from "../space-service.ts";
import { RouterAllocator } from "../router-allocator.ts";
import { TransportAllocator } from "../transport-allocator.ts";
import { SfuWorker } from "../worker.ts";
import { InMemoryStore } from "../in-memory-store.ts";
import { ProcessCounterIdGenerator } from "../id-gen-process.ts";
import { FakeMediaWorker } from "../test-fakes/fake-media-worker.ts";
import type { Space } from "../domain.ts";
import { waitFor } from "./test-utils.ts";


function buildSystem() {
  const bus = new InProcessBus();
  const mediaWorker = new FakeMediaWorker();
  const sfuWorker = new SfuWorker(mediaWorker, bus);
  sfuWorker.start((err) => { throw err; });

  const spaceStore = new InMemoryStore<string, Space>();
  // Build allocators with the same lazy-closure pattern the Coordinator uses.
  let spaceService: SpaceService;
  const transportAllocator = new TransportAllocator(
    bus,
    (uuid) => spaceService.hasSubscribers(uuid),
    new ProcessCounterIdGenerator(),
  );
  const routerAllocator = new RouterAllocator(
    bus, transportAllocator, new ProcessCounterIdGenerator());
  spaceService = new SpaceService(bus, routerAllocator, spaceStore);
  spaceService.start();

  return { bus, spaceService, spaceStore, mediaWorker };
}


describe("SpaceService", () => {
  it("creates a space and allocates its router on first subscribe", async () => {
    const { bus, spaceService, spaceStore, mediaWorker } = buildSystem();

    let resp: any = null;
    bus.publish("subscribeToSpaceRequest", { serverId: 0, uuid: "s-1" },
      (r: any) => { resp = r; },
      (e) => { throw e; });

    await waitFor(() => resp !== null);

    expect(spaceStore.has("s-1")).toBe(true);
    expect(spaceService.isSubscribed(0, "s-1")).toBe(true);
    expect(spaceService.hasSubscribers("s-1")).toBe(true);
    expect(mediaWorker.routers).toHaveLength(1);
    expect(resp.clientSideSpace.uuid).toBe("s-1");
    expect(resp.clientSideSpace.members).toEqual([]);
    expect(resp.routerRtpCapabilities).toBeDefined();
  });

  it("a second subscribe to an existing space reuses the router", async () => {
    const { bus, spaceService, mediaWorker } = buildSystem();

    await new Promise((resolve, reject) => {
      bus.publish("subscribeToSpaceRequest", { serverId: 0, uuid: "s-2" },
        () => resolve(undefined), reject);
    });
    await new Promise((resolve, reject) => {
      bus.publish("subscribeToSpaceRequest", { serverId: 1, uuid: "s-2" },
        () => resolve(undefined), reject);
    });

    expect(mediaWorker.routers).toHaveLength(1);
    expect(spaceService.isSubscribed(0, "s-2")).toBe(true);
    expect(spaceService.isSubscribed(1, "s-2")).toBe(true);
  });

  it("unsubscribe drops the subscription and cleans up if empty", async () => {
    const { bus, spaceService, spaceStore } = buildSystem();

    await new Promise((resolve, reject) => {
      bus.publish("subscribeToSpaceRequest", { serverId: 0, uuid: "s-3" },
        () => resolve(undefined), reject);
    });
    expect(spaceStore.has("s-3")).toBe(true);

    await new Promise((resolve, reject) => {
      bus.publish("unsubscribeFromSpaceRequest", { serverId: 0, uuid: "s-3" },
        () => resolve(undefined), reject);
    });

    expect(spaceService.isSubscribed(0, "s-3")).toBe(false);
    expect(spaceService.hasSubscribers("s-3")).toBe(false);
    // Space is empty and has no subscribers — it should be removed.
    expect(spaceStore.has("s-3")).toBe(false);
  });

  it("unsubscribe with another server still subscribed keeps the space", async () => {
    const { bus, spaceService, spaceStore } = buildSystem();

    await new Promise((resolve, reject) => {
      bus.publish("subscribeToSpaceRequest", { serverId: 0, uuid: "s-4" },
        () => resolve(undefined), reject);
    });
    await new Promise((resolve, reject) => {
      bus.publish("subscribeToSpaceRequest", { serverId: 1, uuid: "s-4" },
        () => resolve(undefined), reject);
    });

    await new Promise((resolve, reject) => {
      bus.publish("unsubscribeFromSpaceRequest", { serverId: 0, uuid: "s-4" },
        () => resolve(undefined), reject);
    });

    expect(spaceService.isSubscribed(0, "s-4")).toBe(false);
    expect(spaceService.isSubscribed(1, "s-4")).toBe(true);
    expect(spaceStore.has("s-4")).toBe(true);
  });
});
