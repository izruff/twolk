/*

Tier-2 integration test. Stitches together InProcessBus + Coordinator +
SfuWorker + SignalingServer(s) with FakeMediaWorker and
FakeClientChannelAcceptor — i.e. all of the real backend code except
mediasoup and Socket.IO. Drives it with simulated client connections
and asserts on the events the server emitted back to each channel.

Each test suite runs twice: once with one signaling server and once with
two, using the YAML configs in tests/configs/. All tests use the primary
server (index 0); the second server in the two-server run exists but has
no clients, which exercises the registration / allocation code paths
without requiring cross-server client management.

*/

import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { InProcessBus } from "../bus.ts";
import { Coordinator } from "../coordinator.ts";
import { SfuWorker } from "../worker.ts";
import { SignalingServer } from "../server.ts";
import { InMemoryStore } from "../in-memory-store.ts";
import { RoundRobinStrategy } from "../allocation-strategy.ts";
import { loadConfig } from "../config.ts";
import type {
  ClientToServerEvents, ServerToClientEvents, Space as SigSpace,
} from "../server.ts";
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import type { Member as SigMember } from "../server.ts";

import { FakeMediaWorker } from "../test-fakes/fake-media-worker.ts";
import {
  FakeClientChannel, FakeClientChannelAcceptor,
} from "../test-fakes/fake-client-channel.ts";
import { waitFor } from "./test-utils.ts";


type Acceptor = FakeClientChannelAcceptor<ClientToServerEvents, ServerToClientEvents>;
type Channel = FakeClientChannel<ClientToServerEvents, ServerToClientEvents>;


const CONFIGS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), "configs");

// Paths to the four test configs used to parameterize each suite.
const TEST_CONFIGS: Array<[string, string]> = [
  ["1 server / 1 worker",  path.join(CONFIGS_DIR, "one-server-one-worker.yaml")],
  ["1 server / 2 workers", path.join(CONFIGS_DIR, "one-server-two-workers.yaml")],
  ["2 servers / 1 worker", path.join(CONFIGS_DIR, "two-servers-one-worker.yaml")],
  ["2 servers / 2 workers", path.join(CONFIGS_DIR, "two-servers-two-workers.yaml")],
];


// Build the full backend wired with fakes and start it. Returns the
// pieces tests need to drive the system.
function buildSystem(configPath: string): {
  bus: InProcessBus;
  coordinator: Coordinator;
  // Primary worker and media worker (index 0) — used by most tests.
  worker: SfuWorker;
  mediaWorker: FakeMediaWorker;
  // All workers for tests that care about count.
  workers: SfuWorker[];
  mediaWorkers: FakeMediaWorker[];
  // Primary server and acceptor (index 0) — used by all tests.
  server: SignalingServer;
  acceptor: Acceptor;
  // All servers and acceptors for tests that care about count.
  servers: SignalingServer[];
  acceptors: Acceptor[];
} {
  const config = loadConfig(configPath);
  const bus = new InProcessBus();
  const coordinator = new Coordinator(bus,
    new RoundRobinStrategy(), new RoundRobinStrategy());

  const workers: SfuWorker[] = [];
  const mediaWorkers: FakeMediaWorker[] = [];
  for (const wCfg of config.sfuWorkers) {
    const mediaWorker = new FakeMediaWorker();
    const worker = new SfuWorker(wCfg.id, mediaWorker, bus);
    workers.push(worker);
    mediaWorkers.push(mediaWorker);
  }

  const servers: SignalingServer[] = [];
  const acceptors: Acceptor[] = [];

  for (const srvCfg of config.signalingServers) {
    const acceptor = new FakeClientChannelAcceptor<
      ClientToServerEvents, ServerToClientEvents>();
    const server = new SignalingServer(
      srvCfg.id,
      `ws://test-server-${srvCfg.id}`,
      acceptor,
      bus,
      new InMemoryStore<string, SigSpace>(),
      new InMemoryStore<number, SigMember>(),
    );
    servers.push(server);
    acceptors.push(acceptor);
  }

  coordinator.start();
  workers.forEach((w) => w.start((err) => { throw err; }));
  servers.forEach((s) => s.start());

  return {
    bus, coordinator,
    worker: workers[0], mediaWorker: mediaWorkers[0],
    workers, mediaWorkers,
    server: servers[0], acceptor: acceptors[0],
    servers, acceptors,
  };
}


