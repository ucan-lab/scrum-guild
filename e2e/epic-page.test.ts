// エピックの画面（/[slug]/w/[id]/epics/[epicId]）。木のエピックの題から開き、依頼主、クリア報酬の段階と額、討伐隊、配下のストーリーを読む。
// seed のセッション（seed/sessions.ts）の Cookie で開く。あおば開発の管理者はミナト。
// seed の受託開発チーム（ゲームの言葉）のエピック「ポイントの交換先を増やす」は、依頼主がミナトで、報酬は中、討伐隊は3人
// （ミナト、ハルカ、所属の無いユイ）、配下のストーリーは完了したタスク1件（2 ポイント）の「送料の割引にポイントを使える」。
// 読むだけで、seed の行は書き換えない（ほかのファイルと並べて走るため）。書き込みはテストで作ったワークスペースの中で行う
import { epicDetail } from '../src/shared/operations/epic/index.ts';
import { workspaceInfo } from '../src/shared/operations/workspace/workspace.ts';
import { expect, test } from './fixtures.ts';
import { createWorkspace, signIn, waitForResponses, watchViolations } from './helpers.ts';
import { failOperation, rewriteOperation } from './operations.ts';

const AOBA = { slug: 'aoba' };
const WORKSPACE = '/aoba/w/019a0000-0000-7000-8000-000000000401';
const EPIC_ID = '019a0000-0000-7000-8000-000000000b01';
const EPIC_TITLE = 'ポイントの交換先を増やす';
const STORY_TITLE = '送料の割引にポイントを使える';

test.use({ timezoneId: 'Asia/Tokyo' });

test.beforeEach(async ({ context, baseURL }) => {
  await signIn(context, baseURL, 'admin');
});

test('ゲームの言葉: 木のエピックの題から画面が開き、依頼主、報酬の段階と額、討伐隊、配下のストーリーが出る', async ({
  page,
}) => {
  const collect = await watchViolations(page);
  await page.goto(WORKSPACE);
  await page.getByRole('link', { name: EPIC_TITLE, exact: true }).click();

  await expect(page).toHaveURL(`${WORKSPACE}/epics/${EPIC_ID}`);
  await expect(page.getByRole('heading', { level: 1, name: EPIC_TITLE })).toBeVisible();
  await expect(page).toHaveTitle(`${EPIC_TITLE} - Scrum Guild`);
  await expect(page.locator('.page-eyebrow')).toHaveText('レイド・追加案件');
  // 概要。本文はエピックの欄
  await expect(page.getByText('貯まったポイントを、送料の割引と提携先の商品券に交換できるようにする。')).toBeVisible();

  // 依頼書。依頼主、報酬の段階と額、期日、区分
  const request = page.getByRole('region', { name: '依頼書' });
  await expect(request.locator('dt')).toHaveText(['依頼主', 'クリア報酬', '期限', '系統']);
  await expect(request.locator('dd').nth(0)).toContainText('ミナト');
  await expect(request.locator('dd').nth(0)).not.toContainText('離脱済み');
  await expect(request.locator('.tier')).toHaveText('中 · 300 XP');
  await expect(request.locator('.tier')).toHaveClass(/is-medium/);
  await expect(request.locator('dd').nth(3)).toContainText('追加案件');
  await expect(request.locator('dd').nth(2)).toContainText('11/27');

  // 討伐隊。入った順で、依頼主に印、所属の無いユイは「（離脱済み）」、全員にレベルの紋章。経験値の数値は出さない
  const party = page.getByRole('region', { name: '討伐隊' });
  await expect(party.locator('.panel-title')).toContainText('3 人');
  const members = party.locator('.party-list > li');
  await expect(members).toHaveCount(3);
  await expect(members.nth(0)).toContainText('ミナト');
  await expect(members.nth(0).locator('.role')).toHaveText('依頼主');
  await expect(members.nth(1)).toContainText('ハルカ');
  await expect(members.nth(1).locator('.role')).toHaveCount(0);
  await expect(members.nth(2)).toContainText('ユイ（離脱済み）');
  for (const member of await members.all()) {
    await expect(member.locator('.emblem')).toHaveAttribute('aria-label', /^レベル \d+$/);
  }
  await expect(party.getByText('まだ誰もいません')).toHaveCount(0);

  // 配下のストーリー。完了したタスクだけなので、完遂 / 全体のポイントが同じ
  const stories = page.getByRole('region', { name: '配下の達成目標' });
  await expect(stories.getByRole('heading', { level: 3, name: STORY_TITLE })).toBeVisible();
  await expect(stories.locator('.progress-num')).toHaveText('2 / 2 pt');
  await expect(stories.getByRole('img', { name: '完遂 2 / 2 難易度' })).toBeVisible();
  // 頭の集計
  await expect(page.locator('.tally > div')).toHaveText(['完遂の難易度 2', '残りの難易度 0', '討伐隊 3']);

  // 読むだけの版。受注、割り振り、報酬の変更、クリア、中止は出さない。直す口は見出しの横のボタンだけ
  await expect(page.getByRole('button', { name: '受注する' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'レイドをクリアする' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'レイドを直す' })).toBeVisible();

  // 掲示板へ戻る
  await page.getByRole('link', { name: '掲示板へ戻る' }).click();
  await expect(page).toHaveURL(WORKSPACE);
  await expect(page.getByRole('heading', { level: 1, name: '掲示板' })).toBeVisible();
  expect(await collect()).toEqual([]);
});

test('スクラムの言葉: 討伐隊が空で配下も無いエピックは、空の案内を出す。作った人が依頼主で、報酬は中', async ({
  page,
}) => {
  await createWorkspace(page, 'エピック画面のワークスペース', 'scrum');
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

test('依頼主がワークスペースを離れていると、依頼主の名前に「（離脱済み）」と出る', async ({ page }) => {
  await rewriteOperation(page, epicDetail, AOBA, (output) => ({
    ...output,
    requester: { ...output.requester, left: true },
  }));
  await page.goto(`${WORKSPACE}/epics/${EPIC_ID}`);
  const request = page.getByRole('region', { name: '依頼書' });
  await expect(request.locator('dd').nth(0)).toContainText('ミナト（離脱済み）');
});

test('終了したワークスペースでも読めて、直す口は出さない', async ({ page }) => {
  await rewriteOperation(page, workspaceInfo, AOBA, (output) => ({
    ...output,
    closed_at: '2026-10-20T00:00:00.000Z',
  }));
  await page.goto(`${WORKSPACE}/epics/${EPIC_ID}`);
  await expect(page.getByRole('heading', { level: 1, name: EPIC_TITLE })).toBeVisible();
  await expect(page.getByRole('region', { name: '討伐隊' }).locator('.party-list > li')).toHaveCount(3);
  await expect(page.getByRole('region', { name: '配下の達成目標' }).locator('.story-block')).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'レイドを直す' })).toHaveCount(0);
});

test('無いエピック（別のワークスペース、存在しない ID、形の合わない ID）は、見つからない画面とバックログへ戻るリンクを出す', async ({
  page,
}) => {
  for (const id of ['019a0000-0000-7000-8000-00000000ffff', 'not-an-id']) {
    await page.goto(`${WORKSPACE}/epics/${id}`);
    await expect(page.getByRole('heading', { level: 1, name: 'レイドが見つかりません' })).toBeVisible();
    await expect(page.getByText('削除されたか、このパーティにないレイドです。')).toBeVisible();
    await page.getByRole('link', { name: '掲示板へ戻る' }).click();
    await expect(page.getByRole('heading', { level: 1, name: '掲示板' })).toBeVisible();
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
