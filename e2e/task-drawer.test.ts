// 一本道: タスクを作る → 行のリンクで引き出しを開く → 属性を直す → 本文に <script> を含む Markdown を書く（描かれた本文に CSP の違反が無い）
// → 書きかけのまま閉じると確かめる → 削除すると木から消える。
// seed のセッション（seed/sessions.ts）の Cookie で開く。あおば開発の管理者はミナト
import { expect, test, type Page } from '@playwright/test';
import { createWorkspace, signIn, watchViolations } from './helpers.ts';

test.use({ timezoneId: 'Asia/Tokyo' });

test.beforeEach(async ({ context, baseURL }) => {
  await signIn(context, baseURL, 'admin');
});

// 起票のダイアログから、タイトルだけでタスクを1件作る（ゲームの言葉）
async function addTask(page: Page, title: string): Promise<void> {
  await page.getByRole('button', { name: '依頼を出す' }).click();
  const dialog = page.getByRole('dialog', { name: '依頼を出す' });
  await dialog.getByLabel('タイトル').fill(title);
  await dialog.getByRole('button', { name: '依頼を出す' }).click();
  await expect(dialog).toBeHidden();
}

const MARKDOWN = [
  '# 手順',
  '',
  '- 見積もりを作る',
  '- <script>window.__injected = true</script>',
  '',
  '<img src=x onerror="window.__injected = true"> と [危ない](javascript:alert(1))',
].join('\n');

