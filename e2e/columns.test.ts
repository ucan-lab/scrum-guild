// ワークスペースの設定の列の節（ColumnsSetting）。リーダーが列を足し、名前を直し、ボタンとキーで並べ替え、
// 移し先を選んで削除し、スプリントの画面で移ったのを見る。完了の列は末尾に固定で、名前は言葉づかいに合わせて出る。
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
  await page.getByRole('button', { name: '依頼を出す' }).click();
  const dialog = page.getByRole('dialog', { name: '依頼を出す' });
  await dialog.getByLabel('タイトル').fill(title);
  await dialog.getByRole('button', { name: '依頼を出す' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('.entry', { hasText: title })).toBeVisible();
}

// 遠征を作って 2 件入れ、始める（先頭の列にカードが並ぶ）
async function startSprintWith(page: Page, name: string, startOn: string, titles: string[]): Promise<void> {
  await page.getByRole('link', { name: '遠征の計画' }).click();
  await page.getByRole('button', { name: '遠征を作る' }).click();
  const create = page.getByRole('dialog', { name: '遠征を作る' });
  await create.getByLabel('開始日').fill(startOn);
  await create.getByLabel('長さ（日）').fill('14');
  await create.getByLabel('名前（任意）').fill(name);
  await create.getByRole('button', { name: '作る' }).click();
  await expect(create).toBeHidden();
  await page.getByRole('button', { name: `掲示板から入れる: 遠征 ${name}` }).click();
  const picker = page.getByRole('dialog', { name: `遠征 ${name} に入れる` });
  for (const title of titles) {
    await picker
      .getByRole('group', { name: '入れるクエスト' })
      .getByRole('checkbox', { name: new RegExp(`^${title}`) })
      .check();
  }
  await picker.getByRole('button', { name: `${titles.length} 件入れる` }).click();
  await expect(picker).toBeHidden();
  await page.getByRole('button', { name: `始める: 遠征 ${name}` }).click();
  const start = page.getByRole('dialog', { name: '遠征を始める' });
  await start.getByRole('button', { name: '始める' }).click();
  await expect(start).toBeHidden();
  await expect(page.locator('.lane', { hasText: name }).locator('.chip.is-ok')).toHaveText('進行中');
}

