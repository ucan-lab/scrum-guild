// バックログの絞り込みと検索: 帯の選択欄と検索で絞り、URL に残り（再読み込み、リンク）、当たるものが無いときは外す操作と一緒に出す。
// 絞っている間は「上へ」「下へ」とドラッグのつまみを出さずに案内を替え、「親を移す」は残す。絞っているときに作ったものが当たらなければ、
// 外す操作つきのトーストで知らせる。seed のセッション（seed/sessions.ts）の Cookie で開く。あおば開発の管理者はミナト。CSP の違反も確かめる
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.ts';
import { createWorkspace, signIn, watchViolations } from './helpers.ts';

test.use({ timezoneId: 'Asia/Tokyo' });

test.beforeEach(async ({ context, baseURL }) => {
  await signIn(context, baseURL, 'admin');
});

async function addTask(page: Page, title: string, options: { assignee?: string; parent?: string } = {}) {
  await page.getByRole('button', { name: '依頼を出す' }).click();
  const dialog = page.getByRole('dialog', { name: '依頼を出す' });
  await dialog.getByLabel('タイトル').fill(title);
  if (options.assignee !== undefined) {
    const assignee = dialog.getByRole('combobox', { name: '担い手' });
    await expect(assignee.getByRole('option', { name: options.assignee })).toBeAttached();
    await assignee.selectOption({ label: options.assignee });
  }
  if (options.parent !== undefined) {
    await dialog.getByRole('combobox', { name: '親の達成目標' }).selectOption({ label: options.parent });
  }
  await dialog.getByRole('button', { name: '依頼を出す' }).click();
  await expect(dialog).toBeHidden();
}

async function create(page: Page, label: string, title: string): Promise<void> {
  await page.getByRole('button', { name: label }).click();
  const dialog = page.getByRole('dialog', { name: label });
  await dialog.getByLabel('タイトル').fill(title);
  await dialog.getByRole('button', { name: '作る' }).click();
  await expect(dialog).toBeHidden();
}

// 木に出ているタスクの題（木の順）
function taskTitles(page: Page) {
  return page.locator('.tree .entry-title');
}

function filterBar(page: Page) {
  return page.getByRole('search', { name: '掲示板の絞り込み' });
}

