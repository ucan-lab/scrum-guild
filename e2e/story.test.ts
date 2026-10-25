// 一本道: ストーリーを作る → 「＋タスク」でその下にタスクを作る → 完了にする → 読み直すとストーリーの「完了 / 全体」が変わる。
// seed のセッション（seed/sessions.ts）の Cookie で開く。あおば開発の管理者はミナト。CSP の違反も確かめる
import { expect, test, type Page } from '@playwright/test';
import { createWorkspace, signIn, watchViolations } from './helpers.ts';

test.use({ timezoneId: 'Asia/Tokyo' });

test.beforeEach(async ({ context, baseURL }) => {
  await signIn(context, baseURL, 'admin');
});

// seed のワークスペース。受託開発チーム（あおば開発、ゲームの言葉）と社内ツール（ひばり工房、スクラムの言葉）
const SEED_GAME_WORKSPACE = '/aoba/w/019a0000-0000-7000-8000-000000000401';
const SEED_SCRUM_WORKSPACE = '/hibari/w/019a0000-0000-7000-8000-000000000402';

// 木のストーリー1件
function storyGroup(page: Page, title: string) {
  return page.locator('details.tree-group', { has: page.getByRole('button', { name: title, exact: true }) });
}

test('ゲームの言葉: 達成目標を作り、＋クエストでその下にクエストを作って完遂にすると、読み直したら「完遂 / 全体」が変わる', async ({
  page,
}) => {
  const collect = await watchViolations(page);
  await createWorkspace(page, '木のパーティ', 'game');

  // ストーリーを作る。タイトル以外は空でよい
  await page.getByRole('button', { name: '達成目標を作る' }).click();
  const storyDialog = page.getByRole('dialog', { name: '達成目標を作る' });
  // 空のタイトルは送らずに知らせる
  await storyDialog.getByRole('button', { name: '作る' }).click();
  await expect(storyDialog.getByText('タイトルを入れてください')).toBeVisible();
  await storyDialog.getByLabel('タイトル').fill('ポイント制度を公開する');
  await storyDialog.getByLabel('達成条件').fill('- 残高が見える');
  await storyDialog.getByLabel('リンク').fill('ftp://example.com');
  await storyDialog.getByRole('button', { name: '作る' }).click();
  await expect(storyDialog.getByText('http か https で始まる URL を入れてください')).toBeVisible();
  await storyDialog.getByLabel('リンク').fill('');
  await storyDialog.getByRole('button', { name: '作る' }).click();
  await expect(storyDialog).toBeHidden();
  await expect(page.getByRole('status').filter({ hasText: '達成目標を作りました' })).toBeVisible();

  const group = storyGroup(page, 'ポイント制度を公開する');
  await expect(group.locator('.tree-ratio')).toHaveText('完遂 0 / 0 pt');
  await expect(group.getByText('クエストはまだありません')).toBeVisible();

  // 行の「＋クエスト」から、親を選んだ状態でタスクのダイアログが開く。行は閉じない
  await group.getByRole('button', { name: 'クエストを足す: ポイント制度を公開する' }).click();
  const taskDialog = page.getByRole('dialog', { name: '依頼を出す' });
  await expect(taskDialog.getByLabel('親の達成目標').locator('option:checked')).toHaveText('ポイント制度を公開する');
  await expect(group).toHaveAttribute('open', '');
  await taskDialog.getByLabel('タイトル').fill('付与のバッチを書く');
  await taskDialog.getByRole('radio', { name: '3', exact: true }).check();
  await taskDialog.getByRole('button', { name: '依頼を出す' }).click();
  await expect(taskDialog).toBeHidden();
  await expect(page.getByRole('status').filter({ hasText: '達成目標の末尾に足しました' })).toBeVisible();

  // 読み直さずに、親の配下に出る。「全体」のポイントには足される
  const row = group.locator('.entry', { hasText: '付与のバッチを書く' });
  await expect(row).toHaveCount(1);
  await expect(group.locator('.tree-ratio')).toHaveText('完遂 0 / 3 pt');
  await expect(group.getByText('クエストはまだありません')).toHaveCount(0);

  // ストーリーの下でも完了にできる。行はその場に残り、完了の印が付く
  await row.getByRole('button', { name: /完遂にする/ }).click();
  await expect(row.getByRole('img', { name: '付与のバッチを書く: 完遂' })).toBeVisible();

  // 読み直すと、「完遂 / 全体」が変わり、完了した行は件数の1行に畳まれる
  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: '掲示板' })).toBeVisible();
  await expect(group.locator('.tree-ratio')).toHaveText('完遂 3 / 3 pt');
  await expect(group.locator('.tree-folded')).toHaveText('完遂 1 件を折りたたんでいます');
  await expect(group.locator('.entry')).toHaveCount(0);
  expect(await collect()).toEqual([]);
});

