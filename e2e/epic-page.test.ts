// エピックの画面（/[slug]/w/[id]/epics/[epicId]）。木のエピックの題から開き、作成者、クリア報酬の段階と額、参加者、配下のストーリーを読む。
// seed のセッション（seed/sessions.ts）の Cookie で開く。あおば開発の管理者はミナト。
// seed の受託開発チームのエピック「ポイントの交換先を増やす」は、作成者がミナトで、報酬は中、参加者は2人
// （ミナト、ハルカ）、配下のストーリーは完了したタスク1件（2 ポイント）の「送料の割引にポイントを使える」。
// 読むだけで、seed の行は書き換えない（ほかのファイルと並べて走るため）。書き込み（参加する、参加をやめる、割り振り、報酬の変更）はテストで作った
// ワークスペースの中で行い、seed の画面での失敗の扱いは応答を差し替えて確かめる
import {
  epicDetail,
  epicPartyAssign,
  epicPartyLeave,
  epicRequesterUpdate,
  epicRewardUpdate,
  epicUpdate,
} from '../src/shared/operations/epic/index.ts';
import { memberList } from '../src/shared/operations/workspace/index.ts';
import { workspaceInfo } from '../src/shared/operations/workspace/workspace.ts';
import { expect, test } from './fixtures.ts';
import { createWorkspace, signIn, waitForResponses, watchViolations } from './helpers.ts';
import { failOperation, mockOperation, rewriteOperation } from './operations.ts';

const AOBA = { slug: 'aoba' };
const WORKSPACE = '/aoba/w/019a0000-0000-7000-8000-000000000401';
const EPIC_ID = '019a0000-0000-7000-8000-000000000b01';
const EPIC_TITLE = 'ポイントの交換先を増やす';
const STORY_TITLE = '送料の割引にポイントを使える';

test.use({ timezoneId: 'Asia/Tokyo' });

test.beforeEach(async ({ context, baseURL }) => {
  await signIn(context, baseURL, 'admin');
});

