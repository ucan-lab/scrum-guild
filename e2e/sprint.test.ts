// スプリントを始めて、スプリントの画面でカードを動かす流れ。
// リーダーは計画の画面から、ゴールの欄のあるダイアログでスプリントを始める。進行中は同時に1つで、2つ目は理由が出て始められない。
// スプリントの画面には列とカードが並び、カードは題から詳細の引き出しを開け、ボタンと Alt と矢印のキーで隣の列へ移し、列の中で並べ替えられる。
// 動かした位置は読み上げられ、読み直しても、別の画面でも同じで、列の移動は変更の履歴に残る。
// 最後の完了でない列から次の列へ送ると完了になり、完了の列のカードは「戻す」で完了の前の列へ戻る。完了の列には完成の定義が出る。
// 自分のワークスペースを作って動かす（ほかのファイルと並べて走るため、seed の行は書き換えない）。
// 空の状態は seed のあおば開発（進行中のスプリントが無い）を開くだけ。
// 終える流れは、リーダーが終了のダイアログで持ち越し先（次の遠征かバックログ）とゴールの達成を選んで終え、計画の画面とバックログで移ったのを見る。
// 最終日を過ぎた知らせは、sprint-board と sprint-list の応答を差し替えて確かめる（開始は最終日が今日以降の遠征にしか出来ないため）
import type { Page } from '@playwright/test';
import { sprintBoard, sprintClose, sprintList, taskColumnMove } from '../src/shared/operations/sprint/index.ts';
import { taskReopen } from '../src/shared/operations/task/index.ts';
import { expect, test } from './fixtures.ts';
import { createWorkspace, signIn, waitForResponses, waitForSettled, watchViolations } from './helpers.ts';
import { failOperation, mockOperation } from './operations.ts';
import { OVERDUE_BOARD, OVERDUE_PLAN, SAMPLE_BOARD } from './sprint-fixture.ts';

test.use({ timezoneId: 'Asia/Tokyo' });

const AOBA_TEAM = '/aoba/w/019a0000-0000-7000-8000-000000000401';
const GOAL = '先方の運用担当が、付与の履歴を自分で追えるようにする';

