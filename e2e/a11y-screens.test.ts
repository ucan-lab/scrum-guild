// 主な画面を axe で確かめる（#334）。4つのテーマ × スクラムの言葉。除外は e2e/ui-exclusions.ts。
// 開いた状態（引き出し、ダイアログ、確かめ）は e2e/a11y-open.test.ts。CI のシャードに散るようファイルを分けた。
// seed のセッション（seed/sessions.ts）の Cookie で開く。あおば開発の管理者はミナト。受託開発チームも社内ツールもスクラムの言葉。
// 読むだけにし、seed の行もテーマの設定も書き換えない（ほかのファイルと並べて走るため）
import type { Locator, Page } from '@playwright/test';
import { PRIVACY_VERSION, TERMS_VERSION } from '../src/lib/legal/versions.ts';
import { consentStatus } from '../src/shared/operations/session/consent.ts';
import { sprintBoard } from '../src/shared/operations/sprint/index.ts';
import { expect, test } from './fixtures.ts';
import { expectNoA11yViolationsInThemes, signIn } from './helpers.ts';
import { mockOperation } from './operations.ts';
import { SAMPLE_BOARD } from './sprint-fixture.ts';
import type { UiScreen } from './ui-exclusions.ts';

const WORKSPACE = '/aoba/w/019a0000-0000-7000-8000-000000000401';
const EPIC_ID = '019a0000-0000-7000-8000-000000000b01';

test.beforeEach(async ({ context, baseURL }) => {
  await signIn(context, baseURL, 'admin');
});

// 画面ごとの URL と、落ち着いたとみなす要素（見出しと、読み込んで描く主な要素）
const screens: {
  screen: UiScreen;
  path: string;
  // 画面を開く前に、応答の差し替えなどを済ませる
  prepare?: (page: Page) => Promise<unknown>;
  ready: (page: Page) => Locator[];
}[] = [
  {
    screen: 'consent',
    path: '/consent',
    // 同意の e2e（e2e/consent.test.ts）が seed の admin に同意を書くので、状態は固定して、読むだけにする
    prepare: (page) =>
      mockOperation(page, consentStatus, {
        terms_version: TERMS_VERSION,
        privacy_version: PRIVACY_VERSION,
        latest: null,
        current: false,
      }),
    ready: (page) => [
      page.getByRole('heading', { level: 1, name: '同意の確認' }),
      page.getByRole('checkbox', { name: '利用規約とプライバシーポリシーを確認し、同意します' }),
    ],
  },
  {
    screen: 'today',
    path: '/aoba',
    ready: (page) => [
      page.getByRole('heading', { level: 1, name: '自分の今日' }),
      // /api/health を読み終えた後にだけ出る文
      page
        .getByRole('region', { name: 'API の疎通' })
        .getByRole('status')
        .filter({ hasText: /^API: / }),
    ],
  },
  {
    screen: 'backlog',
    path: WORKSPACE,
    ready: (page) => [
      page.getByRole('heading', { level: 1, name: 'バックログ' }),
      page.getByRole('link', { name: 'ポイント付与のバッチを作る' }),
    ],
  },
  {
    screen: 'epic',
    path: `${WORKSPACE}/epics/${EPIC_ID}`,
    ready: (page) => [
      page.getByRole('heading', { level: 1, name: 'ポイントの交換先を増やす' }),
      page.getByRole('heading', { level: 2, name: '参加者' }),
    ],
  },
  {
    screen: 'plan',
    path: `${WORKSPACE}/plan`,
    ready: (page) => [page.getByRole('heading', { level: 1, name: '計画' })],
  },
  {
    screen: 'sprint',
    path: `${WORKSPACE}/sprint`,
    // aoba のワークスペースには進行中のスプリントを置かない（seed の進行中は別の組織のワークスペース）ので、架空のスプリントと列とカードに差し替える
    prepare: (page) => mockOperation(page, sprintBoard, { slug: 'aoba' }, SAMPLE_BOARD),
    ready: (page) => [
      page.getByRole('heading', { level: 1, name: 'スプリント 第14回' }),
      page.getByRole('article', { name: 'ポイント付与のバッチを作る' }),
    ],
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
    ready: (page) => [
      page.getByRole('heading', { level: 1 }),
      // 節ごとに読む一覧のうち、seed の行がほかのファイルに消されないもの（ワークスペースの一覧）
      page.getByRole('table', { name: 'ワークスペースの一覧' }),
    ],
  },
  // 枠の外の画面。ログインしていなくても開ける（開く確かめは e2e/legal.test.ts）。ここはログインした状態でも同じ画面が出て、axe の違反が無いことを見る
  {
    screen: 'terms',
    path: '/terms',
    ready: (page) => [
      page.getByRole('heading', { level: 1, name: '利用規約' }),
      page.getByRole('heading', { level: 2, name: /^第1条/ }),
    ],
  },
  {
    screen: 'privacy',
    path: '/privacy',
    ready: (page) => [
      page.getByRole('heading', { level: 1, name: 'プライバシーポリシー' }),
      page.getByRole('heading', { level: 2, name: /預からないもの/ }),
    ],
  },
];

for (const { screen, path, prepare, ready } of screens) {
  test(`${screen}（${path}）に axe の違反が無い`, async ({ page }) => {
    await prepare?.(page);
    await page.goto(path);
    for (const locator of ready(page)) await expect(locator.first()).toBeVisible();
    // 節ごとに読む部品（休日、決まった欄など）は aria-busy を付けないものもあるので、
    // 要求が止むまで待ってから測る（画面は読み込みの後に要求を出し続けない）
    await page.waitForLoadState('networkidle');
    // 見えている所の読み込みが終わるまで待つ（閉じたダイアログの中の欄は、開くまで読み込み中のまま残る）
    await expect(page.locator('[aria-busy="true"]:visible')).toHaveCount(0);
    await expectNoA11yViolationsInThemes(page, screen);
  });
}