test('開く → 属性を直す → 本文に script を含む Markdown を書く → 書きかけで閉じると確かめる → 削除すると木から消える', async ({
  page,
}) => {
  const collect = await watchViolations(page);
  await createWorkspace(page, '引き出しパーティ', 'game');
  await addTask(page, '見積もりを送る');

  // 行のリンクで開く。見出しにフォーカスが移り、URL に ?task=<ID> が付く
  // タイトルを直した後も同じ行を指せるよう、直す前後に共通の文字で探す
  const row = page.locator('.entry', { hasText: '見積もりを送' });
  await row.getByRole('link', { name: '見積もりを送る' }).click();
  const drawer = page.getByRole('dialog', { name: /見積もりを送/ });
  await expect(drawer).toBeVisible();
  await expect(page).toHaveURL(/\?task=[0-9a-f-]{36}$/);
  await expect(drawer).toHaveAttribute('aria-modal', 'true');
  await expect(drawer.getByRole('heading', { level: 2 })).toBeFocused();

  // 難易度は選んだら保存し、その場で木の行に反映する
  await drawer.getByRole('radio', { name: '5', exact: true }).check();
  await expect(page.getByRole('status').filter({ hasText: '保存しました' })).toBeVisible();
  await expect(row.locator('.pts')).toHaveText('5');

  // 期限も選んだら保存する。木の行に期日の印が出る
  await drawer.getByLabel('期限').fill('2099-12-31');
  await expect(row.locator('.chip')).toBeVisible();
  await drawer.getByLabel('期限').fill('');
  await expect(row.locator('.chip')).toHaveCount(0);

  // タイトルは押すと入力欄になり、Enter で確定する。行のタイトルが変わる
  await drawer.getByRole('button', { name: /見積もりを送る/ }).click();
  const titleInput = drawer.getByRole('textbox', { name: 'タイトル' });
  await expect(titleInput).toBeFocused();
  await titleInput.fill('見積もりを送って確かめる');
  await titleInput.press('Enter');
  await expect(row.getByRole('link', { name: '見積もりを送って確かめる' })).toBeVisible();
  await expect(drawer.getByRole('button', { name: /見積もりを送って確かめる/ })).toBeFocused();

  // リンクは押すと入力欄になり、Esc で元に戻る
  await drawer.getByRole('button', { name: /リンクを足す/ }).click();
  await drawer.getByRole('textbox', { name: 'リンク' }).fill('ftp://example.com');
  await drawer.getByRole('button', { name: '保存', exact: true }).click();
  await expect(drawer.getByText('http か https で始まる URL を入れてください')).toBeVisible();
  await drawer.getByRole('textbox', { name: 'リンク' }).press('Escape');
  await expect(drawer.getByRole('textbox', { name: 'リンク' })).toHaveCount(0);
  await expect(drawer).toBeVisible();
  await drawer.getByRole('button', { name: /リンクを足す/ }).click();
  await drawer.getByRole('textbox', { name: 'リンク' }).fill('https://example.com/spec');
  await drawer.getByRole('button', { name: '保存', exact: true }).click();
  await expect(drawer.getByRole('link', { name: 'リンクを新しいタブで開く' })).toHaveAttribute(
    'href',
    'https://example.com/spec',
  );

  // 本文は「編集」で書く欄に替わる。script を含む Markdown を保存すると、描かれた本文は文字で出て、スクリプトは動かない
  await drawer.getByRole('button', { name: '編集' }).click();
  await drawer.getByRole('textbox', { name: '本文' }).fill(MARKDOWN);
  await drawer.getByRole('button', { name: '保存', exact: true }).click();
  const body = drawer.locator('.doc-box');
  await expect(body.getByRole('heading', { level: 3, name: '手順' })).toBeVisible();
  await expect(body.getByText('<script>window.__injected = true</script>')).toBeVisible();
  await expect(body.locator('script, img')).toHaveCount(0);
  await expect(body.getByRole('link')).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { __injected?: boolean }).__injected)).toBeUndefined();

  // 書きかけのまま閉じると、捨てるかを確かめる。書き続けると引き出しは開いたまま
  await drawer.getByRole('button', { name: /見積もりを送って確かめる/ }).click();
  await drawer.getByRole('textbox', { name: 'タイトル' }).fill('書きかけのタイトル');
  await drawer.getByRole('button', { name: '閉じる' }).click();
  const confirm = page.getByRole('dialog', { name: '書きかけを捨てますか' });
  await expect(confirm).toBeVisible();
  await confirm.getByRole('button', { name: '書き続ける' }).click();
  await expect(confirm).toBeHidden();
  await expect(drawer.getByRole('textbox', { name: 'タイトル' })).toHaveValue('書きかけのタイトル');
  // 捨てると、引き出しが閉じて、フォーカスが開いた行のリンクへ戻る。タイトルは元のまま
  await drawer.getByRole('button', { name: '閉じる' }).click();
  await page.getByRole('dialog', { name: '書きかけを捨てますか' }).getByRole('button', { name: '捨てる' }).click();
  await expect(drawer).toBeHidden();
  await expect(page).not.toHaveURL(/\?task=/);
  await expect(row.getByRole('link', { name: '見積もりを送って確かめる' })).toBeFocused();

  // 開き直すと保存した値が出る。Esc で閉じる（書きかけが無いので確かめない）
  await row.getByRole('link', { name: '見積もりを送って確かめる' }).click();
  await expect(drawer.locator('.doc-box').getByRole('heading', { name: '手順' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();
  await expect(row.getByRole('link', { name: '見積もりを送って確かめる' })).toBeFocused();

  // 削除は確認を挟む。やめると残り、削除すると引き出しが閉じて、木から消える
  await row.getByRole('link', { name: '見積もりを送って確かめる' }).click();
  await drawer.getByRole('button', { name: 'このクエストを削除する' }).click();
  const deleteConfirm = page.getByRole('dialog', { name: 'クエストを削除する' });
  await deleteConfirm.getByRole('button', { name: 'やめる' }).click();
  await expect(drawer).toBeVisible();
  await drawer.getByRole('button', { name: 'このクエストを削除する' }).click();
  await deleteConfirm.getByRole('button', { name: '削除する' }).click();
  await expect(drawer).toBeHidden();
  await expect(page.getByRole('status').filter({ hasText: 'クエストを削除しました' })).toBeVisible();
  await expect(page.locator('.entry', { hasText: '見積もりを送って確かめる' })).toHaveCount(0);
  await expect(page).not.toHaveURL(/\?task=/);

  expect(await collect()).toEqual([]);
});

test('完了したタスクの難易度は直せず、理由を添える。ほかの属性は直せる', async ({ page }) => {
  await createWorkspace(page, '完了の引き出しパーティ', 'game');
  await addTask(page, '済んだ依頼');
  const row = page.locator('.entry', { hasText: '済んだ依頼' });
  await row.getByRole('link', { name: '済んだ依頼' }).click();
  const drawer = page.getByRole('dialog', { name: '済んだ依頼' });
  await drawer.getByRole('radio', { name: '3', exact: true }).check();
  await expect(row.locator('.pts')).toHaveText('3');
  await drawer.getByRole('button', { name: '閉じる' }).click();

  await row.getByRole('button', { name: /完遂にする/ }).click();
  await expect(row.getByRole('img', { name: '済んだ依頼: 完遂' })).toBeVisible();
  await row.getByRole('link', { name: '済んだ依頼' }).click();
  await expect(drawer.getByText('完遂を戻すと直せます')).toBeVisible();
  for (const radio of await drawer.getByRole('radio').all()) await expect(radio).toBeDisabled();
  // 期限は完了の後も直せる
  await drawer.getByLabel('期限').fill('2099-01-02');
  await expect(page.getByRole('status').filter({ hasText: '保存しました' })).toBeVisible();
});

test('広げると aria-modal が外れ、左のメニューを押せる。広げた形は次に開くときも残る', async ({ page }) => {
  await createWorkspace(page, '広げるパーティ', 'game');
  await addTask(page, '広げて読む');
  const row = page.locator('.entry', { hasText: '広げて読む' });
  await row.getByRole('link', { name: '広げて読む' }).click();
  const drawer = page.getByRole('dialog', { name: '広げて読む' });
  await expect(drawer).toHaveAttribute('aria-modal', 'true');
  await drawer.getByRole('button', { name: '広げる' }).click();
  await expect(drawer).toHaveAttribute('aria-modal', 'false');
  await expect(drawer).toHaveClass(/is-full/);
  await expect(drawer.getByRole('button', { name: '横に戻す' })).toBeFocused();
  // 広げている間は、左のメニューが操作できる
  await expect(page.getByRole('navigation').first()).not.toHaveAttribute('inert', '');

  await drawer.getByRole('button', { name: '閉じる' }).click();
  await row.getByRole('link', { name: '広げて読む' }).click();
  await expect(drawer).toHaveClass(/is-full/);
  await drawer.getByRole('button', { name: '横に戻す' }).click();
  await expect(drawer).toHaveAttribute('aria-modal', 'true');
});

test('存在しないタスクの ID で開くと、トーストで知らせて閉じる', async ({ page }) => {
  await createWorkspace(page, '見つからないパーティ', 'game');
  const url = new URL(page.url());
  await page.goto(`${url.pathname}?task=019a0000-0000-7000-8000-00000000ffff`);
  await expect(page.getByRole('status').filter({ hasText: 'このクエストは見つかりません' })).toBeVisible();
  await expect(page).not.toHaveURL(/\?task=/);
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('閉じたワークスペースは読み取り専用で開く（seed のひばり工房ではなく、画面の応答を差し替えて確かめる）', async ({
  page,
}) => {
  await createWorkspace(page, '閉じたパーティ', 'game');
  await addTask(page, '読むだけ');
  const row = page.locator('.entry', { hasText: '読むだけ' });
  // ワークスペースの情報だけを閉じた状態に差し替える
  await page.route('**/api/aoba/workspace', async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as Record<string, unknown>;
    await route.fulfill({ response, json: { ...body, closed_at: '2026-10-20T00:00:00.000Z' } });
  });
  await page.reload();
  await page.locator('.entry', { hasText: '読むだけ' }).getByRole('link', { name: '読むだけ' }).click();
  const drawer = page.getByRole('dialog', { name: '読むだけ' });
  await expect(drawer.getByText('閉じたパーティのクエストは、読み取りだけできます')).toBeVisible();
  await expect(drawer.getByRole('button', { name: '編集' })).toHaveCount(0);
  await expect(drawer.getByRole('button', { name: /削除する/ })).toHaveCount(0);
  for (const radio of await drawer.getByRole('radio').all()) await expect(radio).toBeDisabled();
  await expect(row).toHaveCount(1);
});

// 長い本文: 順序付きリスト（3 から始まる）、チェックリスト、表を、描き終わった後に確かめる。
// 描画を分ける実装（#168）が入っても、番号の start、表の見出し、id の一意、CSP が崩れないこと。
// 描き終わりは、枠の aria-busy が外れて、最後の行までそろった時点
test('長い本文（順序付きリスト、チェックリスト、表）を描き終わると、start、表の見出し、id の一意、CSP が保たれる', async ({
  page,
}) => {
  const ORDERED = 200;
  const CHECKS = 200;
  const ROWS = 300;
  const collect = await watchViolations(page);
  await createWorkspace(page, '長い本文パーティ', 'game');
  await addTask(page, '長い本文');
  const markdown = [
    ...Array.from({ length: ORDERED }, (_, i) => `${i + 3}. 項`),
    '',
    '区切りの段落',
    '',
    ...Array.from({ length: CHECKS }, (_, i) => `- [${i % 2 === 0 ? 'x' : ' '}] 確認`),
    '',
    '| 番号 | 名前 | 状態 |',
    '| --- | :---: | ---: |',
    ...Array.from({ length: ROWS }, (_, i) => `| ${i + 1} | 行 | 済 |`),
  ].join('\n');
  // 本文の上限（1 万字）に収まる大きさで書く
  expect([...markdown].length).toBeLessThan(10_000);

  await page.locator('.entry', { hasText: '長い本文' }).getByRole('link', { name: '長い本文' }).click();
  const drawer = page.getByRole('dialog', { name: '長い本文' });
  await drawer.getByRole('button', { name: '編集' }).click();
  await drawer.getByRole('textbox', { name: '本文' }).fill(markdown);
  await drawer.getByRole('button', { name: '保存', exact: true }).click();

  const body = drawer.locator('.doc-box');
  await expect(body.locator('tbody tr')).toHaveCount(ROWS, { timeout: 30_000 });
  await expect(body.locator('[aria-busy="true"]')).toHaveCount(0);
  // 時間切れで文字のまま出す形（is-plain）に落ちていない
  await expect(drawer.locator('.doc-box.is-plain')).toHaveCount(0);

  // 順序付きリストは 3 から始まり、200 項目がそろう
  const ordered = body.locator('ol:not(:has(.is-task))').first();
  await expect(ordered).toHaveAttribute('start', '3');
  await expect(ordered.locator('> li')).toHaveCount(ORDERED);
  // チェックリスト。箱は項目の中身と結ばれ、押せない
  await expect(body.locator('li.is-task')).toHaveCount(CHECKS);
  await expect(body.locator('li.is-task > input[type="checkbox"]:checked')).toHaveCount(CHECKS / 2);
  await expect(body.locator('li.is-task > input[type="checkbox"]:disabled')).toHaveCount(CHECKS);
  // 表の見出し（3 列）が欠けず、列の寄せが付く
  const headers = body.locator('thead th');
  await expect(headers).toHaveText(['番号', '名前', '状態']);
  await expect(headers.nth(0)).toHaveAttribute('scope', 'col');
  await expect(body.locator('tbody tr').last().locator('td').first()).toHaveText(String(ROWS));

  // ページの中の id が重複していない
  const duplicates = await page.evaluate(() => {
    const seen = new Map<string, number>();
    for (const element of document.querySelectorAll('[id]')) seen.set(element.id, (seen.get(element.id) ?? 0) + 1);
    return [...seen].filter(([, count]) => count > 1).map(([id]) => id);
  });
  expect(duplicates).toEqual([]);
  expect(await collect()).toEqual([]);
});
