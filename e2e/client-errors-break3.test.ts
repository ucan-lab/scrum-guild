import type { Page, Request } from '@playwright/test';
import { expect, test } from './fixtures.ts';
import { signIn } from './helpers.ts';

// 画面のエラーの送り手（Issue #376）を、実際のブラウザで崩しにいく3周目。e2e/client-errors.test.ts は /login で、
// 読み込んだ直後の画面だけを確かめた。ここでは、画面の中の移動（SvelteKit のルーター）の後と、招待の秘密を持つ /invite を確かめる

const isReport = (request: Request) =>
  request.method() === 'POST' && new URL(request.url()).pathname === '/api/client-errors';

// 捕まえていない例外を1つ起こし、送った本文を返す
async function throwAndCapture(page: Page, message: string): Promise<Record<string, unknown>> {
  const sent = page.waitForRequest(isReport);
  await page.evaluate((text) => {
    setTimeout(() => {
      throw new TypeError(text);
    });
  }, message);
  const request = await sent;
  expect((await request.response())?.status()).toBe(204);
  return request.postDataJSON() as Record<string, unknown>;
}

test('画面の中で移った後のエラーは、移った先の route.id で送る', async ({ page, context, baseURL }) => {
  await signIn(context, baseURL, 'admin');
  await page.goto('/aoba');
  await page.locator('.nav-item', { hasText: '自分の設定' }).click();
  await expect(page).toHaveURL(/\/aoba\/me$/);
  await expect(page.getByRole('heading', { level: 1, name: '自分の設定' })).toBeVisible();

  const body = await throwAndCapture(page, 'e2e boom after navigation');
  expect(body).toMatchObject({ kind: 'error', name: 'TypeError', route: '/[slug]/me' });
  expect(JSON.stringify(body)).not.toContain('aoba');
});

test('招待の画面（/invite#<秘密>）のエラーは、秘密を送らない', async ({ page }) => {
  // 招待の秘密の形（src/shared/claim-token.ts の CLAIM_TOKEN_PATTERN）。架空の値
  const secret = 'e2eInviteSecret376AAAAAAAAAAAAAAAAAAAAAAAAA';
  expect(secret).toHaveLength(43);
  await page.goto(`/invite#${secret}`);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

  const body = await throwAndCapture(page, 'e2e boom on invite');
  expect(body).toMatchObject({ kind: 'error', route: '/invite' });
  expect(JSON.stringify(body)).not.toContain(secret);
});
