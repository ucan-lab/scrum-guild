// ログアウト。組織の中は上の帯のアカウントのメニュー、組織の外（/operator）は紙の下のボタンから押す。
// e2e は seed のセッションを全ファイルで共有して並列に走るので、本物のログアウトは専用の行（adminLogout、operatorLogout。
// seed/sessions.ts）だけで行い、共有の admin、member、operator は消さない。失敗と待ちの見せ方は、logout の応答を差し替えて確かめる
import { expect, test, type Page } from '@playwright/test';
import { SEED_SESSIONS } from '../seed/sessions.ts';
import { sessionCookieName } from '../src/shared/session-cookie.ts';
import { signIn } from './helpers.ts';

const accountButton = (page: Page) => page.getByRole('button', { name: /アカウントのメニュー$/ });
const logoutItem = (page: Page) => page.locator('.account-menu-list button');

test.describe('組織の中（アカウントのメニュー）', () => {
  test('メニューからログアウトすると、ログインの画面に移り、今のセッションだけが消える', async ({
    context,
    page,
    request,
    baseURL,
  }) => {
    if (baseURL === undefined) throw new Error('baseURL が無い');
    const cookieName = sessionCookieName(baseURL);
    const meWith = async (who: 'admin' | 'adminLogout') => {
      const res = await request.post('/api/me', {
        headers: { Origin: new URL(baseURL).origin, Cookie: `${cookieName}=${SEED_SESSIONS[who].token}` },
        data: {},
      });
      return res.status();
    };
    expect(await meWith('adminLogout')).toBe(200);

    await signIn(context, baseURL, 'adminLogout');
    await page.goto('/aoba');
    await expect(page.getByRole('heading', { level: 1, name: '自分の今日' })).toBeVisible();
    await accountButton(page).click();
    await logoutItem(page).click();

    await expect(page).toHaveURL('/login?logged_out=1');
    await expect(page.getByRole('heading', { level: 1, name: 'ログイン' })).toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: 'ログアウトしました。' })).toBeVisible();
    // 帯のあるページごと読み直したので、左のメニューも出ない
    await expect(page.locator('.app')).toHaveCount(0);

    expect((await context.cookies()).find((cookie) => cookie.name === cookieName)).toBeUndefined();
    // sessions の行が消えた
    expect(await meWith('adminLogout')).toBe(401);
    // 同じ人のほかのセッションは残る
    expect(await meWith('admin')).toBe(200);
  });

  test('?error= があるときは、ログアウトしましたを出さずエラーだけを出す', async ({ page }) => {
    await page.goto('/login?logged_out=1&error=retry');
    await expect(page.getByRole('alert')).toHaveText('ログインを完了できませんでした。もう一度ログインしてください。');
    await expect(page.getByText('ログアウトしました。')).toHaveCount(0);
    await page.goto('/login?logged_out=1');
    await expect(page.getByText('ログアウトしました。')).toBeVisible();
    await page.goto('/login');
    await expect(page.getByText('ログアウトしました。')).toHaveCount(0);
  });

  test.describe('共有のセッション（ログアウトの応答は差し替える）', () => {
    test.beforeEach(async ({ context, baseURL }) => {
      await signIn(context, baseURL, 'admin');
    });

    test('名前のボタンで開閉し、Esc、外を押す、Tab で外へ出ると閉じる。中にフォーカスがあるときはボタンへ戻る', async ({
      page,
    }) => {
      await page.goto('/aoba');
      const button = accountButton(page);
      await expect(button).toContainText('ミナト');
      await expect(button).toHaveAttribute('aria-expanded', 'false');
      await expect(logoutItem(page)).toBeHidden();

      await button.click();
      await expect(button).toHaveAttribute('aria-expanded', 'true');
      await expect(logoutItem(page)).toHaveText('ログアウト');

      // ボタンにフォーカスがあるときの Esc
      await page.keyboard.press('Escape');
      await expect(button).toHaveAttribute('aria-expanded', 'false');
      await expect(button).toBeFocused();

      // メニューの中にフォーカスがあるときの Esc は、ボタンへ戻す
      await page.keyboard.press('Enter');
      await page.keyboard.press('Tab');
      await expect(logoutItem(page)).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(button).toHaveAttribute('aria-expanded', 'false');
      await expect(button).toBeFocused();

      // 外を押すと閉じる
      await button.click();
      await expect(button).toHaveAttribute('aria-expanded', 'true');
      await page.getByRole('heading', { level: 1 }).click();
      await expect(button).toHaveAttribute('aria-expanded', 'false');

      // Tab でメニューの外へ出ると閉じる
      await button.click();
      await page.keyboard.press('Tab');
      await expect(logoutItem(page)).toBeFocused();
      await page.keyboard.press('Tab');
      await expect(button).toHaveAttribute('aria-expanded', 'false');
      await expect(page).toHaveURL(/\/aoba$/);
    });

    test('押した後は結果が返るまで項目を止めて「ログアウトしています」を出し、5xx ならトーストを出して今の画面に留まる', async ({
      page,
    }) => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let calls = 0;
      await page.route('**/api/logout', async (route) => {
        calls += 1;
        await gate;
        await route.fulfill({ status: 503, json: { error: { code: 'unavailable', message: 'x' } } });
      });
      await page.goto('/aoba');
      await accountButton(page).click();
      await logoutItem(page).click();
      await expect(logoutItem(page)).toHaveText('ログアウトしています');
      await expect(logoutItem(page)).toBeDisabled();
      // 止まっている間の押下は送らない
      await logoutItem(page).click({ force: true });
      release();

      // ダイアログごとの領域にも同じトーストが入るので、見えている領域だけを数える
      await expect(page.locator('.toasts:visible .toast')).toHaveText(
        'ログアウトできませんでした。時間をおいてもう一度試してください。',
      );
      await expect(logoutItem(page)).toHaveText('ログアウト');
      await expect(logoutItem(page)).toBeEnabled();
      await expect(page).toHaveURL(/\/aoba$/);
      expect(calls).toBe(1);
    });

    test('通信の失敗でも、今の画面に留まる', async ({ page }) => {
      await page.route('**/api/logout', (route) => route.abort());
      await page.goto('/aoba');
      await accountButton(page).click();
      await logoutItem(page).click();
      await expect(page.locator('.toasts:visible .toast')).toContainText('ログアウトできませんでした');
      await expect(page).toHaveURL(/\/aoba$/);
    });

    test('401 の unauthenticated は、成功と同じくログインの画面へ移る', async ({ page }) => {
      await page.route('**/api/logout', (route) =>
        route.fulfill({ status: 401, json: { error: { code: 'unauthenticated', message: 'x' } } }),
      );
      await page.goto('/aoba');
      await accountButton(page).click();
      await logoutItem(page).click();
      await expect(page).toHaveURL('/login?logged_out=1');
    });
  });
});

