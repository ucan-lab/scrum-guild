// 主な画面を axe で確かめる（#334）。4つのテーマ × ゲームの言葉。除外は e2e/ui-exclusions.ts。
// 開いた状態（引き出し、ダイアログ、確かめ）は e2e/a11y-open.test.ts。CI のシャードに散るようファイルを分けた。
// seed のセッション（seed/sessions.ts）の Cookie で開く。あおば開発の管理者はミナト。受託開発チームはゲームの言葉。
// 読むだけにし、seed の行もテーマの設定も書き換えない（ほかのファイルと並べて走るため）
import type { Locator, Page } from '@playwright/test';
import { expect, test } from './fixtures.ts';
import { expectNoA11yViolationsInThemes, signIn } from './helpers.ts';
import type { UiScreen } from './ui-exclusions.ts';

const WORKSPACE = '/aoba/w/019a0000-0000-7000-8000-000000000401';

test.beforeEach(async ({ context, baseURL }) => {
  await signIn(context, baseURL, 'admin');
});

// 画面ごとの URL と、落ち着いたとみなす要素（見出しと、読み込んで描く主な要素）
const screens: { screen: UiScreen; path: string; ready: (page: Page) => Locator[] }[] = [
  {
    screen: 'today',
    path: '/aoba',
    ready: (page) => [page.getByRole('heading', { level: 1, name: '自分の今日' })],
  },
  {
    screen: 'backlog',
    path: WORKSPACE,
    ready: (page) => [
      page.getByRole('heading', { level: 1, name: '掲示板' }),
      page.getByRole('link', { name: 'ポイント付与のバッチを作る' }),
    ],
  },
  {
    screen: 'plan',
    path: `${WORKSPACE}/plan`,
    ready: (page) => [page.getByRole('heading', { level: 1, name: '遠征の計画' })],
  },
  {
    screen: 'members',
    path: `${WORKSPACE}/members`,
    ready: (page) => [
      page.getByRole('heading', { level: 1, name: 'メンバー' }),
      page.getByRole('table', { name: '所属している人の一覧' }),
    ],
  },
  {
    screen: 'workspace-settings',
    path: `${WORKSPACE}/settings`,
    ready: (page) => [page.getByRole('heading', { level: 1, name: '設定' })],
  },
  {
    screen: 'admin',
    path: '/aoba/admin',
    ready: (page) => [page.getByRole('heading', { level: 1 })],
  },
];

for (const { screen, path, ready } of screens) {
  test(`${screen}（${path}）に axe の違反が無い`, async ({ page }) => {
    await page.goto(path);
    for (const locator of ready(page)) await expect(locator.first()).toBeVisible();
    // 見えている所の読み込みが終わるまで待つ（閉じたダイアログの中の欄は、開くまで読み込み中のまま残る）
    await expect(page.locator('[aria-busy="true"]:visible')).toHaveCount(0);
    await expectNoA11yViolationsInThemes(page, screen);
  });
}
