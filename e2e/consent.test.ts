import { expect, test } from './fixtures.ts';
import { signIn, waitForSettled } from './helpers.ts';

test('ログインした人が同意して return_to の画面へ戻る', async ({ page, context, baseURL }) => {
  await signIn(context, baseURL, 'admin');
  await page.goto('/consent?return_to=%2Faoba');
  await expect(page.getByRole('heading', { level: 1, name: '同意の確認' })).toBeVisible();
  const checkbox = page.getByRole('checkbox', { name: '利用規約とプライバシーポリシーを確認し、同意します' });
  if (await checkbox.isVisible()) {
    await checkbox.check();
    await waitForSettled(page);
    await page.getByRole('button', { name: '同意して進む' }).click();
    await expect(page).toHaveURL(/\/aoba$/);
  } else {
    await expect(page.getByText('現在の版に同意しています。')).toBeVisible();
  }
});
