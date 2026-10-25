// ワークスペースを閉じる、開き直す。管理者が閉じる（確認のダイアログを経る）→ 帯を確かめる → 開き直す。
// seed のセッション（seed/sessions.ts）の Cookie で開く。あおば開発の管理者はミナト、一般のユーザーはハルカ。
// 閉じて確かめるワークスペースは、管理の画面から作った専用のもの（seed のワークスペースを閉じたままにしない）
import { expect, test, type Page } from '@playwright/test';
import { signIn, watchViolations } from './helpers.ts';

test.use({ timezoneId: 'Asia/Tokyo' });

const BANNER = /\d{4}-\d{2}-\d{2} に閉じました。読み取り専用です。/;

// 管理の画面から、自分をリーダーにワークスペースを作る。作ると、そのワークスペースの画面へ移る
async function createWorkspace(page: Page, name: string): Promise<string> {
  await page.goto('/aoba/admin');
  await page.getByRole('button', { name: 'パーティを作る' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'パーティを作る' });
  await expect(dialog.getByRole('combobox')).toBeEnabled();
  await dialog.getByLabel('名前').fill(name);
  await dialog.getByRole('button', { name: '作る' }).click();
  await expect(page).toHaveURL(/\/aoba\/w\/[0-9a-f-]{36}$/);
  return page.url();
}

