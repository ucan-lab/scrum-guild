// バックログの並べ替えと親の移動: 「上へ」「下へ」と Alt と ↑ ↓ で並べ替え、読み直しても並びが残る。
// 「親を移す」のダイアログでストーリーの下へ移し、親なしへ戻す。ストーリーも並べ替える。
// seed のセッション（seed/sessions.ts）の Cookie で開く。あおば開発の管理者はミナト。CSP の違反も確かめる
import { expect, test, type Page } from '@playwright/test';
import { createWorkspace, signIn, watchViolations } from './helpers.ts';

test.use({ timezoneId: 'Asia/Tokyo' });

test.beforeEach(async ({ context, baseURL }) => {
  await signIn(context, baseURL, 'admin');
});

async function addTask(page: Page, title: string): Promise<void> {
  await page.getByRole('button', { name: '依頼を出す' }).click();
  const dialog = page.getByRole('dialog', { name: '依頼を出す' });
  await dialog.getByLabel('タイトル').fill(title);
  await dialog.getByRole('button', { name: '依頼を出す' }).click();
  await expect(dialog).toBeHidden();
}

async function addStory(page: Page, title: string): Promise<void> {
  await page.getByRole('button', { name: '達成目標を作る' }).click();
  const dialog = page.getByRole('dialog', { name: '達成目標を作る' });
  await dialog.getByLabel('タイトル').fill(title);
  await dialog.getByRole('button', { name: '作る' }).click();
  await expect(dialog).toBeHidden();
}

// 親のないタスクの題（並びの順）
function rootTitles(page: Page) {
  return page.locator('.tree > div:not(.tree-group) .entry-title');
}

function storyGroup(page: Page, title: string) {
  return page.locator('.tree-group', { has: page.getByRole('button', { name: title, exact: true }) });
}

test('「上へ」「下へ」と Alt と ↑ ↓ で並べ替え、フォーカスは同じ要素に残り、読み直しても並びが残る', async ({
  page,
}) => {
  const collect = await watchViolations(page);
  await createWorkspace(page, '並べ替えパーティ', 'game');
  for (const title of ['見積もりを送る', '請求書を出す', '議事録をまとめる']) await addTask(page, title);
  await expect(page.getByText(/上にあるものほど優先します/)).toBeVisible();
  await expect(rootTitles(page)).toHaveText(['見積もりを送る', '請求書を出す', '議事録をまとめる']);

  // 端の向きは押せない（フォーカスは残せるよう aria-disabled）
  const firstUp = page.getByRole('button', { name: '上へ: 見積もりを送る' });
  await expect(firstUp).toHaveAttribute('aria-disabled', 'true');
  await expect(page.getByRole('button', { name: '下へ: 議事録をまとめる' })).toHaveAttribute('aria-disabled', 'true');

  // ボタンで1つ下へ。押したボタンにフォーカスが残る
  const down = page.getByRole('button', { name: '下へ: 見積もりを送る' });
  await down.click();
  await expect(rootTitles(page)).toHaveText(['請求書を出す', '見積もりを送る', '議事録をまとめる']);
  await expect(down).toBeFocused();
  await expect(page.getByRole('status').filter({ hasText: '「見積もりを送る」を 2 番目に移しました' })).toBeAttached();
  await expect(firstUp).toHaveAttribute('aria-disabled', 'false');

  // 行の中のリンクにフォーカスを置いて、Alt と ↑ で1つ上へ。フォーカスはリンクに残る
  const link = page.getByRole('link', { name: '議事録をまとめる' });
  await link.focus();
  await page.keyboard.press('Alt+ArrowUp');
  await expect(rootTitles(page)).toHaveText(['請求書を出す', '議事録をまとめる', '見積もりを送る']);
  await expect(link).toBeFocused();
  // Alt と ↓ で戻し、もう一度 ↑ を2回押して先頭へ
  await page.keyboard.press('Alt+ArrowDown');
  await expect(rootTitles(page)).toHaveText(['請求書を出す', '見積もりを送る', '議事録をまとめる']);
  await page.keyboard.press('Alt+ArrowUp');
  await page.keyboard.press('Alt+ArrowUp');
  await expect(rootTitles(page)).toHaveText(['議事録をまとめる', '請求書を出す', '見積もりを送る']);
  await expect(link).toBeFocused();
  await expect(
    page.getByRole('status').filter({ hasText: '「議事録をまとめる」を 1 番目に移しました' }),
  ).toBeAttached();

  // 送り終えてから読み直す。並びは API に残っている
  await page.waitForLoadState('networkidle');
  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: '掲示板' })).toBeVisible();
  await expect(rootTitles(page)).toHaveText(['議事録をまとめる', '請求書を出す', '見積もりを送る']);
  expect(await collect()).toEqual([]);
});

