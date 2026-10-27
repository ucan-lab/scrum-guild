// 一本道: ストーリーを作る → 「＋タスク」でその下にタスクを作る → 完了にする → 「完了 / 全体」がその場で変わる（読み直しても同じ）。
// seed のセッション（seed/sessions.ts）の Cookie で開く。あおば開発の管理者はミナト。CSP の違反も確かめる
import type { Locator, Page } from '@playwright/test';
import { expect, test } from './fixtures.ts';
import { storyGet } from '../src/shared/operations/story/story-get.ts';
import { backlogTree } from '../src/shared/operations/task/backlog-tree.ts';
import { taskCreate } from '../src/shared/operations/task/task-create.ts';
import { workspaceInfo } from '../src/shared/operations/workspace/workspace.ts';
import { createWorkspace, expectModalFocus, signIn, waitForSettled, watchViolations } from './helpers.ts';
import { failOperation, rewriteOperation, routeOperation } from './operations.ts';

test.use({ timezoneId: 'Asia/Tokyo' });

test.beforeEach(async ({ context, baseURL }) => {
  await signIn(context, baseURL, 'admin');
});

// seed のワークスペース。受託開発チーム（あおば開発、ゲームの言葉）と社内ツール（ひばり工房、スクラムの言葉）
const SEED_GAME_WORKSPACE = '/aoba/w/019a0000-0000-7000-8000-000000000401';
const SEED_SCRUM_WORKSPACE = '/hibari/w/019a0000-0000-7000-8000-000000000402';

// 木のストーリー1件
function storyGroup(page: Page, title: string) {
  return page.locator('.tree-group', { has: page.getByRole('button', { name: title, exact: true }) });
}

test('ゲームの言葉: 達成目標を作り、＋クエストでその下にクエストを作って完遂にすると、「完遂 / 全体」がその場で変わる', async ({
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
  await expect(group.locator('.tree-children')).toBeVisible();
  await taskDialog.getByLabel('タイトル').fill('付与のバッチを書く');
  await taskDialog.getByRole('radio', { name: '3', exact: true }).check();
  await taskDialog.getByRole('button', { name: '依頼を出す' }).click();
  await expect(taskDialog).toBeHidden();
  // トーストには親の題を添える
  await expect(
    page.getByRole('status').filter({ hasText: '達成目標「ポイント制度を公開する」の末尾に足しました' }),
  ).toBeVisible();

  // 読み直さずに、親の配下に出る。「全体」のポイントには足される
  const row = group.locator('.entry', { hasText: '付与のバッチを書く' });
  await expect(row).toHaveCount(1);
  await expect(group.locator('.tree-ratio')).toHaveText('完遂 0 / 3 pt');
  await expect(group.getByText('クエストはまだありません')).toHaveCount(0);

  // ストーリーの下でも完了にできる。行はその場に残り、完了の印が付き、その行のポイントが「完遂」に足される
  await row.getByRole('button', { name: /完遂にする/ }).click();
  await expect(row.getByRole('img', { name: '付与のバッチを書く: 完遂' })).toBeVisible();
  await expect(group.locator('.tree-ratio')).toHaveText('完遂 3 / 3 pt');
  // 折りたたみの件数は、読み直すまで変わらない
  await expect(group.locator('.tree-folded')).toHaveCount(0);

  // 読み直しても同じ。完了した行は件数の1行に畳まれる
  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: '掲示板' })).toBeVisible();
  await expect(group.locator('.tree-ratio')).toHaveText('完遂 3 / 3 pt');
  await expect(group.locator('.tree-folded')).toHaveText('完遂 1 件を折りたたんでいます');
  await expect(group.locator('.entry')).toHaveCount(0);
  expect(await collect()).toEqual([]);
});