test('リーダーは行程を足し、名前を直し、ボタンとキーで並べ替え、移し先を選んで削除し、遠征の画面で移ったのを見る', async ({
  page,
  context,
  baseURL,
}) => {
  // 起票から遠征を始めて設定で直すまでを1本で確かめる長い流れ。ほかのファイルと並べて走ると既定の 30 秒を超えうる
  test.setTimeout(90_000);
  await signIn(context, baseURL, 'admin');
  const collect = await watchViolations(page);
  await createWorkspace(page, '行程の見張り番', 'game');
  for (const title of ['A札', 'B札']) await addTask(page, title);
  await startSprintWith(page, '第1回', '2099-05-03', ['A札', 'B札']);

  await openSettings(page);
  const columns = page.getByRole('list', { name: '行程の一覧' });
  const rows = columns.locator('li');
  const status = (text: string | RegExp) => page.getByRole('status').filter({ hasText: text });

  // 作った直後の行程。完遂の行程は末尾に固定で、動かせず、削除もできず、名前は言葉づかいに合わせた言葉
  await expect(rows).toHaveText([/出発前/, /遂行中/, /査定中/, /完遂/]);
  const done = columns.locator('li[data-done-column]');
  await expect(done).toContainText('常に末尾');
  await expect(done.getByRole('button')).toHaveCount(0);
  // 入っているクエストの数。削除の確かめの前に分かる
  await expect(rows.nth(0)).toContainText('削除すると 2 件を移す');

  // 足す。完遂の行程の手前に入る。同じ名前は断る
  await page.getByLabel('新しい行程の名前').fill('公開待ち');
  await page.getByRole('button', { name: '行程を足す' }).click();
  await expect(rows).toHaveText([/出発前/, /遂行中/, /査定中/, /公開待ち/, /完遂/]);
  await page.getByLabel('新しい行程の名前').fill('査定中');
  await page.getByRole('button', { name: '行程を足す' }).click();
  await expect(page.getByRole('alert').filter({ hasText: '同じ名前の行程があります' })).toBeVisible();
  await page.getByLabel('新しい行程の名前').fill('');

  // 名前を直す
  await columns.getByRole('button', { name: /^公開待ち/ }).click();
  const nameInput = columns.getByLabel('行程の名前');
  await nameInput.fill('公開確認');
  await nameInput.press('Enter');
  await expect(rows).toHaveText([/出発前/, /遂行中/, /査定中/, /公開確認/, /完遂/]);

  // 並べ替える。ボタンで1つ上へ、フォーカスは同じボタンに残り、そのままキーでもう1つ上へ
  await columns.getByRole('button', { name: '上へ: 公開確認' }).click();
  await expect(rows).toHaveText([/出発前/, /遂行中/, /公開確認/, /査定中/, /完遂/]);
  const up = columns.getByRole('button', { name: '上へ: 公開確認' });
  await expect(up).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(rows).toHaveText([/出発前/, /公開確認/, /遂行中/, /査定中/, /完遂/]);
  // 先頭の「上へ」は押せない。完遂の行程は最後のまま
  await expect(columns.getByRole('button', { name: '上へ: 出発前' })).toHaveAttribute('aria-disabled', 'true');
  await expect(columns.getByRole('button', { name: '下へ: 査定中' })).toHaveAttribute('aria-disabled', 'true');
  await page.reload();
  await expect(rows).toHaveText([/出発前/, /公開確認/, /遂行中/, /査定中/, /完遂/]);

  // クエストの残る行程を削除する。移し先を選ぶ確かめが出て、選んだ行程の末尾へ移る
  await columns.getByRole('button', { name: '削除: 出発前' }).click();
  const confirm = page.getByRole('dialog', { name: '「出発前」を削除する' });
  await expect(confirm).toContainText('2 件のクエストが残っています');
  await confirm.getByLabel('移し先の行程').selectOption({ label: '遂行中' });
  await confirm.getByRole('button', { name: '削除する' }).click();
  await expect(confirm).toBeHidden();
  await expect(status('「出発前」を削除し、2 件のクエストを「遂行中」へ移しました')).toBeVisible();
  await expect(rows).toHaveText([/公開確認/, /遂行中/, /査定中/, /完遂/]);
  await expect(rows.nth(1)).toContainText('削除すると 2 件を移す');

  // 遠征の画面は、設定の並びの行程にカードを出す
  await page.getByRole('link', { name: '遠征', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: '遠征 第1回' })).toBeVisible();
  await expect(page.locator('.board-col-name')).toHaveText(['公開確認', '遂行中', '査定中', '完遂']);
  const titlesIn = (column: string) => page.getByRole('region', { name: column, exact: true }).locator('.card-title');
  await expect(titlesIn('遂行中')).toHaveText(['A札', 'B札']);
  await expect(titlesIn('公開確認')).toHaveText([]);

  // 残るクエストの無い行程は、確かめだけで削除でき、最後の1つの行程は削除できない
  await openSettings(page);
  for (const name of ['公開確認', '査定中']) {
    await columns.getByRole('button', { name: `削除: ${name}` }).click();
    const empty = page.getByRole('dialog', { name: `「${name}」を削除する` });
    await expect(empty).toContainText('移すクエストはありません。終了した遠征のクエストは変わりません。');
    await expect(empty.getByLabel('移し先の行程')).toHaveCount(0);
    await empty.getByRole('button', { name: '削除する' }).click();
    await expect(empty).toBeHidden();
    await expect(status(`「${name}」を削除しました`)).toBeVisible();
  }
  await expect(rows).toHaveText([/遂行中/, /完遂/]);
  const last = columns.getByRole('button', { name: '削除: 遂行中' });
  await expect(last).toHaveAttribute('aria-disabled', 'true');
  // 押せない理由は、title だけでなく見える文字でも伝え、ボタンの説明に結ぶ
  await expect(page.getByText('最後の行程は削除できません', { exact: true })).toBeVisible();
  await expect(last).toHaveAccessibleDescription('最後の行程は削除できません');
  await last.click({ force: true });
  await expect(page.getByRole('dialog')).toHaveCount(0);
  // 同じ名前の行程を足して断られた 409 のほかに、コンソールのエラーも CSP の違反も出ない
  expect(await collect()).toEqual(['Failed to load resource: the server responded with a status of 409 (Conflict)']);
});

test('削除が 404 で断られたら、削除する行程か移し先の行程が見つからないと伝えて読み直す', async ({
  page,
  context,
  baseURL,
}) => {
  await signIn(context, baseURL, 'admin');
  await createWorkspace(page, '見つからない行程の確認', 'game');
  await openSettings(page);
  const columns = page.getByRole('list', { name: '行程の一覧' });
  const unroute = await failOperation(page, columnDelete, { slug: 'aoba' }, 404, 'not_found');
  await columns.getByRole('button', { name: '削除: 査定中' }).click();
  await page.getByRole('dialog', { name: '「査定中」を削除する' }).getByRole('button', { name: '削除する' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: '削除する行程か移し先の行程が見つかりません。一覧を読み直します' }),
  ).toBeVisible();
  await unroute();
  // 本物の API へ戻すと、行程は消えておらず、読み直した一覧に残っている
  await expect(columns.locator('li')).toHaveText([/出発前/, /遂行中/, /査定中/, /完遂/]);
});

test('スクラムの言葉では、列の節の見出しと完了の列の名前がスクラムの言葉になり、付けた列の名前はそのまま', async ({
  page,
  context,
  baseURL,
}) => {
  await signIn(context, baseURL, 'admin');
  await createWorkspace(page, '列の確認チーム', 'scrum');
  await openSettings(page);
  await expect(page.getByRole('heading', { level: 2, name: '列', exact: true })).toBeVisible();
  const columns = page.getByRole('list', { name: '列の一覧' });
  await expect(columns.locator('li')).toHaveText([/未着手/, /作業中/, /レビュー/, /完了/]);
  await page.getByLabel('新しい列の名前').fill('出発前');
  await page.getByRole('button', { name: '列を足す' }).click();
  await expect(columns.locator('li')).toHaveText([/未着手/, /作業中/, /レビュー/, /出発前/, /完了/]);
  await expect(columns.locator('li[data-done-column]')).toContainText('常に末尾');
});
