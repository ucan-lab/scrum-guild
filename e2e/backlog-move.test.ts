// バックログの並べ替えと親の移動: 「上へ」「下へ」と Alt と ↑ ↓ で並べ替え、読み直しても並びが残る。
// 「親を移す」のダイアログでストーリーの下へ移し、親なしへ戻す。ストーリーも並べ替える。
// seed のセッション（seed/sessions.ts）の Cookie で開く。あおば開発の管理者はミナト。CSP の違反も確かめる
import type { Page } from '@playwright/test';
import { expect, steadyScreenshots, test } from './fixtures.ts';
import { createWorkspace, dragTo, signIn, waitForResponses, watchViolations } from './helpers.ts';

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

// 作った後は、木の読み直しが返るまで待つ。読み直しで木が替わると、画面は画面だけで足したタスクと並べ替えを捨てる（+page.svelte）。
// 返る前に次のタスクを足すか並べ替えると、それが遅れて届いた読み直しで消えうる
async function addStory(page: Page, title: string): Promise<void> {
  await page.getByRole('button', { name: '達成目標を作る' }).click();
  const dialog = page.getByRole('dialog', { name: '達成目標を作る' });
  await dialog.getByLabel('タイトル').fill(title);
  const reloaded = waitForResponses(page, '/backlog-tree');
  await dialog.getByRole('button', { name: '作る' }).click();
  await expect(dialog).toBeHidden();
  await reloaded;
}

// 親のないタスクの題（並びの順）
function rootTitles(page: Page) {
  return page.locator('.tree > div:not(.tree-group) .entry-title');
}

