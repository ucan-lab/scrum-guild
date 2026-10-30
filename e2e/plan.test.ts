// 計画の画面: リーダーが先のスプリントを作り、直し（重なりは断られてダイアログに理由が出る）、削除する。
// 一般のメンバーには作成、変更、削除のボタンが出ない。スプリントが無いワークスペースでは空の状態が出る。
// seed のセッション（seed/sessions.ts）の Cookie で開く。あおば開発の管理者はミナト（ひばり工房では一般のユーザー）、一般のユーザーはハルカ
import { planSummary, sprintTaskAdd } from '../src/shared/operations/sprint/index.ts';
import { backlogTree } from '../src/shared/operations/task/index.ts';
import { expect, test } from './fixtures.ts';
import { createWorkspace, signIn, watchViolations } from './helpers.ts';
import { failOperation, rewriteOperation, routeOperation } from './operations.ts';

test.use({ timezoneId: 'Asia/Tokyo' });

// seed の受託開発チーム（あおば開発）と社内ツール（ひばり工房）
const AOBA_TEAM = '/aoba/w/019a0000-0000-7000-8000-000000000401/plan';
const HIBARI_TOOLS = '/hibari/w/019a0000-0000-7000-8000-000000000402/plan';

test('リーダーは遠征を作り、直し、重なりを断られ、削除できる', async ({ page, context, baseURL }) => {
  await signIn(context, baseURL, 'admin');
  const collect = await watchViolations(page);
  await createWorkspace(page, '遠征のパーティ', 'game');

  // メニューの「遠征の計画」から開く。まだ遠征が無いので、空の状態と作るボタンが出る
  await page.getByRole('link', { name: '遠征の計画' }).click();
  await expect(page.getByRole('heading', { level: 1, name: '遠征の計画' })).toBeVisible();
  await expect(page).toHaveTitle('遠征の計画・遠征のパーティ - Scrum Guild');
  await expect(page.getByText('まだ遠征がありません')).toBeVisible();

  // 1つ目を作る。最終日は開始日と長さから決まり、曜日を添える
  await page.getByRole('button', { name: '遠征を作る' }).click();
  const createDialog = page.getByRole('dialog', { name: '遠征を作る' });
  await createDialog.getByLabel('開始日').fill('2027-01-04');
  await createDialog.getByLabel('長さ（日）').fill('14');
  await expect(createDialog.locator('[data-sprint-end]')).toHaveText('2027-01-17（日）');
  await createDialog.getByRole('button', { name: '作る' }).click();
  await expect(createDialog).toBeHidden();
  await expect(page.getByRole('status').filter({ hasText: '遠征を作りました' })).toBeVisible();
  // 名前の無い遠征は、期間を名前として出す
  await expect(page.locator('.lane-title')).toHaveText(['遠征 1/4〜1/17']);

  // 2つ目の初期値は、前の遠征の最終日の翌日と同じ長さ
  await page.getByRole('button', { name: '遠征を作る' }).click();
  await expect(createDialog.getByLabel('開始日')).toHaveValue('2027-01-18');
  await expect(createDialog.getByLabel('長さ（日）')).toHaveValue('14');
  await createDialog.getByLabel('名前（任意）').fill('新年の仕上げ');
  await createDialog.getByRole('button', { name: '作る' }).click();
  await expect(createDialog).toBeHidden();
  await expect(page.locator('.lane-title')).toHaveText(['遠征 1/4〜1/17', '遠征 新年の仕上げ']);

  // 1つ目を1日伸ばすと2つ目と重なり、ダイアログの中に理由が出て、開いたまま
  await page.getByRole('button', { name: '直す: 遠征 1/4〜1/17' }).click();
  const editDialog = page.getByRole('dialog', { name: '遠征を直す' });
  await expect(editDialog.getByLabel('開始日')).toHaveValue('2027-01-04');
  await editDialog.getByLabel('長さ（日）').fill('15');
  await expect(editDialog.locator('[data-sprint-end]')).toHaveText('2027-01-18（月）');
  await editDialog.getByRole('button', { name: '保存する' }).click();
  await expect(editDialog.getByRole('alert')).toHaveText(
    '期間が、ほかの遠征と重なっています。開始日か長さを変えてください',
  );
  await expect(editDialog).toBeVisible();

  // 前へずらして伸ばすと保存できる
  await editDialog.getByLabel('開始日').fill('2026-12-28');
  await editDialog.getByLabel('長さ（日）').fill('21');
  await editDialog.getByRole('button', { name: '保存する' }).click();
  await expect(editDialog).toBeHidden();
  await expect(page.getByRole('status').filter({ hasText: '遠征を保存しました' })).toBeVisible();
  await expect(page.locator('.lane-title')).toHaveText(['遠征 12/28〜1/17', '遠征 新年の仕上げ']);

  // 2つ目を削除する。確かめのダイアログを通す
  await page.getByRole('button', { name: '削除する: 遠征 新年の仕上げ' }).click();
  const confirm = page.getByRole('dialog', { name: '遠征を削除する' });
  await expect(confirm).toContainText('「遠征 新年の仕上げ」（1/18〜1/31）を削除します。');
  await confirm.getByRole('button', { name: '削除する' }).click();
  await expect(confirm).toBeHidden();
  await expect(page.getByRole('status').filter({ hasText: '遠征を削除しました' })).toBeVisible();
  await expect(page.locator('.lane-title')).toHaveText(['遠征 12/28〜1/17']);
  await expect(page.getByRole('heading', { level: 1, name: '遠征の計画' })).toBeFocused();

  // 読み直しても残る
  await page.reload();
  await expect(page.locator('.lane-title')).toHaveText(['遠征 12/28〜1/17']);
  // 重なりで断られた応答（409）は、ブラウザがコンソールに出す。それ以外の違反とエラーは無い
  const problems = await collect();
  expect(problems.filter((problem) => !problem.includes('status of 409'))).toEqual([]);
});

