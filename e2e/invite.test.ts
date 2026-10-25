import { expect, test } from '@playwright/test';
import { watchViolations } from './helpers.ts';

// 招待の URL を開く画面（/invite#<秘密>）。本物の Google へは行かないので、ログインを始める POST の応答は差し替える。
// 開始の API の処理（形の検査、cross-site の拒否、レート制限、結ぶ処理）は test/invite-google.test.ts

const CLAIM_TOKEN = 'Qm7tX2vLr9aKpE4wZc8hN3bYd6fGs1uJ0oTiRl5eWxA';

test('秘密を読んだらすぐ URL から消し、ボタンを押すまでログインを始めず、押すと秘密を POST の本文だけで送る', async ({
  page,
}) => {
  const posts: {
    method: string;
    contentType: string | undefined;
    body: string | null;
    url: string;
    referer: string | undefined;
  }[] = [];
  await page.route('**/api/auth/google/start', async (route) => {
    const request = route.request();
    posts.push({
      method: request.method(),
      contentType: request.headers()['content-type'],
      body: request.postData(),
      url: request.url(),
      referer: request.headers()['referer'],
    });
    // Google へ移す代わりに、ログインの画面へ移す（本物の Google へは行かない）
    await route.fulfill({ status: 302, headers: { Location: '/login?error=invite' } });
  });
  const collect = await watchViolations(page);

  const response = await page.goto(`/invite#${CLAIM_TOKEN}`);
  // 画面のヘッダー: Referer を送らない
  expect(response?.headers()['referrer-policy']).toBe('no-referrer');
  // フォームは自分の API に POST し、302 で Google の認可の画面へ移る。Chrome は form-action をリダイレクトの先にも当てるので、
  // Google の認可の画面のホストを許している（許さないと 302 が CSP で止まる）
  expect(response?.headers()['content-security-policy']).toContain("form-action 'self' https://accounts.google.com");
  await expect(page.getByRole('heading', { level: 1, name: 'Scrum Guild への招待' })).toBeVisible();
  await expect(page).toHaveTitle('Scrum Guild への招待 - Scrum Guild');
  // 秘密は URL から消える（履歴にも残らない）。組織の名前は出さない
  await expect(page).toHaveURL(/\/invite$/);
  expect(await page.evaluate(() => location.hash)).toBe('');
  await expect(page.locator('body')).not.toContainText(CLAIM_TOKEN);
  expect(await page.locator('input[type="hidden"]').evaluate((input: HTMLInputElement) => input.value)).toBe('');
  // 左のメニューも上の帯も出ない
  await expect(page.locator('.app')).toHaveCount(0);

  // ボタンを押すまでは、ログインを始めない
  await page.waitForTimeout(300);
  expect(posts).toEqual([]);

  await page.getByRole('button', { name: 'Google でログイン' }).click();
  await expect(page).toHaveURL(/\/login\?error=invite$/);
  expect(posts).toHaveLength(1);
  expect(posts[0]).toMatchObject({
    method: 'POST',
    contentType: 'application/x-www-form-urlencoded',
    body: `claim_token=${CLAIM_TOKEN}`,
  });
  // Referer は付かない
  expect(posts[0]!.referer).toBeUndefined();
  // 秘密は URL のクエリにも、フラグメントにも出ない
  expect(posts[0]!.url).not.toContain(CLAIM_TOKEN);
  expect(page.url()).not.toContain(CLAIM_TOKEN);
  await expect(page.getByRole('alert')).toContainText('この招待の URL は使えません');
  expect(await collect()).toEqual([]);
});

test('秘密が無い、形の合わない URL は、使えない旨を出してボタンを出さない', async ({ page }) => {
  const posts: string[] = [];
  await page.route('**/api/auth/google/start', (route) => {
    posts.push(route.request().url());
    return route.abort();
  });
  for (const hash of ['', '#', '#short', `#${CLAIM_TOKEN}x`, `#${CLAIM_TOKEN.slice(0, 42)}!`]) {
    // 前の URL とフラグメントだけが違う移動は、画面を読み込み直さない同じ文書の移動になる。毎回読み込み直す
    await page.goto('about:blank');
    await page.goto(`/invite${hash}`);
    await expect(page.getByRole('alert')).toContainText('この招待の URL は使えません');
    await expect(page.getByRole('button', { name: 'Google でログイン' })).toHaveCount(0);
    await expect(page).toHaveURL(/\/invite$/);
  }
  expect(posts).toEqual([]);
});

test('/login?error=invite は、使えない旨を出す', async ({ page }) => {
  await page.goto('/login?error=invite');
  await expect(page.getByRole('alert')).toContainText(
    'この招待の URL は使えません。期限が切れたか、取り消されたか、招待されたのと別のアカウントでログインしています。招待した人に確かめてください。',
  );
});

test('ほかの画面の Referrer-Policy は変えない', async ({ page }) => {
  const response = await page.goto('/login');
  expect(response?.headers()['referrer-policy']).toBe('strict-origin-when-cross-origin');
});