async function addTask(page: Page, title: string): Promise<void> {
  await page.getByRole('button', { name: '依頼を出す' }).click();
  const dialog = page.getByRole('dialog', { name: '依頼を出す' });
  await dialog.getByLabel('タイトル').fill(title);
  await dialog.getByRole('button', { name: '依頼を出す' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('.entry', { hasText: title })).toBeVisible();
}

async function createSprint(page: Page, startOn: string, name: string): Promise<void> {
  await page.getByRole('button', { name: '遠征を作る' }).click();
  const dialog = page.getByRole('dialog', { name: '遠征を作る' });
  await dialog.getByLabel('開始日').fill(startOn);
  await dialog.getByLabel('長さ（日）').fill('14');
  await dialog.getByLabel('名前（任意）').fill(name);
  await dialog.getByRole('button', { name: '作る' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('.lane-title', { hasText: name })).toBeVisible();
}

// 列の中のカードの題を、上から順に
const titlesIn = (page: Page, column: string) =>
  page.getByRole('region', { name: column, exact: true }).locator('.card-title');

test('リーダーはゴールを書いて遠征を始め、2つ目は始められず、カードをボタンとキーで動かし、読み直しても同じ', async ({
  page,
  context,
  baseURL,
  browser,
}) => {
  // 起票から動かすまでを1本で確かめる長い流れ。ほかのファイルと並べて走ると既定の 30 秒を超えうる
  test.setTimeout(90_000);
  await signIn(context, baseURL, 'admin');
  const collect = await watchViolations(page);
  await createWorkspace(page, '出発の見張り番', 'game');

  // クエストを3件起票する
  for (const title of ['A札', 'B札', 'C札']) await addTask(page, title);

  // 遠征を2つ作り、先の遠征に3件入れる
  await page.getByRole('link', { name: '遠征の計画' }).click();
  await expect(page.getByRole('heading', { level: 1, name: '遠征の計画' })).toBeVisible();
  // 最終日が今日より前のスプリントは始められないので、遠い先の期間にする
  await createSprint(page, '2099-03-01', '第1回');
  await createSprint(page, '2099-03-15', '第2回');
  await page.getByRole('button', { name: '掲示板から入れる: 遠征 第1回' }).click();
  const picker = page.getByRole('dialog', { name: '遠征 第1回 に入れる' });
  const list = picker.getByRole('group', { name: '入れるクエスト' });
  for (const title of ['A札', 'B札', 'C札'])
    await list.getByRole('checkbox', { name: new RegExp(`^${title}`) }).check();
  await picker.getByRole('button', { name: '3 件入れる' }).click();
  await expect(picker).toBeHidden();
  await expect(page.locator('.lane').first().locator('.lane-row a')).toHaveText(['A札', 'B札', 'C札']);

  // 2つ目の遠征の「始める」を開いておき、その間に別の画面で1つ目を始める
  await page.getByRole('button', { name: '始める: 遠征 第2回' }).click();
  const secondDialog = page.getByRole('dialog', { name: '遠征を始める' });
  await expect(secondDialog).toContainText(
    '遠征 第2回（3/15〜3/28）を始めます。入っているクエストは 0 件、0 pt です。',
  );
  await expect(secondDialog.getByRole('alert')).toHaveCount(0);

  const other = await context.newPage();
  await other.goto(page.url());
  await other.getByRole('button', { name: '始める: 遠征 第1回' }).click();
  const firstDialog = other.getByRole('dialog', { name: '遠征を始める' });
  // 入っているクエストは3件、ポイントは未見積もり。始めることはできる
  await expect(firstDialog).toContainText('遠征 第1回（3/1〜3/14）を始めます。入っているクエストは 3 件、0 pt です。');
  await expect(firstDialog.locator('.callout.is-warn')).toHaveText('未見積もりが 3 件あります。始めることはできます。');
  // ゴールの欄は任意だが、長すぎれば断られる
  await firstDialog.getByLabel('遠征の目的').fill('あ'.repeat(201));
  await firstDialog.getByRole('button', { name: '始める' }).click();
  await expect(firstDialog.getByRole('alert')).toHaveText('遠征の目的は 200 字までです');
  await firstDialog.getByLabel('遠征の目的').fill(GOAL);
  await firstDialog.getByRole('button', { name: '始める' }).click();
  await expect(firstDialog).toBeHidden();
  await expect(other.getByRole('status').filter({ hasText: '遠征を始めました' })).toBeVisible();
  // 計画の画面には、進行中の印とゴールが出て、「始める」は消える
  const firstLane = other.locator('.lane', { hasText: '第1回' });
  await expect(firstLane.locator('.chip.is-ok')).toHaveText('進行中');
  await expect(firstLane.locator('.lane-goal')).toContainText(GOAL);
  await expect(other.getByRole('button', { name: '始める: 遠征 第1回' })).toHaveCount(0);
  // 押した「始める」は消えるので、フォーカスは始めた遠征の見出しへ移る
  await expect(firstLane.locator('.lane-title')).toBeFocused();
  await other.close();

  // 開いておいたダイアログから始めようとすると、サーバーが進行中が既にあることを断り、理由がダイアログの中に出る
  await secondDialog.getByRole('button', { name: '始める' }).click();
  await expect(secondDialog.getByRole('alert')).toHaveText(
    '進行中の遠征があるので、始められません。終えてから始めてください',
  );
  await expect(secondDialog).toBeVisible();
  await expect(secondDialog.getByRole('button', { name: '始める' })).toHaveAttribute('aria-disabled', 'true');
  await secondDialog.getByRole('button', { name: 'やめる' }).click();
  await expect(secondDialog).toBeHidden();

  // 読み直した画面では、押す前から理由が出る
  await page.reload();
  await page.getByRole('button', { name: '始める: 遠征 第2回' }).click();
  await expect(secondDialog.getByRole('alert')).toHaveText(
    '進行中の遠征があるので、始められません。終えてから始めてください',
  );
  await expect(secondDialog.getByRole('button', { name: '始める' })).toHaveAttribute('aria-disabled', 'true');
  await secondDialog.getByRole('button', { name: 'やめる' }).click();
  await expect(secondDialog).toBeHidden();
  await expect(page.locator('.lane', { hasText: '第1回' }).locator('.lane-goal')).toContainText(GOAL);

  // 左のメニューの「遠征」から、スプリントの画面を開く。見出しは遠征の名前、ゴールは貼り紙、列は行程の順で完遂が最後
  await page.getByRole('link', { name: '遠征', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: '遠征 第1回' })).toBeVisible();
  await expect(page).toHaveTitle('遠征 第1回・出発の見張り番 - Scrum Guild');
  await expect(page.locator('.notice-title')).toHaveText(GOAL);
  await expect(page.locator('.board-col-name')).toHaveText(['出発前', '遂行中', '査定中', '完遂']);
  await expect(titlesIn(page, '出発前')).toHaveText(['A札', 'B札', 'C札']);
  const card = (title: string) => page.getByRole('article', { name: title, exact: true });
  const status = (text: string | RegExp) => page.getByRole('status').filter({ hasText: text });
  // 送る移動は、A を右、B を次の行程へ、B を上、B を下、B を上、C を右に2回の7件（端で押したものは送らない）
  const moved = waitForResponses(page, '/task-column-move', 7);

  // カードを選んで Alt と → で隣の列へ移す。移した先の位置が読み上げられ、フォーカスは同じカードに残る
  await card('A札').press('Alt+ArrowRight');
  await expect(status('「A札」を遂行中の 1 番目に移しました（1 件中）')).toBeVisible();
  await expect(titlesIn(page, '遂行中')).toHaveText(['A札']);
  await expect(titlesIn(page, '出発前')).toHaveText(['B札', 'C札']);
  await expect(card('A札')).toBeFocused();

  // ボタンでも同じ。移した先の末尾に入る
  await page.getByRole('button', { name: '次の行程へ: B札' }).click();
  await expect(status('「B札」を遂行中の 2 番目に移しました（2 件中）')).toBeVisible();
  await expect(titlesIn(page, '遂行中')).toHaveText(['A札', 'B札']);

  // 列の中の並べ替え。Alt と ↑ で1つ上、端では動かさず、端であることを読み上げる
  await card('B札').press('Alt+ArrowUp');
  await expect(status('「B札」を遂行中の 1 番目に移しました（2 件中）')).toBeVisible();
  await expect(titlesIn(page, '遂行中')).toHaveText(['B札', 'A札']);
  await card('B札').press('Alt+ArrowUp');
  await expect(status('いちばん上です')).toBeVisible();
  await card('A札').press('Alt+ArrowDown');
  await expect(status('いちばん下です')).toBeVisible();
  await page.getByRole('button', { name: '下へ: B札' }).click();
  await expect(titlesIn(page, '遂行中')).toHaveText(['A札', 'B札']);
  await page.getByRole('button', { name: '上へ: B札' }).click();
  await expect(titlesIn(page, '遂行中')).toHaveText(['B札', 'A札']);

  // 最後の完了でない列から先（完遂の列）へ Alt と → で送ると、完遂にする（task-column-move では移さない）
  await card('C札').press('Alt+ArrowRight');
  await card('C札').press('Alt+ArrowRight');
  await expect(titlesIn(page, '査定中')).toHaveText(['C札']);
  // その列の「次の行程へ」は完遂にするので、読み上げの名前と title もそう言う。動かし方の案内にも添える
  const completeNext = page.getByRole('button', { name: '完遂の行程へ（完遂にする）: C札' });
  await expect(completeNext).toHaveAttribute('aria-disabled', 'false');
  await expect(completeNext).toHaveAttribute('title', '完遂の行程へ（完遂にする）');
  await expect(page.getByRole('button', { name: '次の行程へ: C札' })).toHaveCount(0);
  await expect(page.locator('.action-note')).toContainText('完遂の行程の手前の行程から次へ送ると、完遂になります。');
  await expect(page.getByRole('button', { name: '前の行程へ: B札' })).toHaveAttribute('aria-disabled', 'false');
  await expect(page.getByRole('button', { name: '前の行程へ: A札' })).toHaveAttribute('aria-disabled', 'false');
  await moved;
  await card('C札').press('Alt+ArrowRight');
  await expect(status('クエストを完遂にしました')).toBeVisible();
  await expect(titlesIn(page, '完遂')).toHaveText(['C札']);
  await expect(titlesIn(page, '査定中')).toHaveText([]);
  // 完遂の列のカードは、完了の印の横に「戻す」を持つ。戻すと完遂の前の列（査定中）へ戻り、フォーカスはそのカードへ移る
  await page.getByRole('button', { name: '完遂を戻す: C札' }).click();
  await expect(status('「C札」の完遂を戻し、査定中へ移しました')).toBeVisible();
  await expect(titlesIn(page, '査定中')).toHaveText(['C札']);
  await expect(titlesIn(page, '完遂')).toHaveText([]);
  await expect(card('C札')).toBeFocused();
  await expect(page.getByRole('button', { name: '完遂を戻す: C札' })).toHaveCount(0);

  // 読み直しても、別の画面でも、同じ列と順
  await page.reload();
  await expect(titlesIn(page, '出発前')).toHaveText([]);
  await expect(titlesIn(page, '遂行中')).toHaveText(['B札', 'A札']);
  await expect(titlesIn(page, '査定中')).toHaveText(['C札']);
  const elsewhere = await browser.newContext({ baseURL });
  await signIn(elsewhere, baseURL, 'admin');
  const otherPage = await elsewhere.newPage();
  await otherPage.goto(page.url());
  await expect(otherPage.locator('.board-col-name')).toHaveText(['出発前', '遂行中', '査定中', '完遂']);
  await expect(titlesIn(otherPage, '遂行中')).toHaveText(['B札', 'A札']);
  await expect(titlesIn(otherPage, '査定中')).toHaveText(['C札']);
  await elsewhere.close();

  // カードの題から詳細の引き出しが開き、列の移動が変更の履歴に残る（並べ替えは残らない）。閉じると題のリンクへフォーカスが戻る
  await titlesIn(page, '遂行中').filter({ hasText: 'A札' }).click();
  const drawer = page.getByRole('dialog', { name: 'A札' });
  await expect(drawer).toBeVisible();
  await expect(page).toHaveURL(/\/sprint\?task=/);
  await drawer.getByRole('tab', { name: '変更の履歴' }).click();
  const history = drawer.getByRole('tabpanel', { name: '変更の履歴' });
  await expect(history.getByText('出発前 → 遂行中')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();
  await expect(titlesIn(page, '遂行中').filter({ hasText: 'A札' })).toBeFocused();

  // カードの完了の操作は task-complete を呼ぶだけ。完遂の列のカードは完了の印と「戻す」を持ち、動かすボタンを持たない
  await page.getByRole('button', { name: '完遂にする: C札' }).click();
  await expect(status('クエストを完遂にしました')).toBeVisible();
  await expect(titlesIn(page, '完遂')).toHaveText(['C札']);
  await expect(titlesIn(page, '査定中')).toHaveText([]);
  await expect(
    page.getByRole('region', { name: '完遂', exact: true }).getByRole('img', { name: 'C札: 完遂' }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: /: C札$/ })).toHaveText(['戻す']);
  await expect(page.getByRole('article', { name: 'C札' })).toHaveCount(0);
  // 完了と戻しは、詳細の引き出しの変更の履歴に残る
  await titlesIn(page, '完遂').filter({ hasText: 'C札' }).click();
  const doneDrawer = page.getByRole('dialog', { name: 'C札' });
  await doneDrawer.getByRole('tab', { name: '変更の履歴' }).click();
  const doneHistory = doneDrawer.getByRole('tabpanel', { name: '変更の履歴' });
  await expect(doneHistory.getByText('完遂を戻した')).toHaveCount(1);
  await expect(doneHistory.getByText('完遂 → 査定中')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(doneDrawer).toBeHidden();

  const problems = await collect();
  // 進行中が既にある開始の断り（409）は、ブラウザがコンソールに出す。それ以外の違反とエラーは無い
  expect(problems.filter((problem) => !problem.includes('status of 409'))).toEqual([]);
});

test('動かすのが断られたら理由を知らせて読み直し、カードは元の列に戻る', async ({ page, context, baseURL }) => {
  await signIn(context, baseURL, 'admin');
  await createWorkspace(page, '断られる見張り番', 'game');
  await addTask(page, 'D札');
  await page.getByRole('link', { name: '遠征の計画' }).click();
  await createSprint(page, '2099-04-05', '第1回');
  await page.getByRole('button', { name: '掲示板から入れる: 遠征 第1回' }).click();
  const picker = page.getByRole('dialog', { name: '遠征 第1回 に入れる' });
  await picker.getByRole('group', { name: '入れるクエスト' }).getByRole('checkbox', { name: /^D札/ }).check();
  await picker.getByRole('button', { name: '1 件入れる' }).click();
  await expect(picker).toBeHidden();
  await page.getByRole('button', { name: '始める: 遠征 第1回' }).click();
  const dialog = page.getByRole('dialog', { name: '遠征を始める' });
  // ゴールを書かずに始められる。ゴールの貼り紙は出ない
  await dialog.getByRole('button', { name: '始める' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('.lane-goal')).toHaveCount(0);

  await page.getByRole('link', { name: '遠征', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: '遠征 第1回' })).toBeVisible();
  await expect(page.locator('.notice')).toHaveCount(0);

  // サーバーが「もう進行中ではない」と断った。トーストで理由を知らせ、読み直して元の列に戻る
  const unroute = await failOperation(page, taskColumnMove, { slug: 'aoba' }, 409, 'conflict', {
    details: { reason: 'not_active' },
  });
  await page.getByRole('article', { name: 'D札', exact: true }).press('Alt+ArrowRight');
  await expect(
    page.getByRole('status').filter({ hasText: 'この遠征はもう進行中ではありません。一覧を読み直します' }),
  ).toBeVisible();
  await expect(titlesIn(page, '出発前')).toHaveText(['D札']);
  await expect(titlesIn(page, '遂行中')).toHaveText([]);
  await unroute();
});

test('最終日がワークスペースの今日より前の遠征は始められず、理由がダイアログに出る', async ({
  page,
  context,
  baseURL,
}) => {
  await signIn(context, baseURL, 'admin');
  const collect = await watchViolations(page);
  await createWorkspace(page, '過ぎた見張り番', 'game');
  await page.getByRole('link', { name: '遠征の計画' }).click();
  await createSprint(page, '2020-01-06', '過去の回');
  await page.getByRole('button', { name: '始める: 遠征 過去の回' }).click();
  const dialog = page.getByRole('dialog', { name: '遠征を始める' });
  await dialog.getByRole('button', { name: '始める' }).click();
  await expect(dialog.getByRole('alert')).toHaveText(
    'この遠征は最終日を過ぎているので、始められません。期間を直すか、削除して作り直してください',
  );
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'やめる' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('.lane .chip.is-ok')).toHaveCount(0);
  const problems = await collect();
  expect(problems.filter((problem) => !problem.includes('status of 409'))).toEqual([]);
});

test('進行中の遠征が無いときの空の状態は、リーダーと一般のメンバーで文が違う', async ({ page, context, baseURL }) => {
  await signIn(context, baseURL, 'member');
  await page.goto(`${AOBA_TEAM}/sprint`);
  await expect(page.getByRole('heading', { level: 1, name: '遠征' })).toBeVisible();
  await expect(page.getByText('進行中の遠征はありません')).toBeVisible();
  await expect(page.getByText('遠征を作って始めるのは', { exact: false })).toBeVisible();
  await expect(page.getByRole('link', { name: '掲示板を開く' })).toBeVisible();
  await expect(page.getByRole('link', { name: '遠征の計画を開く' })).toHaveCount(0);

  await context.clearCookies();
  await signIn(context, baseURL, 'admin');
  await page.goto(`${AOBA_TEAM}/sprint`);
  await expect(page.getByText('進行中の遠征はありません')).toBeVisible();
  await expect(page.getByText('遠征の計画の画面で遠征を作り', { exact: false })).toBeVisible();
  await page.getByRole('link', { name: '遠征の計画を開く' }).click();
  await expect(page.getByRole('heading', { level: 1, name: '遠征の計画' })).toBeVisible();
});

test('スクラムの言葉でも、スプリントを始めて、列とカードを動かし、次の列へで完了にして戻せる。完了の列に完成の定義が出る', async ({
  page,
  context,
  baseURL,
}) => {
  await signIn(context, baseURL, 'admin');
  await createWorkspace(page, 'スクラムの見張り番', 'scrum');
  // 完成の定義を書いておく
  await page.getByRole('link', { name: '設定', exact: true }).click();
  await page.getByRole('textbox', { name: 'Markdown' }).fill('- レビューを1人以上が通した');
  await page.getByRole('button', { name: '保存する' }).click();
  await expect(page.getByRole('status').filter({ hasText: '完成の定義を保存しました' })).toBeVisible();
  await page.getByRole('link', { name: 'バックログ', exact: true }).click();
  await page.getByRole('button', { name: '起票' }).click();
  const create = page.getByRole('dialog', { name: '起票' });
  await create.getByLabel('タイトル').fill('E札');
  await create.getByRole('button', { name: '起票' }).click();
  await expect(create).toBeHidden();
  await page.getByRole('link', { name: '計画' }).click();
  await page.getByRole('button', { name: 'スプリントを作る' }).click();
  const sprintDialog = page.getByRole('dialog', { name: 'スプリントを作る' });
  await sprintDialog.getByLabel('開始日').fill('2099-05-03');
  await sprintDialog.getByLabel('長さ（日）').fill('7');
  await sprintDialog.getByRole('button', { name: '作る' }).click();
  await expect(sprintDialog).toBeHidden();
  await page.getByRole('button', { name: /^バックログから入れる/ }).click();
  const picker = page.getByRole('dialog', { name: /に入れる$/ });
  await picker.getByRole('group', { name: '入れるタスク' }).getByRole('checkbox', { name: /^E札/ }).check();
  await picker.getByRole('button', { name: '1 件入れる' }).click();
  await expect(picker).toBeHidden();

  await page.getByRole('button', { name: /^始める/ }).click();
  const dialog = page.getByRole('dialog', { name: 'スプリントを始める' });
  await dialog.getByLabel('スプリントゴール').fill('ログインを作り直す');
  await dialog.getByRole('button', { name: '始める' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'スプリントを始めました' })).toBeVisible();

  await page.getByRole('link', { name: 'スプリント', exact: true }).click();
  await expect(page.locator('.board-col-name')).toHaveText(['未着手', '作業中', 'レビュー', '完了']);
  await page.getByRole('article', { name: 'E札', exact: true }).press('Alt+ArrowRight');
  await expect(
    page.getByRole('status').filter({ hasText: '「E札」を作業中の 1 番目に移しました（1 件中）' }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: '前の列へ: E札' })).toBeVisible();

  // 完了の列には、完成の定義を畳んで出す。開くまで本文を描かない
  const doneColumn = page.getByRole('region', { name: '完了', exact: true });
  const dod = doneColumn.locator('details.dod');
  await expect(dod.locator('summary')).toHaveText('完成の定義');
  await expect(dod.locator('.doc-box')).toHaveCount(0);
  await dod.locator('summary').click();
  await expect(dod.getByRole('listitem')).toHaveText(['レビューを1人以上が通した']);
  // ほかの列には出さない
  await expect(page.locator('details.dod')).toHaveCount(1);

  // 最後の完了でない列の「次の列へ」は、完了にする
  await page.getByRole('button', { name: '次の列へ: E札' }).click();
  await expect(titlesIn(page, 'レビュー')).toHaveText(['E札']);
  await page.getByRole('button', { name: '完了の列へ（完了にする）: E札' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'タスクを完了にしました' })).toBeVisible();
  await expect(titlesIn(page, '完了')).toHaveText(['E札']);
  // 戻すと、完了の前の列へ戻る
  await page.getByRole('button', { name: '完了を戻す: E札' }).click();
  await expect(page.getByRole('status').filter({ hasText: '「E札」の完了を戻し、レビューへ移しました' })).toBeVisible();
  await expect(titlesIn(page, 'レビュー')).toHaveText(['E札']);
  await expect(titlesIn(page, '完了')).toHaveText([]);
  await expect(page.getByRole('article', { name: 'E札', exact: true })).toBeFocused();

  // Alt + → の押しっぱなしの自動の繰り返しでは、完了にしない。続けて押した移動は送られ、完了は送られていない
  const completes: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('task-complete')) completes.push(request.url());
  });
  await page
    .getByRole('article', { name: 'E札', exact: true })
    .dispatchEvent('keydown', { key: 'ArrowRight', altKey: true, repeat: true, bubbles: true });
  await page.getByRole('article', { name: 'E札', exact: true }).press('Alt+ArrowLeft');
  await expect(
    page.getByRole('status').filter({ hasText: '「E札」を作業中の 1 番目に移しました（1 件中）' }),
  ).toBeVisible();
  await expect(titlesIn(page, '作業中')).toHaveText(['E札']);
  expect(completes).toEqual([]);
});