function findSpaceInit(channel: Channel) {
  return channel.emitted.find(
    (m) => m.event === "memberEvent" && m.args[0] === "spaceInit");
}


function newChannel(spaceUuid: string, name: string): Channel {
  return new FakeClientChannel<ClientToServerEvents, ServerToClientEvents>({
    spaceUuid,
    memberData: { name },
    memberState: { isMuted: false, transportIsConnected: false },
  });
}


// Create a space via the bus (what the HTTP server forwards) and return
// its generated uuid.
function createSpace(
  bus: InProcessBus,
  data = { name: "Test", description: "integration" },
): Promise<string> {
  return new Promise((resolve, reject) => {
    bus.publish("createSpaceRequest",
      { data, policyType: "subscription-driven" },
      ({ uuid }) => resolve(uuid), reject);
  });
}


describe.each(TEST_CONFIGS)("backend integration (%s)", (_name, configPath) => {
  it("a single member joins and receives spaceInit", async () => {
    const { bus, server, acceptor } = buildSystem(configPath);

    const uuid = await createSpace(bus);
    const channelA = newChannel(uuid, "A");
    acceptor.inject(channelA);

    await waitFor(() => channelA.emitted.some(
      (m) => m.event === "memberEvent" && m.args[0] === "spaceInit"));

    expect(channelA.lastEmitted("connectionSuccessful")).toBeDefined();
    const spaceInit = findSpaceInit(channelA);
    expect(spaceInit).toBeDefined();

    const content = spaceInit?.args[1];
    expect(content.clientSideSpace.uuid).toBe(uuid);
    expect(content.clientSideSpace.members).toHaveLength(1);
    expect(content.receivingMemberId).toBe(content.clientSideSpace.members[0].id);

    // Server has registered the channel for this member.
    expect(server.memberIdToChannel.size).toBe(1);
  });

  it("two members in the same space see each other", async () => {
    const { bus, acceptor } = buildSystem(configPath);

    const uuid = await createSpace(bus);
    const channelA = newChannel(uuid, "A");
    const channelB = newChannel(uuid, "B");

    acceptor.inject(channelA);
    await waitFor(() => channelA.emitted.some(
      (m) => m.event === "memberEvent" && m.args[0] === "spaceInit"));

    acceptor.inject(channelB);
    await waitFor(() => channelB.emitted.some(
      (m) => m.event === "memberEvent" && m.args[0] === "spaceInit"));

    // B's spaceInit shows both members.
    const bSpaceInit = findSpaceInit(channelB)!.args[1];
    expect(bSpaceInit.clientSideSpace.members).toHaveLength(2);

    // A receives a memberJoin for B.
    await waitFor(() => channelA.emitted.some(
      (m) => m.event === "spaceWideEvent" && m.args[0] === "memberJoin"
    ));
    const aMemberJoin = channelA.emitted.find(
      (m) => m.event === "spaceWideEvent" && m.args[0] === "memberJoin"
    );
    const joinedMemberId = aMemberJoin!.args[1].member.id;
    expect(joinedMemberId).toBe(bSpaceInit.receivingMemberId);
  });

  it("worker allocates a router for the first member to join a space", async () => {
    const { bus, acceptor, mediaWorker } = buildSystem(configPath);

    const uuid = await createSpace(bus);
    const channelA = newChannel(uuid, "A");
    acceptor.inject(channelA);
    await waitFor(() => channelA.emitted.some(
      (m) => m.event === "memberEvent" && m.args[0] === "spaceInit"));

    expect(mediaWorker.routers).toHaveLength(1);
    // One producer transport for A, no consumer transports (only one
    // member). The producer transport allocation happens in the
    // addMember handler.
    await waitFor(() => mediaWorker.routers[0].transports.length >= 1);
    expect(mediaWorker.routers[0].transports).toHaveLength(1);
  });

  it("second member joining triggers two consumer transports", async () => {
    const { bus, acceptor, mediaWorker } = buildSystem(configPath);

    const uuid = await createSpace(bus);
    const channelA = newChannel(uuid, "A");
    const channelB = newChannel(uuid, "B");

    acceptor.inject(channelA);
    await waitFor(() => channelA.emitted.some(
      (m) => m.event === "memberEvent" && m.args[0] === "spaceInit"));

    acceptor.inject(channelB);
    await waitFor(() => channelB.emitted.some(
      (m) => m.event === "memberEvent" && m.args[0] === "spaceInit"));

    // Wait for the full allocation cascade: B's producer transport,
    // plus A consuming from B and B consuming from A.
    // Total transports: A.producer, B.producer, A→B consumer, B→A consumer = 4.
    await waitFor(() => mediaWorker.routers[0].transports.length === 4);
    expect(mediaWorker.routers[0].transports).toHaveLength(4);
  });

  it("on channel close, the member is removed and remaining members see memberLeave",
    async () => {
      const { bus, acceptor, server } = buildSystem(configPath);

      const uuid = await createSpace(bus);
      const channelA = newChannel(uuid, "A");
      const channelB = newChannel(uuid, "B");

      acceptor.inject(channelA);
      await waitFor(() => channelA.emitted.some(
      (m) => m.event === "memberEvent" && m.args[0] === "spaceInit"));

      acceptor.inject(channelB);
      await waitFor(() => channelB.emitted.some(
      (m) => m.event === "memberEvent" && m.args[0] === "spaceInit"));

      const bSpaceInit = findSpaceInit(channelB)!.args[1];
      const bMemberId = bSpaceInit.receivingMemberId;

      // B disconnects.
      channelB.simulateClose();

      // A receives memberLeave for B.
      await waitFor(() => channelA.emitted.some(
        (m) => m.event === "spaceWideEvent" && m.args[0] === "memberLeave"
          && m.args[1].memberId === bMemberId
      ));

      // B is no longer registered on the server.
      expect(server.memberIdToChannel.has(bMemberId)).toBe(false);
    },
  );

  it("tryJoinSpaceRequest returns the server URL for a joinable space", async () => {
    const { bus, coordinator } = buildSystem(configPath);

    const uuid = await createSpace(bus);

    const serverUrl = await new Promise<string>((resolve, reject) => {
      bus.publish("tryJoinSpaceRequest", { spaceUuid: uuid },
        ({ serverUrl }) => resolve(serverUrl), reject);
    });

    // Server 0 is always first in round-robin; URL was registered as
    // "ws://test-server-0" in buildSystem above.
    expect(serverUrl).toBe("ws://test-server-0");
    expect(coordinator.channelPreAllocator.serverCount).toBeGreaterThan(0);
  });

  it("tryJoinSpaceRequest rejects an ended space", async () => {
    const { bus } = buildSystem(configPath);

    const uuid = await createSpace(bus);
    // Subscribe then immediately unsubscribe to end the space.
    await new Promise<void>((resolve, reject) => {
      bus.publish("subscribeToSpaceRequest", { serverId: 0, uuid }, () => {
        bus.publish("unsubscribeFromSpaceRequest", { serverId: 0, uuid },
          () => resolve(), reject);
      }, reject);
    });

    await expect(
      new Promise((resolve, reject) => {
        bus.publish("tryJoinSpaceRequest", { spaceUuid: uuid }, resolve, reject);
      })
    ).rejects.toThrow("not joinable");
  });
});
