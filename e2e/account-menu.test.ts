// アカウントと組織の入口は上の帯へ置き、左のメニューはサービスの機能に絞る（#710）。
import { expect, test } from './fixtures.ts';
import { signIn, watchViolations } from './helpers.ts';

test.describe('アカウントのメニュー', () => {
  test.beforeEach(async ({ context, baseURL }) => {
    await signIn(context, baseURL, 'admin');
  });

  test('管理者は3項目が指定順に並び、各リンクで移ると閉じ、現在地が付く', async ({ page }) => {
    const collect = await watchViolations(page);
    await page.goto('/aoba');
    const button = page.getByRole('button', { name: /アカウントのメニュー$/ });
    const list = page.locator('.account-menu-list');
    await button.click();
    await expect(list.locator('li')).toHaveText(['マイプロフィール', '組織の管理', 'ログアウト']);
    await expect(list.locator('[aria-current="page"]')).toHaveCount(0);
    await expect(page.locator('.nav')).not.toContainText(/マイプロフィール|組織の管理/);

    await list.getByRole('link', { name: 'マイプロフィール', exact: true }).click();
    await expect(page).toHaveURL(/\/aoba\/me$/);
    await expect(page.getByRole('heading', { level: 1, name: 'マイプロフィール' })).toBeVisible();
    await expect(page).toHaveTitle('マイプロフィール - Scrum Guild');
    await expect(button).toHaveAttribute('aria-expanded', 'false');
    await expect(list).toBeHidden();
    await button.click();
    await expect(list.getByRole('link', { name: 'マイプロフィール', exact: true })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect(list.getByRole('link', { name: '組織の管理' })).not.toHaveAttribute('aria-current');

    await list.getByRole('link', { name: '組織の管理' }).click();
    await expect(page).toHaveURL(/\/aoba\/admin$/);
    await expect(page.getByRole('heading', { level: 1, name: '組織の管理' })).toBeVisible();
    await expect(button).toHaveAttribute('aria-expanded', 'false');
    await button.click();
    await expect(list.getByRole('link', { name: '組織の管理' })).toHaveAttribute('aria-current', 'page');
    await expect(list.getByRole('link', { name: 'マイプロフィール', exact: true })).not.toHaveAttribute('aria-current');
    expect(await collect()).toEqual([]);
  });

  test('一般のユーザーにはマイプロフィールとログアウトだけを出す', async ({ context, baseURL, page }) => {
    await context.clearCookies();
    await signIn(context, baseURL, 'member');
    await page.goto('/aoba');
    await page.getByRole('button', { name: /アカウントのメニュー$/ }).click();
    await expect(page.locator('.account-menu-list li')).toHaveText(['マイプロフィール', 'ログアウト']);
    await expect(page.locator('.account-menu-list').getByRole('link', { name: '組織の管理' })).toHaveCount(0);
    await expect(page.locator('.nav')).not.toContainText(/マイプロフィール|組織の管理/);
  });

  test('キーボードで順に項目へ移り、Escでボタンへ戻り、Enterで画面を開ける', async ({ page }) => {
    await page.goto('/aoba');
    const button = page.getByRole('button', { name: /アカウントのメニュー$/ });
    const list = page.locator('.account-menu-list');
    await button.focus();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Tab');
    await expect(list.getByRole('link', { name: 'マイプロフィール', exact: true })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(list.getByRole('link', { name: '組織の管理' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(list.getByRole('button', { name: 'ログアウト' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(list).toBeHidden();
    await expect(button).toBeFocused();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/aoba\/me$/);
    await expect(list).toBeHidden();
  });

  for (const width of [320, 390, 760]) {
    test(`${width}px でも全項目が画面内に収まり、高さ44px以上になる`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await page.goto('/aoba');
      await page.getByRole('button', { name: /アカウントのメニュー$/ }).click();
      const boxes = await page.locator('.account-menu-list a, .account-menu-list button').evaluateAll((elements) =>
        elements.map((el) => {
          const box = el.getBoundingClientRect();
          return { inside: box.left >= 0 && box.right <= window.innerWidth, height: box.height };
        }),
      );
      expect(boxes).toHaveLength(3);
      for (const box of boxes) {
        expect(box.inside).toBe(true);
        expect(box.height).toBeGreaterThanOrEqual(44);
      }
    });
  }
});
