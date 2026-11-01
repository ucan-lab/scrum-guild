import type { Locator, Page } from '@playwright/test';
import { tokenCreate } from '../src/shared/operations/session/index.ts';
import { expect, test } from './fixtures.ts';
import { mockOperation } from './operations.ts';
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

test('組織の画面はシェルを返し、CSP の違反が無い', async ({ page }) => {
  const collect = await watchViolations(page);
  const res = await page.goto(today);
  expect(res?.status()).toBe(200);
  expect(res?.headers()['content-security-policy']).toContain("frame-ancestors 'none'");

  await expect(page.getByRole('heading', { level: 1, name: '今日やること' })).toBeVisible();
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

  // 今のページは、太字の名前の代わりに左の縦棒（縁）で示す
  // 縁の色は今のページのアイコンと同じ（操作の色）。縦棒は列の端でなく項目の左端に重ね（罫の太さで位置がにじまない）、
  // 64px の列の内側に収まる
  const bar = await page.locator('#app-nav .nav-item[aria-current="page"]').evaluate((el) => {
    const before = getComputedStyle(el, '::before');
    const item = el.getBoundingClientRect();
    return {
      width: before.borderLeftWidth,
      color: before.borderLeftColor,
      icon: getComputedStyle(el.querySelector('.ico')!).color,
      offset: before.left,
      left: item.left + parseFloat(before.left),
    };
  });
  expect(bar.width).toBe('3px');
  expect(bar.color).toBe(bar.icon);
  expect(bar.offset).toBe('0px');
  expect(bar.left).toBeGreaterThanOrEqual(0);
  expect(bar.left + 3).toBeLessThanOrEqual(64);

  // 項目はアイコンだけで、名前は見えないが読み上げには残る
  const item = page.locator('.nav-item').first();
  await expect(item.locator('.nav-item-label')).toHaveCSS('opacity', '0');
  await expect(page.locator('#app-nav').getByRole('link', { name: '今日やること' })).toBeVisible();
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

test.describe('ホバーのできない端末（1024px の指のタブレット）', () => {
  test.use({ viewport: { width: 1024, height: 768 }, hasTouch: true, isMobile: true });

  test('覚えた状態が畳んだでも、開閉のボタンを出さず、広げた列で出す', async ({ page }) => {
    await page.goto(today);
    expect(await page.evaluate(() => matchMedia('(hover: none)').matches)).toBe(true);
    await page.evaluate(() => localStorage.setItem('sg-nav-collapsed', 'true'));
    await page.reload();
    await expect(page.locator('.app')).toHaveAttribute('data-nav-collapsed', 'true');
    await expect(page.locator('.nav-toggle')).toBeHidden();
    await expect(page.locator('.binding')).toHaveJSProperty('offsetWidth', 240);
    // 畳んだ列のブランドの名前は 1px の見えない箱になる。toBeVisible はそれも見えると扱うので、幅で確かめる
    expect((await page.locator('.brand-name').boundingBox())!.width).toBeGreaterThan(50);
    await expect(page.locator('#app-nav .nav-item-label').first()).toHaveCSS('opacity', '1');
  });
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

  test('畳んだ列で別の組織へ移っている間は、札に「移っています」を出したままにする', async ({ page }) => {
    await page.route('**/api/hibari/organization', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      await route.continue();
    });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(today);
    await page.getByRole('button', { name: 'メニューを畳む' }).click();
    const org = page.locator('.org-menu-button');
    await org.click();
    await page.locator('.org-menu-list').getByRole('link', { name: 'ひばり工房' }).click();
    await page.mouse.move(700, 600);
    await expect(org.locator('.nav-tip')).toBeVisible();
    await expect(org.locator('.nav-tip')).toHaveText('移っています');
    await expect(page).toHaveURL(/\/hibari$/);
    await expect(org).not.toHaveAttribute('data-moving', 'true');
  });

  test('畳んだ列で移っている最中に組織の一覧を開くと、札は一覧に重ねず、閉じるとまた出る', async ({ page }) => {
    // 一覧を開き直して確かめる間、移り終わらないよう長めに待たせる
    await page.route('**/api/hibari/organization', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 4000));
      await route.continue();
    });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(today);
    await page.getByRole('button', { name: 'メニューを畳む' }).click();
    const org = page.locator('.org-menu-button');
    const tip = org.locator('.nav-tip');
    await org.click();
    await page.locator('.org-menu-list').getByRole('link', { name: 'ひばり工房' }).click();
    await page.mouse.move(700, 600);
    await expect(org).toHaveAttribute('data-moving', 'true');
    await expect(tip).toBeVisible();

    await org.click();
    await expect(org).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByRole('list', { name: '入れる組織' })).toBeVisible();
    await expect(tip).toBeHidden();

    await page.keyboard.press('Escape');
    await expect(org).toHaveAttribute('aria-expanded', 'false');
    // ホバーとフォーカスの札の規則で出ないよう、ポインターを外し、Esc でボタンに戻ったフォーカスも外してから確かめる。
    // これで札が見えるのは、移っている最中の規則（[data-moving="true"][aria-expanded="false"]）だけによる
    await page.mouse.move(700, 600);
    await org.evaluate((el) => el.blur());
    await expect(org).toHaveAttribute('data-moving', 'true');
    await expect(tip).toBeVisible();
    await expect(page).toHaveURL(/\/hibari$/);
  });

  test('バックログの画面でも、畳んだ列から開いた組織の一覧は本文の行に覆われない', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`/aoba/w/${AOBA_WORKSPACE_ID}`);
    await expect(page.locator('.tree-row').first()).toBeVisible();
    await page.getByRole('button', { name: 'メニューを畳む' }).click();
    await page.locator('.org-menu-button').click();
    for (const selector of ['.org-menu-list li:first-child a', '.org-menu-list li:last-child button'])
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
  await expect(page.getByRole('heading', { level: 1, name: '今日やること' })).toBeVisible();
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
  await expect(page.getByRole('heading', { level: 1, name: '今日やること' })).toBeVisible();

  const seen = await page.evaluate(
    () => (window as unknown as { __themeSeen: { theme: string | undefined; bodyExists: boolean }[] }).__themeSeen,
  );
  expect(seen[0]).toEqual({ theme: 'medieval', bodyExists: false });
  expect(await collect()).toEqual([]);
});

