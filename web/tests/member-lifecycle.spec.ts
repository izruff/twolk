import { test, expect, type Page, type BrowserContext, type Browser } from '@playwright/test';
import { createSpaceViaHomePage } from './helpers';

// Each context represents a separate user.
interface User {
  name: string;
  ctx: BrowserContext;
  page: Page;
}

async function makeUser(browser: Browser, name: string): Promise<User> {
  const ctx = await browser.newContext({
    ignoreHTTPSErrors: true,
    permissions: ['microphone'],
  });
  const page = await ctx.newPage();
  page.on('console', (m) => {
    // eslint-disable-next-line no-console
    console.log(`[${name}] ${m.text()}`);
  });
  page.on('pageerror', (e) => {
    // eslint-disable-next-line no-console
    console.log(`[${name}] ERR ${e.message}`);
  });
  return { name, ctx, page };
}

async function clickSomewhere(page: Page) {
  await page.locator('body').click();
}

async function joinUser(u: User, spaceUrl: string) {
  await u.page.goto(spaceUrl);
  await clickSomewhere(u.page);
}

async function waitForMemberCount(page: Page, expected: number, timeoutMs = 20_000) {
  await page.waitForFunction(
    (n) => {
      // @ts-expect-error window.__twolkDebug attached by SpacePage
      const snap = window.__twolkDebug?.space?.getSnapshot?.();
      return snap && snap.members.length === n;
    },
    expected,
    { timeout: timeoutMs },
  );
}

// Waits until every entry in _consumerMembers has a ready transport whose
// underlying mediasoup transport reports ICE connectionState === 'connected'
// and whose received track is live + unmuted (i.e., RTP is actually flowing).
async function waitForAllConsumersFlowing(page: Page, expectedCount: number, timeoutMs = 60_000) {
  await page.waitForFunction(
    (n) => {
      // @ts-expect-error
      const debug = window.__twolkDebug;
      if (!debug?.space?._consumerMembers) return false;
      const members = Array.from(
        debug.space._consumerMembers.values(),
      ) as any[];
      if (members.length !== n) return false;
      return members.every((m) => {
        const t = m._transport;
        if (!t || t.isReady?.() !== true) return false;
        const msConsumer = t._consumer?._mediasoupConsumer;
        if (!msConsumer) return false;
        if (t._mediasoupTransport?.connectionState !== 'connected') return false;
        const track = msConsumer.track;
        if (!track || track.readyState !== 'live' || track.muted) return false;
        return true;
      });
    },
    expectedCount,
    { timeout: timeoutMs },
  );
}

// Polls until producer analyzer AND every consumer analyzer report some
// non-zero frequency bin. This is the only reliable signal that the Web Audio
// graph is actually pulling samples — the ICE connection state and track-muted
// flag flip true a beat before FFT data starts populating.
async function waitForAllAnalyzersHaveSignal(page: Page, timeoutMs = 30_000) {
  await page.waitForFunction(
    () => {
      // @ts-expect-error
      const d = window.__twolkDebug;
      if (!d) return false;

      const analyserHasSignal = (a: AnalyserNode | null | undefined): boolean => {
        if (!a) return false;
        const buf = new Uint8Array(a.frequencyBinCount);
        a.getByteFrequencyData(buf);
        for (let i = 0; i < buf.length; i++) {
          if (buf[i] > 0) return true;
        }
        return false;
      };

      if (!analyserHasSignal(d.producerAnalyzer)) return false;
      const consumerAnalyzers: Map<number, AnalyserNode> | undefined =
        d.consumerAnalyzers;
      if (!consumerAnalyzers) return false;
      for (const a of consumerAnalyzers.values()) {
        if (!analyserHasSignal(a)) return false;
      }
      return true;
    },
    null,
    { timeout: timeoutMs },
  );
}

async function readObserverDebug(page: Page) {
  return await page.evaluate(() => {
    // @ts-expect-error window.__twolkDebug attached by SpacePage
    const d = window.__twolkDebug;
    if (!d) return null;

    const snapshot = d.space?.getSnapshot?.() ?? null;
    const producerId = snapshot?.producer?.id ?? null;
    const memberIds: number[] = (snapshot?.members ?? []).map(
      (m: any) => m.id,
    );

    let producerAnalyzerInfo: { nonZeroByteCount: number; maxByte: number } | null = null;
    if (d.producerAnalyzer) {
      const a: AnalyserNode = d.producerAnalyzer;
      const buf = new Uint8Array(a.frequencyBinCount);
      a.getByteFrequencyData(buf);
      let nz = 0, mx = 0;
      for (let i = 0; i < buf.length; i++) {
        if (buf[i] > 0) nz++;
        if (buf[i] > mx) mx = buf[i];
      }
      producerAnalyzerInfo = { nonZeroByteCount: nz, maxByte: mx };
    }

    const consumerMembers = d.space?._consumerMembers
      ? (Array.from(d.space._consumerMembers.entries()) as [number, any][])
      : [];

    const consumers = consumerMembers.map(([id, m]) => {
      const transport = m._transport;
      const msConsumer = transport?._consumer?._mediasoupConsumer ?? null;
      const track: MediaStreamTrack | null = msConsumer?.track ?? null;
      const audio: HTMLAudioElement | undefined =
        d.consumerAudioRefs?.get(id);
      const analyzer: AnalyserNode | undefined = d.consumerAnalyzers?.get(id);

      let nz = 0, mx = 0;
      if (analyzer) {
        const buf = new Uint8Array(analyzer.frequencyBinCount);
        analyzer.getByteFrequencyData(buf);
        for (let i = 0; i < buf.length; i++) {
          if (buf[i] > 0) nz++;
          if (buf[i] > mx) mx = buf[i];
        }
      }

      return {
        memberId: id,
        transportReady: transport?.isReady?.() ?? false,
        connectionState:
          transport?._mediasoupTransport?.connectionState ?? null,
        trackMuted: track?.muted ?? null,
        trackReadyState: track?.readyState ?? null,
        audioPaused: audio?.paused ?? null,
        analyzerAttached: analyzer != null,
        analyzerNonZeroByteCount: nz,
        analyzerMaxByte: mx,
      };
    });

    return {
      audioContextState: d.audioContext?.state ?? null,
      producerId,
      memberIds,
      producerAnalyzer: producerAnalyzerInfo,
      consumers,
    };
  });
}