test('一般のメンバーには、遠征と入っているクエストが並び、入れる、外す口は出るが、作成、変更、削除のボタンが出ない', async ({
  page,
  context,
  baseURL,
}) => {
  await signIn(context, baseURL, 'member');
  await page.goto(AOBA_TEAM);
  await expect(page.getByRole('heading', { level: 1, name: '遠征の計画' })).toBeVisible();
  await expect(page.locator('.lane-title')).toHaveText(['遠征 11/2〜11/15', '遠征 年末の仕上げ']);
  await expect(page.locator('.lane-sub').first()).toContainText('14 日');
  // seed の先の遠征には、達成目標の下のクエストが1件ずつ入っている
  await expect(page.locator('.lane').first().locator('.lane-row a')).toHaveText([
    '失効予定のポイントを知らせる文面を決める',
  ]);
  await expect(page.locator('.lane').nth(1).locator('.lane-row a')).toHaveText(['回答までにかかる時間を測る']);
  await expect(page.locator('.lane-sub').first()).toContainText('1 件・2 pt');
  await expect(page.getByRole('button', { name: '外す: 回答までにかかる時間を測る' })).toBeVisible();
  await expect(page.getByRole('button', { name: '掲示板から入れる: 遠征 年末の仕上げ' })).toBeVisible();
  await expect(page.getByRole('button', { name: '遠征を作る' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^直す/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^削除する/ })).toHaveCount(0);
});

