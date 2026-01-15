/* eslint-disable no-console */
import type { Page, BrowserContext, Browser } from '@playwright/test';


// ─── User abstraction ────────────────────────────────────────────────────────

export interface User {
  name: string;
  ctx: BrowserContext;
  page: Page;
}

export async function makeUser(browser: Browser, name: string): Promise<User> {
  const ctx = await browser.newContext({
    ignoreHTTPSErrors: true,
    permissions: ['microphone'],
  });
  const page = await ctx.newPage();
  page.on('console', (m) => console.log(`[${name}] ${m.text()}`));
  page.on('pageerror', (e) => console.log(`[${name}] ERR ${e.message}`));
  return { name, ctx, page };
}


// ─── Navigation helpers ──────────────────────────────────────────────────────

// Create a space by driving the HomePage "Create Space" flow (open the
// modal, fill the form, submit). The app POSTs to the backend and navigates
// to the new space, so this leaves `page` on the space page and returns the
// /space/{uuid} path other pages can use to join the same space.
export async function createSpaceViaHomePage(
  page: Page,
  name = 'E2E Space',
): Promise<string> {
  await page.goto('/');
  await page.getByRole('button', { name: 'Create Space' }).click();
  await page.getByLabel('Space Name').fill(name);
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await page.waitForURL(/\/space\/.+/, { timeout: 20_000 });
  return new URL(page.url()).pathname;
}

// Navigate to a space URL and perform a click to resume the AudioContext.
export async function joinUser(user: User, spaceUrl: string): Promise<void> {
  await user.page.goto(spaceUrl);
  await clickSomewhere(user.page);
}

// Performs a body click to satisfy the user-gesture requirement for
// AudioContext.resume().
export async function clickSomewhere(page: Page): Promise<void> {
  await page.locator('body').click();
}


// ─── Wait helpers ────────────────────────────────────────────────────────────

export async function waitForMemberCount(
  page: Page,
  expected: number,
  timeoutMs = 20_000,
): Promise<void> {
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

// Waits until every consumer member has a ready transport with a mediasoup
// consumer assigned (looser check — does not verify RTP flow).
export async function waitForConsumerReady(
  page: Page,
  timeoutMs = 30_000,
): Promise<void> {
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
    { timeout: timeoutMs },
  );
}

// Waits until every consumer transport reports ICE connectionState ===
// 'connected' and its track is live and unmuted (RTP is flowing).
export async function waitForAllConsumersFlowing(
  page: Page,
  expectedCount: number,
  timeoutMs = 60_000,
): Promise<void> {
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
        return track && track.readyState === 'live' && !track.muted;
      });
    },
    expectedCount,
    { timeout: timeoutMs },
  );
}

// Waits until both the producer analyser and every consumer analyser report
// at least one non-zero frequency bin (i.e. the Web Audio graph is pulling
// samples).
export async function waitForAllAnalyzersHaveSignal(
  page: Page,
  timeoutMs = 30_000,
): Promise<void> {
  await page.waitForFunction(
    () => {
      // @ts-expect-error
      const d = window.__twolkDebug;
      if (!d) return false;

      const hasSignal = (a: AnalyserNode | null | undefined): boolean => {
        if (!a) return false;
        const buf = new Uint8Array(a.frequencyBinCount);
        a.getByteFrequencyData(buf);
        return buf.some((v) => v > 0);
      };

      if (!hasSignal(d.producerAnalyzer)) return false;
      const analyzers: Map<number, AnalyserNode> | undefined = d.consumerAnalyzers;
      if (!analyzers) return false;
      for (const a of analyzers.values()) {
        if (!hasSignal(a)) return false;
      }
      return true;
    },
    null,
    { timeout: timeoutMs },
  );
}


// ─── Debug reader ─────────────────────────────────────────────────────────────

export interface AnalyzerInfo {
  nonZeroByteCount: number;
  maxByte: number;
}

