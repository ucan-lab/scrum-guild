import { expect, test } from './fixtures.ts';
import { PRIVACY_VERSION, TERMS_VERSION } from '../src/lib/legal/versions.ts';
import { findOverflowViolations, findTargetSizeViolations, NARROW_VIEWPORT, watchViolations } from './helpers.ts';

// 利用規約（/terms）とプライバシーポリシー（/privacy）。ログインしていない人が、ログインの画面に移されずに読める（Issue #646）。
// どのテストも、Cookie の無い（ログインしていない）page で開く。axe は e2e/a11y-screens.test.ts が、4つのテーマで確かめる。
// 文面は人が直すので、見出しの文字は固定せず、画面の見出しと、版（src/lib/legal/versions.ts）で確かめる

const pages = [
  { path: '/terms', title: '利用規約', version: TERMS_VERSION },
  { path: '/privacy', title: 'プライバシーポリシー', version: PRIVACY_VERSION },
] as const;

for (const { path, title, version } of pages) {
  test(`${path} は、ログインしていなくても、ログインの画面に移らずに本文と改定日が読める`, async ({ page }) => {
    const apiCalls: string[] = [];
    page.on('request', (request) => {
      if (new URL(request.url()).pathname.startsWith('/api/')) apiCalls.push(request.url());
    });
    const collect = await watchViolations(page);

    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
    await expect(page).toHaveTitle(`${title} - Scrum Guild`);
    await expect(page.getByText(`改定日: ${version}`, { exact: true }).first()).toBeVisible();
    // 条の見出し（h2）と本文がある
    await expect(page.getByRole('heading', { level: 2 }).first()).toBeVisible();
    // 移り続けない（その画面で止まる）。枠（左のメニューと上の帯）も出ない
    await page.waitForTimeout(300);
    await expect(page).toHaveURL(new RegExp(`${path}$`));
    await expect(page.locator('.app')).toHaveCount(0);
    // API を呼ばない（ログインの確かめもしない）
    expect(apiCalls).toEqual([]);
    expect(await collect()).toEqual([]);
  });
}

test('/privacy に、預かるもの、預からないもの（取り込み元の本文の既定）、消す時期（解約から 30 日）が書かれている', async ({
  page,
}) => {
  await page.goto('/privacy');
  await expect(page.getByRole('heading', { level: 2, name: /預かるもの/ })).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: /預からないもの/ })).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: /消す時期/ })).toBeVisible();
  await expect(page.getByText('取り込み元の本文は、既定では預かりません', { exact: false })).toBeVisible();
  await expect(page.getByText('停止の日から 30 日後に', { exact: false })).toBeVisible();
});

test('/login から、利用規約とプライバシーポリシーに移れて、それぞれからログインに戻れる', async ({ page }) => {
  await page.goto('/login');
  const links = page.getByRole('group', { name: '利用規約とプライバシーポリシー' });

  await links.getByRole('link', { name: '利用規約' }).click();
  await expect(page).toHaveURL(/\/terms$/);
  await expect(page.getByRole('heading', { level: 1, name: '利用規約' })).toBeVisible();

  // もう一方のページへ
  const related = page.getByRole('group', { name: '関連するページ' });
  await related.getByRole('link', { name: 'プライバシーポリシー' }).click();
  await expect(page).toHaveURL(/\/privacy$/);
  await expect(page.getByRole('heading', { level: 1, name: 'プライバシーポリシー' })).toBeVisible();

  await page.getByRole('group', { name: '関連するページ' }).getByRole('link', { name: '利用規約' }).click();
  await expect(page).toHaveURL(/\/terms$/);

  // ログインに戻る
  await page.getByRole('group', { name: '関連するページ' }).getByRole('link', { name: 'ログインに戻る' }).click();
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('heading', { level: 1, name: 'ログイン' })).toBeVisible();

  await links.getByRole('link', { name: 'プライバシーポリシー' }).click();
  await expect(page).toHaveURL(/\/privacy$/);
});

test('招待の画面（/invite）から、利用規約とプライバシーポリシーが新しいタブで開ける。元の画面は残る', async ({
  page,
}) => {
  // 秘密の形（src/shared/claim-token.ts の CLAIM_TOKEN_PATTERN）。架空の値
  await page.goto('/invite#Qm7tX2vLr9aKpE4wZc8hN3bYd6fGs1uJ0oTiRl5eWxA');
  await expect(page.getByRole('button', { name: 'Google でログイン' })).toBeVisible();

  const links = page.getByRole('group', { name: '利用規約とプライバシーポリシー' });
  for (const [name, path, heading] of [
    ['利用規約', '/terms', '利用規約'],
    ['プライバシーポリシー', '/privacy', 'プライバシーポリシー'],
  ] as const) {
    const link = links.getByRole('link', { name });
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('href', path);
    const popup = page.waitForEvent('popup');
    await link.click();
    const opened = await popup;
    await expect(opened.getByRole('heading', { level: 1, name: heading })).toBeVisible();
    await expect(opened).toHaveURL(new RegExp(`${path}$`));
    await opened.close();
    // 元の画面は、秘密を持ったまま残り、ログインのボタンを押せる
    await expect(page.getByRole('button', { name: 'Google でログイン' })).toBeVisible();
  }
});

for (const { path, title } of pages) {
  test(`${path} は、幅 390px で横にはみ出さず、押せる範囲が足りる`, async ({ page }) => {
    await page.setViewportSize(NARROW_VIEWPORT);
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth),
    ).toBe(true);
    expect(await findOverflowViolations(page)).toEqual([]);
    expect(await findTargetSizeViolations(page)).toEqual([]);
  });
}

test('/login と /invite も、リンクを足した後に幅 390px で横にはみ出さず、押せる範囲が足りる', async ({ page }) => {
  await page.setViewportSize(NARROW_VIEWPORT);
  for (const path of ['/login', '/invite#Qm7tX2vLr9aKpE4wZc8hN3bYd6fGs1uJ0oTiRl5eWxA']) {
    await page.goto(path);
    await expect(page.getByRole('link', { name: '利用規約' }).first()).toBeVisible();
    expect(await findOverflowViolations(page)).toEqual([]);
    expect(await findTargetSizeViolations(page)).toEqual([]);
  }
});