test('戻すのが断られたら理由を知らせて読み直す', async ({ page, context, baseURL }) => {
  await signIn(context, baseURL, 'member');
  await mockOperation(page, sprintBoard, { slug: 'aoba' }, SAMPLE_BOARD);
  await page.goto(`${AOBA_TEAM}/sprint`);
  const unroute = await failOperation(page, taskReopen, { slug: 'aoba' }, 409, 'conflict', {
    details: { reason: 'sprint_closed' },
  });
  // 読み込みで行が動いている間に押すと、Playwright が押し直す前にスクロールし、その位置が画像に残る（#354、#491）
  const reopen = page.getByRole('button', { name: '完遂を戻す: 付与の履歴を返す API を作る' });
  await expect(reopen).toBeVisible();
  await waitForSettled(page);
  await reopen.click();
  await expect(
    page.getByRole('status').filter({ hasText: '終了した遠征の中で完遂したクエストは戻せません。一覧を読み直します' }),
  ).toBeVisible();
  // 読み直した画面（差し替えた応答）では、カードは完遂の列に残る
  await expect(titlesIn(page, '完遂')).toHaveText(['付与の履歴を返す API を作る']);
  await unroute();
});

test('カードが1枚も無いあいだだけ、列とカードの領域そのものに Tab で止まれる', async ({ page, context, baseURL }) => {
  await signIn(context, baseURL, 'member');
  const region = page.getByRole('region', { name: '遠征の行程とカード' });
  const emptyBoard = {
    ...SAMPLE_BOARD,
    columns: SAMPLE_BOARD.columns.map((column) => ({ ...column, tasks: [] })),
  };
  const unroute = await mockOperation(page, sprintBoard, { slug: 'aoba' }, emptyBoard);
  await page.goto(`${AOBA_TEAM}/sprint`);
  await expect(region).toHaveAttribute('tabindex', '0');

  // カードがあれば、カードが止まる先になるので、領域には止まらない
  await unroute();
  await mockOperation(page, sprintBoard, { slug: 'aoba' }, SAMPLE_BOARD);
  await page.reload();
  await expect(page.getByRole('article', { name: 'ポイント付与のバッチを作る' })).toBeVisible();
  await expect(region).not.toHaveAttribute('tabindex');
});