test('スクラムの言葉: ストーリーの題と「＋タスク」は、クリックでもキーボードでも行を開閉せずにダイアログを開く', async ({
  page,
}) => {
  await createWorkspace(page, '木のチーム', 'scrum');
  await page.getByRole('button', { name: 'ストーリーを作る' }).click();
  const created = page.getByRole('dialog', { name: 'ストーリーを作る' });
  await created.getByLabel('タイトル').fill('請求の流れを整える');
  await created.getByRole('button', { name: '作る' }).click();
  await expect(created).toBeHidden();

  const group = storyGroup(page, '請求の流れを整える');
  await expect(group).toHaveAttribute('open', '');
  const addTask = group.getByRole('button', { name: 'タスクを足す: 請求の流れを整える' });
  const title = group.getByRole('button', { name: '請求の流れを整える', exact: true });

  // 閉じたら、開いたボタンへフォーカスが戻る（close の event は遅れて届くので、戻るのを待ってから次の操作をする）
  async function closeBackTo(opener: typeof title): Promise<void> {
    await page.keyboard.press('Escape');
    await expect(page.locator('dialog[open]')).toHaveCount(0);
    await expect(opener).toBeFocused();
  }

  // クリック
  await title.click();
  await expect(page.getByRole('dialog', { name: 'ストーリー' })).toBeVisible();
  await expect(group).toHaveAttribute('open', '');
  await closeBackTo(title);

  // キーボード（Enter と Space）
  for (const key of ['Enter', ' ']) {
    await addTask.focus();
    await page.keyboard.press(key);
    await expect(page.getByRole('dialog', { name: '起票' })).toBeVisible();
    await expect(group).toHaveAttribute('open', '');
    await closeBackTo(addTask);

    await title.focus();
    await page.keyboard.press(key);
    await expect(page.getByRole('dialog', { name: 'ストーリー' })).toBeVisible();
    await expect(group).toHaveAttribute('open', '');
    await closeBackTo(title);
  }

  // 行のほかの場所を押すと開閉する
  await group.locator('summary .tree-caret').click();
  await expect(group).not.toHaveAttribute('open', '');
});

