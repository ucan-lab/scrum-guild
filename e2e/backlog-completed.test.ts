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

for (const vocabulary of ['game', 'scrum'] as const) {
  test(`${vocabulary}: 親なしと配下の完了をキーボードで開閉し、詳細を開く。再試行と完了を戻した後の読み直し`, async ({
    page,
  }) => {
    const collect = await watchViolations(page);
    const suffix = `${test.info().repeatEachIndex}-${test.info().retry}`;
    await createWorkspace(page, `完了の一覧-${vocabulary}-${suffix}`, vocabulary);
    const story = vocabulary === 'game' ? '達成目標' : 'ストーリー';
    const create = vocabulary === 'game' ? '依頼を出す' : '起票';
    const done = vocabulary === 'game' ? '完遂' : '完了';
    const assignee = vocabulary === 'game' ? '担い手' : '担当';
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
    await expect(rootList.getByText('ミナト', { exact: true })).toBeVisible();
    await expect(rootList.locator('time')).toContainText('完了した日:');
    await expect(rootList.locator('.pts')).toHaveText('3');
    await expect(rootList.locator('.grip, .done-btn, [data-drop]')).toHaveCount(0);
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
    await page.getByRole('button', { name: `${done} 1 件を折りたたんでいます`, exact: true }).click();
    const childOpen = page.getByRole('button', { name: `${done} 1 件を閉じる`, exact: true });
    await expect(childOpen).toHaveAttribute('aria-expanded', 'true');
    const childTitle = page
      .locator('.completed-list')
      .getByRole('button', { name: `配下の完了-${suffix}`, exact: true });
    await expectModalFocus(page, {
      opener: childTitle,
      modal: page.getByRole('dialog', { name: `配下の完了-${suffix}`, exact: true }),
      press: 'Enter',
    });
    await page.setViewportSize({ width: 390, height: 844 });
    const layout = createLayoutCheck('backlog');
    await layout.inThemes(page, vocabulary);
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
    await expect(page.getByRole('button', { name: `${done} 1 件を折りたたんでいます`, exact: true })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    expect(await collect()).toEqual([]);
  });
}