test('スクラムの言葉: ストーリーごとと1件ずつ入れ、外し、始まっていないスプリントの中で完了にすると外れる', async ({
  page,
  context,
  baseURL,
}) => {
  await signIn(context, baseURL, 'admin');
  const collect = await watchViolations(page);
  await createWorkspace(page, '出し入れのチーム', 'scrum');

  // バックログに、親のないタスク1件と、ストーリーの下のタスク2件を作る
  await page.getByRole('button', { name: '起票' }).click();
  const rootDialog = page.getByRole('dialog', { name: '起票' });
  await rootDialog.getByLabel('タイトル').fill('ヘルプを書く');
  await rootDialog.getByRole('button', { name: '起票' }).click();
  await expect(rootDialog).toBeHidden();
  await page.getByRole('button', { name: 'ストーリーを作る' }).click();
  const storyDialog = page.getByRole('dialog', { name: 'ストーリーを作る' });
  await storyDialog.getByLabel('タイトル').fill('ログインを作り直す');
  await storyDialog.getByRole('button', { name: '作る' }).click();
  await expect(storyDialog).toBeHidden();
  for (const title of ['フォームを置く', '送信を確かめる']) {
    await page.getByRole('button', { name: 'タスクを足す: ログインを作り直す' }).click();
    const taskDialog = page.getByRole('dialog', { name: '起票' });
    await taskDialog.getByLabel('タイトル').fill(title);
    await taskDialog.getByRole('button', { name: '起票' }).click();
    await expect(taskDialog).toBeHidden();
  }
  await expect(page.locator('.entry', { hasText: '送信を確かめる' })).toBeVisible();

  // 計画の画面でスプリントを作る
  await page.getByRole('link', { name: '計画' }).click();
  await page.getByRole('button', { name: 'スプリントを作る' }).click();
  const createDialog = page.getByRole('dialog', { name: 'スプリントを作る' });
  await createDialog.getByLabel('開始日').fill('2027-02-01');
  await createDialog.getByLabel('長さ（日）').fill('14');
  await createDialog.getByLabel('名前（任意）').fill('第1回');
  await createDialog.getByRole('button', { name: '作る' }).click();
  await expect(createDialog).toBeHidden();
  await expect(page.locator('.lane-title')).toHaveText(['スプリント 第1回']);
  await expect(page.locator('.lane .action-note')).toHaveText('まだ何も入っていません');

  // ストーリーごとと、親のないタスクを1件選んで入れる
  const addButton = page.getByRole('button', { name: 'バックログから入れる: スプリント 第1回' });
  await addButton.click();
  const picker = page.getByRole('dialog', { name: 'スプリント 第1回 に入れる' });
  const list = picker.getByRole('group', { name: '入れるタスク' });
  // ストーリーの見出しと、その下の2件、親のないタスクの1件。同じタスクを二度描かない
  await expect(list.getByRole('checkbox')).toHaveCount(4);
  await expect(picker.getByRole('button', { name: '入れる', exact: true })).toBeVisible();
  const story = list.getByRole('checkbox', { name: /^ログインを作り直す/ });
  const form = list.getByRole('checkbox', { name: /^フォームを置く/ });
  const send = list.getByRole('checkbox', { name: /^送信を確かめる/ });
  const search = picker.getByRole('searchbox', { name: 'タスクとストーリーのタイトルで絞る' });
  // 絞っている間の見出しは、見えている配下だけを選ぶ
  await search.fill('送信');
  await expect(list.getByRole('checkbox')).toHaveCount(2);
  await story.check();
  await expect(picker.locator('.pick-count')).toHaveText('1 件を選んでいます');
  await search.fill('');
  await expect(send).toBeChecked();
  await expect(form).not.toBeChecked();
  // 検索欄で Enter を押しても送らない（選んだものが入ってしまわない）
  let adds = 0;
  page.on('request', (request) => {
    if (request.url().endsWith('/sprint-task-add')) adds++;
  });
  await search.press('Enter');
  await expect(picker).toBeVisible();
  await expect(picker.locator('.callout')).toHaveCount(0);
  expect(adds).toBe(0);
  await send.uncheck();
  // 見出しを選ぶと配下がまとめて選ばれ、1件外すと見出しは一部だけの印（indeterminate）になる
  await story.check();
  await expect(form).toBeChecked();
  await expect(send).toBeChecked();
  await form.uncheck();
  expect(await story.evaluate((node) => (node as HTMLInputElement).indeterminate)).toBe(true);
  await form.check();
  expect(await story.evaluate((node) => (node as HTMLInputElement).indeterminate)).toBe(false);
  await expect(story).toBeChecked();
  // タイトルで絞る。絞っても選んだものは残る
  await picker.getByRole('searchbox', { name: 'タスクとストーリーのタイトルで絞る' }).fill('ヘルプ');
  await expect(list.getByRole('checkbox')).toHaveCount(1);
  await list.getByRole('checkbox', { name: /^ヘルプを書く/ }).check();
  await expect(picker.locator('.pick-count')).toHaveText('3 件を選んでいます');
  await picker.getByRole('searchbox', { name: 'タスクとストーリーのタイトルで絞る' }).fill('');
  await picker.getByRole('button', { name: '3 件入れる' }).click();
  await expect(picker).toBeHidden();
  await expect(page.getByRole('status').filter({ hasText: '3 件入れました' })).toBeVisible();
  await expect(page.locator('.lane-row a')).toHaveText(['フォームを置く', '送信を確かめる', 'ヘルプを書く']);
  await expect(page.locator('.lane-sub')).toContainText('3 件・0 pt');

  // もう入れられるタスクが無い
  await addButton.click();
  await expect(picker.getByText('入れられる未完了のタスクがありません。バックログで起票してください。')).toBeVisible();
  await picker.getByRole('button', { name: 'やめる' }).click();
  await expect(picker).toBeHidden();

  // 1件外す。行が消え、同じスプリントの「バックログから入れる」へフォーカスが移る
  await page.getByRole('button', { name: '外す: ヘルプを書く' }).click();
  await expect(page.getByRole('status').filter({ hasText: '「ヘルプを書く」を外しました' })).toBeVisible();
  await expect(page.locator('.lane-row a')).toHaveText(['フォームを置く', '送信を確かめる']);
  await expect(addButton).toBeFocused();

  // 行から詳細を開くと、入っているスプリントが出る。完了にすると、始まっていないスプリントから外れてバックログに戻る
  await page.locator('.lane-row').getByRole('link', { name: 'フォームを置く' }).click();
  const drawer = page.getByRole('dialog', { name: 'フォームを置く' });
  await expect(drawer.locator('.props')).toContainText('スプリント 第1回');
  await expect(drawer.locator('.props')).toContainText('計画の画面で出し入れします');
  await drawer.getByRole('button', { name: '完了にする' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'タスクを完了にしました。始まっていないスプリントから外れました' }),
  ).toBeVisible();
  await expect(drawer.locator('.props')).not.toContainText('スプリント 第1回');
  await expect(page.locator('.lane-row a')).toHaveText(['送信を確かめる']);
  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();

  // バックログの木の行にも、入っているスプリントの名前が出る
  await page.getByRole('link', { name: 'バックログ' }).click();
  await expect(page.locator('.entry', { hasText: '送信を確かめる' }).locator('.entry-meta .chip')).toHaveText(
    'スプリント：第1回',
  );
  await expect(page.locator('.entry', { hasText: 'ヘルプを書く' }).locator('.entry-meta')).toHaveCount(0);
  expect(await collect()).toEqual([]);
});

