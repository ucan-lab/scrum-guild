// ワークスペースの中の主な画面（バックログ、タスクの引き出し、計画、メンバー、ワークスペースの設定）を幅 390px で開き、
// 横のはみ出しと 44px の押せる範囲を確かめる（#336）。3つのテーマ × 2つの言葉。ワークスペースの外の画面は
// e2e/layout-narrow.test.ts（CI のシャードに散るよう分けた）。除外は e2e/ui-exclusions.ts。
// seed のセッション（seed/sessions.ts）の Cookie で開く。あおば開発の管理者はミナト。受託開発チームの言葉づかいはゲームで、
// スクラムの言葉は workspace の操作の応答の書き換えで当てる。開くだけで、seed の行もテーマも書き換えない（ほかのファイルと並べて走るため）
import type { Page } from '@playwright/test';
import type { DictionaryKey, TemplateParams } from '../src/shared/vocabulary.ts';
import { expect, test } from './fixtures.ts';
import { expectNarrowLayout, signIn } from './helpers.ts';

const WORKSPACE = '/aoba/w/019a0000-0000-7000-8000-000000000401';
const TASK_ID = '019a0000-0000-7000-8000-000000000801';

type W = (key: DictionaryKey, params?: TemplateParams) => string;

test.beforeEach(async ({ context, baseURL }) => {
  await signIn(context, baseURL, 'admin');
});

// ワークスペースの言葉づかいが当たったこと。左のメニューのバックログの項目の名前で見る（狭い幅では帯の中に畳まれる）
async function expectWorkspaceWords(page: Page, w: W): Promise<void> {
  await expect(page.locator('.nav a.nav-item', { hasText: w('backlog') })).toHaveCount(1);
}

test('バックログが 390px で横にはみ出さず、押せる要素が 44px 四方で押せる', async ({ page }) => {
  await expectNarrowLayout(page, 'backlog', async (w) => {
    await page.goto(WORKSPACE);
    await expect(page.getByRole('heading', { level: 1, name: w('backlog') })).toBeVisible();
    await expect(page.getByRole('link', { name: 'ポイント付与のバッチを作る' })).toBeVisible();
    await expectWorkspaceWords(page, w);
  });
});

test('タスクの引き出しが 390px で横にはみ出さず、押せる要素が 44px 四方で押せる', async ({ page }) => {
  await expectNarrowLayout(page, 'task-drawer', async (w) => {
    await page.goto(`${WORKSPACE}?task=${TASK_ID}`);
    const drawer = page.getByRole('dialog', { name: 'ポイント付与のバッチを作る' });
    await expect(drawer).toBeVisible();
    await expect(drawer.getByRole('heading', { level: 2 })).toBeFocused();
    await expectWorkspaceWords(page, w);
  });
});

test('計画が 390px で横にはみ出さず、押せる要素が 44px 四方で押せる', async ({ page }) => {
  await expectNarrowLayout(page, 'plan', async (w) => {
    await page.goto(`${WORKSPACE}/plan`);
    await expect(page.getByRole('heading', { level: 1, name: w('plan') })).toBeVisible();
    await expectWorkspaceWords(page, w);
  });
});

test('メンバーが 390px で横にはみ出さず、押せる要素が 44px 四方で押せる', async ({ page }) => {
  await expectNarrowLayout(page, 'members', async (w) => {
    await page.goto(`${WORKSPACE}/members`);
    await expect(page.getByRole('heading', { level: 1, name: w('pageMembers') })).toBeVisible();
    await expect(page.getByRole('table', { name: '所属している人の一覧' })).toBeVisible();
    await expectWorkspaceWords(page, w);
  });
});

test('ワークスペースの設定が 390px で横にはみ出さず、押せる要素が 44px 四方で押せる', async ({ page }) => {
  await expectNarrowLayout(page, 'workspace-settings', async (w) => {
    await page.goto(`${WORKSPACE}/settings`);
    await expect(page.getByRole('heading', { level: 1, name: w('pageSettings') })).toBeVisible();
    await expectWorkspaceWords(page, w);
  });
});
