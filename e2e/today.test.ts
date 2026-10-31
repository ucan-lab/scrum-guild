import { expect, test } from './fixtures.ts';
import { signIn } from './helpers.ts';

test.describe('今日やること', () => {
  test('組織の今日やることを開き、空の区分を表示しない', async ({ context, baseURL, page }) => {
    await signIn(context, baseURL, 'member');
    await page.goto('/aoba');
    await expect(page.getByRole('heading', { level: 1, name: '今日やること' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: '今日やると決めたもの' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: '期日切れ' })).toHaveCount(0);
    await expect(page.getByRole('heading', { level: 2, name: '今週が期日' })).toHaveCount(0);
  });
});
