// ワークスペースの設定の画面（区分とリポジトリ）と、起票と木と引き出しでの使い方。
// seed のセッション（seed/sessions.ts）の Cookie で開く。行を足すテストは、自分で作ったワークスペースで行う（seed の行は他の e2e も読むため）
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.ts';
import { createWorkspace, dragTo, signIn, waitForResponses, watchViolations } from './helpers.ts';

const SEED_GAME_WORKSPACE = '/aoba/w/019a0000-0000-7000-8000-000000000401';

async function openSettings(page: Page): Promise<void> {
  // 「自分の設定」の項目にも当たらないよう、全体が「設定」の項目だけを選ぶ
  await page.locator('.nav-item', { hasText: /^\s*設定\s*$/ }).click();
  await expect(page).toHaveURL(/\/aoba\/w\/[0-9a-f-]{36}\/settings$/);
  await expect(page.getByRole('heading', { level: 1, name: '設定' })).toBeVisible();
}

async function addDefinition(page: Page, kind: '区分' | 'リポジトリ', name: string): Promise<void> {
  await page.getByLabel(`新しい${kind}の名前`).fill(name);
  await page.getByRole('button', { name: `${kind}を足す` }).click();
  await expect(page.getByRole('list', { name: `${kind}の一覧` }).getByText(name, { exact: true })).toBeVisible();
}