test('選んだカードは題を名前に、ポイントと担い手と動かし方を説明に読み上げる', async ({ page, context, baseURL }) => {
  await signIn(context, baseURL, 'member');
  await mockOperation(page, sprintBoard, { slug: 'aoba' }, SAMPLE_BOARD);
  await page.goto(`${AOBA_TEAM}/sprint`);
  const assigned = page.getByRole('article', { name: 'ポイント付与のバッチを作る', exact: true });
  await expect(assigned).toHaveAccessibleDescription(/3.*担い手はミナト.*Alt と ← → で隣の行程/);
  const unassigned = page.getByRole('article', { name: '障害時の連絡手順を書く', exact: true });
  await expect(unassigned).toHaveAccessibleDescription(/未見積もり.*担い手なし/);
});

test('リーダーは遠征を終え、終わらなかったクエストを次の遠征へ、次はバックログへ持ち越し、移ったのを見る', async ({
  page,
  context,
  baseURL,
}) => {
  // 起票から2回終えるまでを1本で確かめる長い流れ
  test.setTimeout(120_000);
  await signIn(context, baseURL, 'admin');
  await createWorkspace(page, '帰還の見張り番', 'game');
  for (const title of ['A札', 'B札', 'C札']) await addTask(page, title);

  await page.getByRole('link', { name: '遠征の計画' }).click();
  await expect(page.getByRole('heading', { level: 1, name: '遠征の計画' })).toBeVisible();
  // 最終日が今日より前のスプリントは始められないので、遠い先の期間にする
  await createSprint(page, '2099-03-01', '第1回');
  await createSprint(page, '2099-03-15', '第2回');
  await page.getByRole('button', { name: '掲示板から入れる: 遠征 第1回' }).click();
  const picker = page.getByRole('dialog', { name: '遠征 第1回 に入れる' });
  const list = picker.getByRole('group', { name: '入れるクエスト' });
  for (const title of ['A札', 'B札', 'C札'])
    await list.getByRole('checkbox', { name: new RegExp(`^${title}`) }).check();
  await picker.getByRole('button', { name: '3 件入れる' }).click();
  await expect(picker).toBeHidden();

  // 第1回をゴールを書いて始め、スプリントの画面で A札 を完遂にする
  await page.getByRole('button', { name: '始める: 遠征 第1回' }).click();
  const startDialog = page.getByRole('dialog', { name: '遠征を始める' });
  await startDialog.getByLabel('遠征の目的').fill(GOAL);
  await startDialog.getByRole('button', { name: '始める' }).click();
  await expect(startDialog).toBeHidden();
  await page.getByRole('link', { name: '遠征', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: '遠征 第1回' })).toBeVisible();
  // 最終日の前なので、最終日を過ぎた知らせは出ない。見出しの右の「終える」だけがある
  await expect(page.locator('.callout.is-warn')).toHaveCount(0);
  await page.getByRole('button', { name: '完遂にする: A札' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'クエストを完遂にしました' })).toBeVisible();
  await expect(titlesIn(page, '完遂')).toHaveText(['A札']);

  // 終える。未完了の2件の行き先は、既定が次の遠征（第2回）で、バックログへ戻すことも選べる。ゴールがあるので達成を聞く（既定は達成した）
  await page.getByRole('button', { name: '終える: 遠征 第1回' }).click();
  const closeDialog = page.getByRole('dialog', { name: '遠征を終える' });
  await expect(closeDialog).toContainText(
    '遠征 第1回（3/1〜3/14）を終えます。終えた遠征の期間と中身は、あとから変えられません。',
  );
  const carry = closeDialog.getByRole('radiogroup', { name: '終わらなかったクエスト 2 件の行き先' });
  await expect(carry.getByRole('radio')).toHaveCount(2);
  await expect(carry.getByRole('radio', { name: /^遠征 第2回（3\/15〜3\/28）へ持ち越す/ })).toBeChecked();
  await expect(carry.getByRole('radio', { name: /^掲示板へ戻す/ })).not.toBeChecked();
  // 読み込みが終わったら、フォーカスは選ばれている行き先へ移る（開いた直後の主ボタンから）
  await expect(carry.getByRole('radio', { name: /^遠征 第2回（3\/15〜3\/28）へ持ち越す/ })).toBeFocused();
  const goal = closeDialog.getByRole('radiogroup', { name: '遠征の目的は達成できましたか' });
  await expect(closeDialog.locator('.props-note')).toHaveText(GOAL);
  await expect(goal.getByRole('radio', { name: '達成した' })).toBeChecked();
  await closeDialog.getByRole('button', { name: '終える', exact: true }).click();
  await expect(closeDialog).toBeHidden();
  await expect(
    page.getByRole('status').filter({ hasText: '遠征 第1回を終えました。クエスト 2 件を遠征 第2回へ持ち越しました' }),
  ).toBeVisible();
  // 進行中の遠征が無い表示に戻り、フォーカスは見出しへ移る
  await expect(page.getByRole('heading', { level: 1, name: '遠征', exact: true })).toBeFocused();
  await expect(page.getByText('進行中の遠征はありません')).toBeVisible();

  // 計画の画面では、終えた第1回は並ばず、持ち越した2件は第2回に元の順で入っている。完遂した A札 は入らない
  await page.getByRole('link', { name: '遠征の計画', exact: true }).click();
  await expect(page.locator('.lane-title', { hasText: '第2回' })).toBeVisible();
  await expect(page.locator('.lane')).toHaveCount(1);
  await expect(page.locator('.lane', { hasText: '第2回' }).locator('.lane-row a')).toHaveText(['B札', 'C札']);

  // 第2回をゴールなしで始め、スプリントの画面で終える。持ち越し先の遠征が無いので、バックログへ戻すだけを出し、達成は聞かない
  await page.getByRole('button', { name: '始める: 遠征 第2回' }).click();
  await startDialog.getByRole('button', { name: '始める' }).click();
  await expect(startDialog).toBeHidden();
  await page.getByRole('link', { name: '遠征', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: '遠征 第2回' })).toBeVisible();
  await expect(titlesIn(page, '出発前')).toHaveText(['B札', 'C札']);
  await page.getByRole('button', { name: '終える: 遠征 第2回' }).click();
  await expect(closeDialog).toBeVisible();
  const backlogOnly = closeDialog.getByRole('radiogroup', { name: '終わらなかったクエスト 2 件の行き先' });
  await expect(backlogOnly.getByRole('radio')).toHaveCount(1);
  await expect(backlogOnly.getByRole('radio', { name: /^掲示板へ戻す/ })).toBeChecked();
  await expect(backlogOnly.getByRole('radio', { name: /^掲示板へ戻す/ })).toBeFocused();
  await expect(closeDialog).toContainText('持ち越せる遠征がありません。掲示板へ戻します。');
  await expect(closeDialog.getByRole('radiogroup', { name: '遠征の目的は達成できましたか' })).toHaveCount(0);
  await closeDialog.getByRole('button', { name: '終える', exact: true }).click();
  await expect(closeDialog).toBeHidden();
  await expect(
    page.getByRole('status').filter({ hasText: '遠征 第2回を終えました。クエスト 2 件を掲示板へ戻しました' }),
  ).toBeVisible();

  // 計画の画面には先の遠征が無くなる（終えた遠征があるので、題は「先の遠征はありません」）。掲示板では2件がどの遠征にも入っていない
  await page.getByRole('link', { name: '遠征の計画', exact: true }).click();
  await expect(page.getByText('先の遠征はありません')).toBeVisible();
  await page.getByRole('link', { name: '掲示板', exact: true }).click();
  for (const title of ['B札', 'C札']) {
    const entry = page.locator('.entry', { hasText: title });
    await expect(entry).toBeVisible();
    await expect(entry).not.toContainText('第2回');
  }
});

