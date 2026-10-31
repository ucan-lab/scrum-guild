import { expect, test } from './fixtures.ts';
import { signIn } from './helpers.ts';

// seed に同意の行は無いので、ログインしたばかりの admin は未同意
test('ログインした人が印を付けて同意し、return_to の画面へ戻り、開き直すと同意済みと出る', async ({
  page,
  context,
  baseURL,
}) => {
  await signIn(context, baseURL, 'admin');
  await page.goto('/consent?return_to=%2Faoba');
  const checkbox = page.getByRole('checkbox', { name: '利用規約とプライバシーポリシーを確認し、同意します' });
  const submit = page.getByRole('button', { name: '同意して進む' });
  await expect(checkbox).toBeVisible();
  await expect(submit).toHaveAttribute('aria-disabled', 'true');
  await checkbox.check();
  await expect(submit).toHaveAttribute('aria-disabled', 'false');
  await submit.click();
  await expect(page).toHaveURL(/\/aoba$/);

  await page.goto('/consent');
  await expect(page.getByText('現在の版に同意しています。')).toBeVisible();
  await expect(page.getByText(/^同意した日時: /)).toBeVisible();
});
