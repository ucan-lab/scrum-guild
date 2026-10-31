// 組織の既定のテーマ（組織の管理の画面）。管理者が選んで「保存する」を押すと送り、組織の枠を読み直して自分の画面にも当てる。
// 組織の値を書き換えるので、このファイルだけが使う seed の組織、くもラボで確かめる（seed/README.md）。
// 管理者はカイ（lookAdmin。テーマを選んでいない）、一般のユーザーはテーマを選んでいないソウタ（lookMember）と、
// 自分のテーマ（シンプル（ダーク））を選んだコハル（lookThemed）。変えた値は、各テストの終わりに画面から元に戻す
import type { Browser, Page } from '@playwright/test';
import { expect, test } from './fixtures.ts';
import type { SEED_SESSIONS } from '../seed/sessions.ts';
import { signIn, waitForSettled, watchViolations } from './helpers.ts';

const UPDATE_ROUTE = '**/api/kumo/organization-settings-update';

// 同じ組織の値を書き換えるので、このファイルの中は順に走らせる
test.describe.configure({ mode: 'serial' });

// くもラボの一般のユーザーとして、組織の画面を開き直して data-theme を読む
async function themeOf(browser: Browser, baseURL: string | undefined, who: keyof typeof SEED_SESSIONS) {
  const context = await browser.newContext();
  try {
    await signIn(context, baseURL, who);
    const page = await context.newPage();
    await page.goto('/kumo');
    await expect(page.getByRole('heading', { level: 1, name: '今日やること' })).toBeVisible();
    return await page.locator('html').getAttribute('data-theme');
  } finally {
    await context.close();
  }
}

const themeSection = (page: Page) => page.getByRole('region', { name: '既定のテーマ' });

// 選んで保存し、知らせを待つ
async function saveTheme(page: Page, label: string): Promise<void> {
  const section = themeSection(page);
  await section.getByRole('radio', { name: new RegExp(`^${label}`) }).check();
  await section.getByRole('button', { name: '保存する' }).click();
  await expect(page.getByRole('status').filter({ hasText: `既定のテーマを「${label}」に変えました` })).toBeVisible();
}