test('覚えた値が壊れていても、落ちずに描く', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('sg-theme', 'retro'));
  await page.goto(today);
  await expect(page.getByRole('heading', { level: 1, name: '今日やること' })).toBeVisible();
  // 壊れた値は先当てで無視され、組織の値（seed は simple）が当たる
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'simple');
});

// ダイアログとトーストの部品の確かめは、自分の設定（/aoba/me）の API トークンの節を使う（#686）。
// 取り消しの確認のダイアログ（seed のトークンの行から開く。やめるだけで、取り消さない）で開閉とフォーカスを、
// 発行の直後のダイアログ（発行の応答を差し替えるので、DB には何も書かない）でトーストを確かめる
const me = '/aoba/me';
const tokenSection = (page: Page) => page.getByRole('region', { name: 'API トークン', exact: true });
const revokeOpener = (page: Page) =>
  tokenSection(page)
    .getByRole('button', { name: /^API トークン「.+」を取り消す$/ })
    .first();
const revokeDialog = (page: Page) => page.getByRole('dialog', { name: /^API トークン「.+」を取り消しますか$/ });

async function openTokenSection(page: Page): Promise<void> {
  await page.goto(me);
  await expect(tokenSection(page).getByRole('table', { name: '発行済みの API トークン' })).toBeVisible();
}

// 発行の応答を差し替えて、値のダイアログを開く。トークンの値はコピーの確かめ用の偽の値で、DB には書かれない
async function openIssuedDialog(page: Page, token = `sgp_${'A'.repeat(43)}`, name = '確かめ用'): Promise<Locator> {
  await mockOperation(page, tokenCreate, {
    id: '019a0000-0000-7000-8000-00000000f686',
    name,
    scope: 'read',
    expires_at: '2099-01-01T00:00:00.000Z',
    token,
  });
  await openTokenSection(page);
  const section = tokenSection(page);
  await section.getByLabel('名前', { exact: true }).fill('確かめ用');
  await section.getByRole('button', { name: '発行する' }).click();
  const dialog = page.getByRole('dialog', { name: 'API トークンを発行しました' });
  await expect(dialog).toBeVisible();
  return dialog;
}