// 題の行を持つ木の1件。ストーリーの題はボタン、エピックの題はリンク
function storyGroup(page: Page, title: string) {
  return page.locator('.tree-group', {
    has: page
      .getByRole('button', { name: title, exact: true })
      .or(page.getByRole('link', { name: title, exact: true })),
  });
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

  // 読み直す前に待つ。このテストで動かすのは、下のボタンの1回と Alt と ↑ ↓ の4回
  const moved = waitForResponses(page, '/task-move', 5);

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
  await moved;
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

  // ストーリーを並べ替える。前の親の移動の後に送られるので、この応答を待てば両方が書き終わっている
  const storyMoved = waitForResponses(page, '/story-move');
  await page.getByRole('button', { name: '下へ: ポイント制度を公開する' }).click();
  await expect(page.locator('.tree-group button.tree-link')).toHaveText([
    '決済の障害を減らす',
    'ポイント制度を公開する',
  ]);

  await storyMoved;
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
  const taskMoved = waitForResponses(page, '/task-move');
  await back.getByRole('button', { name: '移す' }).click();
  await expect(rootTitles(page)).toHaveText(['付与のバッチを書く']);
  await taskMoved;
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

test('先に送った並べ替えが断られて読み直したら、待っていた並べ替えは送らずに捨て、そのことを知らせる', async ({
  page,
}) => {
  await createWorkspace(page, '捨てるパーティ', 'game');
  for (const title of ['見積もりを送る', '請求書を出す', '議事録をまとめる']) await addTask(page, title);
  // 1件目の応答を、3回目を押し終えるまで止めてから断る。その間に2件を待たせる
  let sent = 0;
  let release!: () => void;
  const clicked = new Promise<void>((resolve) => (release = resolve));
  await page.route('**/api/aoba/task-move', async (route) => {
    sent++;
    await clicked;
    await route.fulfill({
      status: 409,
      json: { error: { code: 'conflict', message: 'conflict', details: { reason: 'changed' } } },
    });
  });
  await page.getByRole('button', { name: '下へ: 見積もりを送る' }).click();
  await page.getByRole('button', { name: '上へ: 議事録をまとめる' }).click();
  await page.getByRole('button', { name: '上へ: 議事録をまとめる' }).click();
  release();
  await expect(
    page.getByRole('status').filter({ hasText: '動かしている間に一覧が読み直されたため、一覧を読み直しました' }),
  ).toBeVisible();
  await expect(rootTitles(page)).toHaveText(['見積もりを送る', '請求書を出す', '議事録をまとめる']);
  expect(sent).toBe(1);
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

// 作った後は、木の読み直しが返るまで待つ（上の addStory と同じ）
async function addEpic(page: Page, title: string): Promise<void> {
  await page.getByRole('button', { name: 'レイドを作る' }).click();
  const dialog = page.getByRole('dialog', { name: 'レイドを作る' });
  await dialog.getByLabel('タイトル').fill(title);
  const reloaded = waitForResponses(page, '/backlog-tree');
  await dialog.getByRole('button', { name: '作る' }).click();
  await expect(dialog).toBeHidden();
  await reloaded;
}

function epicRow(page: Page, title: string) {
  return page.locator('.tree-row.is-epic', { has: page.getByRole('link', { name: title, exact: true }) });
}

// エピックの題（並びの順）
function epicTitles(page: Page) {
  return page.locator('.tree-row.is-epic a.tree-link');
}

test('エピックを「上へ」「下へ」と Alt と ↑ ↓ で並べ替え、読み直しても同じ順になる。端では動かせないことを読み上げる', async ({
  page,
}) => {
  const collect = await watchViolations(page);
  await createWorkspace(page, 'レイドの並べ替えパーティ', 'game');
  for (const title of ['ポイント制度を公開する', '決済の障害を減らす', '会員ランクを見直す'])
    await addEpic(page, title);
  await expect(page.getByText(/上にあるものほど優先します。レイド、達成目標、クエストは/)).toBeVisible();
  await expect(epicTitles(page)).toHaveText(['ポイント制度を公開する', '決済の障害を減らす', '会員ランクを見直す']);

  // 端の向きは押せない（フォーカスは残せるよう aria-disabled）
  await expect(page.getByRole('button', { name: '上へ: ポイント制度を公開する' })).toHaveAttribute(
    'aria-disabled',
    'true',
  );
  await expect(page.getByRole('button', { name: '下へ: 会員ランクを見直す' })).toHaveAttribute('aria-disabled', 'true');

  // 下の1回のボタンと、2回の Alt と ↑
  const moved = waitForResponses(page, '/epic-move', 3);
  const down = page.getByRole('button', { name: '下へ: ポイント制度を公開する' });
  await down.click();
  await expect(epicTitles(page)).toHaveText(['決済の障害を減らす', 'ポイント制度を公開する', '会員ランクを見直す']);
  await expect(down).toBeFocused();
  await expect(
    page.getByRole('status').filter({ hasText: '「ポイント制度を公開する」を 2 番目に移しました' }),
  ).toBeAttached();

  // 行の中の題のボタンにフォーカスを置いて、Alt と ↑ を2回で先頭へ。フォーカスは題に残る
  const title = page.getByRole('link', { name: '会員ランクを見直す', exact: true });
  await title.focus();
  await page.keyboard.press('Alt+ArrowUp');
  await page.keyboard.press('Alt+ArrowUp');
  await expect(epicTitles(page)).toHaveText(['会員ランクを見直す', '決済の障害を減らす', 'ポイント制度を公開する']);
  await expect(title).toBeFocused();
  await expect(
    page.getByRole('status').filter({ hasText: '「会員ランクを見直す」を 1 番目に移しました' }),
  ).toBeAttached();
  // 端でもう一度押すと、動かせないことを読み上げる
  await page.keyboard.press('Alt+ArrowUp');
  await expect(page.getByRole('status').filter({ hasText: 'いちばん上です' })).toBeAttached();
  await page.getByRole('link', { name: 'ポイント制度を公開する', exact: true }).focus();
  await page.keyboard.press('Alt+ArrowDown');
  await expect(page.getByRole('status').filter({ hasText: 'いちばん下です' })).toBeAttached();

  await moved;
  await page.reload();
  await expect(epicTitles(page)).toHaveText(['会員ランクを見直す', '決済の障害を減らす', 'ポイント制度を公開する']);
  expect(await collect()).toEqual([]);
});

test('エピックをつまみのドラッグで並べ替え、線はエピックの塊に出て、読み直しても同じ順になる', async ({ page }) => {
  const collect = await watchViolations(page);
  await createWorkspace(page, 'レイドのドラッグパーティ', 'game');
  for (const title of ['ポイント制度を公開する', '決済の障害を減らす']) await addEpic(page, title);
  // 配下のストーリーを足す（エピックの線が、開いた配下の途中に入らないことを確かめる）
  await addStory(page, '残高が見える');
  await page.getByRole('button', { name: '親を移す: 残高が見える' }).click();
  const moveDialog = page.getByRole('dialog', { name: '「残高が見える」の親を移す' });
  await moveDialog.getByLabel('移す先').selectOption({ label: 'ポイント制度を公開する' });
  await moveDialog.getByRole('button', { name: '移す' }).click();
  await expect(moveDialog).toBeHidden();
  const points = storyGroup(page, 'ポイント制度を公開する');
  await expect(points.locator('.tree-row.is-story')).toHaveCount(1);
  // つまみは飾り（読み上げに出さない）
  await expect(epicRow(page, '決済の障害を減らす').locator('.grip')).toHaveAttribute('aria-hidden', 'true');

  const moved = waitForResponses(page, '/epic-move');
  await dragTo(
    page,
    epicRow(page, '決済の障害を減らす').locator('.grip'),
    epicRow(page, 'ポイント制度を公開する'),
    'top',
    async () => {
      // 線は配下を含めた塊に出る。エピックを運ぶときは、エピックの行を囲まない
      await expect(points).toHaveAttribute('data-drop', 'before');
      await expect(page.locator('.tree-row[data-drop="into"]')).toHaveCount(0);
      await expect(storyGroup(page, '決済の障害を減らす')).toHaveClass(/is-dragging/);
    },
  );
  await expect(epicTitles(page)).toHaveText(['決済の障害を減らす', 'ポイント制度を公開する']);
  await expect(page.locator('[data-drop]')).toHaveCount(0);
  await expect(epicRow(page, '決済の障害を減らす')).toHaveClass(/is-dropped/);
  await expect(
    page.getByRole('status').filter({ hasText: '「決済の障害を減らす」を 1 番目に移しました' }),
  ).toBeAttached();
  // 配下のストーリーは、元のエピックの下のまま
  await expect(points.locator('.tree-row.is-story')).toHaveCount(1);

  // ストーリーやタスクの行に重ねても、エピックは落とせない（何も示さない）
  await dragTo(
    page,
    epicRow(page, '決済の障害を減らす').locator('.grip'),
    storyRow(page, '残高が見える'),
    'bottom',
    async () => {
      await expect(page.locator('[data-drop]')).toHaveCount(0);
    },
  );
  await expect(epicTitles(page)).toHaveText(['決済の障害を減らす', 'ポイント制度を公開する']);

  await moved;
  await page.reload();
  await expect(epicTitles(page)).toHaveText(['決済の障害を減らす', 'ポイント制度を公開する']);
  expect(await collect()).toEqual([]);
});

test('完了か中止したエピックも並べ替えられる。断られたら、理由を知らせて読み直す', async ({ page }) => {
  await createWorkspace(page, 'レイドの中止パーティ', 'game');
  for (const title of ['ポイント制度を公開する', '決済の障害を減らす']) await addEpic(page, title);
  // 2番目のエピックを、木の上だけ中止したことにする（中止の操作は #65 で足す）
  await page.route('**/api/aoba/backlog-tree', async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { epics: { title: string; canceled_at: string | null }[] };
    const epics = body.epics.map((epic) =>
      epic.title === '決済の障害を減らす' ? { ...epic, canceled_at: '2026-10-22T00:00:00.000Z' } : epic,
    );
    await route.fulfill({ response, json: { ...body, epics } });
  });
  await page.reload();
  await expect(epicRow(page, '決済の障害を減らす').locator('.chip', { hasText: '中止' })).toBeVisible();
  await expect(epicRow(page, '決済の障害を減らす').locator('.grip')).toBeVisible();
  const up = page.getByRole('button', { name: '上へ: 決済の障害を減らす' });
  await expect(up).toHaveAttribute('aria-disabled', 'false');

  // 断られたら、ストーリーとタスクと同じ文で知らせて読み直し、フォーカスを同じ操作へ戻す
  await page.route('**/api/aoba/epic-move', (route) =>
    route.fulfill({
      status: 409,
      json: { error: { code: 'conflict', message: 'conflict', details: { reason: 'changed' } } },
    }),
  );
  await up.click();
  await expect(
    page.getByRole('status').filter({ hasText: 'ほかの画面で変わったため、移せませんでした。一覧を読み直します' }),
  ).toBeVisible();
  await expect(epicTitles(page)).toHaveText(['ポイント制度を公開する', '決済の障害を減らす']);
  await expect(up).toBeFocused();

  // 通るときは、中止したエピックも先頭へ動く
  await page.unroute('**/api/aoba/epic-move');
  const moved = waitForResponses(page, '/epic-move');
  await up.click();
  await expect(epicTitles(page)).toHaveText(['決済の障害を減らす', 'ポイント制度を公開する']);
  await moved;
  await page.reload();
  await expect(epicTitles(page)).toHaveText(['決済の障害を減らす', 'ポイント制度を公開する']);
});

function taskRow(page: Page, title: string) {
  return page.locator('.entry', { hasText: title });
}

function taskGrip(page: Page, title: string) {
  return taskRow(page, title).locator('.grip');
}

function storyRow(page: Page, title: string) {
  return page.locator('.tree-row.is-story', { has: page.getByRole('button', { name: title, exact: true }) });
}

function storyTitles(page: Page) {
  return page.locator('.tree-group button.tree-link');
}

test('つまみのドラッグで、同じ親の中のタスクを並べ替え、読み直しても同じ順になる。元と同じ位置では送らない', async ({
  page,
}) => {
  const collect = await watchViolations(page);
  await createWorkspace(page, 'ドラッグパーティ', 'game');
  for (const title of ['見積もりを送る', '請求書を出す', '議事録をまとめる']) await addTask(page, title);
  const sent: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/task-move')) sent.push(request.postData() ?? '');
  });
  // つまみは飾り（読み上げに出さない）
  await expect(taskGrip(page, '見積もりを送る')).toHaveAttribute('aria-hidden', 'true');
  // 下の2回のドラッグの応答。2件目は1件目の応答の後に送られる
  const moved = waitForResponses(page, '/task-move', 2);

  // 3番目を先頭の行の上半分へ。離す前に、その行の上に線が出る
  await dragTo(page, taskGrip(page, '議事録をまとめる'), taskRow(page, '見積もりを送る'), 'top', async () => {
    await expect(taskRow(page, '見積もりを送る')).toHaveAttribute('data-drop', 'before');
    await expect(taskRow(page, '議事録をまとめる')).toHaveClass(/is-dragging/);
  });
  await expect(rootTitles(page)).toHaveText(['議事録をまとめる', '見積もりを送る', '請求書を出す']);
  await expect(page.locator('[data-drop]')).toHaveCount(0);
  await expect(taskRow(page, '議事録をまとめる')).toHaveClass(/is-dropped/);
  // ボタンと同じ読み上げ。フォーカスは動かさない
  await expect(
    page.getByRole('status').filter({ hasText: '「議事録をまとめる」を 1 番目に移しました' }),
  ).toBeAttached();
  await expect(page.locator(':focus')).toHaveCount(0);

  // 先頭の行を、2番目の行の下半分へ（1つ下へ）
  await dragTo(page, taskGrip(page, '議事録をまとめる'), taskRow(page, '見積もりを送る'), 'bottom', async () => {
    await expect(taskRow(page, '見積もりを送る')).toHaveAttribute('data-drop', 'after');
  });
  await expect(rootTitles(page)).toHaveText(['見積もりを送る', '議事録をまとめる', '請求書を出す']);

  // 元と同じ位置（自分の行、すぐ上の行の下）には、線を出さず、何も送らない
  await moved;
  const before = sent.length;
  expect(before).toBe(2);
  await dragTo(page, taskGrip(page, '議事録をまとめる'), taskRow(page, '議事録をまとめる'), 'bottom', async () => {
    await expect(page.locator('[data-drop]')).toHaveCount(0);
  });
  await dragTo(page, taskGrip(page, '議事録をまとめる'), taskRow(page, '見積もりを送る'), 'bottom', async () => {
    await expect(page.locator('[data-drop]')).toHaveCount(0);
  });
  await expect(rootTitles(page)).toHaveText(['見積もりを送る', '議事録をまとめる', '請求書を出す']);

  // 落とした時点で送るなら、その要求は読み直しより前に出る。読み直した後で、送った数が増えていないことを確かめる
  await page.reload();
  expect(sent.length).toBe(before);
  await expect(rootTitles(page)).toHaveText(['見積もりを送る', '議事録をまとめる', '請求書を出す']);
  expect(await collect()).toEqual([]);
});

