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

test('終了したワークスペースは読み取り専用で開く（seed のひばり工房ではなく、画面の応答を差し替えて確かめる）', async ({
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
  await expect(drawer.getByText('終了したパーティのクエストは、読み取りだけできます')).toBeVisible();
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
  // 完了していないタスクの 409 は、「完了している」でなく、同時に直された競合の文（読み直した今の値で決める）
  const raced = 'ほかの人が同時に直したため、保存できませんでした';
  await expect(drawer.locator('.props').getByText(raced, { exact: false })).toBeVisible();
  await expect(drawer.getByText('完遂したクエストの難易度は直せません')).toHaveCount(0);
  await drawer.getByRole('button', { name: /断られる/ }).click();
  await drawer.getByRole('textbox', { name: 'タイトル' }).fill('同時に直された');
  await drawer.getByRole('button', { name: '保存', exact: true }).click();
  await expect(drawer.locator('.edit-form').getByText(raced, { exact: false })).toBeVisible();
  // 書きかけが残ったまま、枠の読み直しが 500 になっても、引き出しは消えない
  await page.unroute('**/api/aoba/task-update');
  await drawer.getByRole('textbox', { name: 'タイトル' }).fill('書きかけが残る');
  await page.route('**/api/aoba/workspace', (route) =>
    route.fulfill({ status: 500, json: { error: { code: 'internal', message: 'x' } } }),
  );
  // 組織の枠の 500 は、最後まで外さない。引き出しは組織の枠を読み直さない（要求も出ない）
  await page.route('**/api/aoba/organization', (route) =>
    route.fulfill({ status: 500, json: { error: { code: 'internal', message: 'x' } } }),
  );
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
  await page.route('**/api/aoba/task-update', (route) =>
    route.fulfill({ status: 409, json: { error: { code: 'workspace_closed', message: 'closed' } } }),
  );
  await drawer.getByRole('radio', { name: '8', exact: true }).check();
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
// 要求を SLOW_MS だけ遅らせて通す。status を渡すと、遅らせた後にその失敗を返す
async function slowTaskUpdate(page: Page, failure?: { status: number; code: string }) {
  const bodies: Record<string, unknown>[] = [];
  await page.route('**/api/aoba/task-update', async (route) => {
    bodies.push(route.request().postDataJSON());
    await new Promise((resolve) => setTimeout(resolve, SLOW_MS));
    if (failure === undefined) await route.continue();
    else
      await route.fulfill({ status: failure.status, json: { error: { code: failure.code, message: failure.code } } });
  });
  return bodies;
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
  await slowTaskUpdate(page);
  await drawer.getByLabel('期限').fill('2099-12-31');
  // 閉じるボタンを押すと、期日の入力が外れて（blur）送られる。送った値は書きかけではないので、確認なしで閉じる
  await drawer.getByRole('button', { name: '閉じる' }).click();
  await expect(drawer).toBeHidden();
  await expect(page.getByRole('status').filter({ hasText: '保存しました' })).toBeVisible();
  await expect(row.locator('.chip')).toBeVisible();
  // ポイントも、選んだ直後に閉じて、結果が木に出る
  await page.unroute('**/api/aoba/task-update');
  await slowTaskUpdate(page);
  await row.getByRole('link', { name: '閉じた後に返る' }).click();
  await drawer.getByRole('radio', { name: '8', exact: true }).check();
  await drawer.getByRole('button', { name: '閉じる' }).click();
  await expect(drawer).toBeHidden();
  await expect(row.locator('.pts')).toHaveText('8');
  // 失敗はトーストで知らせる
  await page.unroute('**/api/aoba/task-update');
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
  const bodies = await slowTaskUpdate(page);
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
  const bodies = await slowTaskUpdate(page);
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
  // seed: あおば開発の受託開発チームの「障害時の連絡手順を書く」は、期日 2026-10-17（今日より前）
  await page.goto('/aoba/w/019a0000-0000-7000-8000-000000000401?task=019a0000-0000-7000-8000-000000000802');
  const drawer = page.getByRole('dialog', { name: '障害時の連絡手順を書く' });
  await expect(drawer).toBeVisible();
  const chip = drawer.locator('.props .chip');
  await expect(chip).toHaveText(/期限切れ 10\/17/);
  await expect(chip).toHaveClass(/is-danger/);
  await expect(drawer.locator('.props .chip svg, .props .chip .ico')).toHaveCount(1);
  // 期日を直すと、保存した値で印を出し直す（未来の日付は、色なしの印）
  await drawer.getByLabel('期限').fill('2099-12-31');
  await expect(chip).toHaveText('12/31');
  await expect(chip).not.toHaveClass(/is-danger/);
  await drawer.getByLabel('期限').fill('2000-01-02');
  await expect(chip).toHaveText(/期限切れ 1\/2/);
  // 後始末（seed を残す）。元の期日へ戻す
  await drawer.getByLabel('期限').fill('2026-10-17');
  await expect(chip).toHaveText(/期限切れ 10\/17/);
});

test('取り込んだタスクは、タイトルを直せず、リンクの欄と削除を出さず、理由を添える', async ({ page }) => {
  await createWorkspace(page, '取り込みパーティ', 'game');
  await addTask(page, '取り込んだ体');
  const taskId = await taskIdOf(page, '取り込んだ体');
  // 取り込みはまだ無いので、1件の読み取りの応答を、取り込んだタスクに差し替える
  await page.route('**/api/aoba/task-detail', async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { task: Record<string, unknown> };
    await route.fulfill({
      response,
      json: { task: { ...body.task, is_imported: true, can_delete: false, link_url: null } },
    });
  });
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
