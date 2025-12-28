/*

Tier-2 integration test. Stitches together InProcessBus + Coordinator +
SfuWorker + SignalingServer with FakeMediaWorker and
FakeClientChannelAcceptor — i.e. all of the real backend code except
mediasoup and Socket.IO. Drives it with simulated client connections
and asserts on the events the server emitted back to each channel.

*/

import { describe, it, expect } from "vitest";

import { InProcessBus } from "../bus.ts";
import { Coordinator } from "../coordinator.ts";
import { SfuWorker } from "../worker.ts";
import { SignalingServer } from "../server.ts";
import { InMemoryStore } from "../in-memory-store.ts";
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


// Build the full backend wired with fakes and start it. Returns the
// pieces tests need to drive the system.
function buildSystem(): {
  bus: InProcessBus;
  coordinator: Coordinator;
  worker: SfuWorker;
  server: SignalingServer;
  acceptor: Acceptor;
  mediaWorker: FakeMediaWorker;
} {
  const bus = new InProcessBus();
  const coordinator = new Coordinator(bus);
  const mediaWorker = new FakeMediaWorker();
  const worker = new SfuWorker(mediaWorker, bus);
  const acceptor = new FakeClientChannelAcceptor<ClientToServerEvents, ServerToClientEvents>();
  const server = new SignalingServer(
    /* serverId */ 0,
    acceptor,
    bus,
    // SignalingServer's own local space/member mirror
    new InMemoryStore<string, SigSpace>(),
    new InMemoryStore<number, SigMember>(),
  );

  coordinator.start();
  worker.start((err) => { throw err; });
  server.start();

  return { bus, coordinator, worker, server, acceptor, mediaWorker };
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


describe("backend integration (with fakes)", () => {
  it("a single member joins and receives spaceInit", async () => {
    const { server, acceptor } = buildSystem();

    const channelA = newChannel("space-1", "A");
    acceptor.inject(channelA);

    await waitFor(() => channelA.emitted.some(
      (m) => m.event === "memberEvent" && m.args[0] === "spaceInit"));

    expect(channelA.lastEmitted("connectionSuccessful")).toBeDefined();
    const spaceInit = findSpaceInit(channelA);
    expect(spaceInit).toBeDefined();

    const content = spaceInit?.args[1];
    expect(content.clientSideSpace.uuid).toBe("space-1");
    expect(content.clientSideSpace.members).toHaveLength(1);
    expect(content.receivingMemberId).toBe(content.clientSideSpace.members[0].id);

    // Server has registered the channel for this member.
    expect(server.memberIdToChannel.size).toBe(1);
  });

  it("two members in the same space see each other", async () => {
    const { acceptor } = buildSystem();

    const channelA = newChannel("space-2", "A");
    const channelB = newChannel("space-2", "B");

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
    const { acceptor, mediaWorker } = buildSystem();

    const channelA = newChannel("space-3", "A");
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
    const { acceptor, mediaWorker } = buildSystem();

    const channelA = newChannel("space-4", "A");
    const channelB = newChannel("space-4", "B");

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
      const { acceptor, server } = buildSystem();

      const channelA = newChannel("space-5", "A");
      const channelB = newChannel("space-5", "B");

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
});
