// ワークスペースの設定の列の節（ColumnsSetting）。リーダーが列を足し、名前を直し、ボタンとキーで並べ替え、
// 移し先を選んで削除し、スプリントの画面で移ったのを見る。完了の列は末尾に固定で、名前は辞書の言葉で出る。
// 自分で作ったワークスペースで行う（seed の行は他の e2e も読むため）
import type { Page } from '@playwright/test';
import { columnDelete } from '../src/shared/operations/column/index.ts';
import { expect, test } from './fixtures.ts';
import { createWorkspace, signIn, watchViolations } from './helpers.ts';
import { failOperation } from './operations.ts';

test.use({ timezoneId: 'Asia/Tokyo' });

async function openSettings(page: Page): Promise<void> {
  // 「自分の設定」の項目にも当たらないよう、全体が「設定」の項目だけを選ぶ
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
  await expect(page.locator('.entry', { hasText: title })).toBeVisible();
}

// スプリントを作って 2 件入れ、始める（先頭の列にカードが並ぶ）
async function startSprintWith(page: Page, name: string, startOn: string, titles: string[]): Promise<void> {
  await page.getByRole('link', { name: '計画' }).click();
  await page.getByRole('button', { name: 'スプリントを作る' }).click();
  const create = page.getByRole('dialog', { name: 'スプリントを作る' });
  await create.getByLabel('開始日').fill(startOn);
  await create.getByLabel('長さ（日）').fill('14');
  await create.getByLabel('名前（任意）').fill(name);
  await create.getByRole('button', { name: '作る' }).click();
  await expect(create).toBeHidden();
  await page.getByRole('button', { name: `バックログから入れる: スプリント ${name}` }).click();
  const picker = page.getByRole('dialog', { name: `スプリント ${name} に入れる` });
  for (const title of titles) {
    await picker
      .getByRole('group', { name: '入れるタスク' })
      .getByRole('checkbox', { name: new RegExp(`^${title}`) })
      .check();
  }
  await picker.getByRole('button', { name: `${titles.length} 件入れる` }).click();
  await expect(picker).toBeHidden();
  await page.getByRole('button', { name: `始める: スプリント ${name}` }).click();
  const start = page.getByRole('dialog', { name: 'スプリントを始める' });
  await start.getByRole('button', { name: '始める' }).click();
  await expect(start).toBeHidden();
  await expect(page.locator('.lane', { hasText: name }).locator('.chip.is-ok')).toHaveText('進行中');
}

