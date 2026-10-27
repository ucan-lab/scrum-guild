// 計画の画面: リーダーが先のスプリントを作り、直し（重なりは断られてダイアログに理由が出る）、削除する。
// 一般のメンバーには作成、変更、削除のボタンが出ない。スプリントが無いワークスペースでは空の状態が出る。
// seed のセッション（seed/sessions.ts）の Cookie で開く。あおば開発の管理者はミナト（ひばり工房では一般のユーザー）、一般のユーザーはハルカ
import { expect, test } from './fixtures.ts';
import { createWorkspace, signIn, watchViolations } from './helpers.ts';

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

test('一般のメンバーには、遠征が並ぶが、作成、変更、削除のボタンが出ない', async ({ page, context, baseURL }) => {
  await signIn(context, baseURL, 'member');
  await page.goto(AOBA_TEAM);
  await expect(page.getByRole('heading', { level: 1, name: '遠征の計画' })).toBeVisible();
  await expect(page.locator('.lane-title')).toHaveText(['遠征 11/2〜11/15', '遠征 年末の仕上げ']);
  await expect(page.locator('.lane-sub').first()).toContainText('14 日');
  await expect(page.getByRole('button', { name: '遠征を作る' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^直す/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^削除する/ })).toHaveCount(0);
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
});