test('seed の受託開発チーム: 木のエピックの題から画面が開き、作成者、報酬の段階と額、参加者、配下のストーリーが出る', async ({
  page,
}) => {
  const collect = await watchViolations(page);
  await page.goto(WORKSPACE);
  await page.getByRole('link', { name: EPIC_TITLE, exact: true }).click();

  await expect(page).toHaveURL(`${WORKSPACE}/epics/${EPIC_ID}`);
  await expect(page.getByRole('heading', { level: 1, name: EPIC_TITLE })).toBeVisible();
  await expect(page).toHaveTitle(`${EPIC_TITLE} - Scrum Guild`);
  await expect(page.locator('.page-eyebrow')).toHaveText('エピック・追加案件');
  // 概要。本文はエピックの欄
  await expect(page.getByText('貯まったポイントを、送料の割引と提携先の商品券に交換できるようにする。')).toBeVisible();

  // 概要。作成者、報酬の段階と額、期日、区分
  const request = page.getByRole('region', { name: '概要' });
  await expect(request.locator('dt')).toHaveText(['作成者', 'クリア報酬', '期日', '区分']);
  await expect(request.locator('dd').nth(0)).toContainText('ミナト');
  await expect(request.locator('dd').nth(0)).not.toContainText('離脱済み');
  await expect(request.locator('.tier')).toHaveText('中 · 300 XP');
  await expect(request.locator('.tier')).toHaveClass(/is-medium/);
  // 先頭にクリア報酬のアイコン（chest）。段階の色を受けるので is-xp は付けず、読み上げから外す
  const rewardIcon = request.locator('.tier > svg.ico');
  await expect(rewardIcon.locator('use')).toHaveAttribute('href', '#i-chest');
  await expect(rewardIcon).toHaveAttribute('aria-hidden', 'true');
  await expect(rewardIcon).not.toHaveClass(/\bis-xp\b/);
  await expect(request.locator('dd').nth(3)).toContainText('追加案件');
  await expect(request.locator('dd').nth(2)).toContainText('11/27');

  // 参加者。入った順で、作成者に印、全員にレベルの紋章。経験値の数値は出さない
  const party = page.getByRole('region', { name: '参加者' });
  await expect(party.locator('.panel-title')).toContainText('2 人');
  const members = party.locator('.party-list > li');
  await expect(members).toHaveCount(2);
  await expect(members.nth(0)).toContainText('ミナト');
  await expect(members.nth(0).locator('.role')).toHaveText('作成者');
  await expect(members.nth(1)).toContainText('ハルカ');
  await expect(members.nth(1).locator('.role')).toHaveCount(0);
  await expect(members.nth(1)).not.toContainText('離脱済み');
  for (const member of await members.all()) {
    await expect(member.locator('.emblem')).toHaveAttribute('aria-label', /^レベル \d+$/);
  }
  await expect(party.getByText('参加者はまだいません')).toHaveCount(0);

  // 配下のストーリー。完了したタスクだけなので、完了 / 全体のポイントが同じ
  const stories = page.getByRole('region', { name: '配下のストーリー' });
  await expect(stories.getByRole('heading', { level: 3, name: STORY_TITLE })).toBeVisible();
  await expect(stories.locator('.progress-num')).toHaveText('2 / 2 pt');
  await expect(stories.getByRole('img', { name: '完了 2 / 2 ポイント' })).toBeVisible();
  // 頭の集計
  await expect(page.locator('.tally > div')).toHaveText(['完了のポイント 2', '残りのポイント 0', '参加者 2']);

  // 作成者でリーダーのミナトは参加者にいるので、参加者の面の下に「参加をやめる」と「参加者に割り振る」、
  // 「クリア報酬を変える」、リーダーだけの「作成者を替える」が出る。クリア、中止はまだ出さない。直す口は見出しの横のボタン
  await expect(party.getByRole('button', { name: '参加をやめる' })).toBeVisible();
  await expect(party.getByRole('button', { name: '参加する' })).toHaveCount(0);
  await expect(party.getByRole('button', { name: '参加者に割り振る' })).toBeVisible();
  await expect(party.getByRole('button', { name: 'クリア報酬を変える' })).toBeVisible();
  await expect(party.getByRole('button', { name: '作成者を替える' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'エピックを完了にする' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'エピックを直す' })).toBeVisible();

  // バックログへ戻る
  await page.getByRole('link', { name: 'バックログへ戻る' }).click();
  await expect(page).toHaveURL(WORKSPACE);
  await expect(page.getByRole('heading', { level: 1, name: 'バックログ' })).toBeVisible();
  expect(await collect()).toEqual([]);
});

test('スクラムの言葉: 参加者が空で配下も無いエピックは、空の案内を出す。作った人が作成者で、報酬は中', async ({
  page,
}) => {
  await createWorkspace(page, 'エピック画面のワークスペース');
  await page.getByRole('button', { name: 'エピックを作る' }).click();
  const dialog = page.getByRole('dialog', { name: 'エピックを作る' });
  await dialog.getByLabel('タイトル').fill('決済の障害を減らす');
  const reloaded = waitForResponses(page, '/backlog-tree');
  await dialog.getByRole('button', { name: '作る' }).click();
  await expect(dialog).toBeHidden();
  await reloaded;
  await page.getByRole('link', { name: '決済の障害を減らす', exact: true }).click();

  await expect(page.getByRole('heading', { level: 1, name: '決済の障害を減らす' })).toBeVisible();
  await expect(page.locator('.page-eyebrow')).toHaveText('エピック');
  const request = page.getByRole('region', { name: '概要' });
  await expect(request.locator('dt')).toHaveText(['作成者', 'クリア報酬', '期日', '区分']);
  await expect(request.locator('dd').nth(0)).toContainText('ミナト');
  await expect(request.locator('.tier')).toHaveText('中 · 300 XP');
  await expect(request.locator('dd').nth(2)).toHaveText('—');
  await expect(request.locator('dd').nth(3)).toHaveText('区分なし');

  const party = page.getByRole('region', { name: '参加者' });
  await expect(party.locator('.panel-title')).toContainText('0 人');
  await expect(party.getByText('参加者はまだいません。')).toBeVisible();
  await expect(party.locator('.party-list')).toHaveCount(0);
  const stories = page.getByRole('region', { name: '配下のストーリー' });
  await expect(stories.getByText('ストーリーはまだありません')).toBeVisible();
  await expect(page.locator('.tally > div')).toHaveText(['完了のポイント 0', '残りのポイント 0', '参加者 0']);
});

