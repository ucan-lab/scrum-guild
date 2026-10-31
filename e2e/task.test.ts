// 一本道: 管理者がワークスペースを作る → タスクを作る → 完了にする → その行に完了の印 → 読み直すと折りたたみの件数が 1。
// 詳細の引き出しで完了にしたタスクは、完了の帯の「戻す」で戻せる。
// seed のセッション（seed/sessions.ts）の Cookie で開く。あおば開発の管理者はミナト。CSP の違反も確かめる
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.ts';
import { createWorkspace, signIn, watchViolations } from './helpers.ts';

test.use({ timezoneId: 'Asia/Tokyo' });

test.beforeEach(async ({ context, baseURL }) => {
  await signIn(context, baseURL, 'admin');
});

test('seed の受託開発チーム: タスクを作って完了にすると、その行に完了の印が出て、読み直すと折りたたみの件数に入る', async ({
  page,
}) => {
  const collect = await watchViolations(page);
  await createWorkspace(page, '一本道ワークスペース');

  // タスクが無いうちは、最初の一歩を示す
  await expect(page.getByText('まだタスクがありません')).toBeVisible();

  await page.getByRole('button', { name: '起票' }).click();
  const dialog = page.getByRole('dialog', { name: '起票' });
  await dialog.getByLabel('タイトル').fill('  見積もりを送る  ');
  await dialog.getByRole('radio', { name: '3', exact: true }).check();
  await dialog.getByRole('button', { name: '起票' }).click();
  await expect(dialog).toBeHidden();
  // ダイアログの中の閉じた領域には、トーストが見えない形で出るので、role で見える領域だけを引く
  await expect(page.getByRole('status').filter({ hasText: 'バックログの末尾に足しました' })).toBeVisible();

  // 読み直さずに、一覧の末尾に出る。ポイントも出る。タイトルは `?task=<ID>` へのリンク
  const row = page.locator('.entry', { hasText: '見積もりを送る' });
  await expect(row).toHaveCount(1);
  await expect(row.getByRole('link', { name: '見積もりを送る' })).toHaveAttribute('href', /\?task=[0-9a-f-]{36}$/);
  await expect(row.locator('.pts')).toHaveText('3');
  await expect(page.locator('.tree-folded')).toHaveCount(0);

  // 完了にする。ボタンは完了の印に替わり、フォーカスは印へ移る。行はその場に残る
  await row.getByRole('button', { name: /完了にする/ }).click();
  // 完了の印の名前にはタイトルを添える。ポイントの印の名前は「ポイント 3」
  await expect(row.getByRole('img', { name: 'ポイント 3' })).toBeVisible();
  const stamp = row.getByRole('img', { name: '見積もりを送る: 完了' });
  await expect(stamp).toBeVisible();
  await expect(stamp).toBeFocused();
  await expect(row.getByRole('button', { name: /完了にする/ })).toHaveCount(0);
  await expect(page.getByRole('status').filter({ hasText: 'タスクを完了にしました' })).toBeVisible();
  // 読み直すまで、折りたたみの件数には入らない
  await expect(page.locator('.tree-folded')).toHaveCount(0);

  // 読み直すと、行は一覧から外れ、親のない完了の件数に入る
  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: 'バックログ' })).toBeVisible();
  await expect(page.locator('.entry')).toHaveCount(0);
  // 未完了が0件で完了済みがあるときは、折りたたみの行の上に次の一歩を示す
  await expect(page.getByText('未完了のタスクはありません')).toBeVisible();
  await expect(page.locator('.tree-folded.is-root')).toHaveText('親のない完了 1 件を折りたたんでいます');
  expect(await collect()).toEqual([]);
});

test('スクラムの言葉: 同じ流れで、言葉がスクラムの言葉になる。ポイントを選ばないと未見積もり', async ({ page }) => {
  const collect = await watchViolations(page);
  await createWorkspace(page, '一本道チーム');
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
  await expect(row.getByRole('img', { name: '未見積もり' })).toBeVisible();
  await expect(row.getByRole('img', { name: '請求書を出す: 完了' })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'タスクを完了にしました' })).toBeVisible();

  await page.reload();
  await expect(page.locator('.tree-folded.is-root')).toHaveText('親のない完了 1 件を折りたたんでいます');
  expect(await collect()).toEqual([]);
});

// 起票のダイアログから、タイトルだけでタスクを1件作る
async function addTask(page: Page, title: string): Promise<void> {
  await page.getByRole('button', { name: '起票' }).click();
  const dialog = page.getByRole('dialog', { name: '起票' });
  await dialog.getByLabel('タイトル').fill(title);
  await dialog.getByRole('button', { name: '起票' }).click();
  await expect(dialog).toBeHidden();
}