test('入れるダイアログ: 読めなければ枠と「もう一度試す」を出し、飛ばしたものがあれば結果をダイアログの中に残す', async ({
  page,
  context,
  baseURL,
}) => {
  await signIn(context, baseURL, 'admin');
  await createWorkspace(page, '入れ直しの遠征隊', 'game');
  for (const title of ['地図を描く', '水を汲む']) {
    await page.getByRole('button', { name: '依頼を出す' }).click();
    const dialog = page.getByRole('dialog', { name: '依頼を出す' });
    await dialog.getByLabel('タイトル').fill(title);
    await dialog.getByRole('button', { name: '依頼を出す' }).click();
    await expect(dialog).toBeHidden();
  }
  await page.getByRole('link', { name: '遠征の計画' }).click();
  await page.getByRole('button', { name: '遠征を作る' }).click();
  const createDialog = page.getByRole('dialog', { name: '遠征を作る' });
  await createDialog.getByLabel('開始日').fill('2027-03-01');
  await createDialog.getByRole('button', { name: '作る' }).click();
  await expect(createDialog).toBeHidden();

  // 木を読めない。枠（role="alert"）と「もう一度試す」を出し、送っても「選んでください」は出さない
  const unroute = await failOperation(page, backlogTree, { slug: 'aoba' }, 500, 'internal');
  await page.getByRole('button', { name: /^掲示板から入れる/ }).click();
  const picker = page.getByRole('dialog', { name: /に入れる$/ });
  await expect(picker.getByRole('alert')).toHaveText('掲示板を読み込めませんでした');
  // aria-disabled のボタンも押せる（Playwright は押せない形と見るので force で押す）
  await picker.getByRole('button', { name: '入れる', exact: true }).click({ force: true });
  await expect(picker.locator('.callout.is-danger')).toHaveCount(0);
  await unroute();
  await picker.getByRole('button', { name: 'もう一度試す' }).click();
  const search = picker.getByRole('searchbox', { name: 'クエストと達成目標のタイトルで絞る' });
  await expect(search).toBeFocused();
  await expect(picker.getByRole('group', { name: '入れるクエスト' }).getByRole('checkbox')).toHaveCount(2);

  // 飛ばしたものがあれば、閉じずに結果を残す（読む前に消えない）
  await rewriteOperation(page, sprintTaskAdd, { slug: 'aoba' }, (output) => ({
    ...output,
    skipped: { ...output.skipped, completed: 1 },
  }));
  await picker.getByRole('checkbox', { name: /^地図を描く/ }).check();
  await picker.getByRole('button', { name: '1 件入れる' }).click();
  await expect(picker.getByRole('status').filter({ hasText: '1 件入れました' })).toHaveText(
    '1 件入れました。1 件は完遂済みのため入れませんでした',
  );
  await expect(picker).toBeVisible();
  await expect(picker.getByRole('group', { name: '入れるクエスト' }).getByRole('checkbox')).toHaveCount(1);
  await picker.getByRole('button', { name: 'やめる' }).click();
  await expect(page.locator('.lane-row a')).toHaveText(['地図を描く']);

  // 読んでいる間に閉じて開き直しても、読み込み中のまま止まらない（古い応答は捨て、開き直しで読み直す）
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  let first = true;
  await page.route('**/api/aoba/backlog-tree', async (route) => {
    if (first) {
      first = false;
      await held;
    }
    await route.continue();
  });
  const addButton = page.getByRole('button', { name: /^掲示板から入れる/ });
  await addButton.click();
  await expect(picker.locator('.action-note')).toHaveText('読み込んでいます');
  await picker.getByRole('button', { name: 'やめる' }).click();
  await expect(picker).toBeHidden();
  await addButton.click();
  await expect(picker.getByRole('group', { name: '入れるクエスト' }).getByRole('checkbox')).toHaveCount(1);
  release();
  await expect(picker.getByRole('group', { name: '入れるクエスト' }).getByRole('checkbox')).toHaveCount(1);
});

