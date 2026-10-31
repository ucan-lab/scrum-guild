import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.ts';
import { backlogCompletedTasks } from '../src/shared/operations/task/backlog-completed-tasks.ts';
import {
  createWorkspace,
  expectModalFocus,
  createLayoutCheck,
  signIn,
  waitForResponses,
  watchViolations,
} from './helpers.ts';
import { routeOperation } from './operations.ts';

test.use({ timezoneId: 'Asia/Tokyo' });
test.beforeEach(async ({ context, baseURL }) => {
  await signIn(context, baseURL, 'admin');
});

test('親なしと配下の完了をキーボードで開閉し、詳細を開く。再試行と完了を戻した後の読み直し', async ({ page }) => {
  const collect = await watchViolations(page);
  const suffix = `${test.info().repeatEachIndex}-${test.info().retry}`;
  await createWorkspace(page, `完了の一覧-${suffix}`);
  const story = 'ストーリー';
  const create = '起票';
  const done = '完了';
  const assignee = '担当';
  await page.getByRole('button', { name: `${story}を作る` }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('タイトル').fill(`目標-${suffix}`);
  const reloaded = waitForResponses(page, '/backlog-tree');
  await dialog.getByRole('button', { name: '作る', exact: true }).click();
  await expect(dialog).toBeHidden();
  await reloaded;
  for (const child of [false, true]) {
    const title = `${child ? '配下' : '親なし'}の完了-${suffix}`;
    await page.getByRole('button', { name: create, exact: true }).click();
    await dialog.getByLabel('タイトル').fill(title);
    await expect(
      dialog.getByRole('combobox', { name: assignee, exact: true }).getByRole('option', { name: 'ミナト' }),
    ).toBeAttached();
    await dialog.getByRole('combobox', { name: assignee, exact: true }).selectOption({ label: 'ミナト' });
    await dialog.getByRole('radio', { name: '3', exact: true }).check();
    if (child) await dialog.getByLabel(`親の${story}`).selectOption({ label: `目標-${suffix}` });
    const created = waitForResponses(page, '/task-create');
    await dialog.getByRole('button', { name: create, exact: true }).click();
    await expect(dialog).toBeHidden();
    await created;
    const completed = waitForResponses(page, '/task-complete');
    await page.getByRole('button', { name: `${done}にする: ${title}`, exact: true }).click();
    await completed;
  }
  await page.reload();
  let fail = true;
  const unroute = await routeOperation(page, backlogCompletedTasks, { slug: 'aoba' }, async (call) => {
    if (fail) {
      fail = false;
      await call.fail(500, 'internal');
    } else await call.passThrough();
  });
  const root = page.getByRole('button', { name: `親のない${done} 1 件を折りたたんでいます`, exact: true });
  await root.focus();
  await page.keyboard.press('Enter');
  const rootOpen = page.getByRole('button', { name: `親のない${done} 1 件を閉じる`, exact: true });
  await expect(rootOpen).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('alert').filter({ hasText: '読み込めませんでした' })).toBeVisible();
  await page.getByRole('button', { name: 'もう一度試す', exact: true }).click();
  const rootId = await rootOpen.getAttribute('aria-controls');
  const rootList = page.locator(`[id="${rootId}"]`);
  await expect(rootList.getByRole('img', { name: 'ミナト', exact: true })).toBeVisible();
  await expect(rootList.locator('time')).toContainText(`${done}した日`);
  await expect(rootList.locator('time .mono')).toHaveText(/^\d{4}-\d{2}-\d{2}$/);
  await expect(rootList.locator('.pts')).toHaveText('3');
  // 完了した行の操作は、引き出しを開く題のボタン1つだけ（つまみも完了の丸も、落とし先も無い）
  const rootRows = rootList.locator('.entry');
  await expect(rootRows).toHaveCount(1);
  await expect(rootRows.getByRole('button')).toHaveCount(1);
  await expect(rootRows.getByRole('button')).toHaveText(`親なしの完了-${suffix}`);
  await expect(rootRows.getByRole('link')).toHaveCount(0);
  await expect(rootRows).not.toHaveAttribute('data-drop');
  await expectModalFocus(page, {
    opener: rootList.getByRole('button', { name: `親なしの完了-${suffix}`, exact: true }),
    modal: page.getByRole('dialog', { name: `親なしの完了-${suffix}`, exact: true }),
  });
  await rootOpen.click();
  await expect(rootList).toBeHidden();
  await root.focus();
  await page.keyboard.press('Space');
  await expect(rootList).toBeVisible();
  await expect(rootOpen).toHaveAttribute('aria-expanded', 'true');
  // ストーリーの配下の開閉の読み上げの名前には、見える文言にストーリーの題を添える
  const childClosedName = `${done} 1 件を折りたたんでいます（目標-${suffix}）`;
  await page.getByRole('button', { name: childClosedName, exact: true }).click();
  const childOpen = page.getByRole('button', { name: `${done} 1 件を閉じる（目標-${suffix}）`, exact: true });
  await expect(childOpen).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('group', { name: `目標-${suffix}の${done}したタスク` })).toBeVisible();
  const childTitle = page.locator('.completed-list').getByRole('button', { name: `配下の完了-${suffix}`, exact: true });
  await expectModalFocus(page, {
    opener: childTitle,
    modal: page.getByRole('dialog', { name: `配下の完了-${suffix}`, exact: true }),
    press: 'Enter',
  });
  await page.setViewportSize({ width: 390, height: 844 });
  const layout = createLayoutCheck('backlog');
  await layout.inThemes(page);
  layout.finish();
  await childOpen.click();
  await expect(childTitle).toBeHidden();
  // 親なしの引き出しから戻すと、開いた一覧も木と一緒に読み直される。
  await rootList.getByRole('button', { name: `親なしの完了-${suffix}`, exact: true }).click();
  const drawer = page.getByRole('dialog', { name: `親なしの完了-${suffix}`, exact: true });
  await drawer.getByRole('button', { name: `${done}を戻す: 親なしの完了-${suffix}`, exact: true }).click();
  await expect(page.getByRole('button', { name: `親のない${done} 1 件を閉じる`, exact: true })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await unroute();
  await page.reload();
  await expect(page.getByRole('button', { name: childClosedName, exact: true })).toHaveAttribute(
    'aria-expanded',
    'false',
  );
  // ブラウザが出すのは、最初の読み込みをわざと失敗させた 500 の1件だけ
  expect(await collect()).toEqual([
    'Failed to load resource: the server responded with a status of 500 (Internal Server Error)',
  ]);
});