test('完了の操作を送っている間は、押せない印と読み上げを出し、応答が来たら完了の印に替わる', async ({ page }) => {
  await createWorkspace(page, '送信中ワークスペース');
  await addTask(page, '遅い応答を待つ');
  const row = page.locator('.entry', { hasText: '遅い応答を待つ' });

  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let requests = 0;
  await page.route('**/api/aoba/task-complete', async (route) => {
    requests++;
    await gate;
    await route.continue();
  });
  const button = row.getByRole('button', { name: /完了にする/ });
  await button.click();
  await expect(button).toHaveAttribute('aria-disabled', 'true');
  await expect(page.getByRole('status').filter({ hasText: '完了にしています' })).toBeAttached();
  // もう一度押しても、送らない
  await button.click({ force: true });
  release();
  await expect(row.getByRole('img', { name: '遅い応答を待つ: 完了' })).toBeVisible();
  expect(requests).toBe(1);
  await expect(page.getByRole('status').filter({ hasText: '完了にしています' })).toHaveCount(0);
});

test('詳細の引き出しで完了にしたタスクは、完了の帯の「戻す」で戻せ、変更の履歴に残る', async ({ page }) => {
  const collect = await watchViolations(page);
  await createWorkspace(page, '戻すワークスペース');
  await addTask(page, '議事録をまとめる');
  await page.locator('.entry', { hasText: '議事録をまとめる' }).getByRole('link', { name: '議事録をまとめる' }).click();
  const drawer = page.getByRole('dialog', { name: '議事録をまとめる' });
  const bar = drawer.locator('.done-bar');
  // 完了していないうちは「戻す」を出さない
  await expect(bar.getByRole('button', { name: /を戻す/ })).toHaveCount(0);
  await bar.getByRole('button', { name: '完了にする', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'タスクを完了にしました' })).toBeVisible();
  await expect(bar.getByRole('img', { name: '完了' })).toBeFocused();

  // 戻すと、確かめずに送り、「完了にする」に替わって、そこへフォーカスが移る
  await bar.getByRole('button', { name: '完了を戻す: 議事録をまとめる' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'タスクの完了を戻しました' })).toBeVisible();
  const completeButton = bar.getByRole('button', { name: '完了にする', exact: true });
  await expect(completeButton).toBeFocused();
  await expect(bar.getByRole('button', { name: /を戻す/ })).toHaveCount(0);
  await drawer.getByRole('tab', { name: '変更の履歴' }).click();
  await expect(drawer.getByRole('tabpanel', { name: '変更の履歴' }).getByText('完了を戻した')).toHaveCount(1);
  await drawer.getByRole('button', { name: '閉じる' }).click();
  await expect(drawer).toBeHidden();

  // 木の行も、完了していない行に戻る
  const row = page.locator('.entry', { hasText: '議事録をまとめる' });
  await expect(row.getByRole('button', { name: /完了にする/ })).toBeVisible();
  expect(await collect()).toEqual([]);
});

test('完了の操作が 404 か workspace_closed を受けたら、一覧を読み直す', async ({ page }) => {
  await createWorkspace(page, '読み直しワークスペース');
  await addTask(page, '読み直しを促す');
  const row = page.locator('.entry', { hasText: '読み直しを促す' });

  let listRequests = 0;
  page.on('request', (request) => {
    if (request.url().endsWith('/api/aoba/backlog-tree')) listRequests++;
  });
  for (const [status, code] of [
    [404, 'not_found'],
    [409, 'workspace_closed'],
  ] as const) {
    const before = listRequests;
    await page.route('**/api/aoba/task-complete', (route) =>
      route.fulfill({ status, json: { error: { code, message: code } } }),
    );
    await row.getByRole('button', { name: /完了にする/ }).click();
    await expect.poll(() => listRequests).toBeGreaterThan(before);
    // 実際のタスクは完了にしていないので、読み直した一覧に行が残る
    await expect(row).toHaveCount(1);
    await expect(row.getByRole('button', { name: /完了にする/ })).toBeVisible();
  }
});

test('選んだ担当が所属を外れていたら、理由を出し、候補を読み直して担当なしに戻し、担当の選択欄にフォーカスを移す', async ({
  page,
}) => {
  await createWorkspace(page, '担当の外れたワークスペース');
  // 送ったときだけ 404 にする（親は選ばないので、外れたのは担当）
  await page.route('**/api/aoba/task-create', async (route) => {
    await route.fulfill({ status: 404, json: { error: { code: 'not_found', message: 'not_found' } } });
  });
  await page.getByRole('button', { name: '起票' }).click();
  const dialog = page.getByRole('dialog', { name: '起票' });
  await dialog.getByLabel('タイトル').fill('外れた人に頼む');
  const assignee = dialog.getByRole('combobox', { name: '担当' });
  await expect(assignee.getByRole('option', { name: 'ミナト' })).toBeAttached();
  await assignee.selectOption({ label: 'ミナト' });
  await dialog.getByRole('button', { name: '起票' }).click();
  await expect(
    dialog.getByText('選んだ人は、もうこのワークスペースにいません。担当を選び直してください'),
  ).toBeVisible();
  await expect(assignee).toHaveValue('');
  await expect(assignee).toBeFocused();
  await expect(dialog).toBeVisible();
});