test('「親を移す」でストーリーの下の末尾へ移し、親なしへ戻せる。ストーリーも並べ替えられる', async ({ page }) => {
  const collect = await watchViolations(page);
  await createWorkspace(page, '親を移すパーティ', 'game');
  await addStory(page, 'ポイント制度を公開する');
  await addStory(page, '決済の障害を減らす');
  await page.getByRole('button', { name: 'クエストを足す: ポイント制度を公開する' }).click();
  const taskDialog = page.getByRole('dialog', { name: '依頼を出す' });
  await taskDialog.getByLabel('タイトル').fill('付与のバッチを書く');
  await taskDialog.getByRole('button', { name: '依頼を出す' }).click();
  await expect(taskDialog).toBeHidden();
  await addTask(page, '残高の画面を作る');

  // 親のないタスクを、ストーリーの下の末尾へ
  await page.getByRole('button', { name: '親を移す: 残高の画面を作る' }).click();
  const dialog = page.getByRole('dialog', { name: '「残高の画面を作る」の親を移す' });
  const select = dialog.getByLabel('移す先');
  // 今が親なしなので、親なしは候補に出さない
  await expect(select.locator('option')).toHaveText(['ポイント制度を公開する', '決済の障害を減らす']);
  await select.selectOption({ label: 'ポイント制度を公開する' });
  await dialog.getByRole('button', { name: '移す' }).click();
  await expect(dialog).toBeHidden();
  const group = storyGroup(page, 'ポイント制度を公開する');
  await expect(group.locator('.entry-title')).toHaveText(['付与のバッチを書く', '残高の画面を作る']);
  await expect(rootTitles(page)).toHaveCount(0);
  await expect(
    page
      .getByRole('status')
      .filter({ hasText: '「残高の画面を作る」を達成目標「ポイント制度を公開する」の末尾へ移しました' }),
  ).toBeAttached();
  // ダイアログを閉じたら、開いたボタンへフォーカスが戻る
  await expect(page.getByRole('button', { name: '親を移す: 残高の画面を作る' })).toBeFocused();

  // ストーリーを並べ替える
  await page.getByRole('button', { name: '下へ: ポイント制度を公開する' }).click();
  await expect(page.locator('.tree-group button.tree-link')).toHaveText([
    '決済の障害を減らす',
    'ポイント制度を公開する',
  ]);

  await page.waitForLoadState('networkidle');
  await page.reload();
  await expect(page.locator('.tree-group button.tree-link')).toHaveText([
    '決済の障害を減らす',
    'ポイント制度を公開する',
  ]);
  await expect(storyGroup(page, 'ポイント制度を公開する').locator('.entry-title')).toHaveText([
    '付与のバッチを書く',
    '残高の画面を作る',
  ]);

  // ストーリーの下から親なしへ戻す
  await page.getByRole('button', { name: '親を移す: 付与のバッチを書く' }).click();
  const back = page.getByRole('dialog', { name: '「付与のバッチを書く」の親を移す' });
  await expect(back.getByLabel('移す先').locator('option')).toHaveText(['親なし', '決済の障害を減らす']);
  await back.getByLabel('移す先').selectOption({ label: '親なし' });
  await back.getByRole('button', { name: '移す' }).click();
  await expect(rootTitles(page)).toHaveText(['付与のバッチを書く']);
  await page.waitForLoadState('networkidle');
  await page.reload();
  await expect(rootTitles(page)).toHaveText(['付与のバッチを書く']);
  expect(await collect()).toEqual([]);
});

