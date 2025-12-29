import { test, expect, type Page, type BrowserContext } from '@playwright/test';
import { createSpaceViaHomePage } from './helpers';

// Each page must perform a user gesture so the AudioContext resumes and the
// transport factory finishes initializing.
async function clickSomewhere(page: Page) {
  await page.locator('body').click();
}

async function readDebug(page: Page) {
  return await page.evaluate(() => {
    // @ts-expect-error window.__twolkDebug attached by SpacePage in dev
    const d = window.__twolkDebug;
    if (!d) return null;

    const snapshot = d.space?.getSnapshot?.() ?? null;

    const producerMember = d.space?._producerMember;
    const producerTransport = producerMember?._transport ?? null;

    let producerAnalyzerInfo: any = null;
    if (d.producerAnalyzer) {
      const a: AnalyserNode = d.producerAnalyzer;
      const buf = new Uint8Array(a.frequencyBinCount);
      a.getByteFrequencyData(buf);
      let nz = 0, mx = 0;
      for (let i = 0; i < buf.length; i++) {
        if (buf[i] > 0) nz++;
        if (buf[i] > mx) mx = buf[i];
      }
      producerAnalyzerInfo = {
        attached: true,
        nonZeroByteCount: nz,
        maxByte: mx,
        numberOfInputs: a.numberOfInputs,
        contextState: a.context.state,
      };
    } else {
      producerAnalyzerInfo = { attached: false };
    }

    const producerInfo = producerTransport
      ? {
          ready: producerTransport.isReady?.() ?? false,
          producerAssigned:
            producerTransport._producer?._mediasoupProducer != null,
          msTransportId: producerTransport._mediasoupTransport?.id ?? null,
          connectionState:
            producerTransport._mediasoupTransport?.connectionState ?? null,
          producerAnalyzer: producerAnalyzerInfo,
        }
      : { producerAnalyzer: producerAnalyzerInfo };

    const consumerMembers = d.space?._consumerMembers
      ? Array.from(d.space._consumerMembers.entries()) as [number, any][]
      : [];

    const consumers = consumerMembers.map(([id, m]) => {
      const transport = m._transport;
      const msConsumer = transport?._consumer?._mediasoupConsumer ?? null;
      const track: MediaStreamTrack | null = msConsumer?.track ?? null;
      const audio: HTMLAudioElement | undefined =
        d.consumerAudioRefs?.get(id);
      const analyzer: AnalyserNode | undefined = d.consumerAnalyzers?.get(id);

      let nonZeroByteCount = 0;
      let maxByte = 0;
      if (analyzer) {
        const buf = new Uint8Array(analyzer.frequencyBinCount);
        analyzer.getByteFrequencyData(buf);
        for (let i = 0; i < buf.length; i++) {
          if (buf[i] > 0) nonZeroByteCount++;
          if (buf[i] > maxByte) maxByte = buf[i];
        }
      }

      return {
        memberId: id,
        transportAssigned: transport != null,
        transportReady: transport?.isReady?.() ?? false,
        msConsumerAssigned: msConsumer != null,
        msConsumerKind: msConsumer?.kind ?? null,
        msConsumerPaused: msConsumer?.paused ?? null,
        msConsumerClosed: msConsumer?.closed ?? null,
        connectionState:
          transport?._mediasoupTransport?.connectionState ?? null,
        track: track
          ? {
              kind: track.kind,
              id: track.id,
              readyState: track.readyState,
              muted: track.muted,
              enabled: track.enabled,
            }
          : null,
        audio: audio
          ? {
              paused: audio.paused,
              muted: audio.muted,
              volume: audio.volume,
              currentTime: audio.currentTime,
              srcObjectKind: audio.srcObject ? 'MediaStream' : null,
              readyState: audio.readyState,
              error: audio.error?.message ?? null,
            }
          : null,
        analyzerAttached: analyzer != null,
        analyzerNonZeroByteCount: nonZeroByteCount,
        analyzerMaxByte: maxByte,
      };
    });

    return {
      audioContextState: d.audioContext?.state ?? null,
      userMediaTrack: d.userMediaTrack
        ? {
            kind: d.userMediaTrack.kind,
            readyState: d.userMediaTrack.readyState,
            muted: d.userMediaTrack.muted,
            enabled: d.userMediaTrack.enabled,
          }
        : null,
      snapshot,
      producerInfo,
      consumers,
    };
  });
}

async function waitForBothMembers(page: Page) {
  await page.waitForFunction(
    () => {
      // @ts-expect-error
      const snap = window.__twolkDebug?.space?.getSnapshot?.();
      return snap && snap.members.length === 2;
    },
    null,
    { timeout: 20_000 },
  );
}

