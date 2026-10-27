// 開いた状態（タスクの引き出し、Dialog のダイアログ、ConfirmDialog）を axe で確かめる（#334）。4つのテーマ × ゲームの言葉。
// 主な画面は e2e/a11y-screens.test.ts、除外は e2e/ui-exclusions.ts。
// seed のセッション（seed/sessions.ts）の Cookie で開く。あおば開発の管理者はミナト。受託開発チームはゲームの言葉。
// 開くだけで、作る、外すは押さない。seed の行もテーマの設定も書き換えない（ほかのファイルと並べて走るため）
import { expect, test } from './fixtures.ts';
import { expectNoA11yViolationsInThemes, signIn, waitForSettled } from './helpers.ts';

const WORKSPACE = '/aoba/w/019a0000-0000-7000-8000-000000000401';
const TASK_ID = '019a0000-0000-7000-8000-000000000801';

test.beforeEach(async ({ context, baseURL }) => {
  await signIn(context, baseURL, 'admin');
});

test('タスクの引き出しを開いた状態に axe の違反が無い', async ({ page }) => {
  await page.goto(`${WORKSPACE}?task=${TASK_ID}`);
  const drawer = page.getByRole('dialog', { name: 'ポイント付与のバッチを作る' });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByRole('heading', { level: 2 })).toBeFocused();
  await expect(page.locator('[aria-busy="true"]:visible')).toHaveCount(0);
  await expectNoA11yViolationsInThemes(page, 'task-drawer');
});

test('タスクを作るダイアログ（Dialog）を開いた状態に axe の違反が無い', async ({ page }) => {
  await page.goto(WORKSPACE);
  await expect(page.getByRole('heading', { level: 1, name: '掲示板' })).toBeVisible();
  const create = page.getByRole('button', { name: '依頼を出す' });
  await expect(create).toBeVisible();
  await waitForSettled(page);
  await create.click();
  const dialog = page.getByRole('dialog', { name: '依頼を出す' });
  await expect(dialog.getByLabel('タイトル')).toBeVisible();
  await expect(page.locator('[aria-busy="true"]:visible')).toHaveCount(0);
  await expectNoA11yViolationsInThemes(page, 'task-dialog');
});

test('メンバーを外す確かめ（ConfirmDialog）を開いた状態に axe の違反が無い', async ({ page }) => {
  await page.goto(`${WORKSPACE}/members`);
  const remove = page.getByRole('button', { name: 'ハルカを外す' });
  await expect(remove).toBeVisible();
  await waitForSettled(page);
  await remove.click();
  const dialog = page.getByRole('dialog', { name: 'ハルカを外しますか' });
  await expect(dialog.getByRole('button', { name: 'やめる' })).toBeVisible();
  await expectNoA11yViolationsInThemes(page, 'member-remove-confirm');
});
