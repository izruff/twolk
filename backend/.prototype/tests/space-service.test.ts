/*

Unit tests for SpaceService — create/read CRUD plus the subscribe/
unsubscribe lifecycle and its status transitions
(initialized -> running -> ended).

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


function createSpace(
  bus: InProcessBus,
  data = { name: "Test", description: "a test space" },
): Promise<string> {
  return new Promise((resolve, reject) => {
    bus.publish("createSpaceRequest", { data },
      ({ uuid }) => resolve(uuid), reject);
  });
}

function subscribe(bus: InProcessBus, serverId: number, uuid: string): Promise<any> {
  return new Promise((resolve, reject) => {
    bus.publish("subscribeToSpaceRequest", { serverId, uuid }, resolve, reject);
  });
}

function unsubscribe(bus: InProcessBus, serverId: number, uuid: string): Promise<void> {
  return new Promise((resolve, reject) => {
    bus.publish("unsubscribeFromSpaceRequest", { serverId, uuid },
      () => resolve(), reject);
  });
}


describe("SpaceService CRUD", () => {
  it("creates an initialized space and reads its data back", async () => {
    const { bus, spaceStore } = buildSystem();

    const uuid = await createSpace(bus, { name: "Room", description: "hi" });

    const stored = spaceStore.get(uuid)!;
    expect(stored.status).toBe("initialized");
    expect(stored.data).toEqual({ name: "Room", description: "hi" });

    const read = await new Promise<any>((resolve, reject) => {
      bus.publish("readSpaceRequest", { uuid }, resolve, reject);
    });
    expect(read.data).toEqual({ name: "Room", description: "hi" });
    expect(read.status).toBe("initialized");
  });

  it("rejects a read for a space that does not exist", async () => {
    const { bus } = buildSystem();
    await expect(new Promise((resolve, reject) => {
      bus.publish("readSpaceRequest", { uuid: "nope" }, resolve, reject);
    })).rejects.toThrow("space not found");
  });
});


describe("SpaceService subscribe/unsubscribe", () => {
  it("first subscribe allocates the router and promotes to running", async () => {
    const { bus, spaceService, spaceStore, mediaWorker } = buildSystem();

    const uuid = await createSpace(bus);
    expect(spaceStore.get(uuid)!.status).toBe("initialized");

    const resp = await subscribe(bus, 0, uuid);

    expect(spaceService.isSubscribed(0, uuid)).toBe(true);
    expect(spaceService.hasSubscribers(uuid)).toBe(true);
    expect(spaceStore.get(uuid)!.status).toBe("running");
    expect(mediaWorker.routers).toHaveLength(1);
    expect(resp.clientSideSpace.uuid).toBe(uuid);
    expect(resp.clientSideSpace.members).toEqual([]);
    expect(resp.routerRtpCapabilities).toBeDefined();
  });

  it("a second subscribe to a running space reuses the router", async () => {
    const { bus, spaceService, mediaWorker } = buildSystem();

    const uuid = await createSpace(bus);
    await subscribe(bus, 0, uuid);
    await subscribe(bus, 1, uuid);

    expect(mediaWorker.routers).toHaveLength(1);
    expect(spaceService.isSubscribed(0, uuid)).toBe(true);
    expect(spaceService.isSubscribed(1, uuid)).toBe(true);
  });

  it("unsubscribe ends the space (keeps the record) when empty", async () => {
    const { bus, spaceService, spaceStore } = buildSystem();

    const uuid = await createSpace(bus);
    await subscribe(bus, 0, uuid);
    expect(spaceStore.get(uuid)!.status).toBe("running");

    await unsubscribe(bus, 0, uuid);

    expect(spaceService.isSubscribed(0, uuid)).toBe(false);
    expect(spaceService.hasSubscribers(uuid)).toBe(false);
    // The space is no longer destroyed — it is kept around as "ended".
    expect(spaceStore.has(uuid)).toBe(true);
    expect(spaceStore.get(uuid)!.status).toBe("ended");
  });

  it("unsubscribe with another server still subscribed keeps it running", async () => {
    const { bus, spaceService, spaceStore } = buildSystem();

    const uuid = await createSpace(bus);
    await subscribe(bus, 0, uuid);
    await subscribe(bus, 1, uuid);

    await unsubscribe(bus, 0, uuid);

    expect(spaceService.isSubscribed(0, uuid)).toBe(false);
    expect(spaceService.isSubscribed(1, uuid)).toBe(true);
    expect(spaceStore.get(uuid)!.status).toBe("running");
  });

  it("rejects subscribing to a space that does not exist", async () => {
    const { bus } = buildSystem();
    await expect(subscribe(bus, 0, "missing")).rejects.toThrow("space not found");
  });

  it("rejects subscribing to a space that has ended", async () => {
    const { bus, spaceStore } = buildSystem();

    const uuid = await createSpace(bus);
    await subscribe(bus, 0, uuid);
    await unsubscribe(bus, 0, uuid);
    expect(spaceStore.get(uuid)!.status).toBe("ended");

    await expect(subscribe(bus, 0, uuid)).rejects.toThrow("not joinable");
  });
});