test.describe('管理者（あおば開発のミナト）', () => {
  test.beforeEach(async ({ context, baseURL }) => {
    await signIn(context, baseURL, 'admin');
  });

  test('確認のダイアログを経て閉じ、帯と読み取り専用を確かめ、開き直すと元に戻る', async ({ page }) => {
    const collect = await watchViolations(page);
    const name = '閉じる確認パーティ';
    const workspaceUrl = await createWorkspace(page, name);
    // 開いているうちは帯が無く、起票できる
    await expect(page.locator('.callout')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '依頼を出す' })).toBeVisible();

    await page.goto('/aoba/admin');
    const row = page.locator('tbody tr', { hasText: name });
    const closeButton = row.getByRole('button', { name: `「${name}」を閉じる` });
    await expect(closeButton).toHaveText('閉じる');
    await closeButton.click();

    // 確認のダイアログ。読み取り専用になることと、開き直せることを書く。危険の色にはしない
    const dialog = page.getByRole('dialog', { name: 'パーティを閉じる' });
    await expect(dialog).toContainText('読み取り専用');
    await expect(dialog).toContainText('開き直せます');
    await expect(dialog.locator('.is-danger')).toHaveCount(0);
    // やめれば何も起きない
    await dialog.getByRole('button', { name: 'やめる' }).click();
    await expect(dialog).toBeHidden();
    await expect(closeButton).toBeFocused();
    await expect(row.locator('.chip')).toHaveCount(0);

    await closeButton.click();
    await dialog.getByRole('button', { name: `「${name}」を閉じる` }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole('status').filter({ hasText: 'パーティを閉じました' })).toBeVisible();
    // 一覧を読み直して、閉じた印と「開き直す」に替わる。押したボタンは残り、フォーカスを保つ
    await expect(row.locator('.chip')).toHaveText(/^閉じた \d{4}-\d{2}-\d{2}$/);
    const reopenButton = row.getByRole('button', { name: `「${name}」を開き直す` });
    await expect(reopenButton).toHaveText('開き直す');
    await expect(reopenButton).toBeFocused();
    // 見出しの集計は開いているワークスペースの数
    await expect(page.locator('.tally')).toContainText('開いているパーティ');

    // 閉じたワークスペースの画面: どの画面にも帯が出て、起票の操作は出ない。管理者には組織の管理へのリンクが付く
    await page.goto(workspaceUrl);
    const banner = page.locator('.callout');
    await expect(banner).toHaveCount(1);
    await expect(banner).toContainText(BANNER);
    await expect(banner.getByRole('button')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '依頼を出す' })).toHaveCount(0);
    // 見出しの右上の「閉じた <日>」の印は、帯と重なるので出さない
    await expect(page.locator('.page-head .chip')).toHaveCount(0);
    await banner.getByRole('link', { name: '組織の管理で開き直す' }).click();
    await expect(page).toHaveURL(/\/aoba\/admin$/);

    // 開き直す。確認なしで送り、一覧が読み直される
    await row.getByRole('button', { name: `「${name}」を開き直す` }).click();
    await expect(page.getByRole('status').filter({ hasText: 'パーティを開き直しました' })).toBeVisible();
    await expect(row.locator('.chip')).toHaveCount(0);
    await expect(row.getByRole('button', { name: `「${name}」を閉じる` })).toHaveText('閉じる');

    await page.goto(workspaceUrl);
    await expect(page.getByRole('heading', { level: 1, name: '掲示板' })).toBeVisible();
    await expect(page.locator('.callout')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '依頼を出す' })).toBeVisible();
    expect(await collect()).toEqual([]);
  });

  test('送っている間は、「閉じる」を押しても無視し、ダイアログも閉じられず、1回しか送らない', async ({ page }) => {
    const name = '二重送信の確認パーティ';
    await createWorkspace(page, name);
    let requests = 0;
    await page.route('**/api/aoba/workspace-close', async (route) => {
      requests++;
      await new Promise((resolve) => setTimeout(resolve, 1000));
      await route.continue();
    });
    await page.goto('/aoba/admin');
    const row = page.locator('tbody tr', { hasText: name });
    await row.getByRole('button', { name: `「${name}」を閉じる` }).click();
    const dialog = page.getByRole('dialog', { name: 'パーティを閉じる' });
    await dialog.getByRole('button', { name: `「${name}」を閉じる` }).click();

    // disabled でなく aria-disabled。押しても何も起きない
    const submitting = dialog.getByRole('button', { name: '閉じています' });
    await expect(submitting).toHaveAttribute('aria-disabled', 'true');
    await expect(dialog.getByRole('status')).toHaveText('閉じています');
    await submitting.click({ force: true });
    await submitting.click({ force: true });
    await dialog.getByRole('button', { name: 'やめる' }).click({ force: true });
    await page.keyboard.press('Escape');
    await expect(dialog).toBeVisible();

    await expect(dialog).toBeHidden();
    await expect(row.locator('.chip')).toHaveText(/^閉じた /);
    expect(requests).toBe(1);

    // 後片づけ。開き直しておく
    await row.getByRole('button', { name: `「${name}」を開き直す` }).click();
    await expect(row.locator('.chip')).toHaveCount(0);
  });

  test('閉じられなかったときは、ダイアログの中に理由を出して開いたままにする。別の画面で先に閉じられていたら、読み直して知らせる', async ({
    page,
  }) => {
    const name = '失敗の確認パーティ';
    await createWorkspace(page, name);
    await page.goto('/aoba/admin');
    const row = page.locator('tbody tr', { hasText: name });

    await page.route('**/api/aoba/workspace-close', (route) =>
      route.fulfill({ status: 500, json: { error: { code: 'internal', message: 'x' } } }),
    );
    await row.getByRole('button', { name: `「${name}」を閉じる` }).click();
    const dialog = page.getByRole('dialog', { name: 'パーティを閉じる' });
    await dialog.getByRole('button', { name: `「${name}」を閉じる` }).click();
    await expect(dialog.getByRole('alert')).toHaveText('パーティを閉じられませんでした。もう一度試してください。');
    await expect(dialog.getByRole('button', { name: `「${name}」を閉じる` })).toHaveAttribute('aria-disabled', 'false');
    await expect(row.locator('.chip')).toHaveCount(0);

    // 別の画面で先に閉じられていた（409）
    await page.unroute('**/api/aoba/workspace-close');
    await page.route('**/api/aoba/workspace-close', async (route) => {
      await page.request.post('/api/aoba/workspace-close', {
        headers: { Origin: new URL(page.url()).origin },
        data: JSON.parse(route.request().postData() ?? '{}'),
      });
      await route.continue();
    });
    await dialog.getByRole('button', { name: `「${name}」を閉じる` }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole('status').filter({ hasText: `「${name}」は、すでに閉じています` })).toBeVisible();
    await expect(row.locator('.chip')).toHaveText(/^閉じた /);

    await page.unroute('**/api/aoba/workspace-close');
    await row.getByRole('button', { name: `「${name}」を開き直す` }).click();
    await expect(row.locator('.chip')).toHaveCount(0);
  });

  test('一覧を読み込めないときは節の中に知らせ、「もう一度試す」で読み直せる。ほかの部分は出る', async ({ page }) => {
    let calls = 0;
    await page.route('**/api/aoba/workspace-list', (route) => {
      calls++;
      if (calls === 1) return route.fulfill({ status: 500, json: { error: { code: 'internal', message: 'x' } } });
      return route.continue();
    });
    await page.goto('/aoba/admin');
    // 見出しと節の見出しは出ている
    await expect(page.getByRole('heading', { level: 1, name: '組織の管理' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: 'パーティ' })).toBeVisible();
    await expect(page.getByText('パーティの一覧を読み込めませんでした')).toBeVisible();
    await expect(page.getByRole('button', { name: 'パーティを作る' })).toBeVisible();

    await page.getByRole('button', { name: 'もう一度試す' }).click();
    await expect(page.locator('tbody tr', { hasText: '受託開発チーム' })).toBeVisible();
    await expect(page.getByText('パーティの一覧を読み込めませんでした')).toHaveCount(0);
  });
});

test.describe('一般のユーザー（あおば開発のハルカ）', () => {
  test.beforeEach(async ({ context, baseURL }) => {
    await signIn(context, baseURL, 'member');
  });

  test('閉じたワークスペースの帯は出るが、組織の管理へのリンクは出ない', async ({ page }) => {
    // 受託開発チームを、画面の上だけで閉じた状態にする（seed のワークスペースを閉じない）
    await page.route('**/api/aoba/workspace', async (route) => {
      const response = await route.fetch();
      const body = (await response.json()) as { closed_at: string | null };
      body.closed_at = '2026-10-22T00:00:00.000Z';
      await route.fulfill({ response, json: body });
    });
    await page.goto('/aoba/w/019a0000-0000-7000-8000-000000000401');
    await expect(page.getByRole('heading', { level: 1, name: '掲示板' })).toBeVisible();
    await expect(page.locator('.callout')).toHaveText(BANNER);
    await expect(page.locator('.callout').getByRole('link')).toHaveCount(0);
  });
});