test('畳んだストーリーの行やタスクの無いストーリーの行に重ねて落とすと、末尾に入って行が開く。別の親の行の間にも落とせる。ストーリーも並べ替えられる', async ({
  page,
}) => {
  const collect = await watchViolations(page);
  await createWorkspace(page, 'ドラッグの親パーティ', 'game');
  await addStory(page, 'ポイント制度を公開する');
  await addStory(page, '決済の障害を減らす');
  await page.getByRole('button', { name: 'クエストを足す: ポイント制度を公開する' }).click();
  const taskDialog = page.getByRole('dialog', { name: '依頼を出す' });
  await taskDialog.getByLabel('タイトル').fill('付与のバッチを書く');
  await taskDialog.getByRole('button', { name: '依頼を出す' }).click();
  await expect(taskDialog).toBeHidden();
  await addTask(page, '残高の画面を作る');
  await addTask(page, '請求書を出す');
  const points = storyGroup(page, 'ポイント制度を公開する');
  const payments = storyGroup(page, '決済の障害を減らす');

  // 畳んだストーリーの行の真ん中に重ねると、行を囲む。離すと末尾に入り、行が開く
  const caret = points.locator('.tree-caret');
  await caret.click();
  await expect(caret).toHaveAttribute('aria-expanded', 'false');
  await dragTo(
    page,
    taskGrip(page, '残高の画面を作る'),
    storyRow(page, 'ポイント制度を公開する'),
    'middle',
    async () => {
      await expect(storyRow(page, 'ポイント制度を公開する')).toHaveAttribute('data-drop', 'into');
    },
  );
  await expect(caret).toHaveAttribute('aria-expanded', 'true');
  await expect(points.locator('.entry-title')).toHaveText(['付与のバッチを書く', '残高の画面を作る']);
  await expect(
    page
      .getByRole('status')
      .filter({ hasText: '「残高の画面を作る」を達成目標「ポイント制度を公開する」の末尾へ移しました' }),
  ).toBeAttached();
  await expect(rootTitles(page)).toHaveText(['請求書を出す']);

  // タスクの無いストーリーの行に重ねても、末尾に入る
  await dragTo(page, taskGrip(page, '請求書を出す'), storyRow(page, '決済の障害を減らす'), 'middle');
  await expect(payments.locator('.entry-title')).toHaveText(['請求書を出す']);
  await expect(rootTitles(page)).toHaveCount(0);

  // 別のストーリーの行の間に落とす（先頭の行の上）。離す前に、その行の上に線が出る
  await dragTo(page, taskGrip(page, '付与のバッチを書く'), taskRow(page, '請求書を出す'), 'top', async () => {
    await expect(taskRow(page, '請求書を出す')).toHaveAttribute('data-drop', 'before');
  });
  await expect(payments.locator('.entry-title')).toHaveText(['付与のバッチを書く', '請求書を出す']);
  await expect(points.locator('.entry-title')).toHaveText(['残高の画面を作る']);

  // ストーリーを並べ替える。ストーリーの行の上半分に落とすと、配下を含めた塊の上に線が出る。
  // 前のタスクの移動の後に送られるので、この応答を待てば、読み直す前にすべて書き終わっている
  const storyMoved = waitForResponses(page, '/story-move');
  await dragTo(
    page,
    storyRow(page, '決済の障害を減らす').locator('.grip'),
    storyRow(page, 'ポイント制度を公開する'),
    'top',
    async () => {
      await expect(points).toHaveAttribute('data-drop', 'before');
    },
  );
  await expect(storyTitles(page)).toHaveText(['決済の障害を減らす', 'ポイント制度を公開する']);

  await storyMoved;
  await page.reload();
  await expect(storyTitles(page)).toHaveText(['決済の障害を減らす', 'ポイント制度を公開する']);
  await expect(payments.locator('.entry-title')).toHaveText(['付与のバッチを書く', '請求書を出す']);
  await expect(points.locator('.entry-title')).toHaveText(['残高の画面を作る']);
  expect(await collect()).toEqual([]);
});

