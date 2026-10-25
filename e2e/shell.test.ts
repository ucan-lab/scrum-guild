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

// Safari と Firefox はクリックしたボタンにフォーカスを移さない。mousedown の既定の動作を止めて同じ状態にし、
// 画面が開く操作を起こしたボタン（show(trigger)）へフォーカスを戻すことを確かめる
test('クリックでボタンにフォーカスが乗らなくても、閉じたら開いたボタンにフォーカスが戻る', async ({ page }) => {
  await page.goto('/');
  const opener = page.getByRole('button', { name: '詳細を見る' });
  await opener.evaluate((button) => button.addEventListener('mousedown', (event) => event.preventDefault()));
  await opener.click();
  const dialog = page.getByRole('dialog', { name: 'API の詳細' });
  await expect(dialog).toBeVisible();
  expect(await page.evaluate(() => document.activeElement?.closest('dialog') !== null)).toBe(true);

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(opener).toBeFocused();
});

test('ダイアログの外側を押すと閉じ、中と外をまたいでドラッグしても閉じない', async ({ page }) => {
  await page.goto('/');
  const dialog = page.getByRole('dialog', { name: 'API の詳細' });
  const open = page.getByRole('button', { name: '詳細を見る' });

  await open.click();
  await expect(dialog).toBeVisible();
  const text = await page.getByText('この画面が呼んだ API の応答です。').boundingBox();
  if (!text) throw new Error('ダイアログの本文の位置が取れない');
  // 中で押し始めて外で離す（文字の選択など）
  await page.mouse.move(text.x + 4, text.y + 4);
  await page.mouse.down();
  await page.mouse.move(4, 4);
  await page.mouse.up();
  await expect(dialog).toBeVisible();
  // 外で押し始めて中で離す
  await page.mouse.move(4, 4);
  await page.mouse.down();
  await page.mouse.move(text.x + 4, text.y + 4);
  await page.mouse.up();
  await expect(dialog).toBeVisible();

  await page.mouse.click(4, 4);
  await expect(dialog).toBeHidden();
  await expect(open).toBeFocused();
});

// モーダルのダイアログが開くと、その外は inert になる。トーストはダイアログの中の領域に出る
test('ダイアログを開いたままトーストを出すと、前面に見えて、読み上げの領域が inert でない', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '詳細を見る' }).click();
  const dialog = page.getByRole('dialog', { name: 'API の詳細' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: '確かめ直す' }).click();

  const toast = dialog.locator('.toast');
  await expect(toast).toHaveText('API を確かめました');
  const state = await toast.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    const region = element.closest('[aria-live]');
    return {
      onTop: hit !== null && element.contains(hit),
      region: region?.getAttribute('aria-live'),
      inert: element.closest('[inert]') !== null,
      regionDisplayed: region !== null && getComputedStyle(region).display !== 'none',
    };
  });
  expect(state).toEqual({ onTop: true, region: 'polite', inert: false, regionDisplayed: true });

  // 外側の領域（画面の最後に置いてある）は隠れ、同じ知らせが二重に読み上げられない。ダイアログを閉じると戻る
  const outer = page.locator('.toasts').last();
  await expect(outer).toHaveAttribute('hidden', '');
  await expect(page.locator('.toasts:visible .toast')).toHaveCount(1);

  await page.keyboard.press('Escape');
  await expect(outer).not.toHaveAttribute('hidden', '');
});

// 成功と失敗で文言とアイコンを分け、確かめている間はボタンを押せない
test('「確かめ直す」は、結果が出てから成功と失敗を分けてトーストを出し、その間は押せない', async ({ page }) => {
  let mode: 'ok' | 'fail' = 'ok';
  await page.route('**/api/health', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 400));
    if (mode === 'ok') await route.fulfill({ json: { status: 'ok', database: 'ok', version } });
    else await route.fulfill({ status: 500, json: { error: { code: 'internal', message: 'x' } } });
  });
  await page.goto('/');
  await expect(page.getByRole('status').first()).toHaveText(`API: ok（版 ${version}）`);

  // ダイアログの外の領域に出る（ダイアログが閉じている間は、中の領域は表示されない）
  const toasts = page.locator('.toasts:visible .toast');
  const recheck = page.getByRole('button', { name: '確かめ直す' });
  await recheck.click();
  await expect(recheck).toBeDisabled();
  await expect(toasts).toHaveCount(0);
  await expect(toasts).toHaveText('API を確かめました');
  await expect(toasts.locator('use')).toHaveAttribute('href', '#i-check');
  await expect(recheck).toBeEnabled();

  mode = 'fail';
  await recheck.click();
  await expect(recheck).toBeDisabled();
  await expect(toasts.last()).toHaveText('API に届きませんでした');
  await expect(toasts.last().locator('use')).toHaveAttribute('href', '#i-alert');
  await expect(recheck).toBeEnabled();
});