test('スクラムの言葉: スプリントが無いときは空の状態を出し、一般のメンバーには作るのはリーダーだと伝える', async ({
  page,
  context,
  baseURL,
}) => {
  await signIn(context, baseURL, 'admin');
  await page.goto(HIBARI_TOOLS);
  await expect(page.getByRole('heading', { level: 1, name: '計画' })).toBeVisible();
  await expect(page.getByText('まだスプリントがありません')).toBeVisible();
  await expect(page.getByText(/スプリントを作るのはリーダーです。/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'スプリントを作る' })).toHaveCount(0);
  // 先のスプリントも終了したスプリントも無いときは、集計（ベロシティ、エピックの表）を出さず、空の状態だけを出す
  await expect(page.locator('.velocity, [data-velocity-empty], [data-plan-epics-empty], .table')).toHaveCount(0);
  await expect(page.locator('.page-head .tally')).toHaveCount(0);
});

// seed の受託開発チームには、終了したスプリントが4つある（夏の仕上げ 6 pt、延長した 9月の追い込み 13 pt、秋の準備 8 pt、秋の立ち上げ 7 pt）。
// 延長した回を除いた新しい3つの平均は 7 pt。先のスプリントは「遠征 11/2〜11/15」（2 pt）と「年末の仕上げ」（未見積もり 1 件）
test('ベロシティは延長した回を除いた直近3回の平均で、先の遠征の棒と未見積もりの件数、レイドごとの残りが並ぶ', async ({
  page,
  context,
  baseURL,
}) => {
  await signIn(context, baseURL, 'member');
  const collect = await watchViolations(page);
  await page.goto(AOBA_TEAM);
  await expect(page.getByRole('heading', { level: 1, name: '遠征の計画' })).toBeVisible();

  // ベロシティ: 平均と、延長した回を除いたことが文字で分かる。棒は4本で、延長した回だけ除外の印
  const velocity = page.locator('.velocity');
  await expect(velocity.locator('.stat-label').first()).toHaveText('ベロシティ（直近 3 回の平均）');
  await expect(velocity.locator('[data-velocity-average]')).toHaveText('7pt');
  await expect(velocity.getByText('延長した遠征は除く')).toBeVisible();
  await expect(velocity.locator('.bar-col')).toHaveCount(4);
  await expect(velocity.locator('.bar-col.is-excluded')).toHaveCount(1);
  await expect(velocity.locator('.bar-col.is-excluded b')).toHaveText('13');
  await expect(velocity.locator('.bar-col b')).toHaveText(['6', '13', '8', '7']);
  await expect(velocity.locator('.bars-labels')).toContainText('延長 3 日・除外');
  await expect(velocity.getByRole('img', { name: /9月の追い込み 13 pt（延長のため除外）/ })).toBeVisible();

  // 見出しの集計。ベロシティ、超過した先の遠征の数、未見積もりの件数
  const tally = page.locator('.page-head .tally');
  await expect(tally.locator('div').filter({ hasText: 'ベロシティ（pt）' }).locator('dd')).toHaveText('7');
  await expect(tally.locator('div').filter({ hasText: '重量オーバー' }).locator('dd')).toHaveText('0');
  await expect(tally.locator('div').filter({ hasText: '未見積もり' }).locator('dd')).toHaveText('1');

  // 先の遠征ごとの棒。入れたポイントがベロシティ以下なら、赤の棒も超過の印も出ない。未見積もりは件数で出す
  const first = page.locator('.lane').first();
  await expect(first.locator('.lane-fill-text')).toContainText('入れた 2 pt');
  await expect(first.locator('.lane-fill-text')).toContainText('ベロシティ 7');
  await expect(first.locator('.lane-fill-bar')).toHaveAttribute('aria-label', '入れた 2 pt、ベロシティ 7 pt');
  await expect(first.locator('.lane-fill-bar.is-over, [data-lane-over]')).toHaveCount(0);
  await expect(first.locator('[data-lane-unestimated]')).toHaveCount(0);
  await expect(page.locator('.lane').nth(1).locator('[data-lane-unestimated]')).toHaveText('未見積もり 1 件');

  // レイドごとの残り。完了も中止もしていないレイドが、題（レイドの画面へのリンク）、残り、進み、期日で並ぶ
  const row = page.locator('[data-plan-epic]');
  await expect(page.getByRole('heading', { level: 2, name: 'レイドごとの残り' })).toBeVisible();
  await expect(row).toHaveCount(1);
  await expect(row.getByRole('link', { name: 'ポイントの交換先を増やす' })).toHaveAttribute(
    'href',
    /\/aoba\/w\/019a0000-0000-7000-8000-000000000401\/epics\/019a0000-0000-7000-8000-000000000b01$/,
  );
  await expect(row.locator('td.is-num')).toHaveText('0');
  await expect(row.locator('.progress-num')).toHaveText('2 / 2 pt');
  await expect(row.locator('.chip')).toBeVisible();
  expect(await collect()).toEqual([]);
});

