// エピックとストーリーの削除: ダイアログの下の「この<エピック>を削除する」から、配下の件数と配下の扱い（残す、まとめて削除する）を
// 選ぶ確認を開き、削除したら木を読み直す。削除できない人には削除のボタンを出さない。
// seed のセッション（seed/sessions.ts）の Cookie で開く。あおば開発の管理者はミナト、一般のユーザーはハルカ。CSP の違反も確かめる
import { expect, test, type Page } from '@playwright/test';
import { createWorkspace, signIn, watchViolations } from './helpers.ts';

test.use({ timezoneId: 'Asia/Tokyo' });

// 題の行を自分の直下に持つ木の1件（エピックの中のストーリーで、エピックの方を拾わない）
function rowGroup(page: Page, title: string) {
  return page.locator(
    `xpath=//div[contains(@class, "tree-group")][./div[contains(@class, "tree-row")]//button[contains(@class, "tree-link") and normalize-space() = "${title}"]]`,
  );
}

async function create(page: Page, label: string, title: string): Promise<void> {
  await page.getByRole('button', { name: label }).click();
  const dialog = page.getByRole('dialog', { name: label });
  await dialog.getByLabel('タイトル').fill(title);
  await dialog.getByRole('button', { name: '作る' }).click();
  await expect(dialog).toBeHidden();
}

async function addTask(page: Page, storyTitle: string, title: string, createLabel: string): Promise<void> {
  await page.getByRole('button', { name: new RegExp(`を足す: ${storyTitle}$`) }).click();
  const dialog = page.getByRole('dialog', { name: createLabel });
  await dialog.getByLabel('タイトル').fill(title);
  await dialog.getByRole('button', { name: createLabel }).click();
  await expect(dialog).toBeHidden();
}

test('スクラムの言葉: エピックを配下を残して削除し、残ったストーリーを配下ごと削除する', async ({
  context,
  baseURL,
  page,
}) => {
  await signIn(context, baseURL, 'admin');
  const collect = await watchViolations(page);
  await createWorkspace(page, '削除のワークスペース', 'scrum');

  await create(page, 'エピックを作る', '会員証を作り直す');
  await create(page, 'ストーリーを作る', 'カードの画面');
  await page.getByRole('button', { name: '親を移す: カードの画面' }).click();
  const moveDialog = page.getByRole('dialog', { name: '「カードの画面」の親を移す' });
  await moveDialog.getByRole('button', { name: '移す' }).click();
  await expect(moveDialog).toBeHidden();
  await expect(
    rowGroup(page, '会員証を作り直す').locator('.tree-children .tree-row.is-story button.tree-link'),
  ).toHaveText(['カードの画面']);
  await addTask(page, 'カードの画面', 'バーコードを出す', '起票');
  await page.waitForLoadState('networkidle');

  // 作るときのダイアログには削除のボタンを出さない
  await page.getByRole('button', { name: 'エピックを作る' }).click();
  const createDialog = page.getByRole('dialog', { name: 'エピックを作る' });
  await expect(createDialog.getByRole('button', { name: 'このエピックを削除する' })).toHaveCount(0);
  await createDialog.getByRole('button', { name: 'やめる' }).click();
  await expect(createDialog).toBeHidden();

  // エピックのダイアログの下の削除から、確認を開く。配下の件数と、既定の「残す」が出る
  await page.getByRole('button', { name: '会員証を作り直す', exact: true }).click();
  const epicDialog = page.getByRole('dialog', { name: 'エピック', exact: true });
  await expect(epicDialog.getByLabel('タイトル')).toHaveValue('会員証を作り直す');
  const deleteEpic = epicDialog.getByRole('button', { name: 'このエピックを削除する' });
  await deleteEpic.click();
  const confirm = page.getByRole('dialog', { name: 'エピックを削除する' });
  await expect(confirm.getByText('「会員証を作り直す」を削除します。')).toBeVisible();
  const keep = confirm.getByRole('radio', { name: /配下を親なしで残す/ });
  await expect(keep).toBeChecked();
  await expect(keep).toBeFocused();
  await expect(
    confirm.getByText(/ストーリー 1 件は親なしのストーリーとして末尾へ移り、その下のタスク 1 件/),
  ).toBeVisible();
  await expect(confirm.getByText(/ストーリー 1 件とタスク 1 件を削除します/)).toBeVisible();

  // やめると、削除のボタンへ戻る
  await confirm.getByRole('button', { name: 'やめる' }).click();
  await expect(confirm).toBeHidden();
  await expect(deleteEpic).toBeFocused();

  await deleteEpic.click();
  await confirm.getByRole('button', { name: '削除する' }).click();
  await expect(confirm).toBeHidden();
  await expect(epicDialog).toBeHidden();
  await expect(page.getByRole('status').filter({ hasText: 'エピックを削除しました' })).toBeVisible();
  await expect(page.getByRole('button', { name: '会員証を作り直す', exact: true })).toHaveCount(0);
  await expect(page.getByRole('heading', { level: 1, name: 'バックログ' })).toBeFocused();
  // ストーリーは親なしになり、その下のタスクはストーリーの下のまま
  const story = rowGroup(page, 'カードの画面');
  await expect(story.locator('.tree-row.is-story')).toHaveClass(/is-root/);
  await expect(story.locator('.entry', { hasText: 'バーコードを出す' })).toHaveCount(1);

  // ストーリーを配下ごと削除する
  await page.getByRole('button', { name: 'カードの画面', exact: true }).click();
  const storyDialog = page.getByRole('dialog', { name: 'ストーリー', exact: true });
  await storyDialog.getByRole('button', { name: 'このストーリーを削除する' }).click();
  const storyConfirm = page.getByRole('dialog', { name: 'ストーリーを削除する' });
  await expect(
    storyConfirm.getByText(/タスク 1 件を削除します。取り込んだタスクは削除せず、アーカイブへ移します/),
  ).toBeVisible();
  await storyConfirm.getByRole('radio', { name: /配下もまとめて削除する/ }).check();
  await storyConfirm.getByRole('button', { name: '削除する' }).click();
  await expect(storyDialog).toBeHidden();
  await expect(page.getByRole('status').filter({ hasText: 'ストーリーを削除しました' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'カードの画面', exact: true })).toHaveCount(0);
  await expect(page.locator('.entry', { hasText: 'バーコードを出す' })).toHaveCount(0);

  // 読み直しても同じ
  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: 'バックログ' })).toBeVisible();
  await expect(page.locator('.tree-link')).toHaveCount(0);
  expect(await collect()).toEqual([]);
});