test('トーストは数秒で消え、同時に出るのは3件まで', async ({ page }) => {
  await page.route('**/api/health', (route) => route.fulfill({ json: { status: 'ok', database: 'ok', version } }));
  await page.goto('/');
  const recheck = page.getByRole('button', { name: '確かめ直す' });
  for (let i = 0; i < 5; i++) {
    await recheck.click();
    await expect(recheck).toBeEnabled();
  }
  const toasts = page.locator('.toasts:visible .toast');
  await expect(toasts).toHaveCount(3);
  await expect(toasts).toHaveCount(0, { timeout: 8000 });
});

// 同じ ID は同じ色。色相は style:--h（CSSOM）で渡すので CSP に止められない
test('アバターの色相が当たり、CSP の違反が無い', async ({ page }) => {
  const collect = await watchViolations(page);
  await page.goto('/');
  const avatar = page.getByRole('img', { name: '仮の利用者' });
  await expect(avatar).toBeVisible();
  const style = await avatar.evaluate((element) => ({
    hue: getComputedStyle(element).getPropertyValue('--h').trim(),
    background: getComputedStyle(element).backgroundColor,
    styleAttribute: element.getAttribute('style'),
  }));
  expect(style.hue).toMatch(/^\d+$/);
  expect(Number(style.hue)).toBeLessThan(360);
  // 初期値の hsl(210 …) ではなく、計算した色相の色になっている
  expect(style.background).not.toBe('rgba(0, 0, 0, 0)');
  expect(await collect()).toEqual([]);
});

test('画面の題名は「画面 - Scrum Guild」で、メニューには画面のある項目だけが出る', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveTitle('自分の今日 - Scrum Guild');
  await expect(page.locator('.nav-item')).toHaveText(['自分の今日']);
  await expect(page.locator('.nav-item[aria-current="page"]')).toHaveCount(1);
  // 項目が1つも無いグループは、見出しごと出さない
  await expect(page.locator('.nav-group')).toHaveCount(0);
  await expect(page.locator('.is-later')).toHaveCount(0);
});

// 本番の版は40文字の SHA。狭い幅でも横にはみ出さない
test('320px の幅で、40文字の版とダイアログの JSON が横にはみ出さない', async ({ page }) => {
  const sha = '9f2c4e7a1b3d5f60718293a4b5c6d7e8f901a2b3';
  await page.route('**/api/health', (route) => route.fulfill({ json: { status: 'ok', database: 'ok', version: sha } }));
  await page.setViewportSize({ width: 320, height: 700 });
  await page.goto('/');
  await expect(page.getByRole('status')).toHaveText(`API: ok（版 ${sha}）`);

  const overflow = () =>
    page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, inner: window.innerWidth }));
  const closed = await overflow();
  expect(closed.scroll).toBeLessThanOrEqual(closed.inner);

  await page.getByRole('button', { name: '詳細を見る' }).click();
  await expect(page.getByRole('dialog', { name: 'API の詳細' })).toBeVisible();
  const dialogBox = await page.locator('.dialog-sheet').evaluate((sheet) => ({
    sheetRight: sheet.getBoundingClientRect().right,
    contentRight: Math.max(
      ...[...sheet.querySelectorAll('.dialog-body *')].map((e) => e.getBoundingClientRect().right),
    ),
    inner: window.innerWidth,
  }));
  expect(dialogBox.sheetRight).toBeLessThanOrEqual(dialogBox.inner);
  expect(dialogBox.contentRight).toBeLessThanOrEqual(dialogBox.sheetRight);
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