test('入れたポイントがベロシティを上回る遠征は、赤い棒に加えて文字でも示す。ベロシティが出ないときは「まだ出ません」の文を出す', async ({
  page,
  context,
  baseURL,
}) => {
  await signIn(context, baseURL, 'member');
  // 集計の応答を差し替える（seed の行は書き換えない）。1つ目の遠征に 10 pt 入っていることにして、ベロシティ 7 pt を 3 pt 上回らせる
  await rewriteOperation(page, planSummary, { slug: 'aoba' }, (output) => ({
    ...output,
    lanes: output.lanes.map((lane, index) => (index === 0 ? { ...lane, points: 10 } : lane)),
  }));
  await page.goto(AOBA_TEAM);
  const first = page.locator('.lane').first();
  await expect(first.locator('.lane-fill-bar.is-over')).toBeVisible();
  await expect(first.locator('[data-lane-over]')).toHaveText('重量オーバー（ベロシティより 3 pt 多い）');
  await expect(first.locator('.lane-fill-text')).toContainText('入れた 10 pt');
  await expect(page.locator('.page-head .tally div').filter({ hasText: '重量オーバー' }).locator('dd')).toHaveText('1');

  // 終了した遠征が無ければ、平均と棒の代わりに文を出す。比べる相手が無いので、遠征の棒は出さず、入れたポイントの文字だけを出す
  await rewriteOperation(page, planSummary, { slug: 'aoba' }, (output) => ({
    ...output,
    velocity: { average: null, sprints: [] },
  }));
  await page.reload();
  await expect(page.locator('[data-velocity-empty]')).toHaveText(
    '終えた遠征がまだないので、ベロシティはまだ出ません。遠征を終えると、ここに出ます。',
  );
  await expect(page.locator('.velocity, .bars')).toHaveCount(0);
  await expect(page.locator('.lane').first().locator('.lane-fill-bar')).toHaveCount(0);
  await expect(page.locator('.lane').first().locator('.lane-fill-text')).toContainText('入れた 2 pt');
  await expect(page.locator('.page-head .tally').getByText('ベロシティ（pt）')).toHaveCount(0);
});

