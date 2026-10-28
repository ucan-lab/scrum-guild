// ワークスペースの中の主な画面（バックログ、タスクの引き出し、計画、メンバー、ワークスペースの設定）を幅 390px で開き、
// 横のはみ出しと 44px の押せる範囲を確かめる（#336）。3つのテーマ × 2つの言葉。ワークスペースの外の画面は
// e2e/layout-narrow.test.ts（CI のシャードに散るよう分けた）。除外は e2e/ui-exclusions.ts。
// seed のセッション（seed/sessions.ts）の Cookie で開く。あおば開発の管理者はミナト。受託開発チームの言葉づかいはゲームで、
// スクラムの言葉は workspace の操作の応答の書き換えで当てる。開くだけで、seed の行もテーマも書き換えない（ほかのファイルと並べて走るため）
import type { Page } from '@playwright/test';
import type { DictionaryKey, TemplateParams } from '../src/shared/vocabulary.ts';
import { sprintBoard } from '../src/shared/operations/sprint/index.ts';
import { expect, test } from './fixtures.ts';
import { workspaceInfo } from '../src/shared/operations/workspace/workspace.ts';
import {
  NARROW_VIEWPORT,
  createWorkspace,
  expectNarrowLayout,
  findOverflowViolations,
  findTargetSizeViolations,
  signIn,
} from './helpers.ts';
import { mockOperation, rewriteOperation } from './operations.ts';
import { SAMPLE_BOARD } from './sprint-fixture.ts';

const WORKSPACE = '/aoba/w/019a0000-0000-7000-8000-000000000401';
const TASK_ID = '019a0000-0000-7000-8000-000000000801';
const EPIC_ID = '019a0000-0000-7000-8000-000000000b01';

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

test('エピックの画面が 390px で横にはみ出さず、押せる要素が 44px 四方で押せる', async ({ page }) => {
  await expectNarrowLayout(page, 'epic', async (w) => {
    await page.goto(`${WORKSPACE}/epics/${EPIC_ID}`);
    await expect(page.getByRole('heading', { level: 1, name: 'ポイントの交換先を増やす' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: w('party') })).toBeVisible();
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

test('スプリントが 390px で横にはみ出さず、押せる要素が 44px 四方で押せる', async ({ page }) => {
  // seed には進行中のスプリントを置かない（ほかのファイルが始める）ので、架空のスプリントと列とカードに差し替える
  await mockOperation(page, sprintBoard, { slug: 'aoba' }, SAMPLE_BOARD);
  await expectNarrowLayout(page, 'sprint', async (w) => {
    await page.goto(`${WORKSPACE}/sprint`);
    await expect(page.getByRole('heading', { level: 1, name: `${w('sprint')} 第14回` })).toBeVisible();
    await expect(page.getByRole('article', { name: 'ポイント付与のバッチを作る' })).toBeVisible();
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

// 空白の無い 2048 字近い URL のリンクを持つエピック。seed の行は書き換えず、作ったワークスペースの中に作る（ほかのファイルと並べて走るため）
async function createEpicWithLongLink(page: Page): Promise<{ epicPath: string; link: string }> {
  await createWorkspace(page, '長いリンクのパーティ', 'game');
  const workspacePath = new URL(page.url()).pathname;
  const link = `https://example.com/${'a'.repeat(2000)}`;
  const response = await page.request.post('/api/aoba/epic-create', {
    headers: { Origin: new URL(page.url()).origin },
    data: { workspace_id: workspacePath.split('/').pop(), title: '長いリンクのレイド', link_url: link },
  });
  expect(response.ok()).toBe(true);
  const { epic } = (await response.json()) as { epic: { id: string } };
  return { epicPath: `${workspacePath}/epics/${epic.id}`, link };
}

test('長い URL のリンクを持つエピックの画面が 390px で横にはみ出さず、押せる要素が 44px 四方で押せる', async ({
  page,
}) => {
  const { epicPath, link } = await createEpicWithLongLink(page);
  await expectNarrowLayout(page, 'epic', async (w) => {
    await page.goto(epicPath);
    await expect(page.getByRole('heading', { level: 1, name: '長いリンクのレイド' })).toBeVisible();
    // URL は全文を出し、折り返す。「開く」は URL の文字と別のリンクで、読み上げの名前に「開く」を含む
    await expect(page.locator('.source-key.is-wrap')).toContainText(link);
    await expect(page.getByRole('link', { name: 'リンクを新しいタブで開く' })).toHaveText('開く');
    await expectWorkspaceWords(page, w);
  });
});

test('長い URL のリンクを持つエピックの画面が 320px でも横にはみ出さず、押せる要素が 44px 四方で押せる', async ({
  page,
}) => {
  const { epicPath } = await createEpicWithLongLink(page);
  await page.setViewportSize({ width: 320, height: 844 });
  await page.goto(epicPath);
  await expect(page.getByRole('heading', { level: 1, name: '長いリンクのレイド' })).toBeVisible();
  await page.waitForLoadState('networkidle');
  expect(await findOverflowViolations(page)).toEqual([]);
  expect(await findTargetSizeViolations(page)).toEqual([]);
});

test('終了したワークスペースのエピックの画面は、「戻る」だけが残る見出しの右も 44px 四方で押せる', async ({ page }) => {
  await page.setViewportSize(NARROW_VIEWPORT);
  await rewriteOperation(page, workspaceInfo, { slug: 'aoba' }, (output) => ({
    ...output,
    closed_at: '2026-10-20T00:00:00.000Z',
  }));
  await page.goto(`${WORKSPACE}/epics/${EPIC_ID}`);
  await expect(page.getByRole('heading', { level: 1, name: 'ポイントの交換先を増やす' })).toBeVisible();
  await expect(page.locator('.page-actions .btn')).toHaveCount(1);
  await page.waitForLoadState('networkidle');
  // 終了の帯の中のリンク（組織の管理へ）は、どのワークスペースの画面にも出る帯の部品で、この画面の対象ではない
  const violations = await findTargetSizeViolations(page);
  expect(violations.filter((violation) => !violation.detail.includes('div.callout'))).toEqual([]);
});