test('リーダーは列を足し、名前を直し、ボタンとキーで並べ替え、移し先を選んで削除し、スプリントの画面で移ったのを見る', async ({
  page,
  context,
  baseURL,
}) => {
  // 起票からスプリントを始めて設定で直すまでを1本で確かめる長い流れ。ほかのファイルと並べて走ると既定の 30 秒を超えうる
  test.setTimeout(90_000);
  await signIn(context, baseURL, 'admin');
  const collect = await watchViolations(page);
  await createWorkspace(page, '列の見張り番');
  for (const title of ['A札', 'B札']) await addTask(page, title);
  await startSprintWith(page, '第1回', '2099-05-03', ['A札', 'B札']);

  await openSettings(page);
  const columns = page.getByRole('list', { name: '列の一覧' });
  const rows = columns.locator('li');
  const status = (text: string | RegExp) => page.getByRole('status').filter({ hasText: text });

  // 作った直後の列。完了の列は末尾に固定で、動かせず、削除もできず、名前は辞書の言葉
  await expect(rows).toHaveText([/未着手/, /作業中/, /レビュー/, /完了/]);
  const done = columns.locator('li[data-done-column]');
  await expect(done).toContainText('常に末尾');
  await expect(done.getByRole('button')).toHaveCount(0);
  // 入っているタスクの数。削除の確かめの前に分かる
  await expect(rows.nth(0)).toContainText('削除すると 2 件を移す');

  // 足す。完了の列の手前に入る。同じ名前は断る
  await page.getByLabel('新しい列の名前').fill('公開待ち');
  await page.getByRole('button', { name: '列を足す' }).click();
  await expect(rows).toHaveText([/未着手/, /作業中/, /レビュー/, /公開待ち/, /完了/]);
  await page.getByLabel('新しい列の名前').fill('レビュー');
  await page.getByRole('button', { name: '列を足す' }).click();
  await expect(page.getByRole('alert').filter({ hasText: '同じ名前の列があります' })).toBeVisible();
  await page.getByLabel('新しい列の名前').fill('');

  // 名前を直す
  await columns.getByRole('button', { name: /^公開待ち/ }).click();
  const nameInput = columns.getByLabel('列の名前');
  await nameInput.fill('公開確認');
  await nameInput.press('Enter');
  await expect(rows).toHaveText([/未着手/, /作業中/, /レビュー/, /公開確認/, /完了/]);

  // 並べ替える。ボタンで1つ上へ、フォーカスは同じボタンに残り、そのままキーでもう1つ上へ
  await columns.getByRole('button', { name: '上へ: 公開確認' }).click();
  await expect(rows).toHaveText([/未着手/, /作業中/, /公開確認/, /レビュー/, /完了/]);
  const up = columns.getByRole('button', { name: '上へ: 公開確認' });
  await expect(up).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(rows).toHaveText([/未着手/, /公開確認/, /作業中/, /レビュー/, /完了/]);
  // 先頭の「上へ」は押せない。完了の列は最後のまま
  await expect(columns.getByRole('button', { name: '上へ: 未着手' })).toHaveAttribute('aria-disabled', 'true');
  await expect(columns.getByRole('button', { name: '下へ: レビュー' })).toHaveAttribute('aria-disabled', 'true');
  await page.reload();
  await expect(rows).toHaveText([/未着手/, /公開確認/, /作業中/, /レビュー/, /完了/]);

  // タスクの残る列を削除する。移し先を選ぶ確かめが出て、選んだ列の末尾へ移る
  await columns.getByRole('button', { name: '削除: 未着手' }).click();
  const confirm = page.getByRole('dialog', { name: '「未着手」を削除する' });
  await expect(confirm).toContainText('2 件のタスクが残っています');
  await confirm.getByLabel('移し先の列').selectOption({ label: '作業中' });
  await confirm.getByRole('button', { name: '削除する' }).click();
  await expect(confirm).toBeHidden();
  await expect(status('「未着手」を削除し、2 件のタスクを「作業中」へ移しました')).toBeVisible();
  await expect(rows).toHaveText([/公開確認/, /作業中/, /レビュー/, /完了/]);
  await expect(rows.nth(1)).toContainText('削除すると 2 件を移す');

  // スプリントの画面は、設定の並びの列にカードを出す
  await page.getByRole('link', { name: 'スプリント', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'スプリント 第1回' })).toBeVisible();
  await expect(page.locator('.board-col-name')).toHaveText(['公開確認', '作業中', 'レビュー', '完了']);
  const titlesIn = (column: string) => page.getByRole('region', { name: column, exact: true }).locator('.card-title');
  await expect(titlesIn('作業中')).toHaveText(['A札', 'B札']);
  await expect(titlesIn('公開確認')).toHaveText([]);

  // 残るタスクの無い列は、確かめだけで削除でき、最後の1つの列は削除できない
  await openSettings(page);
  for (const name of ['公開確認', 'レビュー']) {
    await columns.getByRole('button', { name: `削除: ${name}` }).click();
    const empty = page.getByRole('dialog', { name: `「${name}」を削除する` });
    await expect(empty).toContainText('移すタスクはありません。終了したスプリントのタスクは変わりません。');
    await expect(empty.getByLabel('移し先の列')).toHaveCount(0);
    await empty.getByRole('button', { name: '削除する' }).click();
    await expect(empty).toBeHidden();
    await expect(status(`「${name}」を削除しました`)).toBeVisible();
  }
  await expect(rows).toHaveText([/作業中/, /完了/]);
  const last = columns.getByRole('button', { name: '削除: 作業中' });
  await expect(last).toHaveAttribute('aria-disabled', 'true');
  // 押せない理由は、title だけでなく見える文字でも伝え、ボタンの説明に結ぶ
  await expect(page.getByText('最後の列は削除できません', { exact: true })).toBeVisible();
  await expect(last).toHaveAccessibleDescription('最後の列は削除できません');
  await last.click({ force: true });
  await expect(page.getByRole('dialog')).toHaveCount(0);
  // 同じ名前の列を足して断られた 409 のほかに、コンソールのエラーも CSP の違反も出ない
  expect(await collect()).toEqual(['Failed to load resource: the server responded with a status of 409 (Conflict)']);
});

test('削除が 404 で断られたら、削除する列か移し先の列が見つからないと伝えて読み直す', async ({
  page,
  context,
  baseURL,
}) => {
  await signIn(context, baseURL, 'admin');
  await createWorkspace(page, '見つからない列の確認');
  await openSettings(page);
  const columns = page.getByRole('list', { name: '列の一覧' });
  const unroute = await failOperation(page, columnDelete, { slug: 'aoba' }, 404, 'not_found');
  await columns.getByRole('button', { name: '削除: レビュー' }).click();
  await page.getByRole('dialog', { name: '「レビュー」を削除する' }).getByRole('button', { name: '削除する' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: '削除する列か移し先の列が見つかりません。一覧を読み直します' }),
  ).toBeVisible();
  await unroute();
  // 本物の API へ戻すと、列は消えておらず、読み直した一覧に残っている
  await expect(columns.locator('li')).toHaveText([/未着手/, /作業中/, /レビュー/, /完了/]);
});

test('作ったワークスペースでは、列の節の見出しと完了の列の名前が辞書の言葉になり、付けた列の名前はそのまま', async ({
  page,
  context,
  baseURL,
}) => {
  await signIn(context, baseURL, 'admin');
  await createWorkspace(page, '列の確認チーム');
  await openSettings(page);
  await expect(page.getByRole('heading', { level: 2, name: '列', exact: true })).toBeVisible();
  const columns = page.getByRole('list', { name: '列の一覧' });
  await expect(columns.locator('li')).toHaveText([/未着手/, /作業中/, /レビュー/, /完了/]);
  await page.getByLabel('新しい列の名前').fill('出発前');
  await page.getByRole('button', { name: '列を足す' }).click();
  await expect(columns.locator('li')).toHaveText([/未着手/, /作業中/, /レビュー/, /出発前/, /完了/]);
  await expect(columns.locator('li[data-done-column]')).toContainText('常に末尾');
});
