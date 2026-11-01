// 組織の無い会員が、組織を作ってその組織へ移る流れ。手元では実行せず、CI の e2e で確かめる。
import type { Page } from '@playwright/test';
import { word } from '../src/shared/vocabulary.ts';
import { expect, test } from './fixtures.ts';
import { signIn } from './helpers.ts';
import { removeCreatedOrganizations } from './local-d1.ts';

// 作った組織は API に消す操作が無く、お試し中の組織は1アカウントに1つまでなので、テストの前と後に seed の状態（組織の無い会員）へ戻す
// （e2e/local-d1.ts）。繰り返し（--repeat-each）でも毎回組織の無い状態から始める。この会員を使うテストはこのファイルにまとめる
test.beforeEach(async () => {
  await removeCreatedOrganizations('createOrg');
});
test.afterEach(async () => {
  await removeCreatedOrganizations('createOrg');
});

async function openDialog(page: Page) {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: '入れる組織がありません' })).toBeVisible();
  await page.getByRole('button', { name: '組織を作る' }).click();
  const dialog = page.getByRole('dialog', { name: word('createMyOrganizationTitle') });
  await expect(dialog).toBeVisible();
  return dialog;
}

test('組織の無い会員は「組織を作る」から作成後の組織へ移る', async ({ context, baseURL, page }) => {
  await signIn(context, baseURL, 'createOrg');
  const dialog = await openDialog(page);
  await dialog.getByLabel('URL の名前（slug）').fill('nagi-trial');
  await dialog.getByLabel('組織の名前').fill('ナギの工房');
  await dialog.getByRole('button', { name: '組織を作る' }).click();
  await expect(page).toHaveURL(/\/nagi-trial\/?$/);
});

test('すでにある組織の slug を入れると、ダイアログに理由が出て、組織は作られない', async ({
  context,
  baseURL,
  page,
}) => {
  await signIn(context, baseURL, 'createOrg');
  const dialog = await openDialog(page);
  // seed の組織（aoba）と同じ slug
  await dialog.getByLabel('URL の名前（slug）').fill('aoba');
  await dialog.getByLabel('組織の名前').fill('ナギの工房');
  await dialog.getByRole('button', { name: '組織を作る' }).click();
  await expect(dialog.getByText(word('createMyOrganizationSlugTaken'))).toBeVisible();
  await expect(dialog).toBeVisible();
  await expect(page).not.toHaveURL(/\/aoba/);
});
