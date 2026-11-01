import { expect, test } from './fixtures.ts';
import { findA11yViolations, findOverflowViolations, findTargetSizeViolations, NARROW_VIEWPORT } from './helpers.ts';

// 会員登録の画面（枠の外。Issue #640）。ログインの画面から入り、GitHub と Google のボタンだけを出す（パスワードの登録は無い）。
// 本物の GitHub や Google へは行かない（ボタンの href を確かめるだけ）。画面の文言は辞書を通るので、ボタンは href で引く。
// seed を入れた手元の D1（pnpm db:seed）が要る

const githubStart = 'a[href*="/api/auth/github/start"]';
const googleStart = 'a[href*="/api/auth/google/start"]';

test('ログインの画面に会員登録への入口があり、押すと /signup に移る', async ({ page }) => {
  await page.goto('/login');
  const entry = page.locator('a[href^="/signup"]');
  await expect(entry).toHaveCount(1);
  await entry.click();
  await expect(page).toHaveURL(/\/signup(\?|$)/);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
});

test('/signup は枠の外に GitHub と Google のボタンだけを出し、パスワードの欄は無い', async ({ page }) => {
  await page.goto('/signup');
  // ログインしていなくても、ログインの画面へ移さず、その場に止まる
  await page.waitForTimeout(300);
  await expect(page).toHaveURL(/\/signup(\?|$)/);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

  await expect(page.locator(githubStart)).toHaveCount(1);
  await expect(page.locator(googleStart)).toHaveCount(1);
  await expect(page.locator(githubStart)).toBeVisible();
  await expect(page.locator(googleStart)).toBeVisible();
  // 登録の手段はこの2つだけ
  await expect(page.locator('a[href*="/api/auth/"]')).toHaveCount(2);
  await expect(page.locator('input[type="password"]')).toHaveCount(0);
  await expect(page.locator('input[type="email"]')).toHaveCount(0);
  await expect(page.getByLabel('パスワード', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('メールアドレス', { exact: true })).toHaveCount(0);
  // 左のメニューも上の帯も出ない
  await expect(page.locator('.app')).toHaveCount(0);
  await expect(page.getByRole('navigation')).toHaveCount(0);
});

test('ボタンの href は、登録の印（signup=1）と return_to を付けた開始の URL', async ({ page }) => {
  await page.goto('/signup');
  for (const [locator, provider] of [
    [page.locator(githubStart), 'github'],
    [page.locator(googleStart), 'google'],
  ] as const) {
    const href = (await locator.getAttribute('href')) ?? '';
    const url = new URL(href, 'http://localhost');
    expect(url.pathname).toBe(`/api/auth/${provider}/start`);
    expect(url.searchParams.get('signup')).toBe('1');
    expect(url.searchParams.get('return_to')).toBe('/');
  }
});

test('return_to は自分のサイトのパスだけを開始の URL に渡す', async ({ page }) => {
  await page.goto('/signup?return_to=%2Faoba%2Fboard%3Ftab%3D1');
  for (const locator of [page.locator(githubStart), page.locator(googleStart)]) {
    const url = new URL((await locator.getAttribute('href')) ?? '', 'http://localhost');
    expect(url.searchParams.get('signup')).toBe('1');
    expect(url.searchParams.get('return_to')).toBe('/aoba/board?tab=1');
  }

  for (const bad of ['https%3A%2F%2Fevil.example%2F', '%2F%2Fevil.example', '%2F%5Cevil.example', '%2Fapi%2Fhealth']) {
    await page.goto(`/signup?return_to=${bad}`);
    const url = new URL((await page.locator(githubStart).getAttribute('href')) ?? '', 'http://localhost');
    expect(url.searchParams.get('return_to')).toBe('/');
  }
});

test('ログインの画面のボタンは、登録の印を付けない（ログインのボタンからはアカウントを作らない）', async ({ page }) => {
  await page.goto('/login');
  for (const locator of [page.locator(githubStart), page.locator(googleStart)]) {
    const url = new URL((await locator.getAttribute('href')) ?? '', 'http://localhost');
    expect(url.searchParams.has('signup')).toBe(false);
  }
});

test('登録の開始は Worker が 302 で答え、画面の fallback を返さない', async ({ request }) => {
  const res = await request.get('/api/auth/github/start?signup=1&return_to=%2F', { maxRedirects: 0 });
  expect(res.status()).toBe(302);
  // 開発用の OAuth App を .dev.vars に入れていれば GitHub へ、無ければログインの画面へ戻る（失敗は今の /login?error= へ）
  expect(res.headers().location).toMatch(
    /^(https:\/\/github\.com\/login\/oauth\/authorize\?|\/login\?error=unavailable)/,
  );
  expect(res.headers()['cache-control']).toBe('no-store');
});

test('会員登録の画面は、幅 390px で横にはみ出さず、押せる範囲が足り、axe の違反が無い', async ({ page }) => {
  await page.setViewportSize(NARROW_VIEWPORT);
  await page.goto('/signup');
  await expect(page.locator(githubStart)).toBeVisible();
  expect(await findOverflowViolations(page)).toEqual([]);
  expect(await findTargetSizeViolations(page)).toEqual([]);
  expect(await findA11yViolations(page)).toEqual([]);
});