test('最終日を過ぎた進行中の遠征には終えるのを促す知らせが出て、終えられるのはリーダーだけ', async ({
  page,
  context,
  baseURL,
}) => {
  await signIn(context, baseURL, 'admin');
  await mockOperation(page, sprintBoard, { slug: 'aoba' }, OVERDUE_BOARD);
  await mockOperation(page, sprintList, { slug: 'aoba' }, OVERDUE_PLAN);
  const notice = page.locator('.callout.is-warn');
  const text = '遠征 第14回は最終日（10/26）を過ぎています。';

  // スプリントの画面。見出しの下に知らせ、リーダーには「終える」を添える
  await page.goto(`${AOBA_TEAM}/sprint`);
  await expect(notice).toContainText(`${text}終わらなかったクエストの行き先を決めて、終えてください。`);
  // 知らせの「終える」から、見出しの右と同じダイアログを開く。持ち越し先は最終日より後に始まる第15回
  await notice.getByRole('button', { name: '終える: 遠征 第14回' }).click();
  const dialog = page.getByRole('dialog', { name: '遠征を終える' });
  const carry = dialog.getByRole('radiogroup', { name: '終わらなかったクエスト 2 件の行き先' });
  await expect(carry.getByRole('radio', { name: /^遠征 第15回（10\/27〜11\/9）へ持ち越す/ })).toBeChecked();
  // 別の画面で先に終えられていたら、理由を知らせてダイアログを閉じ、読み直す
  const unroute = await failOperation(page, sprintClose, { slug: 'aoba' }, 409, 'conflict', {
    details: { reason: 'not_active' },
  });
  await dialog.getByRole('button', { name: '終える', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(
    page.getByRole('status').filter({ hasText: 'この遠征は進行中ではありません（もう終わっています）。読み直します' }),
  ).toBeVisible();
  await unroute();

  // 計画の画面。進行中の遠征のレーンに同じ知らせが出る。先の遠征には出ない
  await page.goto(`${AOBA_TEAM}/plan`);
  const lane = page.locator('.lane.is-active');
  await expect(lane.locator('.callout.is-warn')).toContainText(text);
  await expect(page.locator('.callout.is-warn')).toHaveCount(1);
  await lane.getByRole('button', { name: '終える: 遠征 第14回' }).click();
  await expect(dialog).toBeVisible();
  await expect(carry).toBeVisible();
  await dialog.getByRole('button', { name: 'やめる' }).click();
  await expect(dialog).toBeHidden();
});

test('終了のダイアログは、読み込めなければ「終える」を押せず、もう一度試すで読み直せる', async ({
  page,
  context,
  baseURL,
}) => {
  await signIn(context, baseURL, 'admin');
  await mockOperation(page, sprintBoard, { slug: 'aoba' }, OVERDUE_BOARD);
  const unroute = await failOperation(page, sprintList, { slug: 'aoba' }, 500, 'internal');
  await page.goto(`${AOBA_TEAM}/sprint`);
  await page.locator('.callout.is-warn').getByRole('button', { name: '終える: 遠征 第14回' }).click();
  const dialog = page.getByRole('dialog', { name: '遠征を終える' });
  await expect(dialog.getByRole('alert')).toContainText('遠征の状態を読み込めませんでした');
  const submit = dialog.getByRole('button', { name: '終える', exact: true });
  await expect(submit).toHaveAttribute('aria-disabled', 'true');
  // 押しても送らない
  let closes = 0;
  page.on('request', (request) => {
    if (request.url().includes('sprint-close')) closes++;
  });
  // aria-disabled の要素は、Playwright が押せない状態として待つので、force で押す
  await submit.click({ force: true });
  expect(closes).toBe(0);

  await unroute();
  await mockOperation(page, sprintList, { slug: 'aoba' }, OVERDUE_PLAN);
  await dialog.getByRole('button', { name: 'もう一度試す' }).click();
  const first = dialog.getByRole('radio', { name: /^遠征 第15回（10\/27〜11\/9）へ持ち越す/ });
  await expect(first).toBeChecked();
  await expect(first).toBeFocused();
  await expect(submit).toHaveAttribute('aria-disabled', 'false');
});

test('最終日を過ぎた知らせは、リーダーでない人には終える人を伝えるだけで、最終日の前には出ない', async ({
  page,
  context,
  baseURL,
}) => {
  await signIn(context, baseURL, 'member');
  await mockOperation(page, sprintBoard, { slug: 'aoba' }, OVERDUE_BOARD);
  await mockOperation(page, sprintList, { slug: 'aoba' }, OVERDUE_PLAN);
  await page.goto(`${AOBA_TEAM}/sprint`);
  await expect(page.locator('.callout.is-warn')).toContainText(
    '遠征 第14回は最終日（10/26）を過ぎています。終えるのはパーティリーダーです。',
  );
  await expect(page.getByRole('button', { name: /^終える/ })).toHaveCount(0);
  await page.goto(`${AOBA_TEAM}/plan`);
  await expect(page.locator('.lane.is-active .callout.is-warn')).toHaveCount(1);
  await expect(page.getByRole('button', { name: /^終える/ })).toHaveCount(0);

  // 最終日の前（today が最終日と同じ日）には出ない
  await mockOperation(page, sprintBoard, { slug: 'aoba' }, { ...OVERDUE_BOARD, today: SAMPLE_BOARD.sprint!.end_on });
  await page.goto(`${AOBA_TEAM}/sprint`);
  await expect(page.getByRole('heading', { level: 1, name: '遠征 第14回' })).toBeVisible();
  await expect(page.locator('.callout.is-warn')).toHaveCount(0);
});