test('集計だけ読めなかったときは、遠征の一覧を出したまま読み直す口を出す', async ({ page, context, baseURL }) => {
  await signIn(context, baseURL, 'otherOrg');
  let fail = true;
  await routeOperation(page, planSummary, { slug: 'hibari' }, async (call) => {
    if (fail) await call.fail(500, 'internal');
    else await call.passThrough();
  });
  await page.goto('/hibari/w/019a0000-0000-7000-8000-000000000404/plan');
  await expect(page.locator('.lane-title')).toHaveText(['遠征 第3回']);
  await expect(
    page.getByRole('alert').filter({ hasText: 'ベロシティとレイドごとの残りを読み込めませんでした。' }),
  ).toBeVisible();
  fail = false;
  await page.getByRole('button', { name: 'もう一度試す' }).click();
  await expect(page.locator('.velocity, [data-velocity-empty]')).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: 'レイドごとの残り' })).toBeVisible();
  await expect(page.locator('[data-plan-epics-empty]')).toHaveText('進行中のレイドはありません');
});

test('先の遠征が無くて集計が読めないときは、空の状態だけにせず、読み込めなかったことと読み直す口を出す', async ({
  page,
  context,
  baseURL,
}) => {
  await signIn(context, baseURL, 'admin');
  await createWorkspace(page, '集計が失敗するパーティ', 'game');
  const unroute = await failOperation(page, planSummary, { slug: 'aoba' }, 500, 'internal');
  await page.getByRole('link', { name: '遠征の計画' }).click();
  await expect(page.getByRole('heading', { level: 1, name: '遠征の計画' })).toBeVisible();
  await expect(page.getByText('まだ遠征がありません')).toBeVisible();
  await expect(
    page.getByRole('alert').filter({ hasText: 'ベロシティとレイドごとの残りを読み込めませんでした。' }),
  ).toBeVisible();
  await unroute();
  await page.getByRole('button', { name: 'もう一度試す' }).click();
  // 読めたら、本当に何も無いので空の状態だけが残る
  await expect(page.getByRole('alert').filter({ hasText: '読み込めませんでした' })).toHaveCount(0);
  await expect(page.getByText('まだ遠征がありません')).toBeVisible();
  await expect(page.locator('.velocity, [data-plan-epics-empty], .table')).toHaveCount(0);
});

test('先の遠征が無くても、終えた遠征とレイドがあれば、ベロシティとレイドの表を出し、空の状態は先の遠征の話だと分かる', async ({
  page,
  context,
  baseURL,
}) => {
  await signIn(context, baseURL, 'admin');
  await createWorkspace(page, '先の遠征が無いパーティ', 'game');
  // 集計の応答を差し替える（終えた遠征が1つとレイドが1つ）。seed の行は書き換えない
  await rewriteOperation(page, planSummary, { slug: 'aoba' }, (output) => ({
    ...output,
    velocity: {
      average: 5,
      sprints: [
        {
          id: '019a0000-0000-7000-8000-00000000f901',
          name: '第1回',
          start_on: '2026-09-07',
          end_on: '2026-09-20',
          extended_days: 0,
          points: 5,
          counted: true,
        },
      ],
    },
    epics: [
      {
        id: '019a0000-0000-7000-8000-00000000f902',
        title: '長い題のレイド'.repeat(8),
        due_on: null,
        points_done: 1,
        points_all: 4,
      },
    ],
  }));
  await page.getByRole('link', { name: '遠征の計画' }).click();
  await expect(page.locator('[data-velocity-average]')).toHaveText('5pt');
  await expect(page.getByText('先の遠征はありません')).toBeVisible();
  await expect(page.getByText('まだ遠征がありません')).toHaveCount(0);
  await expect(page.getByText('ベロシティも出ます')).toHaveCount(0);
  await expect(page.locator('[data-plan-epic]')).toHaveCount(1);
  await expect(page.locator('[data-plan-epic] td.is-num')).toHaveText('3');
  // ベロシティが出ていれば超過の項目は出るが、先の遠征が無いので 0
  await expect(page.locator('.page-head .tally div').filter({ hasText: '重量オーバー' }).locator('dd')).toHaveText('0');
});