test('作ったワークスペース: 参加するで参加者に加わり、参加をやめられる。割り振りのダイアログで、参加者にいない人を割り振れる', async ({
  page,
}) => {
  const collect = await watchViolations(page);
  await createWorkspace(page, '参加者のワークスペース');
  await page.getByRole('button', { name: 'エピックを作る' }).click();
  const create = page.getByRole('dialog', { name: 'エピックを作る' });
  await create.getByLabel('タイトル').fill('会員ランクを公開する');
  const reloaded = waitForResponses(page, '/backlog-tree');
  await create.getByRole('button', { name: '作る' }).click();
  await expect(create).toBeHidden();
  await reloaded;
  await page.getByRole('link', { name: '会員ランクを公開する', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: '会員ランクを公開する' })).toBeVisible();

  const party = page.getByRole('region', { name: '参加者' });
  const toast = page.locator('.toasts:visible .toast');
  await expect(party.getByText('参加者はまだいません。')).toBeVisible();

  // 参加する（主ボタン）。加わると、同じ位置のボタンが「参加をやめる」に替わり、フォーカスが残る
  const accept = party.getByRole('button', { name: '参加する' });
  await expect(accept).toHaveClass(/is-primary/);
  await accept.click();
  await expect(toast.last()).toHaveText('エピックに参加しました');
  await expect(party.locator('.party-list > li')).toHaveCount(1);
  await expect(party.locator('.party-list > li').first()).toContainText('ミナト');
  await expect(party.locator('.panel-title')).toContainText('1 人');
  await expect(page.locator('.tally > div').nth(2)).toHaveText('参加者 1');
  const leave = party.getByRole('button', { name: '参加をやめる' });
  await expect(leave).toBeFocused();
  await expect(leave).not.toHaveClass(/is-primary/);

  // 抜ける
  await leave.click();
  await expect(toast.last()).toHaveText('参加者から抜けました');
  await expect(party.getByText('参加者はまだいません。')).toBeVisible();
  await expect(party.getByRole('button', { name: '参加する' })).toBeFocused();

  // 割り振る。候補は今所属していて参加者にいない人（作ったワークスペースにはミナトだけ）
  const opener = party.getByRole('button', { name: '参加者に割り振る' });
  await opener.click();
  const dialog = page.getByRole('dialog', { name: '参加者に割り振る' });
  const select = dialog.getByLabel('割り振る人');
  await expect(select.locator('option')).toHaveText(['ミナト']);
  await expect(select).toBeFocused();
  await expect(dialog.getByText('ワークスペースに今所属していて、まだ参加者にいない人から選びます。')).toBeVisible();
  await dialog.getByRole('button', { name: '割り振る' }).click();
  await expect(dialog).toBeHidden();
  await expect(toast.last()).toHaveText('「ミナト」を参加者に割り振りました');
  await expect(party.locator('.party-list > li')).toHaveCount(1);
  await expect(party.getByRole('button', { name: '参加をやめる' })).toBeVisible();

  // 全員が参加者にいれば、候補が無いことを欄の説明に出し、常に置いた読み上げの領域にも同じ文を入れる。「割り振る」は押せない
  await opener.click();
  const noCandidates = '割り振れる人がいません。ワークスペースの全員が参加者にいます。';
  await expect(dialog.locator('.field-hint')).toHaveText(noCandidates);
  // 前の割り振りのトースト（role="status"）がまだ残っていることがあるので、文で絞る
  await expect(dialog.getByRole('status').filter({ hasText: noCandidates })).toHaveCount(1);
  await expect(dialog.getByRole('button', { name: '割り振る' })).toHaveAttribute('aria-disabled', 'true');
  await dialog.getByRole('button', { name: 'やめる' }).click();
  await expect(dialog).toBeHidden();
  expect(await collect()).toEqual([]);
});

