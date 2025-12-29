import { test, expect, type Page, type BrowserContext } from '@playwright/test';
import { createSpace, spaceUrl } from './helpers';

async function clickSomewhere(page: Page) {
  await page.locator('body').click();
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

// isMuted of the *other* member (the one that isn't us) in this page's snapshot.
async function otherMemberMuted(page: Page): Promise<boolean | null> {
  return await page.evaluate(() => {
    // @ts-expect-error
    const snap = window.__twolkDebug?.space?.getSnapshot?.();
    if (!snap) return null;
    const other = snap.members.find((m: any) => m.id !== snap.producer.id);
    return other ? other.state.isMuted : null;
  });
}

test('mute disables the audio track and propagates isMuted to other members', async ({
  browser,
  request,
}) => {
  const SPACE_URL = spaceUrl(await createSpace(request));

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

  await pageA.goto(SPACE_URL);
  await clickSomewhere(pageA);
  await pageB.goto(SPACE_URL);
  await clickSomewhere(pageB);

  await waitForMemberCount(pageA, 2);
  await waitForMemberCount(pageB, 2);

  // Wait until A's mic track exists, and confirm it starts enabled + unmuted.
  await pageA.waitForFunction(
    () => {
      // @ts-expect-error
      return window.__twolkDebug?.userMediaTrack != null;
    },
    null,
    { timeout: 20_000 },
  );
  const enabledBefore = await pageA.evaluate(() => {
    // @ts-expect-error
    return window.__twolkDebug.userMediaTrack.enabled;
  });
  expect(enabledBefore, 'track enabled before mute').toBe(true);
  expect(await otherMemberMuted(pageB), 'B sees A unmuted before').toBe(false);

  // A mutes.
  await pageA.getByLabel('Mute').click();

  // A's outgoing track is disabled.
  await pageA.waitForFunction(
    () => {
      // @ts-expect-error
      return window.__twolkDebug?.userMediaTrack?.enabled === false;
    },
    null,
    { timeout: 10_000 },
  );

  // A's own button + self box reflect the muted state.
  await expect(pageA.getByLabel('Unmute')).toBeVisible();
  const aSelfMuted = await pageA.evaluate(() => {
    // @ts-expect-error
    const snap = window.__twolkDebug.space.getSnapshot();
    const self = snap.members.find((m: any) => m.id === snap.producer.id);
    return self?.state.isMuted;
  });
  expect(aSelfMuted, 'A self snapshot muted').toBe(true);

  // B sees A as muted, and renders exactly one mic-off icon (on A's box; B's
  // own mic button still shows the unmuted icon).
  await pageB.waitForFunction(
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
  await expect(pageB.locator('.tabler-icon-microphone-off')).toHaveCount(1);

  // A unmutes: track re-enables and B sees the change.
  await pageA.getByLabel('Unmute').click();
  await pageA.waitForFunction(
    () => {
      // @ts-expect-error
      return window.__twolkDebug?.userMediaTrack?.enabled === true;
    },
    null,
    { timeout: 10_000 },
  );
  await pageB.waitForFunction(
    () => {
      // @ts-expect-error
      const snap = window.__twolkDebug?.space?.getSnapshot?.();
      const other = snap?.members.find((m: any) => m.id !== snap.producer.id);
      return other?.state.isMuted === false;
    },
    null,
    { timeout: 10_000 },
  );

  await ctxA.close();
  await ctxB.close();
});