test.describe('組織の外（紙の下のボタン）', () => {
  test('/operator の紙の下のボタンからログアウトすると、ログインの画面に移る', async ({
    context,
    page,
    request,
    baseURL,
  }) => {
    if (baseURL === undefined) throw new Error('baseURL が無い');
    // e2e の Worker には運用者の一覧が無いので、組織の一覧は差し替える（運用者の画面は operator.test.ts と同じ）
    await page.route('**/api/list-organizations', (route) => route.fulfill({ json: { organizations: [] } }));
    await signIn(context, baseURL, 'operatorLogout');
    await page.goto('/operator');
    await expect(page.getByRole('heading', { level: 1, name: '運用' })).toBeVisible();
    await page.getByRole('button', { name: 'ログアウト' }).click();

    await expect(page).toHaveURL('/login?logged_out=1');
    await expect(page.getByText('ログアウトしました。')).toBeVisible();
    const cookieName = sessionCookieName(baseURL);
    expect((await context.cookies()).find((cookie) => cookie.name === cookieName)).toBeUndefined();
    const res = await request.post('/api/me', {
      headers: {
        Origin: new URL(baseURL).origin,
        Cookie: `${cookieName}=${SEED_SESSIONS.operatorLogout.token}`,
      },
      data: {},
    });
    expect(res.status()).toBe(401);
  });

  test('/ の紙の下にもログアウトのボタンがある', async ({ context, page, baseURL }) => {
    // 組織が2つの人にだけ組織の選択の画面が出る
    await signIn(context, baseURL, 'admin');
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1, name: '冒険者ギルドを選ぶ' })).toBeVisible();
    await expect(page.locator('.gate-sheet').first().getByRole('button', { name: 'ログアウト' })).toBeVisible();
  });
});