test('参加するとやめるの失敗はトーストで知らせ、割り振りの失敗はダイアログの中に理由を出す（応答を差し替えて確かめる）', async ({
  page,
}) => {
  await page.goto(`${WORKSPACE}/epics/${EPIC_ID}`);
  const party = page.getByRole('region', { name: '参加者' });
  await expect(party.locator('.party-list > li')).toHaveCount(2);

  // 抜ける前にエピックが終わっていた（409 の conflict）。参加者は変わらない
  await failOperation(page, epicPartyLeave, AOBA, 409, 'conflict');
  await party.getByRole('button', { name: '参加をやめる' }).click();
  await expect(page.locator('.toasts:visible .toast').last()).toHaveText(
    'このエピックは終わっているので、参加者を変えられません',
  );
  await expect(party.locator('.party-list > li')).toHaveCount(2);

  // 何も書かなかった（別の画面で先に抜けていた）ときは、抜けたとは言わず、もう変わっていたことを知らせる
  const unmockLeave = await mockOperation(page, epicPartyLeave, AOBA, { changed: false });
  await party.getByRole('button', { name: '参加をやめる' }).click();
  await expect(page.locator('.toasts:visible .toast').last()).toHaveText(
    '参加者はもう変わっていました。最新の内容を表示しています',
  );
  await unmockLeave();

  // 所属していない（403）ときは、もう一度試すようには書かない
  await failOperation(page, epicPartyLeave, AOBA, 403, 'forbidden');
  await party.getByRole('button', { name: '参加をやめる' }).click();
  await expect(page.locator('.toasts:visible .toast').last()).toHaveText(
    'このワークスペースに所属していないため、参加者を変えられません',
  );

  // 割り振りの候補に、参加者にいない架空の人を足し、送ると所属を外れていた（404）
  await rewriteOperation(page, memberList, AOBA, (output) => ({
    ...output,
    members: [
      ...output.members,
      {
        id: '019a0000-0000-7000-8000-00000000fff1',
        name: '仮置き 太郎',
        role: 'member' as const,
        joined_on: '2026-10-01',
        avatar_url: null,
        level: 1,
      },
    ],
  }));
  await failOperation(page, epicPartyAssign, AOBA, 404, 'not_found');
  await party.getByRole('button', { name: '参加者に割り振る' }).click();
  const dialog = page.getByRole('dialog', { name: '参加者に割り振る' });
  const select = dialog.getByLabel('割り振る人');
  await expect(select.locator('option')).toHaveText(['仮置き 太郎']);
  await dialog.getByRole('button', { name: '割り振る' }).click();
  await expect(dialog.getByRole('alert')).toHaveText(
    '選んだ人はワークスペースに所属していないか、エピックが見つかりません。選び直してください。',
  );
  await expect(select).toBeFocused();
  await dialog.getByRole('button', { name: 'やめる' }).click();
  await expect(dialog).toBeHidden();
});

