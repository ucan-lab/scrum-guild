// 一本道: 設定で決まった欄を足す → 起票した行と見出しに「詳細 未記入」が出る → 引き出しで欄を Markdown で書くと印が消える →
// 空にすると未記入に戻る → 欄を削除すると未記入の判定から外れる。同時に直されて断られたら、読み直しを促す。計画の画面とスプリントに入れるダイアログに件数が出る。
// seed のセッション（seed/sessions.ts）の Cookie で開く。あおば開発の管理者はミナト。行を足すテストは、自分で作ったワークスペースで行う
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.ts';
import { taskFieldSet } from '../src/shared/operations/task/task-field-set.ts';
import { createWorkspace, signIn, watchViolations } from './helpers.ts';
import { failOperation } from './operations.ts';

const AOBA = { slug: 'aoba' };

test.beforeEach(async ({ context, baseURL }) => {
  await signIn(context, baseURL, 'admin');
});

async function openSettings(page: Page): Promise<void> {
  await page.locator('.nav-item', { hasText: /^\s*設定\s*$/ }).click();
  await expect(page).toHaveURL(/\/aoba\/w\/[0-9a-f-]{36}\/settings$/);
  await expect(page.getByRole('heading', { level: 1, name: '設定' })).toBeVisible();
}

async function addTask(page: Page, title: string): Promise<void> {
  await page.getByRole('button', { name: '起票' }).click();
  const dialog = page.getByRole('dialog', { name: '起票' });
  await dialog.getByLabel('タイトル').fill(title);
  await dialog.getByRole('button', { name: '起票' }).click();
  await expect(dialog).toBeHidden();
}

// 見出しの集計の「詳細 未記入」の数
function unfilledTally(page: Page) {
  return page.locator('.page-head .tally > div', { hasText: '詳細 未記入' });
}

