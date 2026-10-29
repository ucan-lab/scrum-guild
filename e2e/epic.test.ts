// 一本道: エピックを作る → ストーリーを作ってエピックの下へ移す → タスクを足して完了にする → ストーリーを完了にする → 取り消す。
// 未完了のタスクが残るあいだは「完了にする」が押せず、残りの件数が出る。完了と取り消しを断られたら、理由を知らせて読み直す。
// seed のセッション（seed/sessions.ts）の Cookie で開く。あおば開発の管理者はミナト。CSP の違反も確かめる
import type { Page } from '@playwright/test';
import { expect, steadyScreenshots, test } from './fixtures.ts';
import { createWorkspace, signIn, waitForResponses, watchViolations } from './helpers.ts';

test.use({ timezoneId: 'Asia/Tokyo' });

test.beforeEach(async ({ context, baseURL }) => {
  await signIn(context, baseURL, 'admin');
});

// 題の行を自分の直下に持つ木の1件（エピックの中のストーリーで、エピックの方を拾わない）
function rowGroup(page: Page, title: string) {
  return page.locator(
    `xpath=//div[contains(@class, "tree-group")][./div[contains(@class, "tree-row")]//*[contains(@class, "tree-link") and normalize-space() = "${title}"]]`,
  );
}

// 作った後は、木の読み直しが返るまで待つ。読み直しで木が替わると、画面だけで足したタスクと並べ替えを捨てる（+page.svelte）ので、
// 返る前に次の操作を送ると、その結果が後から届いた読み直しで消えうる
async function createEpic(page: Page, label: string, title: string): Promise<void> {
  await page.getByRole('button', { name: label }).click();
  const dialog = page.getByRole('dialog', { name: label });
  await dialog.getByLabel('タイトル').fill(title);
  const reloaded = waitForResponses(page, '/backlog-tree');
  await dialog.getByRole('button', { name: '作る' }).click();
  await expect(dialog).toBeHidden();
  await reloaded;
}

async function createStory(page: Page, label: string, title: string): Promise<void> {
  await page.getByRole('button', { name: label }).click();
  const dialog = page.getByRole('dialog', { name: label });
  await dialog.getByLabel('タイトル').fill(title);
  const reloaded = waitForResponses(page, '/backlog-tree');
  await dialog.getByRole('button', { name: '作る' }).click();
  await expect(dialog).toBeHidden();
  await reloaded;
}

