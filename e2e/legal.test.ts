import { expect, test } from './fixtures.ts';
import { PRIVACY_VERSION, TERMS_VERSION } from '../src/lib/legal/versions.ts';
import { findOverflowViolations, findTargetSizeViolations, NARROW_VIEWPORT, watchViolations } from './helpers.ts';

// 利用規約（/terms）とプライバシーポリシー（/privacy）。ログインしていない人が、ログインの画面に移されずに読める（Issue #646）。
// どのテストも、Cookie の無い（ログインしていない）page で開く。axe は e2e/a11y-screens.test.ts が、4つのテーマで確かめる。
// 文面は人が直すので、文の言い回しは固定せず、画面の見出し、短い語、版（src/lib/legal/versions.ts）で確かめる

const pages = [
  { path: '/terms', title: '利用規約', version: TERMS_VERSION },
  { path: '/privacy', title: 'プライバシーポリシー', version: PRIVACY_VERSION },
] as const;

for (const { path, title, version } of pages) {
  test(`${path} は、ログインしていなくても、ログインの画面に移らずに本文が読め、改定日が1か所に出る`, async ({
    page,
  }) => {
    const apiCalls: string[] = [];
    page.on('request', (request) => {
      if (new URL(request.url()).pathname.startsWith('/api/')) apiCalls.push(request.url());
    });
    const collect = await watchViolations(page);

    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
    await expect(page).toHaveTitle(`${title} - Scrum Guild`);
    // 条の見出し（h2）と本文がある
    await expect(page.getByRole('heading', { level: 2 }).first()).toBeVisible();
    await expect(page.getByRole('heading', { name: '改定の履歴' })).toHaveCount(0);
    // 改定日（版）は、紙の上の1か所だけ（本文の末尾の行は描かない）
    await expect(page.getByText(`改定日: ${version}`, { exact: true })).toHaveCount(1);
    await expect(page.getByText(`改定日: ${version}`, { exact: true })).toBeVisible();
    // ログインの画面に移らず、その画面に居る。枠（左のメニューと上の帯）も出ない
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
  await expect(page.getByText('取り込み元の本文').first()).toBeVisible();
  await expect(page.getByText('30 日').first()).toBeVisible();
});

test('/login から、利用規約とプライバシーポリシーに移れて、もう一方のページへも移れる', async ({ page }) => {
  await page.goto('/login');
  const links = page.getByRole('group', { name: '利用規約とプライバシーポリシー' });

  await links.getByRole('link', { name: '利用規約' }).click();
  await expect(page).toHaveURL(/\/terms$/);
  await expect(page.getByRole('heading', { level: 1, name: '利用規約' })).toBeVisible();

  const related = page.getByRole('group', { name: '関連するページ' });
  await related.getByRole('link', { name: 'プライバシーポリシー' }).click();
  await expect(page).toHaveURL(/\/privacy$/);
  await expect(page.getByRole('heading', { level: 1, name: 'プライバシーポリシー' })).toBeVisible();

  await page.getByRole('group', { name: '関連するページ' }).getByRole('link', { name: '利用規約' }).click();
  await expect(page).toHaveURL(/\/terms$/);
});

test('/login?return_to=… から規約へ移り、「前の画面に戻る」で、同じクエリのログインの画面に戻る', async ({ page }) => {
  await page.goto('/login?return_to=%2Faoba');
  await page
    .getByRole('group', { name: '利用規約とプライバシーポリシー' })
    .getByRole('link', { name: '利用規約' })
    .click();
  await expect(page).toHaveURL(/\/terms$/);

  const related = page.getByRole('group', { name: '関連するページ' });
  // アプリの中から移ってきたので、戻るボタンを出す（/ へのリンクは出さない）
  await expect(related.getByRole('button', { name: '前の画面に戻る' })).toBeVisible();
  await expect(related.getByRole('link', { name: 'Scrum Guild を開く' })).toHaveCount(0);
  await related.getByRole('button', { name: '前の画面に戻る' }).click();

  await expect(page).toHaveURL(/\/login\?return_to=%2Faoba$/);
  await expect(page.getByRole('heading', { level: 1, name: 'ログイン' })).toBeVisible();
});

test('/login?return_to=… から規約、ポリシーと移っても、「前の画面に戻る」で同じクエリのログインの画面に戻る', async ({
  page,
}) => {
  await page.goto('/login?return_to=%2Faoba');
  await page
    .getByRole('group', { name: '利用規約とプライバシーポリシー' })
    .getByRole('link', { name: '利用規約' })
    .click();
  await expect(page).toHaveURL(/\/terms$/);
  const related = page.getByRole('group', { name: '関連するページ' });
  await related.getByRole('link', { name: 'プライバシーポリシー' }).click();
  await expect(page).toHaveURL(/\/privacy$/);
  await expect(page.getByRole('heading', { level: 1, name: 'プライバシーポリシー' })).toBeVisible();

  await related.getByRole('button', { name: '前の画面に戻る' }).click();
  await expect(page).toHaveURL(/\/login\?return_to=%2Faoba$/);
  await expect(page.getByRole('heading', { level: 1, name: 'ログイン' })).toBeVisible();
});

test('/terms を直に開いてポリシーへ移っても、戻るボタンを出さず / へのリンクのまま', async ({ page }) => {
  await page.goto('/terms');
  const related = page.getByRole('group', { name: '関連するページ' });
  await expect(related.getByRole('link', { name: 'Scrum Guild を開く' })).toBeVisible();
  await related.getByRole('link', { name: 'プライバシーポリシー' }).click();
  await expect(page).toHaveURL(/\/privacy$/);
  await expect(page.getByRole('heading', { level: 1, name: 'プライバシーポリシー' })).toBeVisible();
  await expect(related.getByRole('link', { name: 'Scrum Guild を開く' })).toBeVisible();
  await expect(related.getByRole('button', { name: '前の画面に戻る' })).toHaveCount(0);
});

test('/terms を直に開いたときは、戻るボタンの代わりに / へのリンクを出し、ログインしていなければログインの画面へ移る', async ({
  page,
}) => {
  await page.goto('/terms');
  const related = page.getByRole('group', { name: '関連するページ' });
  await expect(related.getByRole('link', { name: 'Scrum Guild を開く' })).toBeVisible();
  await expect(related.getByRole('button', { name: '前の画面に戻る' })).toHaveCount(0);

  await related.getByRole('link', { name: 'Scrum Guild を開く' }).click();
  await expect(page).toHaveURL(/\/login/);
  await expect(page.getByRole('heading', { level: 1, name: 'ログイン' })).toBeVisible();
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
    // 新しいタブは直に開いた画面なので、戻るボタンの代わりに / へのリンクを出す
    await expect(opened.getByRole('link', { name: 'Scrum Guild を開く' })).toBeVisible();
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
