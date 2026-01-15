/* eslint-disable no-console */
import { test, expect, type Page } from '@playwright/test';
import {
  makeUser,
  createSpaceViaHomePage,
  joinUser,
  clickSomewhere,
  waitForMemberCount,
} from './helpers';


// Returns the isMuted state of the non-self member in the page's snapshot.
async function otherMemberMuted(page: Page): Promise<boolean | null> {
  return await page.evaluate(() => {
    // @ts-expect-error window.__twolkDebug attached by SpacePage
    const snap = window.__twolkDebug?.space?.getSnapshot?.();
    if (!snap) return null;
    const other = snap.members.find((m: any) => m.id !== snap.producer.id);
    return other ? other.state.isMuted : null;
  });
}


test('mute disables the audio track and propagates isMuted to other members', async ({
  browser,
}) => {
  const A = await makeUser(browser, 'A');
  const B = await makeUser(browser, 'B');

  const SPACE_URL = await createSpaceViaHomePage(A.page);
  await clickSomewhere(A.page);
  await joinUser(B, SPACE_URL);

  await waitForMemberCount(A.page, 2);
  await waitForMemberCount(B.page, 2);

  // Wait until A's mic track exists, and confirm it starts enabled + unmuted.
  await A.page.waitForFunction(
    // @ts-expect-error
    () => window.__twolkDebug?.userMediaTrack != null,
    null,
    { timeout: 20_000 },
  );
  const enabledBefore = await A.page.evaluate(
    // @ts-expect-error
    () => window.__twolkDebug.userMediaTrack.enabled,
  );
  expect(enabledBefore, 'track enabled before mute').toBe(true);
  expect(await otherMemberMuted(B.page), 'B sees A unmuted before').toBe(false);

  // A mutes.
  await A.page.getByLabel('Mute').click();

  // A's outgoing track is disabled.
  await A.page.waitForFunction(
    // @ts-expect-error
    () => window.__twolkDebug?.userMediaTrack?.enabled === false,
    null,
    { timeout: 10_000 },
  );

  // A's own button and self box reflect the muted state.
  await expect(A.page.getByLabel('Unmute')).toBeVisible();
  const aSelfMuted = await A.page.evaluate(() => {
    // @ts-expect-error
    const snap = window.__twolkDebug.space.getSnapshot();
    const self = snap.members.find((m: any) => m.id === snap.producer.id);
    return self?.state.isMuted;
  });
  expect(aSelfMuted, 'A self snapshot muted').toBe(true);

  // B sees A as muted, and renders exactly one mic-off icon (on A's box; B's
  // own mic button still shows the unmuted icon).
  await B.page.waitForFunction(
    () => {
      // @ts-expect-error
      const snap = window.__twolkDebug?.space?.getSnapshot?.();
      if (!snap || snap.members.length !== 2) return false;
      const other = snap.members.find((m: any) => m.id !== snap.producer.id);
      return other?.state.isMuted === true;
    },
    null,
    { timeout: 10_000 },
  );
  await expect(B.page.locator('.tabler-icon-microphone-off')).toHaveCount(1);

  // A unmutes: track re-enables and B sees the change.
  await A.page.getByLabel('Unmute').click();
  await A.page.waitForFunction(
    // @ts-expect-error
    () => window.__twolkDebug?.userMediaTrack?.enabled === true,
    null,
    { timeout: 10_000 },
  );
  await B.page.waitForFunction(
    () => {
      // @ts-expect-error
      const snap = window.__twolkDebug?.space?.getSnapshot?.();
      const other = snap?.members.find((m: any) => m.id !== snap.producer.id);
      return other?.state.isMuted === false;
    },
    null,
    { timeout: 10_000 },
  );

  await A.ctx.close();
  await B.ctx.close();
});