test('ストーリーを直すときは、変えた欄だけを送る。変えた欄が無ければ何も送らない。過ぎた期日は赤い印で出る', async ({
  page,
}) => {
  await createWorkspace(page, '直すパーティ', 'game');
  await page.getByRole('button', { name: '達成目標を作る' }).click();
  const created = page.getByRole('dialog', { name: '達成目標を作る' });
  await created.getByLabel('タイトル').fill('元のタイトル');
  await created.getByLabel('本文').fill('元の本文');
  await created.getByRole('button', { name: '作る' }).click();
  await expect(created).toBeHidden();

  const updates: unknown[] = [];
  page.on('request', (request) => {
    if (request.url().endsWith('/api/aoba/story-update')) updates.push(request.postDataJSON());
  });

  // 変えずに保存すると、閉じるだけで送らない
  await page.getByRole('button', { name: '元のタイトル', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '達成目標' });
  await expect(dialog.getByLabel('本文')).toHaveValue('元の本文');
  await dialog.getByRole('button', { name: '保存する' }).click();
  await expect(dialog).toBeHidden();
  expect(updates).toEqual([]);

  // タイトルと期日だけを変える
  await page.getByRole('button', { name: '元のタイトル', exact: true }).click();
  await dialog.getByLabel('タイトル').fill('新しいタイトル');
  await dialog.getByLabel('期限').fill('2020-01-02');
  await dialog.getByRole('button', { name: '保存する' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('status').filter({ hasText: '達成目標を保存しました' })).toBeVisible();
  expect(updates).toHaveLength(1);
  expect(Object.keys(updates[0] as object).sort()).toEqual(['due_on', 'story_id', 'title', 'workspace_id']);
  expect(updates[0]).toMatchObject({ title: '新しいタイトル', due_on: '2020-01-02' });

  // 読み直された木で、色だけでなく文字とアイコンを添えた赤い印が出る。ほかの欄は残っている
  const group = storyGroup(page, '新しいタイトル');
  const chip = group.locator('.chip.is-danger');
  await expect(chip).toHaveText('期限切れ 1/2');
  await expect(chip.locator('svg')).toHaveCount(1);
  await page.getByRole('button', { name: '新しいタイトル', exact: true }).click();
  await expect(dialog.getByLabel('本文')).toHaveValue('元の本文');
});

test('期日の印: 過ぎた（赤）、今日と今週（橙）、それ以外（色なし）。今日と週の始まりは API の値', async ({ page }) => {
  // 今日と週の始まりは API が返す値で決まる。seed の日付（2026-10-20 前後）に合わせて差し替える
  await page.route('**/api/aoba/backlog-tree', async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as Record<string, unknown>;
    await route.fulfill({ response, json: { ...body, today: '2026-10-20', week_start: 1 } });
  });
  await page.goto(SEED_GAME_WORKSPACE);
  await expect(page.getByRole('heading', { level: 1, name: '掲示板' })).toBeVisible();

  const first = storyGroup(page, 'ポイントの付与と失効を管理画面で確かめられる');
  // ストーリーの期日（10/23）は今週
  await expect(first.locator('summary .chip.is-warn')).toHaveText('今週 10/23');
  await expect(first.locator('.tree-ratio')).toHaveText('完遂 5 / 10 pt');
  await expect(first.locator('.tree-folded')).toHaveText('完遂 1 件を折りたたんでいます');
  const overdue = first.locator('.entry', { hasText: '失効日の計算に月末の扱いを足す' });
  await expect(overdue.locator('.chip.is-danger')).toHaveText('期限切れ 10/19');
  const thisWeek = first.locator('.entry', { hasText: '失効予定のポイントを知らせる文面を決める' });
  await expect(thisWeek.locator('.chip.is-warn')).toHaveText('今週 10/22');

  const second = storyGroup(page, '問い合わせの一次回答を早くする');
  await expect(
    second.locator('.entry', { hasText: '一次回答のテンプレートを10件書く' }).locator('.chip.is-warn'),
  ).toHaveText('今日まで');
  await expect(second.locator('summary .chip')).toHaveCount(0);

  // 親のないタスクの期日（10/17）は過ぎている
  await expect(page.locator('.entry', { hasText: '障害時の連絡手順を書く' }).locator('.chip.is-danger')).toHaveText(
    '期限切れ 10/17',
  );

  // 今日を 10/12 に替えると、期日（10/19 以降）は来週以降で色なし
  await page.route('**/api/aoba/backlog-tree', async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as Record<string, unknown>;
    await route.fulfill({ response, json: { ...body, today: '2026-10-12', week_start: 1 } });
  });
  await page.reload();
  await expect(first.locator('summary .chip')).toHaveText('10/23');
  await expect(first.locator('summary .chip.is-warn')).toHaveCount(0);
  await expect(page.locator('.chip.is-danger')).toHaveCount(0);
});

test('スクラムの言葉の seed: 言葉が替わり、ストーリーの行の合計と畳んだ件数が出る', async ({ page }) => {
  await page.goto(SEED_SCRUM_WORKSPACE);
  await expect(page.getByRole('heading', { level: 1, name: 'バックログ' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'ストーリーを作る' })).toBeVisible();
  const group = storyGroup(page, '勤怠の締め処理を月末にまとめて回せる');
  await expect(group.locator('.tree-ratio')).toHaveText('完了 1 / 6 pt');
  await expect(group.locator('.tree-folded')).toHaveText('完了 1 件を折りたたんでいます');
  await expect(group.locator('.entry')).toHaveCount(2);
  await expect(storyGroup(page, '有給の残日数を自分で確かめられる').getByText('タスクはまだありません')).toBeVisible();
  // ストーリーの段が先で、親のないタスクは後
  const order = await page
    .locator('.tree > details, .tree > div')
    .evaluateAll((nodes) => nodes.map((node) => node.tagName));
  expect(order).toEqual(['DETAILS', 'DETAILS', 'DIV']);
});

test('閉じたワークスペースでは、作る操作と「＋タスク」を出さず、ストーリーのダイアログは読み取り専用で開く', async ({
  page,
}) => {
  await page.route('**/api/aoba/workspace', async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as Record<string, unknown>;
    await route.fulfill({ response, json: { ...body, closed_at: '2026-10-21T00:00:00.000Z' } });
  });
  await page.goto(SEED_GAME_WORKSPACE);
  await expect(page.getByRole('heading', { level: 1, name: '掲示板' })).toBeVisible();
  await expect(page.getByRole('button', { name: '達成目標を作る' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /クエストを足す/ })).toHaveCount(0);

  await page.getByRole('button', { name: '問い合わせの一次回答を早くする', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '達成目標' });
  await expect(dialog.getByLabel('タイトル')).toHaveValue('問い合わせの一次回答を早くする');
  await expect(dialog.getByLabel('タイトル')).toHaveAttribute('readonly', '');
  await expect(dialog.getByRole('button', { name: '保存する' })).toHaveCount(0);
  await expect(dialog.getByText(/読み取りだけできます/)).toBeVisible();
});