test.describe('リーダー（あおば開発のミナト）', () => {
  test.beforeEach(async ({ context, baseURL }) => {
    await signIn(context, baseURL, 'admin');
  });

  test('区分とリポジトリを足す → 起票でリポジトリを1回押して選ぶ → 木に区分とリポジトリが出る → 区分を消すと行から外れる', async ({
    page,
  }) => {
    const collect = await watchViolations(page);
    await createWorkspace(page, '設定ワークスペース');
    await openSettings(page);
    await expect(page).toHaveTitle('設定・設定ワークスペース - Scrum Guild');
    await expect(page.locator('.nav-item[aria-current="page"]')).toHaveText('設定');

    // 空のうちは案内を出す
    await expect(page.getByText('まだ区分がありません')).toBeVisible();
    await expect(page.getByText('まだリポジトリがありません')).toBeVisible();

    await addDefinition(page, '区分', '保守');
    await addDefinition(page, '区分', '追加案件');
    await addDefinition(page, 'リポジトリ', 'point-api');
    await addDefinition(page, 'リポジトリ', 'admin-web');

    // 月ごとに計上するを切り替える
    const billed = page.getByRole('checkbox', { name: '月ごとに計上する: 保守' });
    await billed.check();
    await expect(page.getByRole('status').filter({ hasText: '保存しました' }).first()).toBeVisible();
    await page.reload();
    await expect(billed).toBeChecked();

    // 名前を直す
    const categories = page.getByRole('list', { name: '区分の一覧' });
    // 名前そのものが押せるボタン（ほかの「上へ: 追加案件」などと分けるため、名前で始まるものを押す）
    await categories.getByRole('button', { name: /^追加案件/ }).click();
    const nameInput = categories.getByLabel('区分の名前');
    await nameInput.fill('改修');
    await nameInput.press('Enter');
    await expect(categories.locator('li')).toHaveText([/保守/, /改修/]);

    // 並べ替える。先頭の「上へ」は押せない
    await expect(categories.getByRole('button', { name: '上へ: 保守' })).toHaveAttribute('aria-disabled', 'true');
    await categories.getByRole('button', { name: '上へ: 改修' }).click();
    await expect(categories.locator('li')).toHaveText([/改修/, /保守/]);
    await expect(categories.getByRole('button', { name: '上へ: 改修' })).toBeFocused();

    // バックログで起票する。リポジトリはボタンで1回押して選び、区分は親なしのときだけ選べる
    await page.locator('.nav-item', { hasText: 'バックログ' }).click();
    await page.getByRole('button', { name: '起票' }).click();
    const dialog = page.getByRole('dialog', { name: '起票' });
    const repositories = dialog.getByRole('radiogroup', { name: 'リポジトリ' });
    // 2つあるので、既定は「なし」
    await expect(repositories.getByRole('radio', { name: 'なし' })).toBeChecked();
    await dialog.getByLabel('タイトル').fill('ポイントの失効を直す');
    await repositories.getByRole('radio', { name: 'point-api' }).check();
    await dialog.getByLabel('区分').selectOption({ label: '保守' });
    await dialog.getByRole('button', { name: '起票' }).click();
    await expect(dialog).toBeHidden();

    const row = page.locator('.entry', { hasText: 'ポイントの失効を直す' });
    await expect(row.locator('.entry-meta .chip')).toHaveText(['リポジトリ：point-api', '区分：保守']);
    // 読み直しても出る
    await page.reload();
    await expect(row.locator('.entry-meta .chip')).toHaveText(['リポジトリ：point-api', '区分：保守']);

    // 引き出しでリポジトリを直す
    await row.getByRole('link', { name: 'ポイントの失効を直す' }).click();
    const drawer = page.getByRole('dialog', { name: 'ポイントの失効を直す' });
    await drawer.getByRole('radiogroup', { name: 'リポジトリ' }).getByRole('radio', { name: 'admin-web' }).check();
    await expect(row.locator('.entry-meta .chip')).toHaveText(['リポジトリ：admin-web', '区分：保守']);
    await drawer.getByRole('button', { name: '閉じる' }).click();
    await expect(drawer).toBeHidden();

    // 区分を削除すると、確かめた後に消え、振っていたタスクは区分なしに戻る
    await openSettings(page);
    await page.getByRole('button', { name: '削除: 保守' }).click();
    const confirm = page.getByRole('dialog', { name: '「保守」を削除する' });
    await expect(confirm).toContainText('完了の記録は元の区分のまま残ります');
    await confirm.getByRole('button', { name: '削除する' }).click();
    await expect(page.getByRole('list', { name: '区分の一覧' }).locator('li')).toHaveText([/改修/]);
    await page.locator('.nav-item', { hasText: 'バックログ' }).click();
    await expect(row.locator('.entry-meta .chip')).toHaveText(['リポジトリ：admin-web']);
    expect(await collect()).toEqual([]);
  });

  test('区分の一覧の行を、先頭のつまみのドラッグで並べ替えられ、読み直しても同じ順になる。狭い幅ではつまみを出さない', async ({
    page,
  }) => {
    const collect = await watchViolations(page);
    await createWorkspace(page, 'つまみの設定ワークスペース');
    await openSettings(page);
    for (const name of ['保守', '追加案件', '改修']) await addDefinition(page, '区分', name);
    const categories = page.getByRole('list', { name: '区分の一覧' });
    const row = (name: string) => categories.locator('li', { hasText: name });

    // 3番目を先頭の行の上半分へ。離す前に、その行の上に線が出る
    await expect(row('改修').locator('.grip')).toHaveAttribute('aria-hidden', 'true');
    await dragTo(page, row('改修').locator('.grip'), row('保守'), 'top', async () => {
      await expect(row('保守')).toHaveAttribute('data-drop', 'before');
      await expect(row('改修')).toHaveClass(/is-dragging/);
    });
    await expect(categories.locator('li')).toHaveText([/改修/, /保守/, /追加案件/]);
    await expect(row('改修')).toHaveClass(/is-dropped/);
    await expect(page.getByRole('status').filter({ hasText: '「改修」を 1 番目に移しました' })).toBeAttached();

    // 先頭の行を、最後の行の下半分へ。この一覧は応答を受けて読み直してから並びを変えるので、下の toHaveText の時点で
    // 書き終わっている。画面を先に変える作りに変わっても読み直しの前に書き終わるよう、決まりにそろえて応答を待つ
    const moved = waitForResponses(page, '/category-move');
    await dragTo(page, row('改修').locator('.grip'), row('追加案件'), 'bottom', async () => {
      await expect(row('追加案件')).toHaveAttribute('data-drop', 'after');
    });
    await expect(categories.locator('li')).toHaveText([/保守/, /追加案件/, /改修/]);

    await moved;
    await page.reload();
    await expect(categories.locator('li')).toHaveText([/保守/, /追加案件/, /改修/]);

    // 狭い幅では、つまみを出さず、「上へ」「下へ」で並べ替える
    await page.setViewportSize({ width: 390, height: 900 });
    await expect(row('保守').locator('.grip')).toBeHidden();
    await categories.getByRole('button', { name: '下へ: 保守' }).click();
    await expect(categories.locator('li')).toHaveText([/追加案件/, /保守/, /改修/]);
    expect(await collect()).toEqual([]);
  });

  test('ストーリーの下のタスクには区分を振れず、親の区分を引き継いで出る', async ({ page }) => {
    await createWorkspace(page, '引き継ぎワークスペース');
    await openSettings(page);
    await addDefinition(page, '区分', '保守');
    await addDefinition(page, 'リポジトリ', 'point-api');
    // 同じ名前は断り、欄の下に理由を出す
    await page.getByLabel('新しい区分の名前').fill('保守');
    await page.getByRole('button', { name: '区分を足す' }).click();
    await expect(page.getByRole('alert').filter({ hasText: '同じ名前の区分があります' })).toBeVisible();
    await expect(page.getByLabel('新しい区分の名前')).toBeFocused();

    // 書いた後の読み直しが失敗しても、前の一覧を残し、更新できなかったことと「もう一度試す」を出す
    await page.route('**/api/aoba/category-repository-list', (route) => route.fulfill({ status: 503, body: '' }));
    await page.getByLabel('新しい区分の名前').fill('追加案件');
    await page.getByRole('button', { name: '区分を足す' }).click();
    await expect(page.getByRole('alert').filter({ hasText: '一覧を更新できませんでした' })).toBeVisible();
    await expect(page.getByRole('list', { name: '区分の一覧' }).getByText('保守', { exact: true })).toBeVisible();
    await page.unroute('**/api/aoba/category-repository-list');
    await page.getByRole('button', { name: 'もう一度試す' }).click();
    await expect(page.getByRole('alert').filter({ hasText: '一覧を更新できませんでした' })).toHaveCount(0);
    await expect(page.getByRole('list', { name: '区分の一覧' }).getByText('追加案件', { exact: true })).toBeVisible();
    // 押したボタンが消えるので、先頭の節の見出しへフォーカスを移し、読み直せたことを常に置いた領域で伝える
    await expect(page.locator('.settings .setting-title').first()).toBeFocused();
    await expect(page.getByRole('status').filter({ hasText: '一覧を更新しました' })).toHaveCount(1);
    await page.locator('.nav-item', { hasText: 'バックログ' }).click();

    // 親のないストーリーに区分を振る
    await page.getByRole('button', { name: 'ストーリーを作る' }).click();
    const storyDialog = page.getByRole('dialog', { name: 'ストーリーを作る' });
    await storyDialog.getByLabel('タイトル').fill('ポイントを使える');
    await storyDialog.getByLabel('区分').selectOption({ label: '保守' });
    await storyDialog.getByRole('button', { name: '作る' }).click();
    await expect(storyDialog).toBeHidden();
    const story = page.locator('.tree-group', { hasText: 'ポイントを使える' });
    await expect(story.locator('.tree-row .chip')).toHaveText('区分：保守');

    // 一覧が1つだけなら、リポジトリはそれを選んだ状態で開く。親を選ぶと区分の欄は引き継ぎの表示になる
    await story.getByRole('button', { name: /タスクを足す/ }).click();
    const dialog = page.getByRole('dialog', { name: '起票' });
    await expect(
      dialog.getByRole('radiogroup', { name: 'リポジトリ' }).getByRole('radio', { name: 'point-api' }),
    ).toBeChecked();
    await expect(dialog.getByLabel('区分')).toHaveCount(0);
    await expect(dialog.getByText('親から引き継ぎ')).toBeVisible();
    await dialog.getByLabel('タイトル').fill('残高の画面を作る');
    await dialog.getByRole('button', { name: '起票' }).click();
    await expect(dialog).toBeHidden();
    const task = story.locator('.entry', { hasText: '残高の画面を作る' });
    // 配下の行では区分を繰り返さず、リポジトリだけを出す
    await expect(task.locator('.entry-meta .chip')).toHaveText(['リポジトリ：point-api']);

    // 引き出しでは、引き継いだ区分を読み取り専用で出す
    await task.getByRole('link', { name: '残高の画面を作る' }).click();
    const drawer = page.getByRole('dialog', { name: '残高の画面を作る' });
    await expect(drawer.getByText('親から引き継ぎ')).toBeVisible();
    await expect(drawer.getByLabel('区分')).toHaveCount(0);
  });
});

