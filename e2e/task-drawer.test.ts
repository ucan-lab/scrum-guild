// 一本道: タスクを作る → 行のリンクで引き出しを開く → 属性を直す → 本文に <script> を含む Markdown を書く（描かれた本文に CSP の違反が無い）
// → 書きかけのまま閉じると確かめる → 削除すると木から消える。
// seed のセッション（seed/sessions.ts）の Cookie で開く。あおば開発の管理者はミナト
import type { Locator, Page } from '@playwright/test';
import { expect, test } from './fixtures.ts';
import type { ErrorCode } from '../src/shared/errors.ts';
import type { InputOf } from '../src/shared/operations/define.ts';
import { organizationInfo } from '../src/shared/operations/organization/organization.ts';
import { taskAssign } from '../src/shared/operations/task/task-assign.ts';
import { taskDetail } from '../src/shared/operations/task/task-detail.ts';
import { taskHistory } from '../src/shared/operations/task/task-history.ts';
import { taskUpdate } from '../src/shared/operations/task/task-update.ts';
import { memberList } from '../src/shared/operations/workspace/member-list.ts';
import { workspaceInfo } from '../src/shared/operations/workspace/workspace.ts';
import { createWorkspace, expectModalFocus, signIn, watchViolations } from './helpers.ts';
import { failOperation, mockOperation, rewriteOperation, routeOperation } from './operations.ts';

// 組織の中の操作の slug。このファイルはあおば開発だけを使う
const AOBA = { slug: 'aoba' };

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

  // 開き直すと保存した値が出る。中にフォーカスが入り、Esc で閉じる（書きかけが無いので確かめない）。開いた行のリンクへ戻る
  await expectModalFocus(page, {
    opener: row.getByRole('link', { name: '見積もりを送って確かめる' }),
    modal: drawer,
    whileOpen: () => expect(drawer.locator('.doc-box').getByRole('heading', { name: '手順' })).toBeVisible(),
  });

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
  await expect(drawer.getByText('完遂したクエストの難易度は直せません')).toBeVisible();
  // 理由の文は、難易度の欄の説明に結ばれる。読み取り専用でも、選んだ値は薄めずに読める
  await expect(drawer.getByRole('radiogroup', { name: '難易度' })).toHaveAccessibleDescription(
    '完遂したクエストの難易度は直せません',
  );
  await expect(drawer.getByRole('radio', { name: '3', exact: true })).toBeChecked();
  expect(
    await drawer
      .locator('.segmented input:disabled + span')
      .first()
      .evaluate((el) => getComputedStyle(el).opacity),
  ).toBe('1');
  for (const radio of await drawer.getByRole('radiogroup', { name: '難易度' }).getByRole('radio').all()) {
    await expect(radio).toBeDisabled();
  }
  // 期限とリポジトリは完了の後も直せる
  await expect(
    drawer.getByRole('radiogroup', { name: 'リポジトリ' }).getByRole('radio', { name: 'なし' }),
  ).toBeEnabled();
  await drawer.getByLabel('期限').fill('2099-01-02');
  await expect(page.getByRole('status').filter({ hasText: '保存しました' })).toBeVisible();
});

test('担い手を引き出しで選ぶと、木の行にアバターが出る。外すと担い手なしに戻る。起票のダイアログでも選べる', async ({
  page,
}) => {
  // 作った管理者（ミナト）がリーダーとして所属するので、候補はミナト
  await createWorkspace(page, '担い手パーティ', 'game');
  await addTask(page, '担い手を決める');
  const row = page.locator('.entry', { hasText: '担い手を決める' });
  await expect(row.getByRole('img', { name: '担い手なし' })).toBeVisible();
  await row.getByRole('link', { name: '担い手を決める' }).click();
  const drawer = page.getByRole('dialog', { name: '担い手を決める' });
  const select = drawer.getByRole('combobox', { name: '担い手' });
  await expect(select).toHaveValue('');
  await expect(select.getByRole('option', { name: 'ミナト' })).toBeAttached();
  await select.selectOption({ label: 'ミナト' });
  await expect(page.getByRole('status').filter({ hasText: '保存しました' })).toBeVisible();
  // 引き出しのアバターは、名前を選択欄が読むので、読み上げから外す（見た目と title は残す）
  // （変更の履歴の行にも、変えた人のアバターが出るので、属性の欄に絞る）
  const drawerAvatar = drawer.locator('.props .avatar[title="ミナト"]');
  await expect(drawerAvatar).toBeVisible();
  await expect(drawerAvatar).toHaveAttribute('aria-hidden', 'true');
  await expect(row.getByRole('img', { name: 'ミナト' })).toBeVisible();

  await select.selectOption({ label: '担い手なし' });
  await expect(row.getByRole('img', { name: '担い手なし' })).toBeVisible();
  await expect(select).toHaveValue('');
  await drawer.getByRole('button', { name: '閉じる' }).click();
  await expect(drawer).toBeHidden();

  // 起票のダイアログでは、親の横に担い手を選ぶ（既定は担い手なし）
  await page.getByRole('button', { name: '依頼を出す' }).click();
  const dialog = page.getByRole('dialog', { name: '依頼を出す' });
  await dialog.getByLabel('タイトル').fill('担い手つきの依頼');
  const assignee = dialog.getByRole('combobox', { name: '担い手' });
  await expect(assignee).toHaveValue('');
  await expect(assignee.getByRole('option', { name: 'ミナト' })).toBeAttached();
  await assignee.selectOption({ label: 'ミナト' });
  await dialog.getByRole('button', { name: '依頼を出す' }).click();
  await expect(dialog).toBeHidden();
  const created = page.locator('.entry', { hasText: '担い手つきの依頼' });
  await expect(created.getByRole('img', { name: 'ミナト' })).toBeVisible();
  // 引き出しを開くと、選んだ担い手が出る
  await created.getByRole('link', { name: '担い手つきの依頼' }).click();
  await expect(
    page.getByRole('dialog', { name: '担い手つきの依頼' }).getByRole('combobox', { name: '担い手' }),
  ).toHaveValue(/[0-9a-f-]{36}/);
});