test('設定で欄を足す → 起票した行と見出しに未記入 → 引き出しで書くと印が消える → 空にすると戻る → 欄を削除すると判定から外れる', async ({
  page,
}) => {
  const collect = await watchViolations(page);
  await createWorkspace(page, '決まった欄ワークスペース');

  // 設定: 作った直後は「受け入れ基準」が1つ。足して、名前を直して、並べ替えられる。10 件までは文で示す
  await openSettings(page);
  const fields = page.getByRole('list', { name: '決まった欄の一覧' });
  await expect(fields.locator('li')).toHaveText([/受け入れ基準/]);
  await page.getByLabel('新しい決まった欄の名前').fill('影響範囲');
  await page.getByRole('button', { name: '決まった欄を足す' }).click();
  await expect(fields.locator('li')).toHaveText([/受け入れ基準/, /影響範囲/]);
  await expect(page.getByText('決まった欄は 10 件まで足せます（いま 2 件）。')).toBeVisible();
  await fields.getByRole('button', { name: '上へ: 影響範囲' }).click();
  await expect(fields.locator('li')).toHaveText([/影響範囲/, /受け入れ基準/]);

  // 同じ名前は断る
  await page.getByLabel('新しい決まった欄の名前').fill('影響範囲');
  await page.getByRole('button', { name: '決まった欄を足す' }).click();
  await expect(page.getByText('同じ名前の決まった欄があります')).toBeVisible();

  // バックログ: 起票した行と見出しに未記入が出る
  await page.locator('.nav-item', { hasText: 'バックログ' }).click();
  await addTask(page, '失効の通知を直す');
  await addTask(page, '履歴の画面を作る');
  const row = page.locator('.entry', { hasText: '失効の通知を直す' });
  await expect(row.locator('.chip.is-todo')).toHaveText('詳細 未記入');
  await expect(unfilledTally(page)).toHaveText(/詳細 未記入\s*2/);

  // 引き出し: 欄が設定の並びで出て、どちらも未記入
  await row.getByRole('link', { name: '失効の通知を直す' }).click();
  const drawer = page.getByRole('dialog', { name: '失効の通知を直す' });
  const fieldBlocks = drawer.locator('[data-field-id]');
  await expect(fieldBlocks).toHaveCount(2);
  await expect(fieldBlocks.nth(0)).toContainText('影響範囲');
  await expect(fieldBlocks.nth(1)).toContainText('受け入れ基準');
  await expect(drawer.locator('[data-field-id] .chip.is-todo')).toHaveText(['未記入', '未記入']);

  // 1つ目を Markdown で書く。もう1つが未記入のうちは、行の印も見出しの数も変わらない
  await drawer.getByRole('button', { name: '影響範囲を書く' }).click();
  await drawer.getByRole('textbox', { name: '影響範囲', exact: true }).fill('- 通知の画面\n- 管理画面');
  await drawer.getByRole('button', { name: '保存' }).click();
  await expect(fieldBlocks.nth(0).locator('li')).toHaveText(['通知の画面', '管理画面']);
  await expect(drawer.locator('[data-field-id] .chip.is-todo')).toHaveText(['未記入']);
  await expect(row.locator('.chip.is-todo')).toHaveText('詳細 未記入');

  // 2つ目も書くと、行の印が消え、見出しの数が減る
  await drawer.getByRole('button', { name: '受け入れ基準を書く' }).click();
  await drawer.getByRole('textbox', { name: '受け入れ基準', exact: true }).fill('通知が届いたことを確かめた');
  await drawer.getByRole('button', { name: '保存' }).click();
  await expect(drawer.locator('[data-field-id] .chip.is-todo')).toHaveCount(0);
  await expect(row.locator('.chip.is-todo')).toHaveCount(0);
  await expect(unfilledTally(page)).toHaveText(/詳細 未記入\s*1/);

  // 変更の履歴に欄の名前だけが残る（値の全文は出ない）
  await drawer.getByRole('tab', { name: '変更の履歴' }).click();
  const history = drawer.getByRole('tabpanel', { name: '変更の履歴' });
  await expect(history).toContainText('「受け入れ基準」を書いた');
  await expect(history).toContainText('「影響範囲」を書いた');
  await expect(history).not.toContainText('通知が届いたことを確かめた');

  // 空にして保存すると、未記入に戻る
  await drawer.getByRole('button', { name: '受け入れ基準を書き直す' }).click();
  await drawer.getByRole('textbox', { name: '受け入れ基準', exact: true }).fill('');
  await drawer.getByRole('button', { name: '保存' }).click();
  await expect(drawer.locator('[data-field-id] .chip.is-todo')).toHaveText(['未記入']);
  await expect(row.locator('.chip.is-todo')).toHaveText('詳細 未記入');
  await expect(history).toContainText('「受け入れ基準」を空にした');
  await drawer.getByRole('button', { name: '閉じる' }).click();
  await expect(drawer).toBeHidden();
  await expect(unfilledTally(page)).toHaveText(/詳細 未記入\s*2/);

  // 欄を削除すると、その欄は未記入の判定から外れる。残った欄が書かれている「失効の通知を直す」は未記入でなくなる
  await openSettings(page);
  await page.getByRole('button', { name: '削除: 受け入れ基準' }).click();
  const confirm = page.getByRole('dialog', { name: '「受け入れ基準」を削除する' });
  await expect(confirm).toContainText('未記入」の判定からも外れます');
  await confirm.getByRole('button', { name: '削除する' }).click();
  await expect(fields.locator('li')).toHaveText([/影響範囲/]);
  await page.locator('.nav-item', { hasText: 'バックログ' }).click();
  await expect(row.locator('.chip.is-todo')).toHaveCount(0);
  await expect(page.locator('.entry', { hasText: '履歴の画面を作る' }).locator('.chip.is-todo')).toHaveText(
    '詳細 未記入',
  );
  await expect(unfilledTally(page)).toHaveText(/詳細 未記入\s*1/);
  expect(await collect()).toEqual([]);
});