test.describe('管理者（くもラボのカイ）', () => {
  test.beforeEach(async ({ context, baseURL }) => {
    await signIn(context, baseURL, 'lookAdmin');
  });

  test('既定のテーマは、選んだだけでは送らず、保存すると、テーマを選んでいない人の画面が替わり、選んでいる人は替わらない', async ({
    page,
    browser,
    baseURL,
  }) => {
    const collect = await watchViolations(page);
    let calls = 0;
    page.on('request', (request) => {
      if (request.url().endsWith('/api/kumo/organization-settings-update')) calls++;
    });
    await page.goto('/kumo/admin');
    const section = themeSection(page);
    const save = section.getByRole('button', { name: '保存する' });
    await expect(section.getByRole('radio')).toHaveCount(5);
    await expect(section.getByRole('radio', { name: /^シンプル（自動）/ })).toBeChecked();
    await expect(section).toContainText('冒険者ギルドの帳簿。紙と墨、完了に朱の判子');
    // 今の値のままなら押せない
    await expect(save).toHaveAttribute('aria-disabled', 'true');
    expect(await themeOf(browser, baseURL, 'lookMember')).toBe('simple');
    expect(await themeOf(browser, baseURL, 'lookThemed')).toBe('simple_dark');

    // 矢印のキーで動かしても送らない
    await section.getByRole('radio', { name: /^シンプル（自動）/ }).focus();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await expect(section.getByRole('radio', { name: /^シンプル（ダーク）/ })).toBeChecked();
    await expect(save).toHaveAttribute('aria-disabled', 'false');
    // 今の値に戻すと、また押せなくなる
    await section.getByRole('radio', { name: /^シンプル（自動）/ }).check();
    await expect(save).toHaveAttribute('aria-disabled', 'true');
    expect(calls).toBe(0);

    await saveTheme(page, '中世風');
    expect(calls).toBe(1);
    await expect(section.getByRole('radio', { name: /^中世風/ })).toBeChecked();
    await expect(save).toHaveAttribute('aria-disabled', 'true');
    // 自分もテーマを選んでいないので、自分の画面にもすぐ当たる
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'medieval');
    expect(await themeOf(browser, baseURL, 'lookMember')).toBe('medieval');
    expect(await themeOf(browser, baseURL, 'lookThemed')).toBe('simple_dark');

    // 読み直しても、保存した値が出る
    await page.reload();
    await expect(themeSection(page).getByRole('radio', { name: /^中世風/ })).toBeChecked();
    expect(await collect()).toEqual([]);

    // 後片付け（seed の値に戻す）
    await saveTheme(page, 'シンプル（自動）');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'simple');
    // 読み直しで戻るスクロールの位置と、中世風からテーマを戻したときの組み直しで、終わりの位置が CI で 60px ほど違った（#460）。
    // 読み込みと書体を待ってから、テーマの節を上端に置き、画面の位置をそろえる。
    // 押した位置に残るマウスで「保存する」がホバーの色になるかも揺れるので、押せる要素の無い左上の隅へ動かしておく
    await waitForSettled(page);
    await page.evaluate(() => document.fonts.ready);
    await page.mouse.move(0, 0);
    await themeSection(page).evaluate((section) => section.scrollIntoView({ block: 'start' }));
  });

  test('組織の設定に言葉づかいの節は無く、テーマの節だけがある。画面の言葉はスクラムの言葉', async ({ page }) => {
    await page.goto('/kumo/admin');
    await expect(page.locator('.page-eyebrow')).toHaveText('管理者だけが見られます');
    await expect(page.locator('.me .chip')).toHaveText('管理者');
    await expect(themeSection(page)).toBeVisible();
    await expect(page.getByRole('region', { name: /言葉づかい/ })).toHaveCount(0);
    await expect(page.getByText('スクラムの言葉', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('radio', { name: /の言葉/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^保存/ })).toHaveCount(1);
  });

  test('失敗は節の中に次の操作まで残す。通信の失敗では選んだ値を残して押し直せ、409 と 403 は読み直して今の値に戻す', async ({
    page,
  }) => {
    await page.goto('/kumo/admin');
    const section = themeSection(page);
    const save = section.getByRole('button', { name: '保存する' });
    await expect(section.getByRole('radio', { name: /^シンプル（自動）/ })).toBeChecked();

    await page.route(UPDATE_ROUTE, (route) =>
      route.fulfill({ status: 500, json: { error: { code: 'internal', message: 'test' } } }),
    );
    await section.getByRole('radio', { name: /^現代風/ }).check();
    await save.click();
    await expect(section.getByRole('alert')).toContainText('保存できませんでした。もう一度');
    await expect(section.getByRole('radio', { name: /^現代風/ })).toBeChecked();
    await expect(save).toHaveAttribute('aria-disabled', 'false');
    await page.unroute(UPDATE_ROUTE);

    // ほかの管理者が先に変えていた（409）。組織の枠を読み直し、今の値を見せる
    await page.route(UPDATE_ROUTE, (route) =>
      route.fulfill({ status: 409, json: { error: { code: 'conflict', message: 'test' } } }),
    );
    await save.click();
    await expect(section.getByRole('alert')).toContainText('ほかの管理者が先に変えていました');
    await expect(section.getByRole('radio', { name: /^シンプル（自動）/ })).toBeChecked();
    await expect(save).toHaveAttribute('aria-disabled', 'true');
    await page.unroute(UPDATE_ROUTE);

    // 操作できない（403）。同じく読み直す
    await page.route(UPDATE_ROUTE, (route) =>
      route.fulfill({ status: 403, json: { error: { code: 'forbidden', message: 'test' } } }),
    );
    await section.getByRole('radio', { name: /^現代風/ }).check();
    await save.click();
    await expect(section.getByRole('alert')).toContainText('操作できない状態です');
    await expect(section.getByRole('radio', { name: /^シンプル（自動）/ })).toBeChecked();
    // 次に選ぶと、知らせは消える
    await section.getByRole('radio', { name: /^中世風/ }).check();
    await expect(section.getByRole('alert')).toHaveText('');
  });
});