async function waitForConsumerReady(page: Page) {
  await page.waitForFunction(
    () => {
      // @ts-expect-error
      const debug = window.__twolkDebug;
      if (!debug?.space?._consumerMembers) return false;
      const members = Array.from(
        debug.space._consumerMembers.values(),
      ) as any[];
      if (members.length === 0) return false;
      return members.every(
        (m) =>
          m._transport &&
          m._transport.isReady?.() === true &&
          m._transport._consumer?._mediasoupConsumer != null,
      );
    },
    null,
    { timeout: 30_000 },
  );
}

test('two users in the same space hear each other', async ({ browser }) => {
  const ctxA: BrowserContext = await browser.newContext({
    ignoreHTTPSErrors: true,
    permissions: ['microphone'],
  });
  const ctxB: BrowserContext = await browser.newContext({
    ignoreHTTPSErrors: true,
    permissions: ['microphone'],
  });

  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();

  const allLogs: { who: string; text: string }[] = [];
  pageA.on('console', (m) => allLogs.push({ who: 'A', text: m.text() }));
  pageB.on('console', (m) => allLogs.push({ who: 'B', text: m.text() }));
  pageA.on('pageerror', (e) => allLogs.push({ who: 'A', text: 'ERR ' + e.message }));
  pageB.on('pageerror', (e) => allLogs.push({ who: 'B', text: 'ERR ' + e.message }));

  const stepErrors: string[] = [];
  async function step<T>(name: string, fn: () => Promise<T>): Promise<T | null> {
    try {
      const t0 = Date.now();
      const r = await fn();
      // eslint-disable-next-line no-console
      console.log(`  ✓ ${name} (${Date.now() - t0}ms)`);
      return r;
    } catch (e: any) {
      // eslint-disable-next-line no-console
      console.log(`  ✗ ${name}: ${e.message}`);
      stepErrors.push(`${name}: ${e.message}`);
      return null;
    }
  }

  // A creates the space via the home page and lands on it; B joins via the
  // resulting URL.
  const SPACE_URL = await createSpaceViaHomePage(pageA);
  await step('A.click', () => clickSomewhere(pageA));
  await step('B.goto', () => pageB.goto(SPACE_URL));
  await step('B.click', () => clickSomewhere(pageB));
  await step('A sees 2 members', () => waitForBothMembers(pageA));
  await step('B sees 2 members', () => waitForBothMembers(pageB));
  await step('A consumer ready', () => waitForConsumerReady(pageA));
  await step('B consumer ready', () => waitForConsumerReady(pageB));

  // Give RTP a moment to start flowing so the analyzer can read samples.
  await pageA.waitForTimeout(5000);

  const debugA = await readDebug(pageA);
  const debugB = await readDebug(pageB);

  // Print everything so we can see exactly what state the frontend is in.
  // eslint-disable-next-line no-console
  console.log('========== Page A debug ==========');
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(debugA, null, 2));
  // eslint-disable-next-line no-console
  console.log('========== Page B debug ==========');
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(debugB, null, 2));
  // eslint-disable-next-line no-console
  console.log('========== Console logs ==========');
  for (const l of allLogs) {
    // eslint-disable-next-line no-console
    console.log(`[${l.who}] ${l.text}`);
  }

  if (stepErrors.length > 0) {
    // eslint-disable-next-line no-console
    console.log('========== Step failures ==========');
    for (const e of stepErrors) {
      // eslint-disable-next-line no-console
      console.log('  - ' + e);
    }
  }

  await ctxA.close();
  await ctxB.close();

  expect(stepErrors, 'no step failures').toEqual([]);

  for (const [label, d] of [
    ['A', debugA],
    ['B', debugB],
  ] as const) {
    expect(d, `${label} debug present`).not.toBeNull();
    expect(d!.audioContextState, `${label} audio context`).toBe('running');
    expect(d!.snapshot?.members.length, `${label} sees 2 members`).toBe(2);
    expect(d!.producerInfo?.ready, `${label} producer ready`).toBe(true);
    expect(d!.producerInfo?.connectionState, `${label} producer transport connected`).toBe('connected');
    expect(d!.consumers.length, `${label} consumer count`).toBe(1);

    const c = d!.consumers[0];
    expect(c.transportReady, `${label} consumer transport ready`).toBe(true);
    expect(c.msConsumerAssigned, `${label} ms consumer assigned`).toBe(true);
    expect(c.msConsumerPaused, `${label} ms consumer not paused`).toBe(false);
    expect(c.connectionState, `${label} consumer transport connected`).toBe('connected');
    expect(c.track, `${label} consumer track`).not.toBeNull();
    expect(c.track!.readyState, `${label} consumer track live`).toBe('live');
    expect(c.track!.muted, `${label} consumer track not muted`).toBe(false);
    expect(c.audio, `${label} audio element attached`).not.toBeNull();
    expect(c.audio!.paused, `${label} audio element playing`).toBe(false);
    expect(c.analyzerAttached, `${label} analyzer attached`).toBe(true);
    expect(
      c.analyzerNonZeroByteCount,
      `${label} analyzer sees non-zero samples (max=${c.analyzerMaxByte})`,
    ).toBeGreaterThan(0);
  }
});
