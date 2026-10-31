import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.ts';
import {
  expectFocusReturned,
  expectModalFocus,
  expectNoA11yViolationsInThemes,
  signIn,
  watchViolations,
} from './helpers.ts';
import { exclusionsFor, isAxeCheck } from './ui-exclusions.ts';

// build と wrangler dev に渡した版。playwright.config.ts が決めて process.env に置く（docs/development.md の「e2e のサーバー」）
const version = process.env.APP_VERSION || 'dev';

// 枠の部品は組織の中の画面が使う。あおば開発だけに入れるユーザー（ハルカ）で、組織の画面を開く
const today = '/aoba';
// あおば開発のワークスペース（seed）。バックログの木の行が本文の左端に並ぶ
const AOBA_WORKSPACE_ID = '019a0000-0000-7000-8000-000000000401';

test.beforeEach(async ({ context, baseURL }) => {
  await signIn(context, baseURL, 'member');
});

test('組織の画面はシェルを返し、API の版を出し、CSP の違反が無い', async ({ page }) => {
  const collect = await watchViolations(page);
  const res = await page.goto(today);
  expect(res?.status()).toBe(200);
  expect(res?.headers()['content-security-policy']).toContain("frame-ancestors 'none'");

  await expect(page.getByRole('heading', { level: 1, name: '自分の今日' })).toBeVisible();
  await expect(page.locator('p[role="status"]')).toHaveText(`API: ok（版 ${version}）`);
  expect(await collect()).toEqual([]);
});

test('1280px では左のメニューを折りたため、幅とラベルと状態を覚える', async ({ page }) => {
  const collect = await watchViolations(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(today);
  await page.evaluate(() => localStorage.removeItem('sg-nav-collapsed'));
  await page.reload();

  const app = page.locator('.app');
  const toggle = page.getByRole('button', { name: 'メニューを畳む' });
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(toggle).toHaveAttribute('aria-controls', 'app-nav');
  const before = await page.locator('.content').boundingBox();
  await toggle.click();
  const expand = page.getByRole('button', { name: 'メニューを広げる' });
  await expect(expand).toHaveAttribute('aria-expanded', 'false');
  // 押してもフォーカスはボタンに残る
  await expect(expand).toBeFocused();
  await expect(app).toHaveAttribute('data-nav-collapsed', 'true');
  await expect(page.locator('.binding')).toHaveJSProperty('offsetWidth', 64);
  const after = await page.locator('.content').boundingBox();
  expect(after!.x).toBeLessThan(before!.x);

  // 項目はアイコンだけで、名前は見えないが読み上げには残る
  const item = page.locator('.nav-item').first();
  await expect(item.locator('.nav-item-label')).toHaveCSS('opacity', '0');
  await expect(page.locator('#app-nav').getByRole('link', { name: '自分の今日' })).toBeVisible();
  // ロゴはマークだけで、リンクの名前は残り、押すと組織の画面へ戻る
  await expect(page.locator('.brand-name')).toHaveJSProperty('offsetWidth', 1);
  await expect(page.getByRole('link', { name: 'Scrum Guild' })).toHaveAttribute('href', '/aoba');

  // 再読み込みしても畳んだまま。キーボードだけで広げられる
  await page.reload();
  await expect(app).toHaveAttribute('data-nav-collapsed', 'true');
  await expect(page.locator('.binding')).toHaveJSProperty('offsetWidth', 64);
  await expand.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: 'メニューを畳む' })).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('.binding')).toHaveJSProperty('offsetWidth', 240);
  await page.keyboard.press('Space');
  await expect(expand).toHaveAttribute('aria-expanded', 'false');
  expect(await collect()).toEqual([]);
});