test.describe('ダイアログとトースト（自分の設定の API トークンの節）', () => {
  test.beforeEach(async ({ context, baseURL }) => {
    await signIn(context, baseURL, 'admin');
  });

  test('ダイアログをキーボードだけで開閉でき、閉じたら開いたボタンにフォーカスが戻る', async ({ page }) => {
    const collect = await watchViolations(page);
    await openTokenSection(page);
    const opener = revokeOpener(page);
    const dialog = revokeDialog(page);
    await expectModalFocus(page, { opener, modal: dialog, press: 'Enter' });

    // 閉じるボタン（主ボタンの「やめる」）からも同じく戻る
    await page.keyboard.press('Enter');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'やめる' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(dialog).toBeHidden();
    await expectFocusReturned(page, opener);
    expect(await collect()).toEqual([]);
  });

  // Safari と Firefox はクリックしたボタンにフォーカスを移さない。mousedown の既定の動作を止めて同じ状態にし、
  // 画面が開く操作を起こしたボタン（show(trigger)）へフォーカスを戻すことを確かめる
  test('クリックでボタンにフォーカスが乗らなくても、閉じたら開いたボタンにフォーカスが戻る', async ({ page }) => {
    await openTokenSection(page);
    const opener = revokeOpener(page);
    await opener.evaluate((button) => button.addEventListener('mousedown', (event) => event.preventDefault()));
    await expectModalFocus(page, { opener, modal: revokeDialog(page) });
  });

  test('ダイアログの外側を押すと閉じ、中と外をまたいでドラッグしても閉じない', async ({ page }) => {
    await openTokenSection(page);
    const dialog = revokeDialog(page);
    const open = revokeOpener(page);

    await open.click();
    await expect(dialog).toBeVisible();
    const text = await dialog.getByText('取り消すと、このトークンはすぐ使えなくなります。').boundingBox();
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
});

test.describe('トースト（自分の設定の API トークンの節。発行の応答を差し替える）', () => {
  test.beforeEach(async ({ context, baseURL }) => {
    await signIn(context, baseURL, 'admin');
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  });

  const copyButton = (dialog: Locator) => dialog.getByRole('button', { name: 'コピーする' });

  // モーダルのダイアログが開くと、その外は inert になる。トーストはダイアログの中の領域に出る
  test('ダイアログを開いたままトーストを出すと、前面に見えて、読み上げの領域が inert でない', async ({ page }) => {
    const dialog = await openIssuedDialog(page);
    await copyButton(dialog).click();

    const toast = dialog.locator('.toast');
    await expect(toast).toHaveText('トークンの値をコピーしました');
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

    // 外側の領域（画面の最後に置いてある）は隠れ、同じ知らせが二重に読み上げられない。ダイアログを閉じると戻る。
    // 値のダイアログは Esc では閉じないので、閉じるボタンで閉じる
    const outer = page.locator('.toasts').last();
    await expect(outer).toHaveAttribute('hidden', '');
    await expect(page.locator('.toasts:visible .toast')).toHaveCount(1);

    await dialog.locator('.dialog-foot').getByRole('button', { name: '閉じる' }).click();
    await expect(dialog).toBeHidden();
    await expect(outer).not.toHaveAttribute('hidden', '');
  });

  // 成功と失敗で文言とアイコンを分ける
  test('「コピーする」は、成功と失敗を分けて文言とアイコンのトーストを出す', async ({ page }) => {
    const dialog = await openIssuedDialog(page);
    // ダイアログを開いている間は、トーストはダイアログの中の領域に出る
    const toasts = page.locator('.toasts:visible .toast');
    await copyButton(dialog).click();
    await expect(toasts).toHaveText('トークンの値をコピーしました');
    await expect(toasts.locator('use')).toHaveAttribute('href', '#i-check');

    // 書き込みを断られたときは、失敗のトースト
    await page.evaluate(() => {
      navigator.clipboard.writeText = () => Promise.reject(new Error('denied'));
    });
    await copyButton(dialog).click();
    // 最初のトーストは4秒で消えるので、数ではなく文言で絞る
    const failed = toasts.filter({ hasText: 'コピーできませんでした。値を選んで、手でコピーしてください' });
    await expect(failed).toHaveCount(1);
    await expect(failed.locator('use')).toHaveAttribute('href', '#i-alert');
  });

  test('トーストは数秒で消え、同時に出るのは3件まで', async ({ page }) => {
    const dialog = await openIssuedDialog(page);
    for (let i = 0; i < 5; i++) await copyButton(dialog).click();
    const toasts = page.locator('.toasts:visible .toast');
    await expect(toasts).toHaveCount(3);
    await expect(toasts).toHaveCount(0, { timeout: 8000 });
  });
});

// 同じ ID は同じ色。色相は style:--h（CSSOM）で渡すので CSP に止められない
test('アバターの色相が当たり、CSP の違反が無い', async ({ page }) => {
  const collect = await watchViolations(page);
  await page.goto(today);
  // 今日やること（左のメニューと「自分の記録」の列）にも同じ名前のアバターが出るので、最初の1つを確かめる
  const avatar = page.getByRole('img', { name: 'ハルカ' }).first();
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
  await expect(page).toHaveTitle('今日やること - Scrum Guild');
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

// 値は空白が無い長い文字列。狭い幅でも、画面とダイアログが横にはみ出さない
test('320px の幅で、長いトークンの値のダイアログが横にはみ出さない', async ({ context, baseURL, page }) => {
  await signIn(context, baseURL, 'admin');
  await page.setViewportSize({ width: 320, height: 700 });
  // 空白の無い半角100文字の名前（API が通す上限）が、本文の「「…」の値です。」で折り返される
  const dialog = await openIssuedDialog(page, `sgp_${'A'.repeat(120)}`, 'A'.repeat(100));

  const overflow = () =>
    page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, inner: window.innerWidth }));
  const opened = await overflow();
  expect(opened.scroll).toBeLessThanOrEqual(opened.inner);
  await expect(dialog).toBeVisible();
  const dialogBox = await page.locator('.dialog-sheet:visible').evaluate((sheet) => ({
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
    await expect(page.getByRole('heading', { level: 1, name: '今日やること' })).toBeVisible();
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

// build に埋めた kit.version.name は SvelteKit が書き出す version.json で見る
test('画面の build に埋めた版が API の版と同じ', async ({ request }) => {
  const res = await request.get('/_app/version.json');
  expect(res.status()).toBe(200);
  expect(await res.json()).toEqual({ version });
});

// 本文（.content）は幅の上限を持たない。広い画面でも左のメニューの右から画面の右の端まで広がる
// 4000px は、左のメニューを広げても畳んでも、2000px 台の上限を見逃さない幅
const WIDE_VIEWPORT = { width: 4000, height: 900 };
// 縦スクロールバーの幅の余裕
const SCROLLBAR_ALLOWANCE = 24;
// 欄の幅の上限（design/components.css の `.form` などの 56rem）
const FORM_MAX_PX = 56 * 16;

test('4000px の幅で、本文が画面の右の端まで広がり、畳んでも変わらない', async ({ page }) => {
  await page.setViewportSize(WIDE_VIEWPORT);
  await page.goto(today);
  await page.evaluate(() => localStorage.removeItem('sg-nav-collapsed'));
  await page.reload();

  const content = page.locator('.content');
  await expect(content).toBeVisible();
  const open = await content.boundingBox();
  expect(open!.x + open!.width).toBeGreaterThan(WIDE_VIEWPORT.width - SCROLLBAR_ALLOWANCE);
  // 以前の上限（1320px）を超えている
  expect(open!.width).toBeGreaterThan(1320);

  await page.getByRole('button', { name: 'メニューを畳む' }).click();
  await expect(page.locator('.app')).toHaveAttribute('data-nav-collapsed', 'true');
  const folded = await content.boundingBox();
  expect(folded!.x + folded!.width).toBeGreaterThan(WIDE_VIEWPORT.width - SCROLLBAR_ALLOWANCE);
  expect(folded!.width).toBeGreaterThan(open!.width);
});

test('4000px の幅でも、組織の管理の欄は 56rem で止まり、表は止まらない', async ({ context, baseURL, page }) => {
  await signIn(context, baseURL, 'admin');
  await page.setViewportSize(WIDE_VIEWPORT);
  await page.goto('/aoba/admin');

  // 表が出てから測る（読み込み前の空の箱は、上限が無くても幅が小さい）
  const table = page.locator('.setting-body > .table-wrap').first();
  await expect(table).toBeVisible();
  expect((await table.boundingBox())!.width).toBeGreaterThan(FORM_MAX_PX);

  const fieldWidths = await page
    .locator('.setting-body > :not(.table-wrap)')
    .evaluateAll((els) => els.map((el) => el.getBoundingClientRect().width));
  expect(fieldWidths.length).toBeGreaterThan(0);
  for (const width of fieldWidths) expect(width).toBeLessThanOrEqual(FORM_MAX_PX);
});

test('4000px の幅でも、自分の設定の API トークンの発行の欄は 56rem で止まる', async ({ page }) => {
  await page.setViewportSize(WIDE_VIEWPORT);
  await page.goto('/aoba/me');

  const form = page.locator('form.form').first();
  await expect(form).toBeVisible();
  expect((await form.boundingBox())!.width).toBeLessThanOrEqual(FORM_MAX_PX);
});

test('4000px の幅でも、今日やることの画面に、アクセシビリティの違反が無い', async ({ page }) => {
  await page.setViewportSize(WIDE_VIEWPORT);
  await page.goto(today);
  await expect(page.getByRole('heading', { level: 1, name: '今日やること' })).toBeVisible();
  await expectNoA11yViolationsInThemes(page, 'today', exclusionsFor('today', isAxeCheck));
});