test('親なしの段が空でも、つかんでいる間だけ出る落とし先に落として、タスクを親なしへ引き出せる', async ({ page }) => {
  const collect = await watchViolations(page);
  await createWorkspace(page, '引き出しパーティ', 'game');
  await addStory(page, 'ポイント制度を公開する');
  await page.getByRole('button', { name: 'クエストを足す: ポイント制度を公開する' }).click();
  const taskDialog = page.getByRole('dialog', { name: '依頼を出す' });
  await taskDialog.getByLabel('タイトル').fill('付与のバッチを書く');
  await taskDialog.getByRole('button', { name: '依頼を出す' }).click();
  await expect(taskDialog).toBeHidden();
  await expect(rootTitles(page)).toHaveCount(0);
  // つかんでいないときは、落とし先を出さない
  await expect(page.locator('.tree-slot')).toHaveCount(0);

  const slot = page.locator('.tree-slot .dropzone');
  const moved = waitForResponses(page, '/task-move');
  await dragTo(page, taskGrip(page, '付与のバッチを書く'), slot, 'middle', async () => {
    // つかんでいる間は出て、重ねると囲む
    await expect(slot).toHaveClass(/is-over/);
    await expect(slot).toContainText('親なしのクエストへ移す');
  });
  await expect(rootTitles(page)).toHaveText(['付与のバッチを書く']);
  await expect(storyGroup(page, 'ポイント制度を公開する').locator('.entry-title')).toHaveCount(0);
  await expect(page.locator('.tree-slot')).toHaveCount(0);
  await expect(
    page.getByRole('status').filter({ hasText: '「付与のバッチを書く」を親なしの末尾へ移しました' }),
  ).toBeAttached();

  await moved;
  await page.reload();
  await expect(rootTitles(page)).toHaveText(['付与のバッチを書く']);
  expect(await collect()).toEqual([]);
});