test('ゲームの言葉: レイドを作り、達成目標を下へ移し、配下のクエストを完遂にしてから達成目標を完遂にし、取り消す', async ({
  page,
}) => {
  const collect = await watchViolations(page);
  await createWorkspace(page, 'レイドのパーティ', 'game');

  // エピックを作る。木の最上段に出て、配下が無い
  await createEpic(page, 'レイドを作る', 'ポイント制度を公開する');
  await expect(page.getByRole('status').filter({ hasText: 'レイドを作りました' })).toBeVisible();
  const epic = rowGroup(page, 'ポイント制度を公開する');
  await expect(epic.locator('.tree-row.is-epic .tree-ratio')).toHaveText('完遂 0 / 0 pt');
  await expect(epic.getByText('達成目標はまだありません')).toBeVisible();

  // 題からエピックの画面を開き、見出しの横の「直す」で開くダイアログで直す。開いたら1件を読む
  await page.getByRole('link', { name: 'ポイント制度を公開する', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'ポイント制度を公開する' })).toBeVisible();
  const editEpic = page.getByRole('button', { name: 'レイドを直す' });
  await editEpic.click();
  const epicDialog = page.getByRole('dialog', { name: 'レイド' });
  await expect(epicDialog.getByLabel('タイトル')).toHaveValue('ポイント制度を公開する');
  await epicDialog.getByLabel('本文').fill('年内に公開する');
  await epicDialog.getByLabel('期限').fill('2026-12-25');
  const detailReloaded = waitForResponses(page, '/epic-detail');
  await epicDialog.getByRole('button', { name: '保存する' }).click();
  await expect(epicDialog).toBeHidden();
  await expect(page.getByRole('status').filter({ hasText: 'レイドを保存しました' })).toBeVisible();
  // 直したら画面を読み直す。本文は概要に、期日は依頼書に出る
  await detailReloaded;
  await expect(page.getByText('年内に公開する')).toBeVisible();
  await expect(page.locator('.props').getByText('12/25')).toBeVisible();
  await editEpic.click();
  await expect(epicDialog.getByLabel('本文')).toHaveValue('年内に公開する');
  await epicDialog.getByRole('button', { name: 'やめる' }).click();
  // 掲示板へ戻ると、木のエピックの行に期日が出る
  await page.getByRole('link', { name: '掲示板へ戻る' }).click();
  await expect(epic.locator('.tree-row.is-epic .chip')).toHaveText('12/25');

  // 親のないストーリーを作り、「親を移す」でエピックの下へ移す。今が親なしなので、親なしは候補に出さない
  await createStory(page, '達成目標を作る', '残高が見える');
  await page.getByRole('button', { name: '親を移す: 残高が見える' }).click();
  const moveDialog = page.getByRole('dialog', { name: '「残高が見える」の親を移す' });
  await expect(moveDialog.getByLabel('移す先').locator('option')).toHaveText(['ポイント制度を公開する']);
  // 読み上げは送る前に出るので、読み直す前に応答を待つ
  const moved = waitForResponses(page, '/story-move');
  await moveDialog.getByRole('button', { name: '移す' }).click();
  await expect(moveDialog).toBeHidden();
  await expect(epic.locator('.tree-children .tree-row.is-story button.tree-link')).toHaveText(['残高が見える']);
  await expect(
    page
      .getByRole('status')
      .filter({ hasText: '「残高が見える」をレイド「ポイント制度を公開する」の末尾へ移しました' }),
  ).toBeAttached();
  await moved;
  await page.reload();
  await expect(epic.locator('.tree-children .tree-row.is-story button.tree-link')).toHaveText(['残高が見える']);

  // 配下が無いあいだは完了にできる状態。タスクを足すと、残りの件数が出て押せなくなる
  const story = rowGroup(page, '残高が見える');
  await story.getByRole('button', { name: 'クエストを足す: 残高が見える' }).click();
  const taskDialog = page.getByRole('dialog', { name: '依頼を出す' });
  await expect(taskDialog.getByLabel('親の達成目標').locator('option:checked')).toHaveText('残高が見える');
  // 親の候補は、親のエピックの題でまとめる
  await expect(taskDialog.getByLabel('親の達成目標').locator('optgroup')).toHaveAttribute(
    'label',
    'ポイント制度を公開する',
  );
  await taskDialog.getByLabel('タイトル').fill('残高の API を作る');
  await taskDialog.getByRole('radio', { name: '3', exact: true }).check();
  await taskDialog.getByRole('button', { name: '依頼を出す' }).click();
  await expect(taskDialog).toBeHidden();
  const completeStory = story.getByRole('button', { name: '完遂にする: 残高が見える' });
  await expect(completeStory).toHaveAttribute('aria-disabled', 'true');
  await expect(story.locator('.tree-note')).toHaveText('残り 1 件のクエスト');
  await expect(completeStory).toHaveAccessibleDescription(
    '残り 1 件のクエスト 未完了のクエストが残っているあいだは完遂にできません',
  );
  await expect(epic.locator('.tree-row.is-epic .tree-ratio')).toHaveText('完遂 0 / 3 pt');
  // 押しても何も送らない
  let sent = 0;
  page.on('request', (request) => {
    if (request.url().endsWith('/story-complete')) sent++;
  });
  // aria-disabled のボタンは Playwright が押せないものとして待つので、待たずに押す
  await completeStory.click({ force: true });
  expect(sent).toBe(0);

  // タスクを完了にすると、読み直さずに押せるようになり、エピックの「完遂」にも足される
  await story.getByRole('button', { name: '完遂にする: 残高の API を作る' }).click();
  await expect(story.getByRole('img', { name: '残高の API を作る: 完遂' })).toBeVisible();
  await expect(completeStory).toHaveAttribute('aria-disabled', 'false');
  await expect(story.locator('.tree-note')).toHaveCount(0);
  await expect(epic.locator('.tree-row.is-epic .tree-ratio')).toHaveText('完遂 3 / 3 pt');

  // ストーリーを完了にする。完了の印と「取り消す」が出て、フォーカスは「取り消す」へ移る
  await completeStory.click();
  await expect(page.getByRole('status').filter({ hasText: '達成目標を完遂にしました' })).toBeVisible();
  await expect(story.getByRole('img', { name: '残高が見える: 完遂' })).toBeVisible();
  const reopen = story.getByRole('button', { name: '完遂を取り消す: 残高が見える' });
  await expect(reopen).toBeFocused();
  await expect(story.getByRole('button', { name: 'クエストを足す: 残高が見える' })).toHaveCount(0);
  // 完了したストーリーは、タスクの親の候補に出ない
  await page.getByRole('button', { name: '依頼を出す' }).click();
  await expect(taskDialog.getByLabel('親の達成目標').locator('option')).toHaveText(['なし']);
  await taskDialog.getByRole('button', { name: 'やめる' }).click();

  // 取り消すと「完了にする」に戻る
  await reopen.click();
  await expect(page.getByRole('status').filter({ hasText: '達成目標の完遂を取り消しました' })).toBeVisible();
  await expect(completeStory).toBeFocused();
  await expect(story.getByRole('img', { name: '残高が見える: 完遂' })).toHaveCount(0);

  // エピックの下から親なしへ戻す
  await story.getByRole('button', { name: '親を移す: 残高が見える' }).click();
  await moveDialog.getByLabel('移す先').selectOption({ label: '親なし' });
  await moveDialog.getByRole('button', { name: '移す' }).click();
  await expect(epic.getByText('達成目標はまだありません')).toBeVisible();
  await expect(page.getByRole('button', { name: '親を移す: 残高が見える' })).toBeFocused();
  expect(await collect()).toEqual([]);
});