test('作ったワークスペース: クリア報酬の段階を額つきのラジオで選んで変えられる。作成者を替える候補は今の作成者を除く', async ({
  page,
}) => {
  const collect = await watchViolations(page);
  await createWorkspace(page, '報酬のワークスペース');
  await page.getByRole('button', { name: 'エピックを作る' }).click();
  const create = page.getByRole('dialog', { name: 'エピックを作る' });
  await create.getByLabel('タイトル').fill('会員ランクを公開する');
  const reloaded = waitForResponses(page, '/backlog-tree');
  await create.getByRole('button', { name: '作る' }).click();
  await expect(create).toBeHidden();
  await reloaded;
  await page.getByRole('link', { name: '会員ランクを公開する', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: '会員ランクを公開する' })).toBeVisible();

  const request = page.getByRole('region', { name: '概要' });
  const party = page.getByRole('region', { name: '参加者' });
  const toast = page.locator('.toasts:visible .toast');
  await expect(request.locator('.tier')).toHaveText('中 · 300 XP');

  // 小、中、大を額つきで選ぶ。開いたときは今の段階（中）が選ばれ、そのままでは「変える」は押せない
  await party.getByRole('button', { name: 'クリア報酬を変える' }).click();
  const dialog = page.getByRole('dialog', { name: 'クリア報酬を変える' });
  await expect(dialog.getByRole('radiogroup', { name: 'クリア報酬の段階' })).toBeVisible();
  await expect(dialog.getByRole('radio')).toHaveCount(3);
  await expect(dialog.getByRole('radio', { name: '小 · 100 XP' })).not.toBeChecked();
  await expect(dialog.getByRole('radio', { name: '中 · 300 XP' })).toBeChecked();
  await expect(dialog.getByRole('radio', { name: '大 · 600 XP' })).not.toBeChecked();
  const submit = dialog.getByRole('button', { name: '変える' });
  await expect(submit).toHaveAttribute('aria-disabled', 'true');
  // 説明は常に出し、今の段階のままのときだけ、押せない理由が別の文として加わる
  await expect(dialog.locator('.field-hint')).toHaveText([
    'クリア報酬は、完了にした時点の参加者全員に同じ額が入ります。',
    '今の段階です。別の段階を選ぶと変えられます。',
  ]);

  await dialog.getByRole('radio', { name: '大 · 600 XP' }).check();
  await expect(submit).not.toHaveAttribute('aria-disabled', 'true');
  await expect(dialog.locator('.field-hint')).toHaveText([
    'クリア報酬は、完了にした時点の参加者全員に同じ額が入ります。',
  ]);
  await submit.click();
  await expect(dialog).toBeHidden();
  await expect(toast.last()).toHaveText('クリア報酬を「大」に変えました');
  await expect(request.locator('.tier')).toHaveText('大 · 600 XP');
  await expect(request.locator('.tier')).toHaveClass(/is-large/);

  // 作成者を替える。作ったワークスペースには今の作成者（ミナト）だけなので、候補は無く、「替える」は押せない
  await party.getByRole('button', { name: '作成者を替える' }).click();
  const requesterDialog = page.getByRole('dialog', { name: '作成者を替える' });
  const noCandidates = '替えられる人がいません。ワークスペースに、今の作成者のほかに所属している人がいません。';
  await expect(requesterDialog.locator('.field-hint')).toHaveText(noCandidates);
  await expect(requesterDialog.getByLabel('新しい作成者').locator('option')).toHaveCount(0);
  await expect(requesterDialog.getByRole('button', { name: '替える' })).toHaveAttribute('aria-disabled', 'true');
  await requesterDialog.getByRole('button', { name: 'やめる' }).click();
  await expect(requesterDialog).toBeHidden();
  expect(await collect()).toEqual([]);
});