test('スクラムの言葉: 開閉は caret のボタンだけが受け持ち、題と「＋タスク」は行を開閉せずにダイアログを開く', async ({
  page,
}) => {
  await createWorkspace(page, '木のチーム', 'scrum');
  await page.getByRole('button', { name: 'ストーリーを作る' }).click();
  const created = page.getByRole('dialog', { name: 'ストーリーを作る' });
  await created.getByLabel('タイトル').fill('請求の流れを整える');
  await created.getByRole('button', { name: '作る' }).click();
  await expect(created).toBeHidden();

  const group = storyGroup(page, '請求の流れを整える');
  const body = group.locator('.tree-children');
  const caret = group.locator('button.tree-caret');
  const addTask = group.getByRole('button', { name: 'タスクを足す: 請求の流れを整える' });
  const title = group.getByRole('button', { name: '請求の流れを整える', exact: true });
  await expect(caret).toHaveAttribute('aria-expanded', 'true');
  await expect(caret).toHaveAccessibleName('請求の流れを整えるを閉じる');
  await expect(caret).toHaveAttribute('aria-controls', (await body.getAttribute('id')) ?? '');

  // 開くと中にフォーカスが入り、Esc で閉じたら、開いたボタンへフォーカスが戻る（close の event は遅れて届くので、
  // 戻るのを待ってから次の操作をする）
  const storyDialog = page.getByRole('dialog', { name: 'ストーリー' });
  const taskDialog = page.getByRole('dialog', { name: '起票' });

  // 題を押すとダイアログが開く。行は開閉しない
  await expectModalFocus(page, {
    opener: title,
    modal: storyDialog,
    whileOpen: () => expect(body).toBeVisible(),
  });

  // キーボード（Enter と Space）。行は開閉しない
  for (const key of ['Enter', ' ']) {
    await expectModalFocus(page, {
      opener: addTask,
      modal: taskDialog,
      press: key,
      whileOpen: () => expect(caret).toHaveAttribute('aria-expanded', 'true'),
    });
    await expectModalFocus(page, {
      opener: title,
      modal: storyDialog,
      press: key,
      whileOpen: () => expect(caret).toHaveAttribute('aria-expanded', 'true'),
    });
  }

  // caret のボタンで開閉する（クリックも Enter も Space も）。読み上げの名前は開閉で替わる
  await caret.click();
  await expect(caret).toHaveAttribute('aria-expanded', 'false');
  await expect(caret).toHaveAccessibleName('請求の流れを整えるを開く');
  await expect(body).toBeHidden();
  for (const key of ['Enter', ' ']) {
    await caret.focus();
    await page.keyboard.press(key);
    await expect(body).toBeVisible();
    await page.keyboard.press(key);
    await expect(body).toBeHidden();
  }

  // 畳んだまま起票すると、親の行が開いて、足した行が見える
  await addTask.click();
  const dialog = page.getByRole('dialog', { name: '起票' });
  await dialog.getByLabel('タイトル').fill('請求書の雛形を作る');
  await dialog.getByRole('button', { name: '起票' }).click();
  await expect(dialog).toBeHidden();
  await expect(caret).toHaveAttribute('aria-expanded', 'true');
  await expect(group.locator('.entry', { hasText: '請求書の雛形を作る' })).toBeVisible();
  await expect(
    page.getByRole('status').filter({ hasText: 'ストーリー「請求の流れを整える」の末尾に足しました' }),
  ).toBeVisible();
});

