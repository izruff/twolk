/* eslint-disable no-console */
import { test, expect, type Page } from '@playwright/test';
import {
  type User,
  makeUser,
  createSpaceViaHomePage,
  joinUser,
  clickSomewhere,
  waitForMemberCount,
  waitForAllConsumersFlowing,
  waitForAllAnalyzersHaveSignal,
  readSpaceDebug,
} from './helpers';


async function assertObserverState(
  page: Page,
  label: string,
  expectedMemberCount: number,
) {
  await waitForMemberCount(page, expectedMemberCount);
  try {
    await waitForAllConsumersFlowing(page, expectedMemberCount - 1);
  } catch (e) {
    const snap = await readSpaceDebug(page);
    console.log(`---- waitForAllConsumersFlowing TIMED OUT (${label}) ----`);
    console.log(JSON.stringify(snap, null, 2));
    throw e;
  }
  await waitForAllAnalyzersHaveSignal(page);

  const debug = await readSpaceDebug(page);
  console.log(`---- Observer state (${label}) ----`);
  console.log(JSON.stringify(debug, null, 2));

  expect(debug, `${label}: debug present`).not.toBeNull();
  expect(debug!.audioContextState, `${label}: audio context running`).toBe('running');

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

  const canvasCount = await page.locator('canvas').count();
  expect(canvasCount, `${label}: rendered SpaceMemberBox count`).toBe(expectedMemberCount);

  expect(
    debug!.producerInfo?.analyzer,
    `${label}: producer analyser attached`,
  ).not.toBeNull();
  expect(
    debug!.producerInfo!.analyzer!.nonZeroByteCount,
    `${label}: producer analyser sees signal (max=${debug!.producerInfo!.analyzer!.maxByte})`,
  ).toBeGreaterThan(0);

  for (const c of debug!.consumers) {
    expect(c.transportReady, `${label}: consumer ${c.memberId} transport ready`).toBe(true);
    expect(c.connectionState, `${label}: consumer ${c.memberId} ICE connected`).toBe('connected');
    expect(c.trackReadyState, `${label}: consumer ${c.memberId} track live`).toBe('live');
    expect(c.trackMuted, `${label}: consumer ${c.memberId} track unmuted`).toBe(false);
    expect(c.audioPaused, `${label}: consumer ${c.memberId} audio playing`).toBe(false);
    expect(c.analyzerAttached, `${label}: consumer ${c.memberId} analyser attached`).toBe(true);
    expect(
      c.analyzerNonZeroByteCount,
      `${label}: consumer ${c.memberId} analyser sees signal (max=${c.analyzerMaxByte})`,
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

  const SPACE_URL = await createSpaceViaHomePage(X.page);
  await clickSomewhere(X.page);
  await waitForMemberCount(X.page, 1);

  await joinUser(Y, SPACE_URL);
  await waitForMemberCount(Y.page, 2);
  await waitForMemberCount(X.page, 2);

  await joinUser(O, SPACE_URL);
  await assertObserverState(O.page, 'after O joins (X,Y already present)', 3);

  await joinUser(Z, SPACE_URL);
  await assertObserverState(O.page, 'after Z joins', 4);

  await joinUser(W, SPACE_URL);
  await assertObserverState(O.page, 'after W joins', 5);

  await W.ctx.close();
  await assertObserverState(O.page, 'after W leaves', 4);

  await Y.ctx.close();
  await assertObserverState(O.page, 'after Y leaves', 3);

  await Promise.all([X.ctx.close(), Z.ctx.close(), O.ctx.close()]);
});