test('畳んだ列では、マウスを載せるかフォーカスすると項目の名前が横に見える', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(today);
  await page.getByRole('button', { name: 'メニューを畳む' }).click();
  const items = page.locator('#app-nav .nav-item');
  // キーボードで移ると名前が出る（開閉のボタンから Tab で組織の切り替えを越え、最初の項目へ）
  await page.getByRole('button', { name: 'メニューを広げる' }).focus();
  for (let i = 0; i < 5 && !(await items.nth(0).evaluate((el) => el === document.activeElement)); i++)
    await page.keyboard.press('Tab');
  await expect(items.nth(0)).toBeFocused();
  await expect(items.nth(0).locator('.nav-item-label')).toHaveCSS('opacity', '1');
  await items.nth(1).hover();
  await expect(items.nth(1).locator('.nav-item-label')).toHaveCSS('opacity', '1');
  // 名前は列の外（右）に浮く
  const label = await items.nth(1).locator('.nav-item-label').boundingBox();
  expect(label!.x).toBeGreaterThanOrEqual(64);

  // マウスで押した後は、マウスを外せば名前が消える（押したリンクにフォーカスが残っても出し続けない）
  await items.nth(0).click();
  await page.mouse.move(700, 600);
  await expect(items.nth(0).locator('.nav-item-label')).toHaveCSS('opacity', '0');
});

// 浮かせた名前の中の点が、本文の要素に覆われずに名前自身を返すか（名前は pointer-events: none なので、測る間だけ戻す）
async function frontmostAcross(page: Page, selector: string): Promise<boolean[]> {
  return page.locator(selector).evaluate((el: HTMLElement) => {
    el.style.pointerEvents = 'auto';
    const r = el.getBoundingClientRect();
    const hits = [0.1, 0.5, 0.9].map((f) => {
      const hit = document.elementFromPoint(r.left + r.width * f, r.top + r.height / 2);
      return hit !== null && el.contains(hit);
    });
    el.style.pointerEvents = '';
    return hits;
  });
}