test('同時に直されて断られると、書きかけを残したまま読み直しを促し、読み直した値で書き直せる', async ({ page }) => {
  await createWorkspace(page, '同時に直すワークスペース');
  await addTask(page, '比べる対象');
  await page.locator('.entry', { hasText: '比べる対象' }).getByRole('link', { name: '比べる対象' }).click();
  const drawer = page.getByRole('dialog', { name: '比べる対象' });

  await drawer.getByRole('button', { name: '受け入れ基準を書く' }).click();
  const box = drawer.getByRole('textbox', { name: '受け入れ基準', exact: true });
  await box.fill('自分の下書き');
  // サーバーが「先に別の人が直した」と答える
  const unroute = await failOperation(page, taskFieldSet, AOBA, 409, 'conflict', { details: { reason: 'changed' } });
  await drawer.getByRole('button', { name: '保存' }).click();
  await expect(drawer.getByRole('alert').filter({ hasText: 'ほかの人が先にこの欄を直しました' })).toBeVisible();
  // 書きかけは残る
  await expect(box).toHaveValue('自分の下書き');
  await unroute();

  // 読み直した値（未記入）を読んだ値として、そのまま書き直せる
  await drawer.getByRole('button', { name: '保存' }).click();
  await expect(drawer.locator('[data-field-id] .chip.is-todo')).toHaveCount(0);
  await expect(drawer.locator('[data-field-id]')).toContainText('自分の下書き');
});

test('計画の画面の先のスプリントとスプリントに入れるダイアログに、入るタスクのうち未記入の件数が出る', async ({
  page,
}) => {
  await createWorkspace(page, '計画の未記入ワークスペース');
  await addTask(page, '書き終えたタスク');
  await addTask(page, '書いていないタスク');
  const first = page.locator('.entry', { hasText: '書き終えたタスク' });
  await first.getByRole('link', { name: '書き終えたタスク' }).click();
  const drawer = page.getByRole('dialog', { name: '書き終えたタスク' });
  await drawer.getByRole('button', { name: '受け入れ基準を書く' }).click();
  await drawer.getByRole('textbox', { name: '受け入れ基準', exact: true }).fill('確かめた');
  await drawer.getByRole('button', { name: '保存' }).click();
  await expect(drawer.locator('[data-field-id] .chip.is-todo')).toHaveCount(0);
  await drawer.getByRole('button', { name: '閉じる' }).click();
  await expect(drawer).toBeHidden();

  // 計画の画面でスプリントを作り、2件とも入れる
  await page.getByRole('link', { name: '計画' }).click();
  await page.getByRole('button', { name: 'スプリントを作る' }).click();
  const createDialog = page.getByRole('dialog', { name: 'スプリントを作る' });
  await createDialog.getByLabel('開始日').fill('2027-02-01');
  await createDialog.getByLabel('長さ（日）').fill('14');
  await createDialog.getByLabel('名前（任意）').fill('第1回');
  await createDialog.getByRole('button', { name: '作る' }).click();
  await expect(createDialog).toBeHidden();
  await expect(page.locator('.lane-title')).toHaveText(['スプリント 第1回']);
  await expect(page.locator('[data-lane-unfilled]')).toHaveCount(0);

  await page.getByRole('button', { name: 'バックログから入れる: スプリント 第1回' }).click();
  const picker = page.getByRole('dialog', { name: 'スプリント 第1回 に入れる' });
  const list = picker.getByRole('group', { name: '入れるタスク' });
  await list.getByRole('checkbox', { name: /^書き終えたタスク/ }).check();
  await expect(picker.locator('[data-pick-unfilled]')).toHaveCount(0);
  await list.getByRole('checkbox', { name: /^書いていないタスク/ }).check();
  // 選んだ 2 件のうち、未記入は 1 件（入れる操作は止めない）
  await expect(picker.locator('[data-pick-unfilled]')).toHaveText('（うち詳細 未記入 1 件）');
  await picker.getByRole('button', { name: '2 件入れる' }).click();
  await expect(picker).toBeHidden();

  // 先のスプリントの .lane-sub に未記入の件数が出る
  await expect(page.locator('.lane').first().locator('[data-lane-unfilled]')).toHaveText('詳細 未記入 1 件');
});