test('並べ替えを断られたら、理由を知らせて読み直す', async ({ page }) => {
  await createWorkspace(page, '断られるパーティ', 'game');
  for (const title of ['見積もりを送る', '請求書を出す']) await addTask(page, title);
  await page.route('**/api/aoba/task-move', (route) =>
    route.fulfill({ status: 409, json: { error: { code: 'workspace_closed', message: 'workspace_closed' } } }),
  );
  const down = page.getByRole('button', { name: '下へ: 見積もりを送る' });
  await down.click();
  await expect(page.getByRole('status').filter({ hasText: '終了したパーティには書き込めません' })).toBeVisible();
  // 読み直すと、送れなかった並べ替えは元に戻り、フォーカスは同じ行の同じ操作に戻る
  await expect(rootTitles(page)).toHaveText(['見積もりを送る', '請求書を出す']);
  await expect(down).toBeFocused();

  // 409 の conflict は、理由（details.reason）で知らせる文を選ぶ
  for (const [reason, message] of [
    ['task_completed', 'このクエストは完遂しています。一覧を読み直します'],
    ['changed', 'ほかの画面で変わったため、移せませんでした。一覧を読み直します'],
  ] as const) {
    await page.unrouteAll();
    await page.route('**/api/aoba/task-move', (route) =>
      route.fulfill({ status: 409, json: { error: { code: 'conflict', message: 'conflict', details: { reason } } } }),
    );
    await down.click();
    await expect(page.getByRole('status').filter({ hasText: message })).toBeVisible();
    await expect(rootTitles(page)).toHaveText(['見積もりを送る', '請求書を出す']);
  }
  // 404 は、どの行が消えたかが分からないので、一覧が変わったことを知らせる
  await page.unrouteAll();
  await page.route('**/api/aoba/task-move', (route) =>
    route.fulfill({ status: 404, json: { error: { code: 'not_found', message: 'not found' } } }),
  );
  await down.click();
  await expect(
    page.getByRole('status').filter({ hasText: '一覧が変わったため移せませんでした。一覧を読み直します' }),
  ).toBeVisible();
});

test('端の行で Alt と ↑ ↓ を押すと、動かせないことを読み上げる', async ({ page }) => {
  await createWorkspace(page, '端のパーティ', 'game');
  for (const title of ['見積もりを送る', '請求書を出す']) await addTask(page, title);
  await page.getByRole('link', { name: '見積もりを送る' }).focus();
  await page.keyboard.press('Alt+ArrowUp');
  await expect(page.getByRole('status').filter({ hasText: 'いちばん上です' })).toBeAttached();
  await page.getByRole('link', { name: '請求書を出す' }).focus();
  await page.keyboard.press('Alt+ArrowDown');
  await expect(page.getByRole('status').filter({ hasText: 'いちばん下です' })).toBeAttached();
  await expect(rootTitles(page)).toHaveText(['見積もりを送る', '請求書を出す']);
});

// seed のワークスペース（受託開発チーム）。ストーリーの下に、期日、ポイント、担当の付いたタスクがある
const SEED_GAME_WORKSPACE = '/aoba/w/019a0000-0000-7000-8000-000000000401';

test('メニューの横で一覧が狭い幅でも、題の列は縮みすぎず、狭い画面でも横にはみ出さない', async ({ page }) => {
  for (const width of [800, 900, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(SEED_GAME_WORKSPACE);
    const title = page.locator('.tree-children .entry .entry-title').first();
    await expect(title).toBeVisible();
    // 題の列は 120px 以上（右端の操作が並んだままだと、数文字の幅に縮む）
    for (const locator of [title, page.locator('.tree-row.is-story .tree-title').first()]) {
      const box = await locator.boundingBox();
      expect(box!.width, `${width}px`).toBeGreaterThanOrEqual(width <= 320 ? 100 : 120);
    }
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, `${width}px`).toBeLessThanOrEqual(0);
  }
  // 狭い幅では、並べ替えのボタンは 44px 四方
  await page.setViewportSize({ width: 390, height: 900 });
  const up = page.locator('.tree-children .entry .order-actions .icon-btn').first();
  const box = await up.boundingBox();
  expect(box!.width).toBeGreaterThanOrEqual(44);
  expect(box!.height).toBeGreaterThanOrEqual(44);
});