test('ストーリーを直すときは、開いたら1件を読み、変えた欄だけを送る。変えた欄が無ければ何も送らない。過ぎた期日は赤い印で出る', async ({
  page,
}) => {
  await createWorkspace(page, '直すパーティ', 'game');
  await page.getByRole('button', { name: '達成目標を作る' }).click();
  const created = page.getByRole('dialog', { name: '達成目標を作る' });
  await created.getByLabel('タイトル').fill('元のタイトル');
  await created.getByLabel('本文').fill('元の本文');
  await created.getByLabel('リンク').fill('https://example.com/spec');
  await created.getByRole('button', { name: '作る' }).click();
  await expect(created).toBeHidden();

  const updates: unknown[] = [];
  page.on('request', (request) => {
    if (request.url().endsWith('/api/aoba/story-update')) updates.push(request.postDataJSON());
  });

  // 変えずに保存すると、閉じるだけで送らない。リンクの横に、新しいタブで開く「開く」が出る
  await page.getByRole('button', { name: '元のタイトル', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '達成目標' });
  await expect(dialog.getByLabel('本文')).toHaveValue('元の本文');
  const open = dialog.getByRole('link', { name: 'リンクを新しいタブで開く' });
  await expect(open).toHaveText('開く');
  await expect(open).toHaveAttribute('href', 'https://example.com/spec');
  await expect(open).toHaveAttribute('target', '_blank');
  await expect(open).toHaveAttribute('rel', /noopener noreferrer/);
  await dialog.getByRole('button', { name: '保存する' }).click();
  await expect(dialog).toBeHidden();
  expect(updates).toEqual([]);

  // タイトルと期日だけを変える
  await page.getByRole('button', { name: '元のタイトル', exact: true }).click();
  await expect(dialog.getByLabel('本文')).toHaveValue('元の本文');
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

test('ストーリーのダイアログは、読んでいる間は読み込み中を出し、読めなければもう一度試せ、消えていれば閉じて見出しにフォーカスを移す', async ({
  page,
}) => {
  await page.goto(SEED_GAME_WORKSPACE);
  await expect(page.getByRole('heading', { level: 1, name: '掲示板' })).toBeVisible();
  const title = page.getByRole('button', { name: '問い合わせの一次回答を早くする', exact: true });
  const dialog = page.getByRole('dialog', { name: '達成目標' });

  // 読んでいる間
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const unrouteGate = await routeOperation(page, storyGet, { slug: 'aoba' }, async (call) => {
    await gate;
    await call.passThrough();
  });
  await title.click();
  await expect(dialog.getByRole('status')).toHaveText('読み込んでいます');
  await expect(dialog.getByLabel('タイトル')).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: '保存する' })).toHaveAttribute('aria-disabled', 'true');
  release();
  await expect(dialog.getByLabel('タイトル')).toHaveValue('問い合わせの一次回答を早くする');
  await expect(dialog.getByLabel('タイトル')).toBeFocused();
  await expect(dialog.getByLabel('達成条件')).toHaveValue('- よくある問い合わせ10件にテンプレートがある');
  await page.keyboard.press('Escape');
  await expect(page.locator('dialog[open]')).toHaveCount(0);
  await unrouteGate();

  // 読めなかった（5xx）。もう一度試すで読み直す
  let failures = 1;
  const unrouteOnce = await routeOperation(page, storyGet, { slug: 'aoba' }, async (call) => {
    if (failures-- > 0) {
      await call.fail(503, 'unavailable');
    } else {
      await call.passThrough();
    }
  });
  await title.click();
  await expect(dialog.getByText('この達成目標を読み込めませんでした。')).toBeVisible();
  await expect(dialog.getByLabel('タイトル')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'もう一度試す' }).click();
  await expect(dialog.getByLabel('タイトル')).toHaveValue('問い合わせの一次回答を早くする');
  await page.keyboard.press('Escape');
  await expect(page.locator('dialog[open]')).toHaveCount(0);
  await unrouteOnce();

  // 消えていた（404）。閉じて、知らせ、木を読み直し、見出しにフォーカスを移す
  await failOperation(page, storyGet, { slug: 'aoba' }, 404, 'not_found');
  await title.click();
  await expect(page.locator('dialog[open]')).toHaveCount(0);
  await expect(page.getByRole('status').filter({ hasText: 'この達成目標は見つかりません' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: '掲示板' })).toBeFocused();
});

test('日付の入力が途中までしか打たれていなければ、期日の欄に知らせて送らない', async ({ page }) => {
  await createWorkspace(page, '日付パーティ', 'game');
  await page.getByRole('button', { name: '達成目標を作る' }).click();
  const dialog = page.getByRole('dialog', { name: '達成目標を作る' });
  await dialog.getByLabel('タイトル').fill('期日を入れる');
  let requests = 0;
  page.on('request', (request) => {
    if (request.url().endsWith('/api/aoba/story-create')) requests++;
  });
  // 日付の入力は、年月日の一部だけだと value が空のまま、validity.badInput が立つ
  const due = dialog.getByLabel('期限');
  await due.focus();
  await page.keyboard.type('12');
  await expect(due).toHaveJSProperty('value', '');
  await dialog.getByRole('button', { name: '作る' }).click();
  await expect(dialog.getByText('期限は正しい日付で入れてください')).toBeVisible();
  await expect(due).toBeFocused();
  expect(requests).toBe(0);
});