test('終了したワークスペースでは、つまみを出さない', async ({ page }) => {
  // 管理の画面の行を名前で探すので、繰り返しと再試行で作った同じ名前の行に当てない
  const name = `終了したつまみパーティ ${test.info().repeatEachIndex}-${test.info().retry}`;
  await createWorkspace(page, name, 'game');
  await addTask(page, '見積もりを送る');
  await addEpic(page, 'ポイント制度を公開する');
  await expect(page.locator('.entry .grip')).toBeVisible();
  await expect(page.locator('.tree-row.is-epic .grip')).toBeVisible();
  const workspaceUrl = page.url();
  // 管理の画面から終了する
  await page.goto('/aoba/admin');
  const row = page.getByRole('region', { name: 'パーティ', exact: true }).locator('tbody tr', { hasText: name });
  await row.getByRole('button', { name: `「${name}」を終了する` }).click();
  await page
    .getByRole('dialog', { name: `「${name}」を終了しますか？` })
    .getByRole('button', { name: `「${name}」を終了する` })
    .click();
  await expect(row.locator('.chip')).toHaveText(/^終了 \d{4}-\d{2}-\d{2}$/);

  await page.goto(workspaceUrl);
  await expect(rootTitles(page)).toHaveText(['見積もりを送る']);
  await expect(page.locator('.grip')).toHaveCount(0);
  await expect(page.locator('.action-note')).toHaveCount(0);
  // エピックの行にも、つまみと「上へ」「下へ」を出さない
  await expect(epicTitles(page)).toHaveText(['ポイント制度を公開する']);
  await expect(page.locator('.order-actions')).toHaveCount(0);
});

