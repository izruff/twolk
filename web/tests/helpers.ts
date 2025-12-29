import type { Page } from '@playwright/test';

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
