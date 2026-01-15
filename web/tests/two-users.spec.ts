/* eslint-disable no-console */
import { test, expect } from '@playwright/test';
import {
  makeUser,
  createSpaceViaHomePage,
  joinUser,
  clickSomewhere,
  waitForMemberCount,
  waitForConsumerReady,
  readSpaceDebug,
} from './helpers';

test('two users in the same space hear each other', async ({ browser }) => {
  const A = await makeUser(browser, 'A');
  const B = await makeUser(browser, 'B');

  const SPACE_URL = await createSpaceViaHomePage(A.page);
  await clickSomewhere(A.page);
  await joinUser(B, SPACE_URL);

  await waitForMemberCount(A.page, 2);
  await waitForMemberCount(B.page, 2);
  await waitForConsumerReady(A.page);
  await waitForConsumerReady(B.page);

  // Give RTP a moment to start flowing so the analyser can read samples.
  await A.page.waitForTimeout(5000);

  const debugA = await readSpaceDebug(A.page);
  const debugB = await readSpaceDebug(B.page);

  console.log('========== Page A debug ==========');
  console.log(JSON.stringify(debugA, null, 2));
  console.log('========== Page B debug ==========');
  console.log(JSON.stringify(debugB, null, 2));

  await A.ctx.close();
  await B.ctx.close();

  for (const [label, d] of [['A', debugA], ['B', debugB]] as const) {
    expect(d, `${label} debug present`).not.toBeNull();
    expect(d!.audioContextState, `${label} audio context`).toBe('running');
    expect(d!.snapshot?.members.length, `${label} sees 2 members`).toBe(2);
    expect(d!.producerInfo?.ready, `${label} producer ready`).toBe(true);
    expect(
      d!.producerInfo?.connectionState,
      `${label} producer transport connected`,
    ).toBe('connected');
    expect(d!.consumers.length, `${label} consumer count`).toBe(1);

    const c = d!.consumers[0];
    expect(c.transportReady, `${label} consumer transport ready`).toBe(true);
    expect(c.msConsumerAssigned, `${label} ms consumer assigned`).toBe(true);
    expect(c.msConsumerPaused, `${label} ms consumer not paused`).toBe(false);
    expect(c.connectionState, `${label} consumer transport connected`).toBe('connected');
    expect(c.trackReadyState, `${label} consumer track live`).toBe('live');
    expect(c.trackMuted, `${label} consumer track not muted`).toBe(false);
    expect(c.audioPaused, `${label} audio element playing`).toBe(false);
    expect(c.analyzerAttached, `${label} analyser attached`).toBe(true);
    expect(
      c.analyzerNonZeroByteCount,
      `${label} analyser sees non-zero samples (max=${c.analyzerMaxByte})`,
    ).toBeGreaterThan(0);
  }
});