test.describe('一般のメンバー（あおば開発のハルカ）', () => {
  test.beforeEach(async ({ context, baseURL }) => {
    await signIn(context, baseURL, 'member');
  });

  test('メニューに設定を出さず、URL で開くと入れないことを伝える', async ({ page }) => {
    await page.goto(SEED_GAME_WORKSPACE);
    await expect(page.getByRole('heading', { level: 1, name: 'バックログ' })).toBeVisible();
    await expect(page.locator('.nav-item', { hasText: 'メンバー' })).toBeVisible();
    await expect(page.locator('.nav-item', { hasText: /^\s*設定\s*$/ })).toHaveCount(0);
    await page.goto(`${SEED_GAME_WORKSPACE}/settings`);
    await expect(page.getByText('この画面には入れません')).toBeVisible();
    await expect(page.getByLabel('新しい区分の名前')).toHaveCount(0);
    // 列の節も出さない
    await expect(page.getByLabel('新しい列の名前')).toHaveCount(0);
    await expect(page.getByRole('list', { name: '列の一覧' })).toHaveCount(0);
    await page.getByRole('link', { name: 'バックログへ戻る' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'バックログ' })).toBeVisible();
  });

  test('seed の区分とリポジトリが木の行に出る', async ({ page }) => {
    await page.goto(SEED_GAME_WORKSPACE);
    const epic = page.locator('.tree-group', { hasText: 'ポイントの交換先を増やす' }).first();
    await expect(epic.locator('.tree-row.is-epic .chip', { hasText: '区分：追加案件' })).toBeVisible();
    const task = page.locator('.entry', { hasText: 'ポイント付与のバッチを作る' });
    await expect(task.locator('.entry-meta .chip')).toHaveText(['リポジトリ：point-api', '区分：保守']);
  });
});