test('クリア報酬の変更と作成者の変更の失敗と成功を、ダイアログとトーストで知らせる（応答を差し替えて確かめる）', async ({
  page,
}) => {
  await page.goto(`${WORKSPACE}/epics/${EPIC_ID}`);
  const party = page.getByRole('region', { name: '参加者' });
  const request = page.getByRole('region', { name: '概要' });
  const toast = page.locator('.toasts:visible .toast');
  await expect(request.locator('.tier')).toHaveText('中 · 300 XP');

  // 報酬の変更が 403（権限を失った）。理由をダイアログの中に出し、閉じたときに画面を読み直す
  await failOperation(page, epicRewardUpdate, AOBA, 403, 'forbidden');
  await party.getByRole('button', { name: 'クリア報酬を変える' }).click();
  const rewardDialog = page.getByRole('dialog', { name: 'クリア報酬を変える' });
  await rewardDialog.getByRole('radio', { name: '小 · 100 XP' }).check();
  await rewardDialog.getByRole('button', { name: '変える' }).click();
  await expect(rewardDialog.getByRole('alert')).toHaveText('クリア報酬を変えられるのは、作成者とリーダーだけです');
  await rewardDialog.getByRole('button', { name: 'やめる' }).click();
  await expect(rewardDialog).toBeHidden();

  // 終わったエピック（409 の conflict）
  await page.unrouteAll();
  await failOperation(page, epicRewardUpdate, AOBA, 409, 'conflict');
  await party.getByRole('button', { name: 'クリア報酬を変える' }).click();
  await rewardDialog.getByRole('radio', { name: '大 · 600 XP' }).check();
  await rewardDialog.getByRole('button', { name: '変える' }).click();
  await expect(rewardDialog.getByRole('alert')).toHaveText(
    'このエピックは終わっているので、クリア報酬を変えられません',
  );
  await rewardDialog.getByRole('button', { name: 'やめる' }).click();
  await expect(rewardDialog).toBeHidden();
  await page.unrouteAll();

  // 終了したワークスペース（409 の workspace_closed）。辞書の {workspace} を置き換えた文が出る
  await failOperation(page, epicRewardUpdate, AOBA, 409, 'workspace_closed');
  await party.getByRole('button', { name: 'クリア報酬を変える' }).click();
  await rewardDialog.getByRole('radio', { name: '大 · 600 XP' }).check();
  await rewardDialog.getByRole('button', { name: '変える' }).click();
  await expect(rewardDialog.getByRole('alert')).toHaveText('終了したワークスペースには書き込めません');
  await rewardDialog.getByRole('button', { name: 'やめる' }).click();
  await expect(rewardDialog).toBeHidden();
  await page.unrouteAll();

  // 作成者の候補に、今の作成者（ミナト）は出ない。架空の人を足し、替えられた知らせを出す
  await rewriteOperation(page, memberList, AOBA, (output) => ({
    ...output,
    members: [
      ...output.members,
      {
        id: '019a0000-0000-7000-8000-00000000fff1',
        name: '仮置き 太郎',
        role: 'member' as const,
        joined_on: '2026-10-01',
        avatar_url: null,
        level: 1,
      },
    ],
  }));
  await page.reload();
  await party.getByRole('button', { name: '作成者を替える' }).click();
  const dialog = page.getByRole('dialog', { name: '作成者を替える' });
  const select = dialog.getByLabel('新しい作成者');
  await expect(select.locator('option', { hasText: '仮置き 太郎' })).toHaveCount(1);
  await expect(select.locator('option', { hasText: 'ミナト' })).toHaveCount(0);
  await expect(select).toBeFocused();

  // 選んだ人が所属を外れていた（404）。理由を出し、候補を選び直せる
  const unfailRequester = await failOperation(page, epicRequesterUpdate, AOBA, 404, 'not_found');
  await select.selectOption({ label: '仮置き 太郎' });
  await dialog.getByRole('button', { name: '替える' }).click();
  await expect(dialog.getByRole('alert')).toHaveText(
    '選んだ人はワークスペースに所属していないか、エピックが見つかりません。選び直してください。',
  );
  await expect(select).toBeFocused();
  await unfailRequester();

  // 替えられた
  await mockOperation(page, epicRequesterUpdate, AOBA, {
    changed: true,
    requester: { id: '019a0000-0000-7000-8000-00000000fff1', name: '仮置き 太郎', left: false },
  });
  await dialog.getByRole('button', { name: '替える' }).click();
  await expect(dialog).toBeHidden();
  await expect(toast.last()).toHaveText('作成者を「仮置き 太郎」に替えました');
});

