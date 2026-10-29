// ワークスペースの外の主な画面（自分の今日、組織の管理）を幅 390px で開き、横のはみ出しと 44px の押せる範囲を確かめる（#336）。
// 3つのテーマ × 2つの言葉。ワークスペースの中の画面は e2e/layout-narrow-workspace.test.ts（CI のシャードに散るよう分けた）。
// 検査が空振りしないことは e2e/layout-narrow-check.test.ts。除外は e2e/ui-exclusions.ts。
// seed のセッション（seed/sessions.ts）の Cookie で開く。あおば開発の管理者はミナト。読むだけにし、seed の行もテーマも
// 言葉づかいも書き換えない（言葉は organization と workspace の操作の応答の書き換えで当てる。ほかのファイルと並べて走るため）
import { workspaceList } from '../src/shared/operations/workspace/index.ts';
import { expect, test } from './fixtures.ts';
import { expectNarrowLayout, signIn } from './helpers.ts';
import { rewriteOperation } from './operations.ts';

// あおば開発の seed のワークスペース（受託開発チーム）
const SEED_WORKSPACE_IDS = new Set(['019a0000-0000-7000-8000-000000000401']);

test.beforeEach(async ({ context, baseURL }) => {
  await signIn(context, baseURL, 'admin');
});

test('自分の今日（/aoba）が 390px で横にはみ出さず、押せる要素が 44px 四方で押せる', async ({ page }) => {
  await expectNarrowLayout(page, 'today', async (w) => {
    await page.goto('/aoba');
    await expect(page.getByRole('heading', { level: 1, name: w('pageToday') })).toBeVisible();
    // /api/health を読み終えた後にだけ出る文
    await expect(
      page
        .getByRole('region', { name: 'API の疎通' })
        .getByRole('status')
        .filter({ hasText: /^API: / }),
    ).toBeVisible();
  });
});

test('組織の管理（/aoba/admin）が 390px で横にはみ出さず、押せる要素が 44px 四方で押せる', async ({ page }) => {
  // ワークスペースの一覧は seed の行だけにする。ほかのファイルが作って消せずに残るワークスペース（空白の無い50字の名前など）で
  // 並びと幅が変わり、測る画面がほかのテストの走った順で揺れるため
  await rewriteOperation(page, workspaceList, { slug: 'aoba' }, (output) => ({
    workspaces: output.workspaces.filter((workspace) => SEED_WORKSPACE_IDS.has(workspace.id)),
  }));
  await expectNarrowLayout(page, 'admin', async (w) => {
    await page.goto('/aoba/admin');
    await expect(page.getByRole('heading', { level: 1, name: w('pageOrgAdmin') })).toBeVisible();
    // 節ごとに読む一覧のうち、seed の行がほかのファイルに消されないもの（ワークスペースの一覧）。名前は組織の言葉で変わる
    await expect(
      page.getByRole('table', { name: w('workspaceListLabel', { workspace: w('workspace') }) }),
    ).toBeVisible();
  });
});