test('ゲームの言葉: 配下の無いレイドは選ばせずに削除する。断られたら理由を確認の中に出す', async ({
  context,
  baseURL,
  page,
}) => {
  await signIn(context, baseURL, 'admin');
  await createWorkspace(page, '削除のパーティ', 'game');
  await create(page, 'レイドを作る', '倉庫の棚卸し');
  await page.waitForLoadState('networkidle');

  await page.getByRole('button', { name: '倉庫の棚卸し', exact: true }).click();
  const epicDialog = page.getByRole('dialog', { name: 'レイド', exact: true });
  await epicDialog.getByRole('button', { name: 'このレイドを削除する' }).click();
  const confirm = page.getByRole('dialog', { name: 'レイドを削除する' });
  await expect(confirm.getByText('配下の達成目標はありません。')).toBeVisible();
  await expect(confirm.getByRole('radio')).toHaveCount(0);

  // 権限が無い（別の画面で外された）と断られたら、確認を開いたまま理由を出す
  await page.route('**/epic-delete', (route) =>
    route.fulfill({ status: 403, json: { error: { code: 'forbidden', message: 'forbidden' } } }),
  );
  await confirm.getByRole('button', { name: '削除する' }).click();
  await expect(confirm.getByRole('alert')).toHaveText('作った人とパーティリーダーだけが削除できます');
  await page.unroute('**/epic-delete');

  await confirm.getByRole('button', { name: '削除する' }).click();
  await expect(epicDialog).toBeHidden();
  await expect(page.getByRole('status').filter({ hasText: 'レイドを削除しました' })).toBeVisible();
  await expect(page.getByRole('button', { name: '倉庫の棚卸し', exact: true })).toHaveCount(0);
});

// seed のワークスペース（受託開発チーム）。エピック「ポイントの交換先を増やす」とストーリーは、管理者のミナトが作った
const SEED_GAME_WORKSPACE = '/aoba/w/019a0000-0000-7000-8000-000000000401';

test('作った人でもリーダーでもないメンバーには、削除のボタンを出さず、削除できる人を出す', async ({
  context,
  baseURL,
  page,
}) => {
  await signIn(context, baseURL, 'member');
  await page.goto(SEED_GAME_WORKSPACE);
  await page.getByRole('button', { name: 'ポイントの交換先を増やす', exact: true }).click();
  const epicDialog = page.getByRole('dialog', { name: 'レイド', exact: true });
  await expect(epicDialog.getByLabel('タイトル')).toHaveValue('ポイントの交換先を増やす');
  await expect(epicDialog.getByRole('button', { name: /を削除する/ })).toHaveCount(0);
  await expect(epicDialog.getByText('削除できるのは作った人とパーティリーダーです。')).toBeVisible();
  await epicDialog.getByRole('button', { name: 'やめる' }).click();

  await page.getByRole('button', { name: '送料の割引にポイントを使える', exact: true }).click();
  const storyDialog = page.getByRole('dialog', { name: '達成目標', exact: true });
  await expect(storyDialog.getByLabel('タイトル')).toHaveValue('送料の割引にポイントを使える');
  await expect(storyDialog.getByRole('button', { name: /を削除する/ })).toHaveCount(0);
  await expect(storyDialog.getByText('削除できるのは作った人とパーティリーダーです。')).toBeVisible();
});