test('作成者の一般のメンバーには「クリア報酬を変える」だけを出し、「作成者を替える」は出さない（応答を差し替えて確かめる）', async ({
  page,
}) => {
  await rewriteOperation(page, epicDetail, AOBA, (output) => ({ ...output, can_change_requester: false }));
  await page.goto(`${WORKSPACE}/epics/${EPIC_ID}`);
  const party = page.getByRole('region', { name: '参加者' });
  await expect(party.getByRole('button', { name: 'クリア報酬を変える' })).toBeVisible();
  await expect(party.getByRole('button', { name: '作成者を替える' })).toHaveCount(0);

  await page.unrouteAll();
  await rewriteOperation(page, epicDetail, AOBA, (output) => ({
    ...output,
    can_manage: false,
    can_change_requester: false,
  }));
  await page.goto(`${WORKSPACE}/epics/${EPIC_ID}`);
  await expect(party.getByRole('button', { name: 'クリア報酬を変える' })).toHaveCount(0);
  await expect(party.getByRole('button', { name: '作成者を替える' })).toHaveCount(0);
});

// 離脱済みの本物の行は、DB の seed に置けない（所属の無いユーザーは運用者の指名し直しが物理削除する）。API の確かめは test/epic-detail.test.ts
test('参加者に入れる人でなくなっていても、参加者にいれば「参加をやめる」を出す（応答を差し替えて確かめる）', async ({
  page,
}) => {
  await rewriteOperation(page, epicDetail, AOBA, (output) => ({ ...output, can_join: false, joined: true }));
  await page.goto(`${WORKSPACE}/epics/${EPIC_ID}`);
  const party = page.getByRole('region', { name: '参加者' });
  await expect(party.getByRole('button', { name: '参加をやめる' })).toBeVisible();
  await expect(party.getByRole('button', { name: '参加する' })).toHaveCount(0);

  // 入れる人でなく、参加者にもいなければ、参加するも参加をやめるも出さない
  await page.unrouteAll();
  await rewriteOperation(page, epicDetail, AOBA, (output) => ({ ...output, can_join: false, joined: false }));
  await page.goto(`${WORKSPACE}/epics/${EPIC_ID}`);
  await expect(party.locator('.party-list > li')).toHaveCount(2);
  await expect(party.getByRole('button', { name: /参加をやめる|参加する/ })).toHaveCount(0);
});

test('作成者と参加者の人がワークスペースを離れていると、名前に「（離脱済み）」と出る（応答を差し替えて確かめる）', async ({
  page,
}) => {
  await rewriteOperation(page, epicDetail, AOBA, (output) => ({
    ...output,
    requester: { ...output.requester, left: true },
    party: output.party.map((member, index) => (index === 1 ? { ...member, left: true } : member)),
  }));
  await page.goto(`${WORKSPACE}/epics/${EPIC_ID}`);
  const request = page.getByRole('region', { name: '概要' });
  await expect(request.locator('dd').nth(0)).toContainText('ミナト（離脱済み）');
  const members = page.getByRole('region', { name: '参加者' }).locator('.party-list > li');
  await expect(members.nth(0)).not.toContainText('離脱済み');
  await expect(members.nth(1)).toContainText('ハルカ（離脱済み）');
});

test('進行中のエピックは報酬が入る注記、完了は過去形、中止したエピックは入らない注記を出す', async ({ page }) => {
  const request = page.getByRole('region', { name: '概要' });
  await page.goto(`${WORKSPACE}/epics/${EPIC_ID}`);
  await expect(request.locator('.panel-note')).toHaveText(
    'クリア報酬は、完了にした時点の参加者全員に同じ額が入ります。',
  );

  await rewriteOperation(page, epicDetail, AOBA, (output) => ({
    ...output,
    epic: { ...output.epic, completed_at: '2026-10-22T00:00:00.000Z' },
  }));
  await page.goto(`${WORKSPACE}/epics/${EPIC_ID}`);
  await expect(request.locator('.panel-note')).toHaveText(
    'クリア報酬は、完了にした時点の参加者全員に同じ額が入りました。',
  );
  // 終わったエピックの参加者は変えないので、参加する、参加をやめる、割り振りは出さない
  const party = page.getByRole('region', { name: '参加者' });
  await expect(party.locator('.party-list > li')).toHaveCount(2);
  await expect(party.getByRole('button')).toHaveCount(0);

  await page.unrouteAll();
  await rewriteOperation(page, epicDetail, AOBA, (output) => ({
    ...output,
    epic: { ...output.epic, canceled_at: '2026-10-22T00:00:00.000Z' },
  }));
  await page.goto(`${WORKSPACE}/epics/${EPIC_ID}`);
  await expect(request.locator('.panel-note')).toHaveText('中止したので、クリア報酬は参加者に入りません。');
});