// ワークスペースで、タスクを起票して完了にする。parent があれば、その題のストーリーの配下に作る
async function createCompletedTask(page: Page, title: string, parent?: string): Promise<void> {
  await page.getByRole('button', { name: '起票', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('タイトル').fill(title);
  if (parent !== undefined) await dialog.getByLabel('親のストーリー').selectOption({ label: parent });
  const created = waitForResponses(page, '/task-create');
  await dialog.getByRole('button', { name: '起票', exact: true }).click();
  await expect(dialog).toBeHidden();
  await created;
  const completed = waitForResponses(page, '/task-complete');
  await page.getByRole('button', { name: `完了にする: ${title}`, exact: true }).click();
  await completed;
}

test('絞り込み中は、完了だけを持つストーリーに「まだありません」を出さず、開閉のない折りたたみの行を出す', async ({
  page,
}) => {
  const collect = await watchViolations(page);
  const suffix = `${test.info().repeatEachIndex}-${test.info().retry}`;
  await createWorkspace(page, `完了と絞り込み-${suffix}`);
  const story = `完了だけの目標-${suffix}`;
  await page.getByRole('button', { name: 'ストーリーを作る' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('タイトル').fill(story);
  const reloaded = waitForResponses(page, '/backlog-tree');
  await dialog.getByRole('button', { name: '作る', exact: true }).click();
  await expect(dialog).toBeHidden();
  await reloaded;
  await createCompletedTask(page, `終えた依頼-${suffix}`, story);
  await page.reload();
  const toggle = page.getByRole('button', { name: `完了 1 件を折りたたんでいます（${story}）`, exact: true });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await toggle.click();
  // 開くと、読み上げの名前は「閉じる」に替わる
  await expect(page.getByRole('button', { name: `完了 1 件を閉じる（${story}）`, exact: true })).toHaveAttribute(
    'aria-expanded',
    'true',
  );

  const bar = page.getByRole('search', { name: 'バックログの絞り込み' });
  await bar.getByRole('searchbox', { name: 'タイトルで探す' }).fill(story);
  const folded = page.locator('p.tree-folded', { hasText: '完了 1 件を折りたたんでいます' });
  await expect(folded).toBeVisible();
  await expect(page.getByText('タスクはまだありません')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^完了 1 件を(折りたたんでいます|閉じる)/ })).toHaveCount(0);

  // 絞り込みを外すと、開いていた一覧は閉じた状態に戻る
  await bar.getByRole('button', { name: '絞り込みを外す' }).click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  expect(await collect()).toEqual([]);
});

test('開いた直後に空の案内を出さず、押したボタンが消えたら新しく並んだ先頭の行の題へフォーカスを移す', async ({
  page,
}) => {
  const collect = await watchViolations(page);
  const suffix = `${test.info().repeatEachIndex}-${test.info().retry}`;
  await createWorkspace(page, `完了の続き-${suffix}`);
  await createCompletedTask(page, `親なしの完了-${suffix}`);
  await page.reload();
  const completedAt = '2026-10-20T00:00:00.000Z';
  const fake = (from: number, count: number) =>
    Array.from({ length: count }, (_, i) => ({
      id: `fake-${from + i}`,
      title: `仮の完了-${from + i}`,
      points: null,
      completed_at: completedAt,
      assignee: null,
    }));
  let failMore = true;
  // 読み込み中を見られるよう、応答を遅らせる。2回目（さらに見る）は1度だけ失敗させる
  await routeOperation(page, backlogCompletedTasks, { slug: 'aoba' }, async (call) => {
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (call.input.before === undefined)
      await call.fulfill({ tasks: fake(0, 20), next: { completed_at: completedAt, id: 'fake-19' } });
    else if (failMore) {
      failMore = false;
      await call.fail(500, 'internal');
    } else await call.fulfill({ tasks: fake(20, 5), next: null });
  });

  // 読み込みの前後に、空の案内が一度でも DOM に入ったかを見張る
  await page.evaluate(() => {
    const flag = window as Window & { emptyShown?: boolean };
    flag.emptyShown = false;
    new MutationObserver(() => {
      if (document.body.textContent?.includes('完了したタスクはありません')) flag.emptyShown = true;
    }).observe(document.body, { subtree: true, childList: true, characterData: true });
  });
  await page.getByRole('button', { name: '親のない完了 1 件を折りたたんでいます', exact: true }).click();
  const list = page.getByRole('group', { name: '親のない完了したタスク' });
  await expect(list.getByRole('status')).toHaveText('読み込んでいます');
  await expect(list.locator('.entry')).toHaveCount(20);
  await expect(list.getByRole('status')).toHaveText('');
  expect(await page.evaluate(() => (window as Window & { emptyShown?: boolean }).emptyShown)).toBe(false);

  // 続きの読み込みが失敗すると、押した「さらに見る」が「もう一度試す」に替わる。フォーカスはその新しいボタンへ移る
  await list.getByRole('button', { name: 'さらに見る', exact: true }).click();
  const retry = list.getByRole('button', { name: 'もう一度試す', exact: true });
  await expect(retry).toBeFocused();
  // 再試行で最後まで読めると、ボタンは消える。フォーカスは新しく並んだ先頭の行の題へ移る
  await retry.click();
  await expect(list.locator('.entry')).toHaveCount(25);
  await expect(list.getByRole('button', { name: /^(さらに見る|もう一度試す)$/ })).toHaveCount(0);
  await expect(list.getByRole('button', { name: '仮の完了-20', exact: true })).toBeFocused();
  // ブラウザが出すのは、続きの読み込みをわざと失敗させた 500 の1件だけ
  expect(await collect()).toEqual([
    'Failed to load resource: the server responded with a status of 500 (Internal Server Error)',
  ]);
});
