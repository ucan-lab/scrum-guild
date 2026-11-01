// 組織の無い会員が、組織を作ってその組織へ移る流れ。手元では実行せず、CI の e2e で確かめる。
import { expect, test } from './fixtures.ts';
import { signIn } from './helpers.ts';

test('組織の無い会員は「組織を作る」から作成後の組織へ移る', async ({ context, baseURL, page }) => {
  await signIn(context, baseURL, 'createOrg');
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: '入れる組織がありません' })).toBeVisible();
  await page.getByRole('button', { name: '組織を作る' }).click();
  await page.getByLabel('URL の名前（slug）').fill('nagi-trial');
  await page.getByLabel('組織の名前').fill('ナギの工房');
  await page.getByRole('button', { name: '組織を作る' }).last().click();
  await expect(page).toHaveURL(/\/nagi-trial\/?$/);
});