test('担い手、レイド、検索で絞り、URL に残る。絞っている間は並べ替えを出さない。当たるものが無ければ外す操作と一緒に出す', async ({
  page,
}) => {
  const collect = await watchViolations(page);
  await createWorkspace(page, '絞り込みパーティ', 'game');
  // 何も無いときの最初の一歩には、帯を出さない
  await expect(page.getByText('まだクエストがありません')).toBeVisible();
  await expect(filterBar(page)).toHaveCount(0);

  await create(page, 'レイドを作る', '会員ポイント制度を公開する');
  await create(page, '達成目標を作る', '見積もりを整える');
  await addTask(page, 'ポイント表示の API を作る', { assignee: 'ミナト' });
  await addTask(page, '請求書を出す');
  await addTask(page, '議事録をまとめる');
  await addTask(page, '見積もりを送る', { parent: '見積もりを整える' });
  await page.reload();
  const bar = filterBar(page);
  await expect(bar).toBeVisible();
  await expect(taskTitles(page)).toHaveText([
    '見積もりを送る',
    'ポイント表示の API を作る',
    '請求書を出す',
    '議事録をまとめる',
  ]);
  await expect(bar.getByRole('button', { name: '絞り込みを外す' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '上へ: 請求書を出す' })).toBeVisible();
  await expect(page.locator('.entry .grip').first()).toBeVisible();
  await expect(page.locator('.drag-note')).toBeVisible();

  // 担い手の「自分」で絞る。すぐ読み直し、URL に残る。当たるタスクの無い達成目標とレイドは出さない
  const assignee = bar.getByRole('combobox', { name: '担い手' });
  await expect(assignee.getByRole('option')).toHaveText(['担い手: すべて', '自分', 'ミナト', '担い手なし']);
  await assignee.selectOption({ label: '自分' });
  await expect(page).toHaveURL(/\?assignee=me$/);
  await expect(taskTitles(page)).toHaveText(['ポイント表示の API を作る']);
  await expect(page.getByRole('button', { name: '見積もりを整える', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '会員ポイント制度を公開する', exact: true })).toHaveCount(0);
  // 親のない完了の折りたたみは出さない。並べ替えは出さず、外すと並べ替えられると案内する。親を移すは残す
  await expect(page.getByText('上にあるものほど優先します。絞り込みを外すと並べ替えられます。')).toBeVisible();
  await expect(page.getByRole('button', { name: '上へ: ポイント表示の API を作る' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '下へ: ポイント表示の API を作る' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '親を移す: ポイント表示の API を作る' })).toBeVisible();
  // ドラッグも隣を使う並べ替えなので、つまみとその案内も出さない
  await expect(page.locator('.grip')).toHaveCount(0);
  await expect(page.locator('.drag-note')).toHaveCount(0);
  // 結果を読み上げ、ポイントと件数が絞る前の値であることを添える
  await expect(page.getByRole('status').filter({ hasText: '1 件に絞りました' })).toBeAttached();
  await expect(page.getByText('難易度と件数は、絞る前の全体の値です')).toBeVisible();

  // 再読み込みしても、同じ絞り込みで出る
  await page.reload();
  await expect(assignee).toHaveValue('me');
  await expect(taskTitles(page)).toHaveText(['ポイント表示の API を作る']);

  // 帯の「絞り込みを外す」で全部を外し、検索の欄へフォーカスを移す
  await bar.getByRole('button', { name: '絞り込みを外す' }).click();
  await expect(page).toHaveURL(/\/w\/[0-9a-f-]{36}$/);
  await expect(taskTitles(page)).toHaveCount(4);
  await expect(bar.getByRole('searchbox', { name: 'タイトルで探す' })).toBeFocused();
  await expect(page.getByRole('button', { name: '上へ: 請求書を出す' })).toBeVisible();

  // 検索は入力が止まってから読み直す。英字の大文字と小文字は区別しない
  const search = bar.getByRole('searchbox', { name: 'タイトルで探す' });
  await search.fill('api');
  await expect(page).toHaveURL(/\?q=api$/);
  await expect(taskTitles(page)).toHaveText(['ポイント表示の API を作る']);
  // 達成目標の題に当たれば、配下のクエストも出す
  await search.fill('を整える');
  await expect(taskTitles(page)).toHaveText(['見積もりを送る']);
  await expect(page.getByRole('button', { name: '見積もりを整える', exact: true })).toBeVisible();

  // 担い手なしと検索を組み合わせる（「かつ」）
  await assignee.selectOption({ label: '担い手なし' });
  await search.fill('請求');
  await expect(page).toHaveURL(/assignee=none/);
  await expect(page).toHaveURL(/q=%E8%AB%8B%E6%B1%82/);
  await expect(taskTitles(page)).toHaveText(['請求書を出す']);

  // リンクを開いても、同じ絞り込みで出る
  const link = page.url();
  const other = await page.context().newPage();
  await other.goto(link);
  await expect(other.locator('.tree .entry-title')).toHaveText(['請求書を出す']);
  await expect(other.getByRole('combobox', { name: '担い手' })).toHaveValue('none');
  await expect(other.getByRole('searchbox', { name: 'タイトルで探す' })).toHaveValue('請求');
  await other.close();

  // 上限を超えた検索の文字は送らず、理由を出す。ほかの欄を変えて木を読み直しても、欄の文字は巻き戻さない
  await search.fill('a b c d e f');
  await expect(bar.getByRole('alert')).toHaveText('検索の語は 5 つまでです');
  await assignee.selectOption({ label: '担い手: すべて' });
  await expect(page).toHaveURL(/\?q=%E8%AB%8B%E6%B1%82$/);
  await expect(taskTitles(page)).toHaveText(['請求書を出す']);
  await expect(search).toHaveValue('a b c d e f');
  await expect(bar.getByRole('alert')).toBeVisible();

  // 当たるものが無いときは、木の代わりに無いことと、外す操作を出す
  await search.fill('存在しない言葉');
  await expect(page.getByText('絞り込みに当たるものはありません')).toBeVisible();
  await expect(page.locator('.tree')).toHaveCount(0);
  await page.locator('.empty').getByRole('button', { name: '絞り込みを外す' }).click();
  await expect(taskTitles(page)).toHaveCount(4);
  await expect(search).toBeFocused();
  await expect(search).toHaveValue('');

  // レイドで絞ると、そのレイドだけを出す（配下が無くても出す）。親のないクエストは出さない
  await bar.getByRole('combobox', { name: 'レイド' }).selectOption({ label: '会員ポイント制度を公開する' });
  await expect(page.getByRole('button', { name: '会員ポイント制度を公開する', exact: true })).toBeVisible();
  await expect(page.getByText('達成目標はまだありません')).toBeVisible();
  await expect(taskTitles(page)).toHaveCount(0);

  // 行のリンクは絞り込みを残して引き出しを開く
  await bar.getByRole('combobox', { name: 'レイド' }).selectOption({ label: 'レイドなし' });
  await expect(taskTitles(page)).toHaveCount(4);
  await page.getByRole('link', { name: '請求書を出す' }).click();
  await expect(page).toHaveURL(/\?epic=none&task=[0-9a-f-]{36}$/);
  await expect(page.getByRole('dialog', { name: '請求書を出す' })).toBeVisible();
  expect(await collect()).toEqual([]);
});

