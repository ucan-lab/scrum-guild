// スプリントを始めて、スプリントの画面でカードを動かす流れ。
// リーダーは計画の画面から、ゴールの欄のあるダイアログでスプリントを始める。進行中は同時に1つで、2つ目は理由が出て始められない。
// スプリントの画面には列とカードが並び、カードは題から詳細の引き出しを開け、ボタンと Alt と矢印のキーで隣の列へ移し、列の中で並べ替えられる。
// 動かした位置は読み上げられ、読み直しても、別の画面でも同じで、列の移動は変更の履歴に残る。
// 自分のワークスペースを作って動かす（ほかのファイルと並べて走るため、seed の行は書き換えない）。
// 空の状態は seed のあおば開発（進行中のスプリントが無い）を開くだけ
import type { Page } from '@playwright/test';
import { sprintBoard, taskColumnMove } from '../src/shared/operations/sprint/index.ts';
import { expect, test } from './fixtures.ts';
import { createWorkspace, signIn, waitForResponses, watchViolations } from './helpers.ts';
import { failOperation, mockOperation } from './operations.ts';
import { SAMPLE_BOARD } from './sprint-fixture.ts';

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

  // 最後の完了でない列から先（完遂の列）へは、ここから移せない。完遂にするのはカードの「完遂にする」
  await card('C札').press('Alt+ArrowRight');
  await card('C札').press('Alt+ArrowRight');
  await expect(titlesIn(page, '査定中')).toHaveText(['C札']);
  await card('C札').press('Alt+ArrowRight');
  await expect(
    status('完遂の行程へは、ここから移せません。完遂にするには、カードの「完遂にする」を押してください'),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: '次の行程へ: C札' })).toHaveAttribute('aria-disabled', 'true');
  await expect(page.getByRole('button', { name: '前の行程へ: B札' })).toHaveAttribute('aria-disabled', 'false');
  await expect(page.getByRole('button', { name: '前の行程へ: A札' })).toHaveAttribute('aria-disabled', 'false');
  await moved;

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

  // カードの完了の操作は task-complete を呼ぶだけ。完遂の列のカードは完了の印を持ち、動かすボタンを持たない
  await page.getByRole('button', { name: '完遂にする: C札' }).click();
  await expect(status('クエストを完遂にしました')).toBeVisible();
  await expect(titlesIn(page, '完遂')).toHaveText(['C札']);
  await expect(titlesIn(page, '査定中')).toHaveText([]);
  await expect(
    page.getByRole('region', { name: '完遂', exact: true }).getByRole('img', { name: 'C札: 完遂' }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: /: C札$/ })).toHaveCount(0);
  await expect(page.getByRole('article', { name: 'C札' })).toHaveCount(0);

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

test('スクラムの言葉でも、スプリントを始めて、列とカードを動かせる', async ({ page, context, baseURL }) => {
  await signIn(context, baseURL, 'admin');
  await createWorkspace(page, 'スクラムの見張り番', 'scrum');
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