test('担い手は選んで少し待ってから最後の値だけを送り、断られたら理由を出して前の値に戻す', async ({ page }) => {
  await createWorkspace(page, '担い手の断られるパーティ', 'game');
  await addTask(page, '担い手が断られる');
  // 候補を読めないときは知らせ、「もう一度試す」で読み直せる
  const unrouteMembers = await failOperation(page, memberList, AOBA, 500, 'internal');
  const drawer = await openDrawer(page, '担い手が断られる');
  const select = drawer.getByRole('combobox', { name: '担い手' });
  await expect(drawer.getByText('担い手の候補を読み込めませんでした')).toBeVisible();
  await expect(select.getByRole('option')).toHaveText(['担い手なし']);
  await unrouteMembers();
  await drawer.getByRole('button', { name: 'もう一度試す' }).click();
  await expect(select.getByRole('option', { name: 'ミナト' })).toBeAttached();
  await expect(drawer.getByText('担い手の候補を読み込めませんでした')).toHaveCount(0);
  await expect(select).toBeFocused();

  // 閉じた選択欄で矢印キーを続けて押しても、途中の値は送らず、待った後に最後の値だけを送る
  const bodies: { assignee_user_id: string | null }[] = [];
  page.on('request', (request) => {
    if (request.url().endsWith('/api/aoba/task-assign')) bodies.push(request.postDataJSON());
  });
  await select.press('ArrowDown');
  await select.press('ArrowUp');
  await select.press('ArrowDown');
  await expect(page.getByRole('status').filter({ hasText: '保存しました' })).toBeVisible();
  expect(bodies).toHaveLength(1);
  expect(bodies[0]!.assignee_user_id).toMatch(/[0-9a-f-]{36}/);
  await select.selectOption({ label: '担い手なし' });
  await expect.poll(() => bodies.length).toBe(2);
  await expect(
    page.locator('.entry', { hasText: '担い手が断られる' }).getByRole('img', { name: '担い手なし' }),
  ).toBeVisible();

  // 同時に替えられた（409 の conflict）
  const raced = 'ほかの人が同時に直したため、保存できませんでした';
  let unrouteAssign = await failOperation(page, taskAssign, AOBA, 409, 'conflict');
  let request = page.waitForRequest('**/api/aoba/task-assign');
  await select.selectOption({ label: 'ミナト' });
  await request;
  await expect(drawer.locator('.props').getByText(raced, { exact: false })).toBeVisible();
  await expect(select).toHaveValue('');

  // 閉じた（409 の workspace_closed）
  await unrouteAssign();
  unrouteAssign = await failOperation(page, taskAssign, AOBA, 409, 'workspace_closed');
  request = page.waitForRequest('**/api/aoba/task-assign');
  await select.selectOption({ label: 'ミナト' });
  await request;
  await expect(drawer.getByText('終了したパーティには書き込めません')).toBeVisible();
  await expect(select).toHaveValue('');

  // 選んだ人が所属を外れていた（404 で、タスクはある）。理由を出し、候補を読み直す（読み直した候補にはもういない）
  await unrouteAssign();
  await failOperation(page, taskAssign, AOBA, 404, 'not_found');
  await rewriteOperation(page, memberList, AOBA, (output) => ({ ...output, members: [] }));
  request = page.waitForRequest('**/api/aoba/task-assign');
  const reload = page.waitForRequest('**/api/aoba/member-list');
  await select.selectOption({ label: 'ミナト' });
  await request;
  await reload;
  await expect(drawer.getByText('選んだ人は、もうこのパーティにいません。担い手を選び直してください')).toBeVisible();
  await expect(select.getByRole('option', { name: 'ミナト' })).toHaveCount(0);
  await expect(select).toHaveValue('');
  await expect(drawer).toBeVisible();
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

test('スクロールした先の行のリンクで開いても、木のスクロールの位置は動かず、Esc で閉じると開いた行のリンクへ戻る', async ({
  page,
}) => {
  // 低い窓にして、seed のバックログ（あおば開発の受託開発チーム）を縦にスクロールさせる
  await page.setViewportSize({ width: 1280, height: 480 });
  await page.goto('/aoba/w/019a0000-0000-7000-8000-000000000401');
  const link = page.locator('a.entry-title').last();
  await link.scrollIntoViewIfNeeded();
  const scrollBefore = await page.evaluate(() => window.scrollY);
  expect(scrollBefore, '前提: seed の行が窓の高さ 480px を超え、バックログが縦にスクロールする').toBeGreaterThan(0);
  // 行のリンクは data-sveltekit-reset="false" で、移っても先頭へ戻さない
  await link.click();
  const drawer = page.getByRole('dialog');
  await expect(drawer).toBeVisible();
  await expect(page).toHaveURL(/\?task=[0-9a-f-]{36}$/);
  await expect(drawer.getByRole('heading', { level: 2 })).toBeFocused();
  expect(await page.evaluate(() => window.scrollY)).toBe(scrollBefore);
  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();
  await expect(link).toBeFocused();
  expect(await page.evaluate(() => window.scrollY)).toBe(scrollBefore);
});

test('存在しないタスクの ID で開くと、トーストで知らせて閉じる', async ({ page }) => {
  await createWorkspace(page, '見つからないパーティ', 'game');
  const url = new URL(page.url());
  await page.goto(`${url.pathname}?task=019a0000-0000-7000-8000-00000000ffff`);
  await expect(page.getByRole('status').filter({ hasText: 'このクエストは見つかりません' })).toBeVisible();
  await expect(page).not.toHaveURL(/\?task=/);
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('終了したワークスペースは読み取り専用で開く（seed のひばり工房ではなく、画面の応答を差し替えて確かめる）', async ({
  page,
}) => {
  await createWorkspace(page, '閉じたパーティ', 'game');
  await addTask(page, '読むだけ');
  const row = page.locator('.entry', { hasText: '読むだけ' });
  // ワークスペースの情報だけを閉じた状態に差し替える
  await rewriteOperation(page, workspaceInfo, AOBA, (output) => ({
    ...output,
    closed_at: '2026-10-20T00:00:00.000Z',
  }));
  await page.reload();
  await page.locator('.entry', { hasText: '読むだけ' }).getByRole('link', { name: '読むだけ' }).click();
  const drawer = page.getByRole('dialog', { name: '読むだけ' });
  await expect(drawer.getByText('終了したパーティのクエストは、読み取りだけできます')).toBeVisible();
  await expect(drawer.getByRole('button', { name: '編集' })).toHaveCount(0);
  await expect(drawer.getByRole('button', { name: /削除する/ })).toHaveCount(0);
  for (const radio of await drawer.getByRole('radio').all()) await expect(radio).toBeDisabled();
  // 担い手は選択欄を出さず、アバターと名前だけ
  await expect(drawer.getByRole('combobox')).toHaveCount(0);
  await expect(drawer.getByText('担い手なし', { exact: true })).toBeVisible();
  await expect(row).toHaveCount(1);
});

// 引き出しを開いた行を、タイトルで探して開く
async function openDrawer(page: Page, title: string) {
  await page.locator('.entry', { hasText: title }).getByRole('link', { name: title }).click();
  const drawer = page.getByRole('dialog', { name: title });
  await expect(drawer).toBeVisible();
  return drawer;
}

// 「変更の履歴」のタブを選び、その中身（tabpanel）を返す。初めはコメントのタブが選ばれている
async function openHistory(drawer: Locator) {
  await drawer.getByRole('tab', { name: '変更の履歴' }).click();
  const history = drawer.getByRole('tabpanel', { name: '変更の履歴' });
  await expect(history).toBeVisible();
  return history;
}

test('変更の履歴: 読めなければ「もう一度試す」で読み直し、保存の後の読み直しに失敗しても行を残し、「さらに読む」で続きを足す', async ({
  page,
}) => {
  await createWorkspace(page, '履歴の読み込みパーティ', 'game');
  await addTask(page, '履歴を読み直す');

  // 初めに読めない。失敗の文と「もう一度試す」を出す
  let unrouteHistory = await failOperation(page, taskHistory, AOBA, 500, 'internal');
  const drawer = await openDrawer(page, '履歴を読み直す');
  const history = await openHistory(drawer);
  const items = history.locator('.history > li');
  await expect(history.getByText('変更の履歴を読み込めませんでした。')).toBeVisible();
  await unrouteHistory();
  await history.getByRole('button', { name: 'もう一度試す' }).click();
  await expect(items).toHaveCount(1);
  await expect(history).toBeFocused();

  // 保存した後の読み直しに失敗しても、前の行を残し、上に失敗を添える
  unrouteHistory = await failOperation(page, taskHistory, AOBA, 500, 'internal');
  await drawer.getByRole('radio', { name: '5', exact: true }).check();
  await expect(history.getByText('最新の変更の履歴を読み込めませんでした。')).toBeVisible();
  await expect(items).toHaveCount(1);
  await unrouteHistory();
  await history.getByRole('button', { name: 'もう一度試す' }).click();
  await expect(items).toHaveCount(2);
  await expect(history.getByText('最新の変更の履歴を読み込めませんでした。')).toHaveCount(0);

  // 先頭の応答を1件と続き（next）に差し替える。「さらに読む」で、続きを本物の API から足す
  const befores: unknown[] = [];
  await routeOperation(page, taskHistory, AOBA, async (call) => {
    if (call.input.before !== undefined) {
      befores.push(call.input.before);
      await call.passThrough();
      return;
    }
    const output = await call.fetch();
    const first = output.entries[0]!;
    await call.fulfill({ ...output, entries: [first], next: { created_at: first.created_at, id: first.id } });
  });
  await drawer.getByRole('radio', { name: '8', exact: true }).check();
  await expect(items).toHaveCount(1);
  await expect(items.nth(0).locator('.history-changes li span')).toHaveText(['難易度', '5 → 8']);
  await history.getByRole('button', { name: 'さらに読む' }).click();
  await expect(items).toHaveCount(3);
  await expect(items.nth(1).locator('.history-changes li span')).toHaveText(['難易度', '未見積もり → 5']);
  await expect(items.nth(2)).toContainText('依頼を出した');
  await expect(history.getByRole('button', { name: 'さらに読む' })).toHaveCount(0);
  await expect(history).toBeFocused();
  expect(befores).toHaveLength(1);
});

test('変更の履歴が無ければ「まだ変更はありません。」', async ({ page }) => {
  await createWorkspace(page, '履歴の無いパーティ', 'game');
  await addTask(page, '履歴の無い依頼');
  await mockOperation(page, taskHistory, AOBA, { entries: [], next: null, timezone: 'Asia/Tokyo' });
  const drawer = await openDrawer(page, '履歴の無い依頼');
  await expect((await openHistory(drawer)).getByText('まだ変更はありません。')).toBeVisible();
});

test('変更の履歴が 404（タスクが消えた）なら、「もう一度試す」を出さず、トーストで知らせて閉じる', async ({ page }) => {
  await createWorkspace(page, '履歴が消えるパーティ', 'game');
  await addTask(page, '履歴が消える依頼');
  await failOperation(page, taskHistory, AOBA, 404, 'not_found');
  await page.locator('.entry').getByRole('link', { name: '履歴が消える依頼' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'このクエストは見つかりません' })).toBeVisible();
  await expect(page).not.toHaveURL(/\?task=/);
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

// 変更の履歴: 難易度と担い手を直すと、新しい順に、日時と人と、列の名前と前と後が出る。列の名前は言葉づかいの辞書の言葉
for (const [vocabulary, words] of [
  [
    'game',
    {
      create: '依頼を出す',
      points: '難易度',
      assignee: '担い手',
      unassigned: '担い手なし',
      created: '依頼を出した',
      updated: '書き換えた',
    },
  ],
  [
    'scrum',
    {
      create: '起票',
      points: 'ポイント',
      assignee: '担当',
      unassigned: '担当なし',
      created: '作成した',
      updated: '変更した',
    },
  ],
] as const) {
  test(`変更の履歴を新しい順に、${vocabulary === 'game' ? 'ゲーム' : 'スクラム'}の言葉の列の名前で出す`, async ({
    page,
  }) => {
    const collect = await watchViolations(page);
    await createWorkspace(page, `履歴の${vocabulary}チーム`, vocabulary);
    const title = `履歴をたどる（${vocabulary}）`;
    await page.getByRole('button', { name: words.create }).click();
    const dialog = page.getByRole('dialog', { name: words.create });
    await dialog.getByLabel('タイトル').fill(title);
    await dialog.getByRole('button', { name: words.create }).click();
    await expect(dialog).toBeHidden();

    const drawer = await openDrawer(page, title);
    const history = await openHistory(drawer);
    const items = history.locator('.history > li');
    // 開いたときに読む。作成の行だけ
    await expect(items).toHaveCount(1);
    await expect(items.nth(0)).toContainText(words.created);
    await expect(items.nth(0).locator('time')).toHaveText(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    await expect(items.nth(0)).toContainText('ミナト');

    await drawer.getByRole('radio', { name: '5', exact: true }).check();
    await expect(items).toHaveCount(2);
    await drawer.getByRole('combobox', { name: words.assignee }).selectOption({ label: 'ミナト' });
    // 保存した後に読み直す。新しい順
    await expect(items).toHaveCount(3);
    await expect(items.nth(0).locator('> .props-note')).toHaveText(words.updated);
    await expect(items.nth(0).locator('.history-changes li span')).toHaveText([
      words.assignee,
      `${words.unassigned} → ミナト`,
    ]);
    await expect(items.nth(1).locator('.history-changes li span')).toHaveText([words.points, '未見積もり → 5']);
    await expect(items.nth(2).locator('> .props-note')).toHaveText(words.created);
    await expect(items.nth(2).locator('.history-changes li').first().locator('span')).toHaveText(['タイトル', title]);
    // 続きは無い
    await expect(history.getByRole('button', { name: 'さらに読む' })).toHaveCount(0);
    expect(await collect()).toEqual([]);
  });
}

test('2048 字に近い URL を保存しても、390px の引き出しが横にはみ出さない', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await createWorkspace(page, '長いリンクパーティ', 'game');
  await addTask(page, '長いリンク');
  const drawer = await openDrawer(page, '長いリンク');
  const url = `https://example.com/${'a'.repeat(2000)}`;
  await drawer.getByRole('button', { name: /リンクを足す/ }).click();
  await drawer.getByRole('textbox', { name: 'リンク' }).fill(url);
  await drawer.getByRole('button', { name: '保存', exact: true }).click();
  await expect(drawer.locator('.source-key')).toContainText('aaaaaaaa');
  // 引き出しの中身（本文の枠を含む）が、引き出しの幅に収まり、画面も横にスクロールしない
  const overflow = await page.evaluate(() => {
    const drawerElement = document.querySelector('.drawer')!;
    return {
      drawer: drawerElement.scrollWidth - drawerElement.clientWidth,
      page: document.documentElement.scrollWidth - window.innerWidth,
      body:
        document.querySelector('.drawer .doc-box')!.getBoundingClientRect().right -
        drawerElement.getBoundingClientRect().right,
    };
  });
  expect(overflow.drawer).toBeLessThanOrEqual(0);
  expect(overflow.page).toBeLessThanOrEqual(0);
  expect(overflow.body).toBeLessThanOrEqual(0);
});

test('横に出した形は外側が inert で、閉じると外れる。広げると inert が外れ、620px 以下では広げた形を無視する', async ({
  page,
}) => {
  await createWorkspace(page, 'inert パーティ', 'game');
  await addTask(page, '裏を操作できない');
  const drawer = await openDrawer(page, '裏を操作できない');
  await expect(page.locator('.binding')).toHaveAttribute('inert', '');
  await expect(page.locator('.page-head')).toHaveAttribute('inert', '');
  await drawer.getByRole('button', { name: '広げる' }).click();
  await expect(page.locator('.binding')).not.toHaveAttribute('inert', '');
  await page.setViewportSize({ width: 600, height: 800 });
  await expect(drawer).toHaveAttribute('aria-modal', 'true');
  await expect(page.locator('.binding')).toHaveAttribute('inert', '');
  await page.setViewportSize({ width: 1280, height: 800 });
  await drawer.getByRole('button', { name: '横に戻す' }).click();
  await drawer.getByRole('button', { name: '閉じる' }).click();
  await expect(drawer).toBeHidden();
  await expect(page.locator('.binding')).not.toHaveAttribute('inert', '');
  await expect(page.locator('.page-head')).not.toHaveAttribute('inert', '');
});

test('書きかけのまま戻るで別の画面へ移ろうとすると確かめ、書き続けると元の URL に残り、捨てると移る', async ({
  page,
}) => {
  await createWorkspace(page, '戻るパーティ', 'game');
  await addTask(page, '戻る前の確認');
  const listUrl = page.url();
  const drawer = await openDrawer(page, '戻る前の確認');
  const drawerUrl = page.url();
  await drawer.getByRole('button', { name: /戻る前の確認/ }).click();
  await drawer.getByRole('textbox', { name: 'タイトル' }).fill('書きかけ');
  await page.goBack();
  const confirm = page.getByRole('dialog', { name: '書きかけを捨てますか' });
  await expect(confirm).toBeVisible();
  await confirm.getByRole('button', { name: '書き続ける' }).click();
  await expect(confirm).toBeHidden();
  await expect(page).toHaveURL(drawerUrl);
  await expect(drawer.getByRole('textbox', { name: 'タイトル' })).toHaveValue('書きかけ');
  await page.goBack();
  await page.getByRole('dialog', { name: '書きかけを捨てますか' }).getByRole('button', { name: '捨てる' }).click();
  await expect(drawer).toBeHidden();
  await expect(page).toHaveURL(listUrl);
  // 戻る／進むで閉じたときも、開いた行のリンクへフォーカスが戻る
  await expect(page.locator('.entry').getByRole('link', { name: '戻る前の確認' })).toBeFocused();
});

test('前後の空白だけの違いは、書きかけに数えず、確認せずに閉じる', async ({ page }) => {
  await createWorkspace(page, '書きかけの判定パーティ', 'game');
  await addTask(page, '同じ値');
  const drawer = await openDrawer(page, '同じ値');
  await drawer.getByRole('button', { name: /同じ値/ }).click();
  await drawer.getByRole('textbox', { name: 'タイトル' }).fill('  同じ値  ');
  // 空白だけの違いは、確認せずに閉じる
  await drawer.getByRole('button', { name: '閉じる' }).click();
  await expect(drawer).toBeHidden();
  await expect(page.getByRole('dialog', { name: '書きかけを捨てますか' })).toHaveCount(0);
});

test('一般のメンバーには、人が作ったタスクの削除のボタンを出さず、理由を添える', async ({ context, baseURL, page }) => {
  await context.clearCookies();
  await signIn(context, baseURL, 'member');
  // seed: あおば開発の受託開発チーム。「ポイント付与のバッチを作る」はミナトが作った
  await page.goto('/aoba/w/019a0000-0000-7000-8000-000000000401?task=019a0000-0000-7000-8000-000000000801');
  const drawer = page.getByRole('dialog', { name: 'ポイント付与のバッチを作る' });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByRole('button', { name: /削除する/ })).toHaveCount(0);
  await expect(drawer.getByText('削除できるのは作った人とパーティリーダーです。')).toBeVisible();
  // 自分が作ったタスクには出る（ハルカが作った「管理画面にポイント履歴の一覧を出す」）
  await page.goto('/aoba/w/019a0000-0000-7000-8000-000000000401?task=019a0000-0000-7000-8000-000000000803');
  await expect(
    page.getByRole('dialog', { name: '管理画面にポイント履歴の一覧を出す' }).getByRole('button', { name: /削除する/ }),
  ).toBeVisible();
});

test('矢印キーで難易度を続けて動かしても、保存は1本ずつで、最後の選択が残る', async ({ page }) => {
  await createWorkspace(page, '続けて選ぶパーティ', 'game');
  await addTask(page, '続けて選ぶ');
  const row = page.locator('.entry', { hasText: '続けて選ぶ' });
  const drawer = await openDrawer(page, '続けて選ぶ');
  let inFlight = 0;
  let maxInFlight = 0;
  const sent: unknown[] = [];
  await routeOperation(page, taskUpdate, AOBA, async (call) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    sent.push(call.input.points);
    await new Promise((resolve) => setTimeout(resolve, 200));
    await call.passThrough();
    inFlight--;
  });
  await drawer.getByRole('radio', { name: '未見積もり' }).focus();
  // 未 → 0 → 1 → 2 → 3 を続けて選ぶ
  for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowRight');
  await expect(drawer.getByRole('radio', { name: '3', exact: true })).toBeChecked();
  await expect(row.locator('.pts')).toHaveText('3');
  await expect.poll(() => inFlight).toBe(0);
  expect(maxInFlight).toBe(1);
  expect(sent[sent.length - 1]).toBe(3);
  // 溜めた分は最後の選択だけで、途中の選択を全部は送らない
  expect(sent.length).toBeLessThanOrEqual(3);
  await page.reload();
  await expect(page.locator('.entry', { hasText: '続けて選ぶ' }).locator('.pts')).toHaveText('3');
});

test('期日は、打ちかけの年は送らず、年がそろった値だけを保存し、欄を離れたときに直っていなければ知らせる', async ({
  page,
}) => {
  await createWorkspace(page, '期日パーティ', 'game');
  await addTask(page, '期日を打つ');
  const drawer = await openDrawer(page, '期日を打つ');
  const requests: string[] = [];
  page.on('request', (request) => {
    if (request.url().endsWith('/api/aoba/task-update')) requests.push(request.postData() ?? '');
  });
  const due = drawer.getByLabel('期限');
  const type = (value: string) =>
    due.evaluate((input: HTMLInputElement, next) => {
      input.value = next;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }, value);
  // 年を打つ途中の値（0002、0020、0202）は送らない
  for (const partial of ['0002-10-19', '0020-10-19', '0202-10-19']) await type(partial);
  await page.waitForTimeout(1000);
  expect(requests).toEqual([]);
  // 欄を離れたとき、打ちかけのままなら知らせる
  await due.focus();
  await due.blur();
  await expect(drawer.getByText(/期限は正しい日付で入れてください/)).toBeVisible();
  // 年がそろったら、少し待って保存する
  await type('2026-10-19');
  await expect.poll(() => requests.length).toBe(1);
  expect(requests[0]).toContain('"due_on":"2026-10-19"');
});

test('保存を409で断られたとき、送った欄に合う文を出す。ワークスペースの読み直しが失敗しても、引き出しと書きかけは残る', async ({
  page,
}) => {
  await createWorkspace(page, '断られるパーティ', 'game');
  await addTask(page, '断られる');
  const drawer = await openDrawer(page, '断られる');
  const unrouteUpdate = await failOperation(page, taskUpdate, AOBA, 409, 'conflict');
  // 断られると選択が前の値に戻るので、check（押した後に選ばれたかを確かめる）でなく click で押す
  await drawer.getByRole('radio', { name: '5', exact: true }).click();
  // 完了していないタスクの 409 は、「完了している」でなく、同時に直された競合の文（読み直した今の値で決める）
  const raced = 'ほかの人が同時に直したため、保存できませんでした';
  await expect(drawer.locator('.props').getByText(raced, { exact: false })).toBeVisible();
  await expect(drawer.getByText('完遂したクエストの難易度は直せません')).toHaveCount(0);
  await drawer.getByRole('button', { name: /断られる/ }).click();
  await drawer.getByRole('textbox', { name: 'タイトル' }).fill('同時に直された');
  await drawer.getByRole('button', { name: '保存', exact: true }).click();
  await expect(drawer.locator('.edit-form').getByText(raced, { exact: false })).toBeVisible();
  // 書きかけが残ったまま、枠の読み直しが 500 になっても、引き出しは消えない
  await unrouteUpdate();
  await drawer.getByRole('textbox', { name: 'タイトル' }).fill('書きかけが残る');
  await failOperation(page, workspaceInfo, AOBA, 500, 'internal');
  // 組織の枠の 500 は、最後まで外さない。引き出しは組織の枠を読み直さない（要求も出ない）
  await failOperation(page, organizationInfo, AOBA, 500, 'internal');
  const workspaceRequests: string[] = [];
  const organizationRequests: string[] = [];
  page.on('request', (request) => {
    if (request.url().endsWith('/api/aoba/workspace')) workspaceRequests.push(request.url());
    if (request.url().endsWith('/api/aoba/organization')) organizationRequests.push(request.url());
  });
  // 保存の後は木だけを読み直す
  await drawer.getByLabel('期限').fill('2099-12-31');
  await expect(page.getByRole('status').filter({ hasText: '保存しました' })).toBeVisible();
  await expect(drawer).toBeVisible();
  await expect(drawer.getByRole('textbox', { name: 'タイトル' })).toHaveValue('書きかけが残る');
  expect(workspaceRequests).toEqual([]);
  expect(organizationRequests).toEqual([]);
  // 閉じたと分かったときは、ワークスペースの枠だけを読み直す。それが 500 でも、前の値を保って引き出しと書きかけを残す
  await failOperation(page, taskUpdate, AOBA, 409, 'workspace_closed');
  await drawer.getByRole('radio', { name: '8', exact: true }).click();
  await expect(drawer.getByText('終了したパーティには書き込めません')).toBeVisible();
  await expect.poll(() => workspaceRequests.length).toBeGreaterThan(0);
  expect(organizationRequests).toEqual([]);
  await expect(drawer).toBeVisible();
  await expect(drawer.getByRole('textbox', { name: 'タイトル' })).toHaveValue('書きかけが残る');
});

// 行のリンクの `?task=<ID>` から、タスクの ID を取る
async function taskIdOf(page: Page, title: string): Promise<string> {
  const href = await page.locator('.entry', { hasText: title }).getByRole('link', { name: title }).getAttribute('href');
  return new URL(href!, 'http://localhost').searchParams.get('task')!;
}

const SLOW_MS = 700;
// 要求を SLOW_MS だけ遅らせて通す。status を渡すと、遅らせた後にその失敗を返す。
// 届いた入力と、張った route を外す関数を返す
async function slowTaskUpdate(page: Page, failure?: { status: number; code: ErrorCode }) {
  const bodies: InputOf<typeof taskUpdate>[] = [];
  const unroute = await routeOperation(page, taskUpdate, AOBA, async (call) => {
    bodies.push(call.input);
    await new Promise((resolve) => setTimeout(resolve, SLOW_MS));
    if (failure === undefined) await call.passThrough();
    else await call.fail(failure.status, failure.code);
  });
  return { bodies, unroute };
}

test('メンバーの画面で開いて閉じても、メンバーの画面に残り、ほかのクエリも残る', async ({ page }) => {
  await createWorkspace(page, 'メンバー画面パーティ', 'game');
  await addTask(page, 'メンバー画面で開く');
  const taskId = await taskIdOf(page, 'メンバー画面で開く');
  const workspacePath = new URL(page.url()).pathname;
  await page.goto(`${workspacePath}/members?tab=all&task=${taskId}`);
  const drawer = page.getByRole('dialog', { name: 'メンバー画面で開く' });
  await expect(drawer).toBeVisible();
  await drawer.getByRole('button', { name: '閉じる' }).click();
  await expect(drawer).toBeHidden();
  await expect(page).toHaveURL(`${new URL(page.url()).origin}${workspacePath}/members?tab=all`);
  // 戻る先の行が無い画面では、見出しへフォーカスを移す（見出しを focusable にしていない画面でも）
  await expect(page.getByRole('heading', { level: 1 })).toBeFocused();
  // 削除して閉じたときも、メンバーの画面のまま
  await page.goto(`${workspacePath}/members?task=${taskId}`);
  await drawer.getByRole('button', { name: 'このクエストを削除する' }).click();
  await page.getByRole('dialog', { name: 'クエストを削除する' }).getByRole('button', { name: '削除する' }).click();
  await expect(drawer).toBeHidden();
  await expect(page).toHaveURL(`${new URL(page.url()).origin}${workspacePath}/members`);
  await expect(page.getByRole('heading', { level: 1 })).toBeFocused();
});

test('保存の要求を送っている間の入力は書きかけで、閉じようとすると確かめる。失敗しても入力が消えない', async ({
  page,
}) => {
  await createWorkspace(page, '送信中の書きかけパーティ', 'game');
  await addTask(page, '送信中に閉じる');
  const drawer = await openDrawer(page, '送信中に閉じる');
  await slowTaskUpdate(page, { status: 500, code: 'internal' });
  await drawer.getByRole('button', { name: /送信中に閉じる/ }).click();
  await drawer.getByRole('textbox', { name: 'タイトル' }).fill('送っている最中のタイトル');
  await drawer.getByRole('textbox', { name: 'タイトル' }).press('Enter');
  await drawer.getByRole('button', { name: '閉じる' }).click();
  const confirm = page.getByRole('dialog', { name: '書きかけを捨てますか' });
  await expect(confirm).toBeVisible();
  await confirm.getByRole('button', { name: '書き続ける' }).click();
  // 失敗しても、入力と理由が残る
  await expect(drawer.getByText('保存できませんでした')).toBeVisible();
  await expect(drawer.getByRole('textbox', { name: 'タイトル' })).toHaveValue('送っている最中のタイトル');
});

test('期日で欄を離れた直後と、ポイントを選んだ直後に閉じても、結果は木に反映され、トーストで知らせる', async ({
  page,
}) => {
  await createWorkspace(page, '閉じた後の応答パーティ', 'game');
  await addTask(page, '閉じた後に返る');
  const row = page.locator('.entry', { hasText: '閉じた後に返る' });
  const drawer = await openDrawer(page, '閉じた後に返る');
  let slow = await slowTaskUpdate(page);
  await drawer.getByLabel('期限').fill('2099-12-31');
  // 閉じるボタンを押すと、期日の入力が外れて（blur）送られる。送った値は書きかけではないので、確認なしで閉じる
  await drawer.getByRole('button', { name: '閉じる' }).click();
  await expect(drawer).toBeHidden();
  await expect(page.getByRole('status').filter({ hasText: '保存しました' })).toBeVisible();
  await expect(row.locator('.chip')).toBeVisible();
  // ポイントも、選んだ直後に閉じて、結果が木に出る
  await slow.unroute();
  slow = await slowTaskUpdate(page);
  await row.getByRole('link', { name: '閉じた後に返る' }).click();
  await drawer.getByRole('radio', { name: '8', exact: true }).check();
  await drawer.getByRole('button', { name: '閉じる' }).click();
  await expect(drawer).toBeHidden();
  await expect(row.locator('.pts')).toHaveText('8');
  // 失敗はトーストで知らせる
  await slow.unroute();
  await slowTaskUpdate(page, { status: 500, code: 'internal' });
  await row.getByRole('link', { name: '閉じた後に返る' }).click();
  await drawer.getByRole('radio', { name: '5', exact: true }).check();
  await drawer.getByRole('button', { name: '閉じる' }).click();
  await expect(drawer).toBeHidden();
  await expect(page.getByRole('status').filter({ hasText: '保存できませんでした' })).toBeVisible();
});

test('期日の 600ms の待ちの間に Esc で閉じようとすると確かめ、捨てると何も送らない', async ({ page }) => {
  await createWorkspace(page, '期日の待ちパーティ', 'game');
  await addTask(page, '期日を待つ');
  const drawer = await openDrawer(page, '期日を待つ');
  const { bodies } = await slowTaskUpdate(page);
  await drawer.getByLabel('期限').fill('2099-12-31');
  await page.keyboard.press('Escape');
  const confirm = page.getByRole('dialog', { name: '書きかけを捨てますか' });
  await expect(confirm).toBeVisible();
  await confirm.getByRole('button', { name: '捨てる' }).click();
  await expect(drawer).toBeHidden();
  await page.waitForTimeout(SLOW_MS + 600);
  expect(bodies, JSON.stringify(bodies)).toEqual([]);
});

test('期日の保存中に次の値を選んでも、先の応答で入力欄が上書きされず、次の値が送られる', async ({ page }) => {
  await createWorkspace(page, '期日の連続パーティ', 'game');
  await addTask(page, '期日を続ける');
  const drawer = await openDrawer(page, '期日を続ける');
  const { bodies } = await slowTaskUpdate(page);
  const due = drawer.getByLabel('期限');
  await due.fill('2099-12-30');
  await due.press('Enter');
  await expect.poll(() => bodies.length).toBe(1);
  // 先の要求が返る前に、次の値を選ぶ
  await due.fill('2099-12-31');
  await expect(page.getByRole('status').filter({ hasText: '保存しました' })).toBeVisible();
  await expect(due).toHaveValue('2099-12-31');
  await expect.poll(() => bodies.length).toBe(2);
  // 2 本とも通って、保存のトーストが 2 回出るまで待つ
  await expect(page.getByRole('status').filter({ hasText: '保存しました' })).toHaveCount(2);
  expect(bodies.map((body) => body.due_on)).toEqual(['2099-12-30', '2099-12-31']);
  await expect(due).toHaveValue('2099-12-31');
  // 保存した値は、読み直しても同じ
  await page.reload();
  await expect(page.getByRole('dialog', { name: '期日を続ける' }).getByLabel('期限')).toHaveValue('2099-12-31');
});

test('期日は Enter で保存でき、「クリア」を押すと空にして保存し、フォーカスを入力欄へ移す', async ({ page }) => {
  await createWorkspace(page, '期日のクリアパーティ', 'game');
  await addTask(page, '期日をクリアする');
  const row = page.locator('.entry', { hasText: '期日をクリアする' });
  const drawer = await openDrawer(page, '期日をクリアする');
  const bodies: Record<string, unknown>[] = [];
  page.on('request', (request) => {
    if (request.url().endsWith('/api/aoba/task-update')) bodies.push(request.postDataJSON());
  });
  const due = drawer.getByLabel('期限');
  await due.fill('2099-12-31');
  await due.press('Enter');
  // 600ms を待たずに、Enter で送る
  await expect.poll(() => bodies.length, { timeout: 500 }).toBe(1);
  await expect(row.locator('.chip')).toBeVisible();
  await drawer.getByRole('button', { name: 'クリア', exact: true }).click();
  await expect(due).toBeFocused();
  await expect(due).toHaveValue('');
  await expect(row.locator('.chip')).toHaveCount(0);
  expect(bodies.map((body) => body.due_on)).toEqual(['2099-12-31', null]);
});

test('期日が過ぎたタスクを開くと、引き出しの期日に「期限切れ」の印が出て、保存した値で出し直す', async ({ page }) => {
  // seed の行は他の e2e も読むので、このテストで作ったタスクの期日を書き換える
  await createWorkspace(page, '期限切れパーティ', 'game');
  await addTask(page, '期限の印を見る');
  const drawer = await openDrawer(page, '期限の印を見る');
  const chip = drawer.locator('.props .chip');
  await drawer.getByLabel('期限').fill('2000-01-02');
  await expect(chip).toHaveText(/期限切れ 1\/2/);
  // 開き直しても、読み込んだ値で印を出す
  await page.reload();
  const reopened = page.getByRole('dialog', { name: '期限の印を見る' });
  const reopenedChip = reopened.locator('.props .chip');
  await expect(reopenedChip).toHaveText(/期限切れ 1\/2/);
  await expect(reopenedChip).toHaveClass(/is-danger/);
  await expect(reopened.locator('.props .chip svg, .props .chip .ico')).toHaveCount(1);
  // 期日を直すと、保存した値で印を出し直す（未来の日付は、色なしの印）
  await reopened.getByLabel('期限').fill('2099-12-31');
  await expect(reopenedChip).toHaveText('12/31');
  await expect(reopenedChip).not.toHaveClass(/is-danger/);
});

test('取り込んだタスクは、タイトルを直せず、リンクの欄と削除を出さず、理由を添える', async ({ page }) => {
  await createWorkspace(page, '取り込みパーティ', 'game');
  await addTask(page, '取り込んだ体');
  const taskId = await taskIdOf(page, '取り込んだ体');
  // 取り込みはまだ無いので、1件の読み取りの応答を、取り込んだタスクに差し替える
  await rewriteOperation(page, taskDetail, AOBA, (output) => ({
    ...output,
    task: { ...output.task, is_imported: true, can_delete: false, link_url: null },
  }));
  const drawer = await openDrawer(page, '取り込んだ体');
  await expect(drawer.getByText('取り込んだクエストのタイトルは、ここでは直せません')).toBeVisible();
  await expect(drawer.getByRole('button', { name: /取り込んだ体/ })).toHaveCount(0);
  await expect(drawer.getByRole('button', { name: /削除する/ })).toHaveCount(0);
  await expect(drawer.getByText('取り込んだクエストは削除せず、保管庫へ移して外します。')).toBeVisible();
  await expect(drawer.getByText('リンク', { exact: true })).toHaveCount(0);
  expect(taskId).toMatch(/^[0-9a-f-]{36}$/);
});

test('1行の入力欄は、日本語の変換中の Enter では送らない', async ({ page }) => {
  await createWorkspace(page, '変換中パーティ', 'game');
  await addTask(page, '変換中に送らない');
  const drawer = await openDrawer(page, '変換中に送らない');
  await drawer.getByRole('button', { name: /変換中に送らない/ }).click();
  const input = drawer.getByRole('textbox', { name: 'タイトル' });
  await input.fill('変換の途中');
  const prevented = await input.evaluate((element) => {
    const event = new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true });
    element.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(prevented).toBe(true);
  // 変換の確定を待っている入力は、そのまま残る
  await expect(input).toHaveValue('変換の途中');
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
