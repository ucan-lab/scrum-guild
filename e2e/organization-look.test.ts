// 組織の言葉づかいと既定のテーマ（組織の管理の画面）。管理者が選ぶとすぐ送り、組織の枠を読み直して自分の画面にも当てる。
// ひばり工房で確かめる（あおば開発はほかのファイルが並列に開くので、組織の値を変えない）。ひばり工房の管理者はリン（otherOrg）、
// 一般のユーザーはミナト（admin。ひばり工房ではテーマを選んでいない）。
// テーマを選んでいる人を作る操作はまだ無いので、リンの users.theme を手元の D1 に直に書いて作り、終わったら組織の値と一緒に戻す
// （global-setup の seed と同じく --local だけ）
import { spawnSync } from 'node:child_process';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { signIn, watchViolations } from './helpers.ts';

const HIBARI_ID = '019a0000-0000-7000-8000-000000000202';
const RIN_USER_ID = '019a0000-0000-7000-8000-000000000303';

function runLocalSql(sql: string): void {
  const result = spawnSync('pnpm', ['exec', 'wrangler', 'd1', 'execute', 'DB', '--local', '--command', sql], {
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  if (result.error || result.status !== 0) throw new Error('手元の D1 に書けなかった');
}

function restoreSeed(): void {
  runLocalSql(
    `UPDATE organizations SET vocabulary = 'game', theme = 'simple' WHERE id = '${HIBARI_ID}'; ` +
      `UPDATE users SET theme = NULL WHERE id = '${RIN_USER_ID}'`,
  );
}

// 同じ組織の値を書き換えるので、このファイルの中は順に走らせる
test.describe.configure({ mode: 'serial' });

test.afterAll(() => {
  restoreSeed();
});

// ひばり工房の一般のユーザー（ミナト）として、組織の画面を開き直す
async function openAsMinato(browser: Browser, baseURL: string | undefined): Promise<Page> {
  const context = await browser.newContext();
  await signIn(context, baseURL, 'admin');
  const page = await context.newPage();
  await page.goto('/hibari');
  await expect(page.getByRole('heading', { level: 1, name: '自分の今日' })).toBeVisible();
  return page;
}

test.describe('管理者（ひばり工房のリン）', () => {
  test.beforeEach(async ({ context, baseURL }) => {
    await signIn(context, baseURL, 'otherOrg');
  });

  test('既定のテーマを変えると、テーマを選んでいない人の画面は読み直すと替わり、選んでいる自分の画面は替わらない', async ({
    page,
    browser,
    baseURL,
  }) => {
    runLocalSql(`UPDATE users SET theme = 'simple_dark' WHERE id = '${RIN_USER_ID}'`);
    const collect = await watchViolations(page);
    await page.goto('/hibari/admin');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'simple_dark');

    const section = page.getByRole('region', { name: '既定のテーマ' });
    await expect(section.getByRole('radio', { name: /^シンプル（自動）/ })).toBeChecked();
    await expect(section.getByRole('radio')).toHaveCount(5);
    await expect(section).toContainText('冒険者ギルドの帳簿。紙と墨、完了に朱の判子');

    const before = await openAsMinato(browser, baseURL);
    await expect(before.locator('html')).toHaveAttribute('data-theme', 'simple');
    await before.context().close();

    await section.getByRole('radio', { name: /^中世風/ }).check();
    await expect(page.getByRole('status').filter({ hasText: '既定のテーマを「中世風」に変えました' })).toBeVisible();
    await expect(section.getByRole('radio', { name: /^中世風/ })).toBeChecked();
    // 自分で選んでいる人は、組織の既定が変わっても自分のテーマのまま
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'simple_dark');

    const after = await openAsMinato(browser, baseURL);
    await expect(after.locator('html')).toHaveAttribute('data-theme', 'medieval');
    await after.context().close();

    // 読み直しても、選んだ値が出る
    await page.reload();
    await expect(
      page.getByRole('region', { name: '既定のテーマ' }).getByRole('radio', { name: /^中世風/ }),
    ).toBeChecked();
    expect(await collect()).toEqual([]);
  });

  test('テーマを選んでいない自分の画面には、変えた既定のテーマがすぐ当たる', async ({ page }) => {
    runLocalSql(`UPDATE users SET theme = NULL WHERE id = '${RIN_USER_ID}'`);
    await page.goto('/hibari/admin');
    const section = page.getByRole('region', { name: '既定のテーマ' });
    await section.getByRole('radio', { name: /^現代風/ }).check();
    await expect(page.getByRole('status').filter({ hasText: '既定のテーマを「現代風」に変えました' })).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'modern');
  });

  test('言葉づかいを変えると、送っている間は選択を止め、通るとワークスペースの外の画面の言葉が切り替わる', async ({
    page,
    browser,
    baseURL,
  }) => {
    await page.goto('/hibari/admin');
    await expect(page.locator('.page-eyebrow')).toHaveText('ギルドマスターだけが見られます');
    const section = page.getByRole('region', { name: 'パーティの外の言葉づかい' });
    await expect(section.getByRole('radio', { name: /^ゲームの言葉/ })).toBeChecked();
    await expect(section).toContainText('冒険者ギルド、ギルドマスター');
    await expect(section).toContainText('組織、管理者');

    // 送っている間は、両方の節の選択肢を aria-disabled にする
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    await page.route('**/api/hibari/organization-settings-update', async (route) => {
      await held;
      await route.continue();
    });
    await section.getByRole('radio', { name: /^スクラムの言葉/ }).check();
    await expect(section.getByRole('radio', { name: /^ゲームの言葉/ })).toHaveAttribute('aria-disabled', 'true');
    await expect(
      page.getByRole('region', { name: '既定のテーマ' }).getByRole('radio', { name: /^中世風/ }),
    ).toHaveAttribute('aria-disabled', 'true');
    release();

    await expect(
      page.getByRole('status').filter({ hasText: '言葉づかいを「スクラムの言葉」に変えました' }),
    ).toBeVisible();
    // 組織の枠を読み直し、この画面の言葉も替わる
    await expect(page.locator('.page-eyebrow')).toHaveText('管理者だけが見られます');
    const renamed = page.getByRole('region', { name: 'ワークスペースの外の言葉づかい' });
    await expect(renamed.getByRole('radio', { name: /^スクラムの言葉/ })).toBeChecked();
    await expect(renamed.getByRole('radio', { name: /^スクラムの言葉/ })).toHaveAttribute('aria-disabled', 'false');

    // ほかの人のワークスペースの外の画面も、組織の言葉になる
    const minato = await openAsMinato(browser, baseURL);
    await expect(minato.locator('.org-menu-label')).toHaveText('組織');
    await minato.context().close();
  });

  test('送れなかったときは選択を元の値に戻して知らせ、ほかの管理者が先に変えていたら知らせて読み直す', async ({
    page,
  }) => {
    runLocalSql(`UPDATE organizations SET vocabulary = 'game', theme = 'simple' WHERE id = '${HIBARI_ID}'`);
    await page.goto('/hibari/admin');
    const section = page.getByRole('region', { name: '既定のテーマ' });
    await expect(section.getByRole('radio', { name: /^シンプル（自動）/ })).toBeChecked();

    await page.route('**/api/hibari/organization-settings-update', (route) =>
      route.fulfill({ status: 500, json: { error: { code: 'internal', message: 'test' } } }),
    );
    await section.getByRole('radio', { name: /^現代風/ }).check();
    await expect(page.getByRole('status').filter({ hasText: '変えられませんでした' })).toBeVisible();
    await expect(section.getByRole('radio', { name: /^シンプル（自動）/ })).toBeChecked();
    await expect(section.getByRole('radio', { name: /^現代風/ })).not.toBeChecked();
    await page.unroute('**/api/hibari/organization-settings-update');

    // ほかの管理者が先に中世風にしていた。409 を受けて組織の枠を読み直し、今の値を見せる
    await page.route('**/api/hibari/organization-settings-update', (route) => {
      runLocalSql(`UPDATE organizations SET theme = 'medieval' WHERE id = '${HIBARI_ID}'`);
      return route.fulfill({ status: 409, json: { error: { code: 'conflict', message: 'test' } } });
    });
    await section.getByRole('radio', { name: /^現代風/ }).check();
    await expect(
      page.getByRole('status').filter({ hasText: 'ほかのギルドマスターが先に変えていました' }),
    ).toBeVisible();
    await expect(section.getByRole('radio', { name: /^中世風/ })).toBeChecked();
  });
});