test('畳んだ列の名前と組織の一覧は、バックログの行に覆われず、列の外に出る', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/aoba/w/${AOBA_WORKSPACE_ID}`);
  await expect(page.locator('.tree-row').first()).toBeVisible();
  await page.getByRole('button', { name: 'メニューを畳む' }).click();

  const backlog = page.locator('#app-nav').getByRole('link', { name: 'バックログ' });
  await backlog.hover();
  const label = backlog.locator('.nav-item-label');
  await expect(label).toHaveCSS('opacity', '1');
  expect((await label.boundingBox())!.x).toBeGreaterThanOrEqual(64);
  expect(await frontmostAcross(page, '#app-nav .nav-item[aria-current="page"] .nav-item-label')).toEqual([
    true,
    true,
    true,
  ]);
});

test('760px 以下では、畳んだままでも開閉のボタンが無く、帯の形で出る', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(today);
  await page.getByRole('button', { name: 'メニューを畳む' }).click();
  await page.setViewportSize({ width: 390, height: 700 });
  await expect(page.locator('.nav-toggle')).toBeHidden();
  await expect(page.locator('.binding')).toHaveCSS('border-right-width', '0px');
  await expect(page.locator('.brand-name')).toBeVisible();
  await expect(page.locator('.nav-item-label').first()).toHaveCSS('opacity', '1');
});

test('畳んだ列のまま、全テーマでアクセシビリティの検査と CSP の違反が無い', async ({ page }) => {
  const collect = await watchViolations(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(today);
  await page.getByRole('button', { name: 'メニューを畳む' }).click();
  // 畳んだ列では組織のボタンの見える文字（「組織」と名前）を隠すので、#343 の見える名前と aria-label の食い違いが起きない。
  // その除外を渡すと「当たらなくなった除外」で落ちるので外す（広げた列では今までどおり当たる）
  const exclusions = exclusionsFor('today', isAxeCheck).filter(
    (exclusion) => !(exclusion.check === 'label-content-name-mismatch' && exclusion.selector === '.org-menu-button'),
  );
  await expectNoA11yViolationsInThemes(page, 'today', exclusions);
  expect(await collect()).toEqual([]);
});

test.describe('組織が2つの人（ミナト）', () => {
  test.beforeEach(async ({ context, baseURL }) => {
    await signIn(context, baseURL, 'admin');
  });

  test('畳んだ列から組織の切り替えを開いて別の組織へ移れる', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(today);
    await page.getByRole('button', { name: 'メニューを畳む' }).click();
    const org = page.getByRole('button', { name: 'あおば開発。組織を切り替える' });
    await expect(org).toBeVisible();
    // 招待が無いときは印を出さない
    await expect(org.locator('.org-menu-invite')).toHaveCount(0);
    await org.click();
    const list = page.getByRole('list', { name: '入れる組織' });
    await expect(list).toBeVisible();
    // 一覧は列の横に浮かせる
    expect((await list.boundingBox())!.x).toBeGreaterThanOrEqual(64);
    await list.getByRole('link', { name: 'ひばり工房' }).click();
    await expect(page).toHaveURL(/\/hibari$/);
    await expect(page.locator('.app')).toHaveAttribute('data-nav-collapsed', 'true');
  });

  test('バックログの画面でも、畳んだ列から開いた組織の一覧は本文の行に覆われない', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`/aoba/w/${AOBA_WORKSPACE_ID}`);
    await expect(page.locator('.tree-row').first()).toBeVisible();
    await page.getByRole('button', { name: 'メニューを畳む' }).click();
    await page.locator('.org-menu-button').click();
    for (const selector of ['.org-menu-list li:first-child a', '.org-menu-list li:last-child a'])
      expect(await frontmostAcross(page, selector)).toEqual([true, true, true]);
  });

  test('畳んだ列でも、届いた招待があることが印と読み上げで分かる', async ({ page }) => {
    await page.route('**/api/my-organizations', (route) =>
      route.fulfill({
        json: {
          organizations: [{ slug: 'aoba', name: 'あおば開発' }],
          invitations: [{ organization_name: 'つばめ商会', slug: 'tsubame' }],
          operator: false,
        },
      }),
    );
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(today);
    await page.getByRole('button', { name: 'メニューを畳む' }).click();
    const org = page.locator('.org-menu-button');
    await expect(org).toHaveAttribute('aria-label', /届いた招待あり/);
    await expect(org.locator('.org-menu-invite')).toBeVisible();
  });
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
  await page.goto(today);
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
  await page.goto(today);
  await expect(page.getByRole('heading', { level: 1, name: '自分の今日' })).toBeVisible();

  const seen = await page.evaluate(
    () => (window as unknown as { __themeSeen: { theme: string | undefined; bodyExists: boolean }[] }).__themeSeen,
  );
  expect(seen[0]).toEqual({ theme: 'medieval', bodyExists: false });
  expect(await collect()).toEqual([]);
});

test('覚えた値が壊れていても、落ちずに描く', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('sg-theme', 'retro'));
  await page.goto(today);
  await expect(page.getByRole('heading', { level: 1, name: '自分の今日' })).toBeVisible();
  // 壊れた値は先当てで無視され、組織の値（seed は simple）が当たる
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'simple');
});

test('ダイアログをキーボードだけで開閉でき、閉じたら開いたボタンにフォーカスが戻る', async ({ page }) => {
  const collect = await watchViolations(page);
  await page.goto(today);
  const opener = page.getByRole('button', { name: '詳細を見る' });
  const dialog = page.getByRole('dialog', { name: 'API の詳細' });
  await expectModalFocus(page, { opener, modal: dialog, press: 'Enter' });

  // 閉じるボタンからも同じく戻る
  await page.keyboard.press('Enter');
  await expect(dialog).toBeVisible();
  await expect(page.getByRole('button', { name: '閉じる' }).last()).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(dialog).toBeHidden();
  await expectFocusReturned(page, opener);
  expect(await collect()).toEqual([]);
});

// Safari と Firefox はクリックしたボタンにフォーカスを移さない。mousedown の既定の動作を止めて同じ状態にし、
// 画面が開く操作を起こしたボタン（show(trigger)）へフォーカスを戻すことを確かめる
test('クリックでボタンにフォーカスが乗らなくても、閉じたら開いたボタンにフォーカスが戻る', async ({ page }) => {
  await page.goto(today);
  const opener = page.getByRole('button', { name: '詳細を見る' });
  await opener.evaluate((button) => button.addEventListener('mousedown', (event) => event.preventDefault()));
  await expectModalFocus(page, { opener, modal: page.getByRole('dialog', { name: 'API の詳細' }) });
});

test('ダイアログの外側を押すと閉じ、中と外をまたいでドラッグしても閉じない', async ({ page }) => {
  await page.goto(today);
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
  await expectFocusReturned(page, open);
});

// モーダルのダイアログが開くと、その外は inert になる。トーストはダイアログの中の領域に出る
test('ダイアログを開いたままトーストを出すと、前面に見えて、読み上げの領域が inert でない', async ({ page }) => {
  await page.goto(today);
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
  await page.goto(today);
  await expect(page.locator('p[role="status"]')).toHaveText(`API: ok（版 ${version}）`);

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
  await page.goto(today);
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
  await page.goto(today);
  const avatar = page.getByRole('img', { name: 'ハルカ' });
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
  await page.goto(today);
  await expect(page).toHaveTitle('自分の今日 - Scrum Guild');
  // 出る項目はすべて行き先を持つ（画面のある項目だけ）。今の画面は1つだけ
  await expect(page.locator('.nav-item')).not.toHaveCount(0);
  for (const item of await page.locator('.nav-item').all()) await expect(item).toHaveAttribute('href', /^\/aoba/);
  await expect(page.locator('.nav-item[aria-current="page"]')).toHaveCount(1);
  await expect(page.locator('.is-later')).toHaveCount(0);
  // 項目が1つも無いグループは、見出しごと出さない（見出しの次は必ず項目）
  const emptyGroups = await page
    .locator('.nav-group')
    .evaluateAll(
      (groups) => groups.filter((group) => !group.nextElementSibling?.classList.contains('nav-item')).length,
    );
  expect(emptyGroups).toBe(0);
});

// 本番の版は40文字の SHA。狭い幅でも横にはみ出さない
test('320px の幅で、40文字の版とダイアログの JSON が横にはみ出さない', async ({ page }) => {
  const sha = '9f2c4e7a1b3d5f60718293a4b5c6d7e8f901a2b3';
  await page.route('**/api/health', (route) => route.fulfill({ json: { status: 'ok', database: 'ok', version: sha } }));
  await page.setViewportSize({ width: 320, height: 700 });
  await page.goto(today);
  await expect(page.locator('p[role="status"]')).toHaveText(`API: ok（版 ${sha}）`);

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

// 経路に合わない深いパスも SPA の fallback で 200 のシェルを返し、404 は SvelteKit が画面の中で描く
test('経路に合わないパスも 200 でシェルを返し、CSP の違反が無い', async ({ page }) => {
  const collect = await watchViolations(page);
  const res = await page.goto('/foo/bar/baz');
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

// 760px 以下ではメニューが上の帯になる。本文が画面の高さに届かなくても、メニューは中身の高さのままで、余りは本文が受け取る
for (const width of [390, 672]) {
  test(`幅 ${width}px で本文が短くても、メニューの下に空きが出ない`, async ({ page }) => {
    const height = 2000;
    await page.setViewportSize({ width, height });
    await page.goto(today);
    await expect(page.getByRole('heading', { level: 1, name: '自分の今日' })).toBeVisible();
    // 本文が画面より長いと空きは出ないので、この検査の前提が崩れたことを空きの失敗と分けて出す
    const pageHeight = await page.evaluate(() => document.documentElement.scrollHeight);
    expect(pageHeight, '画面の内容が高さを超えたので、height を上げる').toBeLessThanOrEqual(height);

    const binding = await page.locator('.binding').boundingBox();
    const inner = await page.locator('.binding-inner').boundingBox();
    const sheet = await page.locator('.sheet').boundingBox();
    if (!binding || !inner || !sheet) throw new Error('枠の要素の位置が取れない');
    // .binding は下の罫線（テーマで太さが変わる）の分だけ中身より高い
    const rule = await page
      .locator('.binding')
      .evaluate((element) => parseFloat(getComputedStyle(element).borderBottomWidth));
    expect(binding.height - rule).toBeCloseTo(inner.height, 0);
    expect(sheet.y + sheet.height).toBeCloseTo(height, 0);
  });
}

// 画面のシェルが出す版は API から取ったものなので、build に埋めた kit.version.name は SvelteKit が書き出す version.json で見る
test('画面の build に埋めた版が API の版と同じ', async ({ request }) => {
  const res = await request.get('/_app/version.json');
  expect(res.status()).toBe(200);
  expect(await res.json()).toEqual({ version });
});
