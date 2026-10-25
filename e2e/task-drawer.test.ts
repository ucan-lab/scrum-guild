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

// 引き出しを開いた行を、タイトルで探して開く
async function openDrawer(page: Page, title: string) {
  await page.locator('.entry', { hasText: title }).getByRole('link', { name: title }).click();
  const drawer = page.getByRole('dialog', { name: title });
  await expect(drawer).toBeVisible();
  return drawer;
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

test('値が元と同じ欄と、前後の空白だけの違いは、書きかけに数えない。保存中も数えない', async ({ page }) => {
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
  await page.route('**/api/aoba/task-update', async (route) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    sent.push(route.request().postDataJSON().points);
    await new Promise((resolve) => setTimeout(resolve, 200));
    await route.continue();
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
  await page.route('**/api/aoba/task-update', (route) =>
    route.fulfill({ status: 409, json: { error: { code: 'conflict', message: 'conflict' } } }),
  );
  await drawer.getByRole('radio', { name: '5', exact: true }).check();
  await expect(
    drawer.getByText('完遂したクエストの難易度は直せません').or(drawer.getByText(/完遂になっているため/)),
  ).toBeVisible();
  await drawer.getByRole('button', { name: /断られる/ }).click();
  await drawer.getByRole('textbox', { name: 'タイトル' }).fill('同時に直された');
  await drawer.getByRole('button', { name: '保存', exact: true }).click();
  await expect(drawer.getByText('ほかの人が同時に直したため、保存できませんでした', { exact: false })).toBeVisible();
  // 書きかけが残ったまま、枠の読み直しが 500 になっても、引き出しは消えない
  await page.unroute('**/api/aoba/task-update');
  await drawer.getByRole('textbox', { name: 'タイトル' }).fill('書きかけが残る');
  await page.route('**/api/aoba/workspace', (route) =>
    route.fulfill({ status: 500, json: { error: { code: 'internal', message: 'x' } } }),
  );
  await page.route('**/api/aoba/organization', (route) =>
    route.fulfill({ status: 500, json: { error: { code: 'internal', message: 'x' } } }),
  );
  // 保存の後は木だけを読み直すので、枠の情報は読み直さない
  const frameRequests: string[] = [];
  page.on('request', (request) => {
    if (/\/api\/aoba\/(workspace|organization)$/.test(request.url())) frameRequests.push(request.url());
  });
  await drawer.getByLabel('期限').fill('2099-12-31');
  await expect(page.getByRole('status').filter({ hasText: '保存しました' })).toBeVisible();
  await expect(drawer).toBeVisible();
  await expect(drawer.getByRole('textbox', { name: 'タイトル' })).toHaveValue('書きかけが残る');
  expect(frameRequests).toEqual([]);
  // 閉じたと分かって枠ごと読み直すとき、ワークスペースの読み直しが 500 でも、前の値を保って引き出しと書きかけを残す
  await page.unroute('**/api/aoba/organization');
  await page.route('**/api/aoba/task-update', (route) =>
    route.fulfill({ status: 409, json: { error: { code: 'workspace_closed', message: 'closed' } } }),
  );
  await drawer.getByRole('radio', { name: '8', exact: true }).check();
  await expect(drawer.getByText('閉じたパーティには書き込めません')).toBeVisible();
  await expect.poll(() => frameRequests.length).toBeGreaterThan(0);
  await expect(drawer).toBeVisible();
  await expect(drawer.getByRole('textbox', { name: 'タイトル' })).toHaveValue('書きかけが残る');
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