async function assertObserverState(
  page: Page,
  label: string,
  expectedMemberCount: number,
) {
  // Wait for everything to converge (snapshot + transports + RTP + FFT bins).
  await waitForMemberCount(page, expectedMemberCount);
  try {
    await waitForAllConsumersFlowing(page, expectedMemberCount - 1);
  } catch (e) {
    const snap = await readObserverDebug(page);
    // eslint-disable-next-line no-console
    console.log(`---- waitForAllConsumersFlowing TIMED OUT (${label}) ----`);
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(snap, null, 2));
    throw e;
  }
  await waitForAllAnalyzersHaveSignal(page);

  const debug = await readObserverDebug(page);
  // eslint-disable-next-line no-console
  console.log(`---- Observer state (${label}) ----`);
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(debug, null, 2));

  expect(debug, `${label}: debug present`).not.toBeNull();
  expect(debug!.audioContextState, `${label}: audio context running`).toBe('running');

  // Space + Member objects:
  expect(debug!.memberIds.length, `${label}: snapshot member count`).toBe(expectedMemberCount);
  expect(debug!.consumers.length, `${label}: consumer count`).toBe(expectedMemberCount - 1);
  expect(debug!.memberIds, `${label}: observer is in member list`).toContain(debug!.producerId);

  const consumerIds = debug!.consumers.map((c) => c.memberId).sort();
  const expectedConsumerIds = debug!.memberIds
    .filter((id) => id !== debug!.producerId)
    .sort();
  expect(consumerIds, `${label}: consumer ids match non-self member ids`).toEqual(
    expectedConsumerIds,
  );

  // Components rendered (each SpaceMemberBox renders exactly one <canvas>).
  const canvasCount = await page.locator('canvas').count();
  expect(canvasCount, `${label}: rendered SpaceMemberBox count`).toBe(expectedMemberCount);

  // Observer's own audio visualizer (producer analyzer):
  expect(debug!.producerAnalyzer, `${label}: producer analyzer attached`).not.toBeNull();
  expect(
    debug!.producerAnalyzer!.nonZeroByteCount,
    `${label}: producer analyzer sees signal (max=${debug!.producerAnalyzer!.maxByte})`,
  ).toBeGreaterThan(0);

  // Audio + visualizer for each remote member:
  for (const c of debug!.consumers) {
    expect(c.transportReady, `${label}: consumer ${c.memberId} transport ready`).toBe(true);
    expect(c.connectionState, `${label}: consumer ${c.memberId} ICE connected`).toBe('connected');
    expect(c.trackReadyState, `${label}: consumer ${c.memberId} track live`).toBe('live');
    expect(c.trackMuted, `${label}: consumer ${c.memberId} track unmuted`).toBe(false);
    expect(c.audioPaused, `${label}: consumer ${c.memberId} audio playing`).toBe(false);
    expect(c.analyzerAttached, `${label}: consumer ${c.memberId} analyzer attached`).toBe(true);
    expect(
      c.analyzerNonZeroByteCount,
      `${label}: consumer ${c.memberId} analyzer sees signal (max=${c.analyzerMaxByte})`,
    ).toBeGreaterThan(0);
  }
}

test('observer correctly tracks four members across join/leave transitions', async ({
  browser,
}) => {
  // X: in room before observer, stays
  // Y: in room before observer, leaves before observer
  // O: the observer
  // Z: joins after observer, stays
  // W: joins after observer, leaves before observer
  const X = await makeUser(browser, 'X');
  const Y = await makeUser(browser, 'Y');
  const O = await makeUser(browser, 'O');
  const Z = await makeUser(browser, 'Z');
  const W = await makeUser(browser, 'W');

  // Step 1: X creates the space via the home page and joins (alone). The
  // others join the resulting URL.
  const SPACE_URL = await createSpaceViaHomePage(X.page);
  await clickSomewhere(X.page);
  await waitForMemberCount(X.page, 1);

  // Step 2: Y joins
  await joinUser(Y, SPACE_URL);
  await waitForMemberCount(Y.page, 2);
  // X also sees Y now
  await waitForMemberCount(X.page, 2);

  // Step 3: Observer joins — should see X and Y as existing members.
  await joinUser(O, SPACE_URL);
  await assertObserverState(O.page, 'after O joins (X,Y already present)', 3);

  // Step 4: Z joins after observer.
  await joinUser(Z, SPACE_URL);
  await assertObserverState(O.page, 'after Z joins', 4);

  // Step 5: W joins after observer.
  await joinUser(W, SPACE_URL);
  await assertObserverState(O.page, 'after W joins', 5);

  // Step 6: W leaves before observer.
  await W.ctx.close();
  await assertObserverState(O.page, 'after W leaves', 4);

  // Step 7: Y leaves before observer (Y was already there before observer).
  await Y.ctx.close();
  await assertObserverState(O.page, 'after Y leaves', 3);

  // Cleanup remaining contexts.
  await Promise.all([X.ctx.close(), Z.ctx.close(), O.ctx.close()]);
});
