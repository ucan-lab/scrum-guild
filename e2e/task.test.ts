// 一本道: 管理者がワークスペースを作る → タスクを作る → 完了にする → その行に完了の印 → 読み直すと折りたたみの件数が 1。
// seed のセッション（seed/sessions.ts）の Cookie で開く。あおば開発の管理者はミナト。CSP の違反も確かめる
import { expect, test, type Page } from '@playwright/test';
import { signIn, watchViolations } from './helpers.ts';

test.use({ timezoneId: 'Asia/Tokyo' });

test.beforeEach(async ({ context, baseURL }) => {
  await signIn(context, baseURL, 'admin');
});

// 管理の画面から、自分をリーダーにワークスペースを作り、その画面へ移る
async function createWorkspace(page: Page, name: string, vocabulary: 'game' | 'scrum'): Promise<void> {
  await page.goto('/aoba/admin');
  await page.getByRole('button', { name: 'パーティを作る' }).first().click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('combobox')).toBeEnabled();
  await dialog.getByRole('radio', { name: vocabulary === 'game' ? /ゲームの言葉/ : /スクラムの言葉/ }).check();
  await dialog.getByLabel('名前').fill(name);
  await dialog.getByRole('button', { name: '作る' }).click();
  await expect(page).toHaveURL(/\/aoba\/w\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
}

test('ゲームの言葉: タスクを作って完了にすると、その行に完了の印が出て、読み直すと折りたたみの件数に入る', async ({
  page,
}) => {
  const collect = await watchViolations(page);
  await createWorkspace(page, '一本道パーティ', 'game');

  // タスクが無いうちは、最初の一歩を示す
  await expect(page.getByText('まだクエストがありません')).toBeVisible();

  await page.getByRole('button', { name: '依頼を出す' }).click();
  const dialog = page.getByRole('dialog', { name: '依頼を出す' });
  await dialog.getByLabel('タイトル').fill('  見積もりを送る  ');
  await dialog.getByRole('radio', { name: '3', exact: true }).check();
  await dialog.getByRole('button', { name: '依頼を出す' }).click();
  await expect(dialog).toBeHidden();
  // ダイアログの中の閉じた領域には、トーストが見えない形で出るので、role で見える領域だけを引く
  await expect(page.getByRole('status').filter({ hasText: '掲示板の末尾に足しました' })).toBeVisible();

  // 読み直さずに、一覧の末尾に出る。ポイントも出る
  const row = page.locator('.entry', { hasText: '見積もりを送る' });
  await expect(row).toHaveCount(1);
  await expect(row.locator('.pts')).toHaveText('3');
  await expect(page.locator('.tree-folded')).toHaveCount(0);

  // 完了にする。ボタンは完了の印に替わり、フォーカスは印へ移る。行はその場に残る
  await row.getByRole('button', { name: /完遂にする/ }).click();
  const stamp = row.getByRole('img', { name: '完遂' });
  await expect(stamp).toBeVisible();
  await expect(stamp).toBeFocused();
  await expect(row.getByRole('button', { name: /完遂にする/ })).toHaveCount(0);
  await expect(page.getByRole('status').filter({ hasText: 'クエストを完遂にしました' })).toBeVisible();
  // 読み直すまで、折りたたみの件数には入らない
  await expect(page.locator('.tree-folded')).toHaveCount(0);

  // 読み直すと、行は一覧から外れ、親のない完了の件数に入る
  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: '一本道パーティ' })).toBeVisible();
  await expect(page.locator('.entry')).toHaveCount(0);
  await expect(page.locator('.tree-folded.is-root')).toHaveText('親のない完遂 1 件を折りたたんでいます');
  expect(await collect()).toEqual([]);
});

test('スクラムの言葉: 同じ流れで、言葉がスクラムの言葉になる。ポイントを選ばないと未見積もり', async ({ page }) => {
  const collect = await watchViolations(page);
  await createWorkspace(page, '一本道チーム', 'scrum');
  await expect(page.getByText('まだタスクがありません')).toBeVisible();

  await page.getByRole('button', { name: '起票' }).click();
  const dialog = page.getByRole('dialog', { name: '起票' });
  await expect(dialog.getByText(/1 以上のポイントが振られたままタスクが完了すると付きます/)).toBeVisible();
  // 空のタイトルは送らずに知らせる
  await dialog.getByRole('button', { name: '起票' }).click();
  await expect(dialog.getByText('タイトルを入れてください')).toBeVisible();
  await dialog.getByLabel('タイトル').fill('請求書を出す');
  await dialog.getByRole('button', { name: '起票' }).click();
  await expect(dialog).toBeHidden();

  const row = page.locator('.entry', { hasText: '請求書を出す' });
  await expect(row.locator('.pts')).toHaveText('未');
  await row.getByRole('button', { name: /完了にする/ }).click();
  await expect(row.getByRole('img', { name: '完了' })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'タスクを完了にしました' })).toBeVisible();

  await page.reload();
  await expect(page.locator('.tree-folded.is-root')).toHaveText('親のない完了 1 件を折りたたんでいます');
  expect(await collect()).toEqual([]);
});