export interface ConsumerDebug {
  memberId: number;
  transportReady: boolean;
  connectionState: string | null;
  msConsumerAssigned: boolean;
  msConsumerPaused: boolean | null;
  trackReadyState: string | null;
  trackMuted: boolean | null;
  audioPaused: boolean | null;
  analyzerAttached: boolean;
  analyzerNonZeroByteCount: number;
  analyzerMaxByte: number;
}

export interface SpaceDebug {
  audioContextState: string | null;
  userMediaTrack: {
    kind: string; readyState: string; muted: boolean; enabled: boolean;
  } | null;
  snapshot: any | null;
  producerId: number | null;
  memberIds: number[];
  producerInfo: {
    ready: boolean;
    producerAssigned: boolean;
    connectionState: string | null;
    analyzer: AnalyzerInfo | null;
  } | null;
  consumers: ConsumerDebug[];
}

// Reads the full SpacePage debug state exposed on window.__twolkDebug.
export async function readSpaceDebug(page: Page): Promise<SpaceDebug | null> {
  return await page.evaluate(() => {
    // @ts-expect-error window.__twolkDebug attached by SpacePage
    const d = window.__twolkDebug;
    if (!d) return null;

    const snapshot = d.space?.getSnapshot?.() ?? null;
    const producerId: number | null = snapshot?.producer?.id ?? null;
    const memberIds: number[] = (snapshot?.members ?? []).map((m: any) => m.id);

    // Producer info
    const producerMember = d.space?._producerMember;
    const producerTransport = producerMember?._transport ?? null;
    let producerInfo: SpaceDebug['producerInfo'] = null;
    if (producerTransport) {
      let analyzer: AnalyzerInfo | null = null;
      if (d.producerAnalyzer) {
        const a: AnalyserNode = d.producerAnalyzer;
        const buf = new Uint8Array(a.frequencyBinCount);
        a.getByteFrequencyData(buf);
        let nz = 0, mx = 0;
        for (let i = 0; i < buf.length; i++) {
          if (buf[i] > 0) nz++;
          if (buf[i] > mx) mx = buf[i];
        }
        analyzer = { nonZeroByteCount: nz, maxByte: mx };
      }
      producerInfo = {
        ready: producerTransport.isReady?.() ?? false,
        producerAssigned: producerTransport._producer?._mediasoupProducer != null,
        connectionState: producerTransport._mediasoupTransport?.connectionState ?? null,
        analyzer,
      };
    } else if (d.producerAnalyzer) {
      const a: AnalyserNode = d.producerAnalyzer;
      const buf = new Uint8Array(a.frequencyBinCount);
      a.getByteFrequencyData(buf);
      let nz = 0, mx = 0;
      for (let i = 0; i < buf.length; i++) {
        if (buf[i] > 0) nz++;
        if (buf[i] > mx) mx = buf[i];
      }
      producerInfo = {
        ready: false,
        producerAssigned: false,
        connectionState: null,
        analyzer: { nonZeroByteCount: nz, maxByte: mx },
      };
    }

    // Consumer info
    const consumerEntries = d.space?._consumerMembers
      ? (Array.from(d.space._consumerMembers.entries()) as [number, any][])
      : [];

    const consumers: ConsumerDebug[] = consumerEntries.map(([id, m]) => {
      const transport = m._transport;
      const msConsumer = transport?._consumer?._mediasoupConsumer ?? null;
      const track: MediaStreamTrack | null = msConsumer?.track ?? null;
      const audio: HTMLAudioElement | undefined = d.consumerAudioRefs?.get(id);
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
        connectionState: transport?._mediasoupTransport?.connectionState ?? null,
        msConsumerAssigned: msConsumer != null,
        msConsumerPaused: msConsumer?.paused ?? null,
        trackReadyState: track?.readyState ?? null,
        trackMuted: track?.muted ?? null,
        audioPaused: audio?.paused ?? null,
        analyzerAttached: analyzer != null,
        analyzerNonZeroByteCount: nz,
        analyzerMaxByte: mx,
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
      producerId,
      memberIds,
      producerInfo,
      consumers,
    };
  }) as SpaceDebug | null;
}