test('直した後の読み直しが失敗したら、前の値を残して知らせだけを出す', async ({ page }) => {
  await page.goto(`${WORKSPACE}/epics/${EPIC_ID}`);
  await expect(page.getByRole('heading', { level: 1, name: EPIC_TITLE })).toBeVisible();
  await page.getByRole('button', { name: 'エピックを直す' }).click();
  const dialog = page.getByRole('dialog', { name: 'エピック' });
  await expect(dialog.getByLabel('タイトル')).toHaveValue(EPIC_TITLE);
  // 保存は通さず（seed を書き換えない）、読み直しだけが失敗する形にする
  await mockOperation(page, epicUpdate, AOBA, {
    epic: {
      id: EPIC_ID,
      title: EPIC_TITLE,
      body_md: '読み直しに失敗する本文',
      due_on: null,
      link_url: null,
      category_id: null,
    },
  });
  await failOperation(page, epicDetail, AOBA, 500, 'internal');
  await dialog.getByLabel('本文').fill('読み直しに失敗する本文');
  await dialog.getByRole('button', { name: '保存する' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('alert').filter({ hasText: '最新の内容を読み込めませんでした' })).toBeVisible();
  // 画面は読み込みの失敗に替わらず、前の値のまま
  await expect(page.getByRole('heading', { level: 1, name: EPIC_TITLE })).toBeVisible();
  await expect(page.getByRole('region', { name: '参加者' }).locator('.party-list > li')).toHaveCount(2);
});

test('終了したワークスペースでも読めて、直す口と参加者の操作は出さない', async ({ page }) => {
  await rewriteOperation(page, workspaceInfo, AOBA, (output) => ({
    ...output,
    closed_at: '2026-10-20T00:00:00.000Z',
  }));
  await page.goto(`${WORKSPACE}/epics/${EPIC_ID}`);
  await expect(page.getByRole('heading', { level: 1, name: EPIC_TITLE })).toBeVisible();
  await expect(page.getByRole('region', { name: '参加者' }).locator('.party-list > li')).toHaveCount(2);
  await expect(page.getByRole('region', { name: '配下のストーリー' }).locator('.story-block')).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'エピックを直す' })).toHaveCount(0);
  await expect(page.getByRole('region', { name: '参加者' }).getByRole('button')).toHaveCount(0);
});

test('無いエピック（別のワークスペース、存在しない ID、形の合わない ID）は、見つからない画面とバックログへ戻るリンクを出す', async ({
  page,
}) => {
  for (const id of ['019a0000-0000-7000-8000-00000000ffff', 'not-an-id']) {
    await page.goto(`${WORKSPACE}/epics/${id}`);
    await expect(page.getByRole('heading', { level: 1, name: 'エピックが見つかりません' })).toBeVisible();
    await expect(page.getByText('削除されたか、このワークスペースにないエピックです。')).toBeVisible();
    await page.getByRole('link', { name: 'バックログへ戻る' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'バックログ' })).toBeVisible();
  }
});

test('読み込めなかったときは失敗の画面と「もう一度試す」を出す', async ({ page }) => {
  await failOperation(page, epicDetail, AOBA, 500, 'internal');
  await page.goto(`${WORKSPACE}/epics/${EPIC_ID}`);
  await expect(page.getByText('読み込めませんでした').first()).toBeVisible();
  const retry = page.getByRole('button', { name: 'もう一度試す' });
  await expect(retry).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: EPIC_TITLE })).toHaveCount(0);
});