test('スクラムの言葉: 配下の無いストーリーは完了にでき、断られたら理由を知らせて読み直す。狭い幅でもはみ出さない', async ({
  page,
}) => {
  await createWorkspace(page, 'エピックのワークスペース', 'scrum');
  await createEpic(page, 'エピックを作る', '決済の障害を減らす');
  await createStory(page, 'ストーリーを作る', '検知を早くする');
  await page.getByRole('button', { name: '親を移す: 検知を早くする' }).click();
  const moveDialog = page.getByRole('dialog', { name: '「検知を早くする」の親を移す' });
  const moved = waitForResponses(page, '/story-move');
  await moveDialog.getByRole('button', { name: '移す' }).click();
  const story = rowGroup(page, '検知を早くする');
  await expect(rowGroup(page, '決済の障害を減らす').locator('.tree-children .tree-row.is-story')).toHaveCount(1);
  // 下で断られると木を読み直すので、親の移動が書き終わってから進む（書き終わる前に読み直すと、エピックの下から消える）
  await moved;

  // 断られたら（別の画面で先にタスクが足された）、理由を知らせて読み直す
  let reloaded = 0;
  page.on('request', (request) => {
    if (request.url().endsWith('/backlog-tree')) reloaded++;
  });
  await page.route('**/story-complete', (route) =>
    route.fulfill({
      status: 409,
      json: { error: { code: 'conflict', message: 'conflict', details: { reason: 'open_tasks' } } },
    }),
  );
  await story.getByRole('button', { name: '完了にする: 検知を早くする' }).click();
  await expect(
    page
      .getByRole('status')
      .filter({ hasText: '未完了のタスクが残っているため、完了にできません。一覧を読み直します' }),
  ).toBeVisible();
  await expect.poll(() => reloaded).toBeGreaterThan(0);
  await page.unroute('**/story-complete');

  // 配下にタスクが1件も無くても完了にできる
  await story.getByRole('button', { name: '完了にする: 検知を早くする' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'ストーリーを完了にしました' })).toBeVisible();
  await expect(story.getByRole('img', { name: '検知を早くする: 完了' })).toBeVisible();
  await expect(story.getByRole('button', { name: '完了を取り消す: 検知を早くする' })).toBeFocused();

  // 狭い幅でも、エピックとストーリーの行が横にはみ出さない
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(story.locator('.tree-title')).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, `${width}px`).toBeLessThanOrEqual(0);
    expect((await story.locator('.tree-title').boundingBox())!.width, `${width}px`).toBeGreaterThanOrEqual(100);
  }

  await story.getByRole('button', { name: '完了を取り消す: 検知を早くする' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'ストーリーの完了を取り消しました' })).toBeVisible();
  await expect(story.getByRole('button', { name: '完了にする: 検知を早くする' })).toBeVisible();
});

