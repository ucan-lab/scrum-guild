import type { Page } from '@playwright/test';
import { organizationInfo } from '../src/shared/operations/organization/index.ts';
import { expect, test } from './fixtures.ts';
import { expectFocusReturned, signIn, watchViolations } from './helpers.ts';
import { rewriteOperation } from './operations.ts';

const workspaceId = '019a0000-0000-7000-8000-000000000401';
const backlog = `/aoba/w/${workspaceId}`;
const buttonOf = (page: Page) => page.locator('.ws-menu-button');
const listOf = (page: Page) => page.getByRole('list', { name: '所属するワークスペース' });

async function oneWorkspace(page: Page) {
  await rewriteOperation(page, organizationInfo, { slug: 'aoba' }, (body) => ({
    ...body,
    workspaces: body.workspaces.filter((workspace) => workspace.id === workspaceId),
  }));
}

test('一般のメンバーが別の所属先を選ぶと、終了したワークスペースのバックログへ移る', async ({
  page,
  context,
  baseURL,
}) => {
  // seed を変えず、この回だけの移動先を作る。一般のユーザーのハルカを最初のリーダーにする。
  await signIn(context, baseURL, 'admin');
  const name = `架空の切り替え先 ${test.info().repeatEachIndex}-${test.info().retry}`;
  await page.goto('/aoba/admin');
  await page.getByRole('button', { name: 'ワークスペースを作る' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'ワークスペースを作る' });
  await expect(dialog.getByRole('combobox')).toBeEnabled();
  await dialog.getByRole('combobox').selectOption({ label: 'ハルカ' });
  await dialog.getByLabel('名前').fill(name);
  await dialog.getByRole('button', { name: '作る' }).click();
  await page.getByRole('dialog', { name: 'ワークスペースを作りました' }).getByRole('button', { name: '開く' }).click();
  await expect(page).toHaveURL(/\/aoba\/w\/[0-9a-f-]{36}$/);
  const target = new URL(page.url()).pathname;

  // 所属していない管理者には、今のものは押せない現在地の行、リンクは所属先だけ。
  const adminButton = buttonOf(page);
  await adminButton.click();
  await expect(listOf(page).locator('.ws-menu-current')).toHaveText(name);
  await expect(listOf(page).getByRole('link', { name, exact: true })).toHaveCount(0);
  await page.keyboard.press('Escape');

  await page.goto('/aoba/admin');
  const row = page.getByRole('region', { name: 'ワークスペース', exact: true }).locator('tbody tr', { hasText: name });
  await row.getByRole('button', { name: `「${name}」を終了する` }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: `「${name}」を終了する` })
    .click();
  await expect(row.locator('.chip')).toHaveText(/^終了 /);

  await signIn(context, baseURL, 'member');
  const collect = await watchViolations(page);
  await page.goto(`${backlog}/members`);
  await expect(page.getByRole('heading', { level: 1, name: 'メンバー', exact: true })).toBeVisible();
  await expect(page.locator('.nav-item', { hasText: '組織の管理' })).toHaveCount(0);
  await buttonOf(page).click();
  const current = listOf(page).getByRole('link', { name: '受託開発チーム', exact: true });
  await expect(current).toHaveAttribute('aria-current', 'page');
  await expect(current.locator('use')).toHaveAttribute('href', '#i-check');
  const destination = listOf(page).getByRole('link', { name, exact: true });
  await expect(destination).toHaveAttribute('href', target);
  await destination.click();
  await expect(page).toHaveURL(new RegExp(`${target}$`));
  await expect(listOf(page)).toBeHidden();
  await expect(buttonOf(page)).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByRole('heading', { level: 1, name: 'バックログ', exact: true })).toBeVisible();
  await expect(buttonOf(page)).toContainText(name);
  await expect(page.getByText(/に終了しました。読み取り専用です。/).first()).toBeVisible();
  await buttonOf(page).click();
  await expect(listOf(page).getByRole('link', { name, exact: true })).toHaveAttribute('aria-current', 'page');
  expect(await collect()).toEqual([]);
});