test('狭い幅ではつまみを出さず、題の列も空けない', async ({ page }) => {
  await createWorkspace(page, 'つまみのパーティ', 'game');
  await addTask(page, '見積もりを送る');
  await expect(page.locator('.entry .grip')).toBeVisible();
  await expect(page.locator('.drag-note')).toBeVisible();
  await page.setViewportSize({ width: 390, height: 900 });
  await expect(page.locator('.entry .grip')).toBeHidden();
  // つまみに触れる案内の文も隠し、「上へ」「下へ」の案内は残す
  await expect(page.locator('.drag-note')).toBeHidden();
  await expect(page.getByText(/上にあるものほど優先します/)).toBeVisible();
  // つまみの列を空けないので、題は左端から始まる
  const row = await page.locator('.entry').boundingBox();
  const title = await page.locator('.entry-title').boundingBox();
  expect(title!.x - row!.x).toBeLessThan(80);
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

test('一覧が広いまま指で押す画面（タブレットの横置き）でも、44px のボタンで題の列を縮めすぎない', async ({
  browser,
  baseURL,
}) => {
  // 一覧の幅が 640px を少し超える幅。右端は題の下へ折り返さないので、44px のボタンが題の列を押しのけうる
  const context = await browser.newContext({ hasTouch: true, isMobile: true, viewport: { width: 960, height: 768 } });
  await steadyScreenshots(context);
  await signIn(context, baseURL, 'admin');
  const page = await context.newPage();
  await page.goto(SEED_GAME_WORKSPACE);
  expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);
  const up = page.locator('.tree-children .entry .order-actions .icon-btn').first();
  expect((await up.boundingBox())!.width).toBeGreaterThanOrEqual(44);
  // 題の列は 12rem（192px）を保つ
  for (const main of await page.locator('.tree-children .entry .entry-main').all()) {
    expect((await main.boundingBox())!.width).toBeGreaterThanOrEqual(190);
  }
  await context.close();
});

test('ストーリーを作った後の読み直しの応答が、続けて作ったタスクより遅れて届いても、作ったタスクは画面に残る', async ({
  page,
}) => {
  await createWorkspace(page, '遅れた読み直しパーティ', 'game');
  await addStory(page, 'ポイント制度を公開する');

  // 次の読み直しは、サーバーから受け取っておいて、タスクを作った後まで画面へ返さない。
  // 返る木は、タスクを作る前に読んだものなので、作ったタスクを含まない
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let held = false;
  await page.route('**/api/aoba/backlog-tree', async (route) => {
    if (held) return route.fallback();
    held = true;
    const response = await route.fetch();
    await gate;
    await route.fulfill({ response });
  });

  // 返る前に画面へ出す印を使わずに、ダイアログを閉じるところまで進める
  await page.getByRole('button', { name: '達成目標を作る' }).click();
  const storyDialog = page.getByRole('dialog', { name: '達成目標を作る' });
  await storyDialog.getByLabel('タイトル').fill('決済の障害を減らす');
  await storyDialog.getByRole('button', { name: '作る' }).click();
  await expect(storyDialog).toBeHidden();
  await expect.poll(() => held).toBe(true);

  await page.getByRole('button', { name: 'クエストを足す: ポイント制度を公開する' }).click();
  const taskDialog = page.getByRole('dialog', { name: '依頼を出す' });
  await taskDialog.getByLabel('タイトル').fill('付与のバッチを書く');
  await taskDialog.getByRole('button', { name: '依頼を出す' }).click();
  await expect(taskDialog).toBeHidden();
  const group = storyGroup(page, 'ポイント制度を公開する');
  await expect(group.locator('.entry-title')).toHaveText(['付与のバッチを書く']);

  // 遅れた読み直しを届ける
  const reloaded = waitForResponses(page, '/backlog-tree');
  release();
  await reloaded;
  await expect(storyRow(page, '決済の障害を減らす')).toBeVisible();
  await expect(group.locator('.entry-title')).toHaveText(['付与のバッチを書く']);
});