test('期日の印: 過ぎた（赤）、今日と今週（橙）、それ以外（色なし）。今日と週の始まりは API の値', async ({ page }) => {
  // 今日と週の始まりは API が返す値で決まる。seed の日付（2026-10-20 前後）に合わせて差し替える
  await rewriteOperation(page, backlogTree, { slug: 'aoba' }, (output) => ({
    ...output,
    today: '2026-10-20',
    week_start: 1,
  }));
  await page.goto(SEED_GAME_WORKSPACE);
  await expect(page.getByRole('heading', { level: 1, name: '掲示板' })).toBeVisible();

  const first = storyGroup(page, 'ポイントの付与と失効を管理画面で確かめられる');
  // ストーリーの期日（10/23）は今週
  await expect(first.locator('.tree-row .chip.is-warn')).toHaveText('今週 10/23');
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
  await expect(second.locator('.tree-row .chip')).toHaveCount(0);

  // 親のないタスクの期日（10/17）は過ぎている
  await expect(page.locator('.entry', { hasText: '障害時の連絡手順を書く' }).locator('.chip.is-danger')).toHaveText(
    '期限切れ 10/17',
  );

  // 今日を 10/12 に替えると、期日（10/19 以降）は来週以降で色なし
  await rewriteOperation(page, backlogTree, { slug: 'aoba' }, (output) => ({
    ...output,
    today: '2026-10-12',
    week_start: 1,
  }));
  await page.reload();
  await expect(first.locator('.tree-row .chip')).toHaveText('10/23');
  await expect(first.locator('.tree-row .chip.is-warn')).toHaveCount(0);
  await expect(page.locator('.chip.is-danger')).toHaveCount(0);
});

test('完了したストーリーには「＋タスク」を出さず、期日の印の色も付けない。タスクの親の候補にも出ない', async ({
  page,
}) => {
  await rewriteOperation(page, backlogTree, { slug: 'aoba' }, (output) => ({
    ...output,
    today: '2026-10-20',
    week_start: 1,
    stories: output.stories.map((story, index) =>
      index === 0 ? { ...story, completed_at: '2026-10-19T00:00:00.000Z' } : story,
    ),
  }));
  await page.goto(SEED_GAME_WORKSPACE);
  const done = storyGroup(page, 'ポイントの付与と失効を管理画面で確かめられる');
  await expect(done.locator('.tree-ratio')).toBeVisible();
  await expect(done.getByRole('button', { name: /クエストを足す/ })).toHaveCount(0);
  await expect(done.locator('.tree-row .chip')).toHaveText('10/23');
  await expect(done.locator('.tree-row .chip.is-warn')).toHaveCount(0);
  // もう一方のストーリーには出る
  await expect(
    storyGroup(page, '問い合わせの一次回答を早くする').getByRole('button', { name: /クエストを足す/ }),
  ).toBeVisible();

  await page.getByRole('button', { name: '依頼を出す' }).click();
  const parent = page.getByRole('dialog', { name: '依頼を出す' }).getByLabel('親の達成目標');
  // エピックの下の完了していないストーリーも、木の順（エピックの下が先）で候補に出る
  await expect(parent.locator('option')).toHaveText([
    'なし',
    '送料の割引にポイントを使える',
    '問い合わせの一次回答を早くする',
  ]);
});