test('所属が複数の一覧で、矢印キーを押しただけでは移らず、開いたままフォーカスも動かない', async ({
  page,
  context,
  baseURL,
}) => {
  await signIn(context, baseURL, 'member');
  await rewriteOperation(page, organizationInfo, { slug: 'aoba' }, (body) => ({
    ...body,
    workspaces: [
      ...body.workspaces.filter((workspace) => workspace.id === workspaceId),
      { id: '019a0000-0000-7000-8000-000000009001', name: '架空の切り替え先 A', role: 'member' as const },
    ],
  }));
  await page.goto(backlog);
  await buttonOf(page).focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Tab');
  const first = listOf(page).getByRole('link').first();
  await expect(first).toBeFocused();
  for (const key of ['ArrowDown', 'ArrowUp']) {
    await page.keyboard.press(key);
    await expect(first).toBeFocused();
    await expect(listOf(page)).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`${backlog}$`));
  }
});

test.describe('所属が1つの一般のメンバー', () => {
  test.beforeEach(async ({ page, context, baseURL }) => {
    await signIn(context, baseURL, 'member');
    await oneWorkspace(page);
  });

  test('キーボードで開き、Tab でリンクを選ぶ。矢印では移らず、Esc で閉じてボタンへ戻る', async ({ page }) => {
    await page.goto(backlog);
    const button = buttonOf(page);
    await expect(button).toHaveAttribute('aria-expanded', 'false');
    await button.focus();
    await page.keyboard.press('Enter');
    await expect(listOf(page)).toBeVisible();
    await page.keyboard.press('Tab');
    const current = listOf(page).getByRole('link');
    await expect(current).toBeFocused();
    for (const key of ['ArrowDown', 'ArrowUp']) {
      await page.keyboard.press(key);
      await expect(current).toBeFocused();
      await expect(page).toHaveURL(new RegExp(`${backlog}$`));
    }
    await page.keyboard.press('Escape');
    await expect(listOf(page)).toBeHidden();
    await expectFocusReturned(page, button);
    await page.keyboard.press('Enter');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await expect(listOf(page)).toBeHidden();
    await expect(page.locator('.nav-item', { hasText: 'バックログ' })).toBeFocused();
    await button.click();
    await expect(listOf(page)).toBeVisible();
    await page.getByRole('heading', { level: 1, name: 'バックログ', exact: true }).click();
    await expect(listOf(page)).toBeHidden();
  });

  test('畳んだ列と760px以下とワークスペースの外には切り替えを出さない', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(backlog);
    await expect(buttonOf(page)).toBeVisible();
    await page.getByRole('button', { name: 'メニューを畳む' }).click();
    await expect(buttonOf(page)).toBeHidden();
    await page.getByRole('button', { name: 'メニューを広げる' }).click();
    for (const width of [760, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(buttonOf(page)).toBeHidden();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/aoba');
    await expect(buttonOf(page)).toHaveCount(0);
  });
});

for (const width of [1280, 1024]) {
  test(`${width}px で多数の長い名前を一覧内でスクロールでき、本文に隠れない`, async ({ page, context, baseURL }) => {
    await signIn(context, baseURL, 'member');
    const names = Array.from({ length: 30 }, (_, i) => ({
      id: `019a0000-0000-7000-8000-${String(8000 + i).padStart(12, '0')}`,
      name: `架空の開発チーム ${i}・長いワークスペースの名前も折り返して表示する`,
      role: 'member' as const,
    }));
    await rewriteOperation(page, organizationInfo, { slug: 'aoba' }, (body) => ({
      ...body,
      workspaces: [...body.workspaces.filter((workspace) => workspace.id === workspaceId), ...names],
    }));
    await page.setViewportSize({ width, height: 900 });
    await page.goto(backlog);
    await buttonOf(page).click();
    const list = listOf(page);
    await expect(list.getByRole('link')).toHaveCount(31);
    const measurements = await list.evaluate((element) => ({
      overflow: element.scrollHeight > element.clientHeight,
      width: element.scrollWidth <= element.clientWidth,
      maxHeight: element.getBoundingClientRect().height <= innerHeight * 0.4 + 1,
    }));
    expect(measurements).toEqual({ overflow: true, width: true, maxHeight: true });
    await list.getByRole('link').last().scrollIntoViewIfNeeded();
    expect(await list.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    const link = list.getByRole('link').last();
    expect(
      await link.evaluate((element) => {
        const box = element.getBoundingClientRect();
        return element.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
      }),
    ).toBe(true);
  });
}