test('絞っているときに作ったクエストや達成目標が当たらなければ、絞り込みを外す操作つきのトーストで知らせる', async ({
  page,
}) => {
  const collect = await watchViolations(page);
  await createWorkspace(page, '絞り込みと起票のパーティ', 'game');
  await addTask(page, '自分のクエスト', { assignee: 'ミナト' });
  const bar = filterBar(page);
  await bar.getByRole('combobox', { name: '担い手' }).selectOption({ label: '自分' });
  await expect(page).toHaveURL(/\?assignee=me$/);

  // 当たるものは、読み直した木に出し、作ったことだけを知らせる（絞る前に作った知らせを消すため読み直す）
  await page.reload();
  const added = page.getByRole('status').filter({ hasText: '掲示板の末尾に足しました' });
  await expect(added).toHaveCount(0);
  await addTask(page, '自分のもう1つ', { assignee: 'ミナト' });
  await expect(taskTitles(page)).toHaveText(['自分のクエスト', '自分のもう1つ']);
  await expect(added).toBeVisible();
  const notice = page.getByRole('status').filter({ hasText: '作りました。絞り込みに当たらないので表示していません' });
  await expect(notice).toHaveCount(0);

  // 当たらないクエストは出さず、「表示していません」の1つだけで知らせる（作った知らせは重ねない）
  await page.reload();
  await addTask(page, '誰かのクエスト');
  await expect(notice).toBeVisible();
  await expect(added).toHaveCount(0);
  await expect(taskTitles(page)).toHaveText(['自分のクエスト', '自分のもう1つ']);

  // 達成目標も同じ（担い手で絞っているので、配下の無い達成目標は当たらない）。前のトーストを消すため読み直す（絞り込みは残る）
  await page.reload();
  await expect(notice).toHaveCount(0);
  await create(page, '達成目標を作る', '新しい目標');
  await expect(notice).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: '達成目標を作りました' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '新しい目標', exact: true })).toHaveCount(0);

  // トーストの「絞り込みを外す」で外すと、作ったものが出る
  await notice.getByRole('button', { name: '絞り込みを外す' }).click();
  await expect(notice).toHaveCount(0);
  await expect(page).toHaveURL(/\/w\/[0-9a-f-]{36}$/);
  await expect(taskTitles(page)).toHaveText(['自分のクエスト', '自分のもう1つ', '誰かのクエスト']);
  await expect(page.getByRole('button', { name: '新しい目標', exact: true })).toBeVisible();

  // 絞り込みは戻る操作の履歴を積まない。戻ると、絞り込みの手前（掲示板）ではなく、その前の画面（パーティを作った管理の画面）へ戻る
  await page.goBack();
  await expect(page).toHaveURL(/\/aoba\/admin$/);
  expect(await collect()).toEqual([]);
});