test('親のストーリーが消えていたら、理由を出し、その場で候補を読み直して親なしに戻し、親の選択欄にフォーカスを移す', async ({
  page,
}) => {
  await page.goto(SEED_GAME_WORKSPACE);
  await expect(page.getByRole('heading', { level: 1, name: '掲示板' })).toBeVisible();
  // 送ったときだけ 404 にして、読み直した木では候補から消えているようにする
  let gone = false;
  await routeOperation(page, taskCreate, { slug: 'aoba' }, async (call) => {
    gone = true;
    await call.fail(404, 'not_found');
  });
  await rewriteOperation(page, backlogTree, { slug: 'aoba' }, (output) => ({
    ...output,
    stories: output.stories.filter((story) => !(gone && story.title === '問い合わせの一次回答を早くする')),
  }));
  await page.reload();
  await waitForSettled(page);
  await storyGroup(page, '問い合わせの一次回答を早くする')
    .getByRole('button', { name: /クエストを足す/ })
    .click();
  const dialog = page.getByRole('dialog', { name: '依頼を出す' });
  await dialog.getByLabel('タイトル').fill('消えた親に足す');
  await dialog.getByRole('button', { name: '依頼を出す' }).click();
  await expect(dialog.getByText('この達成目標は見つかりません。親を選び直してください')).toBeVisible();
  const parent = dialog.getByLabel('親の達成目標');
  await expect(parent.locator('option')).toHaveText([
    'なし',
    '送料の割引にポイントを使える',
    'ポイントの付与と失効を管理画面で確かめられる',
  ]);
  await expect(parent).toHaveValue('');
  await expect(parent).toBeFocused();
  // ダイアログは開いたまま。親を選び直して作れる
  await expect(dialog).toBeVisible();
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
    .locator('.tree > .tree-group, .tree > div')
    .evaluateAll((nodes) => nodes.map((node) => node.className));
  expect(order).toEqual(['tree-group', 'tree-group', '']);
});

test('閉じたワークスペースでは、作る操作と「＋タスク」を出さず、ストーリーのダイアログは readonly で開く', async ({
  page,
}) => {
  await rewriteOperation(page, workspaceInfo, { slug: 'aoba' }, (output) => ({
    ...output,
    closed_at: '2026-10-21T00:00:00.000Z',
  }));
  await page.goto(SEED_GAME_WORKSPACE);
  await expect(page.getByRole('heading', { level: 1, name: '掲示板' })).toBeVisible();
  await expect(page.getByRole('button', { name: '達成目標を作る' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /クエストを足す/ })).toHaveCount(0);

  await page.getByRole('button', { name: 'ポイントの付与と失効を管理画面で確かめられる', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '達成目標' });
  await expect(dialog.getByLabel('タイトル')).toHaveValue('ポイントの付与と失効を管理画面で確かめられる');
  for (const label of ['タイトル', '達成条件', '本文', '期限', 'リンク']) {
    const field = dialog.getByRole('textbox', { name: label, exact: true });
    await expect(field).toHaveAttribute('readonly', '');
    await expect(field).not.toBeDisabled();
  }
  // 日付は読み取り専用の text で出す
  await expect(dialog.getByLabel('期限')).toHaveValue('2026-10-23');
  await expect(dialog.getByRole('button', { name: '保存する' })).toHaveCount(0);
  await expect(dialog.getByText(/読み取りだけできます/)).toBeVisible();
  // リンクは読み取り専用でも開ける
  await expect(dialog.getByRole('link', { name: 'リンクを新しいタブで開く' })).toHaveAttribute(
    'href',
    'https://example.com/notes/42',
  );
});

test('狭い幅では、caret、題、「＋タスク」の押せる範囲が 44px 四方以上に広がる（見た目は変わらない）', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto(SEED_GAME_WORKSPACE);
  const group = storyGroup(page, '問い合わせの一次回答を早くする');
  await expect(group.locator('.tree-ratio')).toBeVisible();

  // 見た目の枠の外で、44px の範囲の中の点が、そのボタンに当たる
  async function reaches(button: Locator, dx: number, dy: number): Promise<boolean> {
    return button.evaluate(
      (element, offset) => {
        // elementFromPoint は画面の外の点に null を返すので、行を画面の中へ出してから測る
        element.scrollIntoView({ block: 'center' });
        const rect = element.getBoundingClientRect();
        const hit = document.elementFromPoint(
          rect.left + rect.width / 2 + offset.dx,
          rect.top + rect.height / 2 + offset.dy,
        );
        return hit !== null && element.contains(hit);
      },
      { dx, dy },
    );
  }
  const caret = group.locator('button.tree-caret');
  const title = group.getByRole('button', { name: '問い合わせの一次回答を早くする', exact: true });
  const addTask = group.getByRole('button', { name: /クエストを足す/ });
  expect(await reaches(caret, 16, 0)).toBe(true);
  expect(await reaches(title, 0, -18)).toBe(true);
  expect(await reaches(addTask, 0, -18)).toBe(true);
  // 範囲を超えた点は当たらない
  expect(await reaches(title, 0, -60)).toBe(false);
});
