// メンバーの画面。seed のセッション（seed/sessions.ts）の Cookie で開く。
// あおば開発の受託開発チームは、ミナト（管理者でリーダー）とハルカ（一般）が所属し、承諾待ちの招待が1件ある（seed/data.sql）
import { expect, test } from '@playwright/test';
import { signIn, watchViolations } from './helpers.ts';

const AOBA_WORKSPACE_ID = '019a0000-0000-7000-8000-000000000401';
const MEMBERS_PATH = `/aoba/w/${AOBA_WORKSPACE_ID}/members`;

test.describe('リーダー（あおば開発のミナト）', () => {
  test.beforeEach(async ({ context, baseURL }) => {
    await signIn(context, baseURL, 'admin');
  });

  test('メニューの「メンバー」から開くと、所属している人と承諾待ちの招待が出る', async ({ page }) => {
    const collect = await watchViolations(page);
    // 組織の画面のメニューには、ワークスペースの経路の項目を出さない
    await page.goto('/aoba');
    await expect(page.locator('.nav-item', { hasText: 'メンバー' })).toHaveCount(0);

    await page.goto(`/aoba/w/${AOBA_WORKSPACE_ID}`);
    await page.locator('.nav-item', { hasText: 'メンバー' }).click();
    await expect(page).toHaveURL(new RegExp(`${MEMBERS_PATH}$`));
    await expect(page.getByRole('heading', { level: 1, name: 'メンバー' })).toBeVisible();
    await expect(page.locator('.page-eyebrow')).toHaveText('受託開発チーム');
    await expect(page.locator('.nav-item[aria-current="page"]')).toHaveText('メンバー');
    await expect(page).toHaveTitle('メンバー・受託開発チーム - Scrum Guild');

    // 頭の数字は所属、リーダー、招待中
    const tally = page.locator('.tally > div');
    await expect(tally).toHaveText(['所属 2', 'パーティリーダー 1', '招待中 1']);

    // 所属している人。リーダーが先。ロールは文字で、操作の部品は出ない
    const members = page.getByRole('table', { name: '所属している人の一覧' });
    const rows = members.locator('tbody tr');
    await expect(rows).toHaveCount(2);
    // 名前の前に頭文字の円（その文字も td の文字に入る）
    await expect(rows.nth(0).locator('td').nth(0)).toHaveText('ミミナト');
    await expect(rows.nth(0).locator('td').nth(0).getByRole('img', { name: 'ミナト' })).toBeVisible();
    await expect(rows.nth(0).locator('td').nth(1)).toHaveText('パーティリーダー');
    await expect(rows.nth(0).locator('td').nth(2)).toHaveText('2026-10-01');
    await expect(rows.nth(1).locator('td').nth(0)).toHaveText('ハハルカ');
    await expect(rows.nth(1).locator('td').nth(1)).toHaveText('一般');
    await expect(page.locator('select, tbody button')).toHaveCount(0);

    // 承諾待ちの招待。招待した日はワークスペースのタイムゾーン（東京）の日付
    const invitations = page.getByRole('table', { name: '承諾待ちの招待の一覧' });
    await expect(page.getByRole('heading', { level: 2, name: '承諾待ちの招待' })).toBeVisible();
    await expect(invitations.locator('tbody tr')).toHaveCount(1);
    const invitation = invitations.locator('tbody tr').first().locator('td');
    await expect(invitation).toHaveText(['sora--seed', 'GitHub', '一般', '2026-10-19']);
    expect(await collect()).toEqual([]);
  });
});

test.describe('一般のユーザー（あおば開発のハルカ）', () => {
  test.beforeEach(async ({ context, baseURL }) => {
    await signIn(context, baseURL, 'member');
  });

  test('所属している人は見えて、承諾待ちの招待の欄と「招待中」の数は出ず、API も招待を返さない', async ({ page }) => {
    const collect = await watchViolations(page);
    const response = page.waitForResponse((res) => res.url().endsWith('/api/aoba/member-list'));
    await page.goto(MEMBERS_PATH);
    const body = (await (await response).json()) as { members: unknown[]; invitations: unknown };
    expect(body.members).toHaveLength(2);
    expect(body.invitations).toBeNull();

    await expect(page.getByRole('heading', { level: 1, name: 'メンバー' })).toBeVisible();
    await expect(page.locator('.tally > div')).toHaveText(['所属 2', 'パーティリーダー 1']);
    await expect(page.getByRole('table', { name: '所属している人の一覧' }).locator('tbody tr')).toHaveCount(2);
    await expect(page.getByRole('heading', { level: 2, name: '承諾待ちの招待' })).toHaveCount(0);
    await expect(page.getByText('sora--seed')).toHaveCount(0);
    expect(await collect()).toEqual([]);
  });

  test('別の組織のワークスペースの ID は「見つからない」', async ({ page }) => {
    await page.goto('/aoba/w/019a0000-0000-7000-8000-000000000402/members');
    await expect(page.getByRole('heading', { level: 1, name: /見つかりません/ })).toBeVisible();
  });
});