// seed のワークスペース（受託開発チーム）。エピック「ポイントの交換先を増やす」の下に、ストーリー「送料の割引にポイントを使える」がある
const SEED_GAME_WORKSPACE = '/aoba/w/019a0000-0000-7000-8000-000000000401';
const SEED_EPIC_STORY = '送料の割引にポイントを使える';
const SEED_ROOT_STORY = 'ポイントの付与と失効を管理画面で確かめられる';

test('クリアしたレイドの下の完遂した達成目標は、取り消しを押せず、理由を出す', async ({ page }) => {
  // 木の応答で、seed のエピックをクリア済みに、その下のストーリーを完了にする
  await page.route('**/api/aoba/backlog-tree', async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { epics: { completed_at: string | null; stories: object[] }[] };
    const epics = body.epics.map((epic) => ({
      ...epic,
      completed_at: '2026-10-22T00:00:00.000Z',
      stories: epic.stories.map((story) => ({ ...story, completed_at: '2026-10-21T00:00:00.000Z' })),
    }));
    await route.fulfill({ response, json: { ...body, epics } });
  });
  let sent = 0;
  page.on('request', (request) => {
    if (request.url().endsWith('/story-reopen')) sent++;
  });
  await page.goto(SEED_GAME_WORKSPACE);
  const epic = rowGroup(page, 'ポイントの交換先を増やす');
  await expect(epic.locator('.tree-row.is-epic .chip.is-done')).toHaveText('クリア済み');
  const story = rowGroup(page, SEED_EPIC_STORY);
  const reopen = story.getByRole('button', { name: `完遂を取り消す: ${SEED_EPIC_STORY}` });
  await expect(reopen).toHaveAttribute('aria-disabled', 'true');
  await expect(reopen).toHaveAccessibleDescription('完遂か中止したレイドの下の達成目標は取り消せません');
  await expect(story.locator('.tree-note')).toBeVisible();
  // aria-disabled のボタンは Playwright が押せないものとして待つので、待たずに押す
  await reopen.click({ force: true });
  expect(sent).toBe(0);
});

test('中止したレイドの下の達成目標は、完遂にするを押せず、理由を出す', async ({ page }) => {
  await page.route('**/api/aoba/backlog-tree', async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { epics: { canceled_at: string | null }[] };
    const epics = body.epics.map((epic) => ({ ...epic, canceled_at: '2026-10-22T00:00:00.000Z' }));
    await route.fulfill({ response, json: { ...body, epics } });
  });
  let sent = 0;
  page.on('request', (request) => {
    if (request.url().endsWith('/story-complete')) sent++;
  });
  await page.goto(SEED_GAME_WORKSPACE);
  await expect(
    rowGroup(page, 'ポイントの交換先を増やす').locator('.tree-row.is-epic .chip', { hasText: '中止' }),
  ).toBeVisible();
  const story = rowGroup(page, SEED_EPIC_STORY);
  const complete = story.getByRole('button', { name: `完遂にする: ${SEED_EPIC_STORY}` });
  await expect(complete).toHaveAttribute('aria-disabled', 'true');
  await expect(complete).toHaveAccessibleDescription('完遂か中止したレイドの下の達成目標は完遂にできません');
  await complete.click({ force: true });
  expect(sent).toBe(0);
});

test('ストーリーの行は、メニューの横の幅と指で押す画面でも、題の列を 12rem 以上に保ち、横にはみ出さない', async ({
  browser,
  baseURL,
}) => {
  for (const options of [
    { viewport: { width: 960, height: 768 }, hasTouch: true, isMobile: true },
    { viewport: { width: 1024, height: 900 } },
    { viewport: { width: 1280, height: 900 } },
    { viewport: { width: 1280, height: 900 }, hasTouch: true, isMobile: true },
  ]) {
    const context = await browser.newContext(options);
    await steadyScreenshots(context);
    await signIn(context, baseURL, 'admin');
    const page = await context.newPage();
    await page.goto(SEED_GAME_WORKSPACE);
    const label = `${options.viewport.width}px${options.hasTouch ? ' coarse' : ''}`;
    // 親のないストーリーと、エピックの下のストーリー（一段字下げする）
    for (const title of [SEED_ROOT_STORY, SEED_EPIC_STORY]) {
      const row = rowGroup(page, title).locator(':scope > .tree-row');
      await expect(row).toBeVisible();
      expect((await row.locator('.tree-title').boundingBox())!.width, `${label} ${title}`).toBeGreaterThanOrEqual(190);
    }
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, label).toBeLessThanOrEqual(0);
    await context.close();
  }
});
