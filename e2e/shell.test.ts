import { expect, test, type Page } from '@playwright/test';

// build と wrangler dev に渡した版。埋めていなければ dev（docs/development.md の「版」）
const version = process.env.APP_VERSION || 'dev';

// CSP の違反は、ページのスクリプトより先に securitypolicyviolation を拾い、コンソールのエラーと合わせて集める
async function watchViolations(page: Page): Promise<() => Promise<string[]>> {
  const consoleErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => consoleErrors.push(error.message));
  await page.addInitScript(() => {
    const violations: string[] = [];
    (window as unknown as { __cspViolations: string[] }).__cspViolations = violations;
    document.addEventListener('securitypolicyviolation', (event) => {
      violations.push(`${event.violatedDirective} ${event.blockedURI}`);
    });
  });
  return async () => {
    const violations = await page.evaluate(() => (window as unknown as { __cspViolations: string[] }).__cspViolations);
    return [...violations, ...consoleErrors];
  };
}

test('/ はシェルを返し、API の版を出し、CSP の違反が無い', async ({ page }) => {
  const collect = await watchViolations(page);
  const res = await page.goto('/');
  expect(res?.status()).toBe(200);
  expect(res?.headers()['content-security-policy']).toContain("frame-ancestors 'none'");

  await expect(page.getByRole('heading', { level: 1, name: '自分の今日' })).toBeVisible();
  await expect(page.getByRole('status')).toHaveText(`API: ok（版 ${version}）`);
  expect(await collect()).toEqual([]);
});

// 書体は @fontsource を自分の Worker から配る。外への通信が無く、本来の書体が読み込まれる
test('書体を自分のオリジンから読み込み、外へ通信しない', async ({ page, baseURL }) => {
  const collect = await watchViolations(page);
  const origins = new Set<string>();
  const fonts: string[] = [];
  page.on('request', (request) => {
    origins.add(new URL(request.url()).origin);
    if (/\.woff2?$/.test(new URL(request.url()).pathname)) fonts.push(request.url());
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: '自分の今日' })).toBeVisible();
  await page.evaluate(() => document.fonts.ready);

  expect([...origins]).toEqual([new URL(baseURL ?? '').origin]);
  expect(fonts.length).toBeGreaterThan(0);
  expect(await page.evaluate(() => document.fonts.check('700 16px "BIZ UDPGothic"'))).toBe(true);
  expect(await collect()).toEqual([]);
});

// 覚えたテーマは、描く前に static/theme-init.js が html に当てる。シンプルの見た目を挟まない
test('覚えたテーマを、body ができる前に当てる', async ({ page }) => {
  const collect = await watchViolations(page);
  await page.addInitScript(() => {
    localStorage.setItem('sg-theme', 'medieval');
    const seen: { theme: string | undefined; bodyExists: boolean }[] = [];
    (window as unknown as { __themeSeen: typeof seen }).__themeSeen = seen;
    new MutationObserver(() => {
      seen.push({ theme: document.documentElement.dataset.theme, bodyExists: document.body !== null });
      // 初期化のスクリプトは html の要素ができる前に動くので、document を subtree で見る
    }).observe(document, { attributes: true, attributeFilter: ['data-theme'], subtree: true });
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: '自分の今日' })).toBeVisible();

  const seen = await page.evaluate(
    () => (window as unknown as { __themeSeen: { theme: string | undefined; bodyExists: boolean }[] }).__themeSeen,
  );
  expect(seen[0]).toEqual({ theme: 'medieval', bodyExists: false });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'medieval');
  expect(await collect()).toEqual([]);
});

test('覚えた値が壊れていても、属性なしで描く', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('sg-theme', 'retro'));
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: '自分の今日' })).toBeVisible();
  await expect(page.locator('html')).not.toHaveAttribute('data-theme', /.*/);
});

// 本番の build には、開発用のテーマと言葉の切り替えを入れない
test('開発用の切り替えが出ない', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: '自分の今日' })).toBeVisible();
  await expect(page.locator('[data-dev-switch]')).toHaveCount(0);
});

test('ダイアログをキーボードだけで開閉でき、閉じたら開いたボタンにフォーカスが戻る', async ({ page }) => {
  const collect = await watchViolations(page);
  await page.goto('/');
  const opener = page.getByRole('button', { name: '詳細を見る' });
  await opener.focus();
  await page.keyboard.press('Enter');

  const dialog = page.getByRole('dialog', { name: 'API の詳細' });
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(opener).toBeFocused();

  // 閉じるボタンからも同じく戻る
  await page.keyboard.press('Enter');
  await expect(dialog).toBeVisible();
  await expect(page.getByRole('button', { name: '閉じる' }).last()).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(dialog).toBeHidden();
  await expect(opener).toBeFocused();
  expect(await collect()).toEqual([]);
});

test('トーストを出し、数秒で消える', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '確かめ直す' }).click();
  await expect(page.getByText('API を確かめ直しました')).toBeVisible();
  await expect(page.getByText('API を確かめ直しました')).toBeHidden({ timeout: 8000 });
});

// 画面の無いパスも SPA の fallback で 200 のシェルを返し、404 は SvelteKit が画面の中で描く
test('画面の無いパスも 200 でシェルを返し、CSP の違反が無い', async ({ page }) => {
  const collect = await watchViolations(page);
  const res = await page.goto('/foo');
  expect(res?.status()).toBe(200);
  expect(res?.headers()['content-security-policy']).toContain("frame-ancestors 'none'");

  await expect(page.getByRole('heading', { level: 1, name: '404' })).toBeVisible();
  expect(await collect()).toEqual([]);
});

test('/api/health は D1 に届いて 200 で版を返す', async ({ request }) => {
  const res = await request.get('/api/health');
  expect(res.status()).toBe(200);
  expect(await res.json()).toEqual({ status: 'ok', database: 'ok', version });
});

// 画面のシェルが出す版は API から取ったものなので、build に埋めた kit.version.name は SvelteKit が書き出す version.json で見る
test('画面の build に埋めた版が API の版と同じ', async ({ request }) => {
  const res = await request.get('/_app/version.json');
  expect(res.status()).toBe(200);
  expect(await res.json()).toEqual({ version });
});
