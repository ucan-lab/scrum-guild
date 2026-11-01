// ワークスペースの外の主な画面（今日やること、組織の管理）を幅 390px で開き、横のはみ出しと 44px の押せる範囲を確かめる（#336）。
// 3つのテーマ × 1つの言葉（スクラムの言葉）。ワークスペースの中の画面は e2e/layout-narrow-workspace.test.ts（CI のシャードに散るよう分けた）。
// 検査が空振りしないことは e2e/layout-narrow-check.test.ts。除外は e2e/ui-exclusions.ts。
// seed のセッション（seed/sessions.ts）の Cookie で開く。あおば開発の管理者はミナト。読むだけにし、seed の行もテーマも
// 書き換えない（ほかのファイルと並べて走るため）
import { workspaceList } from '../src/shared/operations/workspace/index.ts';
import { expect, test } from './fixtures.ts';
import { applyTheme, expectNarrowLayout, LAYOUT_THEMES, signIn } from './helpers.ts';
import { rewriteOperation } from './operations.ts';

// あおば開発の seed のワークスペース（受託開発チーム）
const SEED_WORKSPACE_IDS = new Set(['019a0000-0000-7000-8000-000000000401']);

test.beforeEach(async ({ context, baseURL }) => {
  await signIn(context, baseURL, 'admin');
});

test('今日やること（/aoba）が 390px で横にはみ出さず、押せる要素が 44px 四方で押せる', async ({ page }) => {
  await expectNarrowLayout(page, 'today', async (w) => {
    await page.goto('/aoba');
    await expect(page.getByRole('heading', { level: 1, name: w('pageToday') })).toBeVisible();
    await expect(page.getByRole('region', { name: w('sectionToday') })).toBeVisible();
  });
});

test('組織の管理（/aoba/admin）が 390px で横にはみ出さず、押せる要素が 44px 四方で押せる', async ({ page }) => {
  // ワークスペースの一覧は seed の行だけにする。ほかのファイルが作って消せずに残るワークスペース（空白の無い50字の名前など）で
  // 並びと幅が変わり、測る画面がほかのテストの走った順で揺れるため。長い名前の行は、下のテストが応答の書き換えで足して確かめる（#462）
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

test('組織の管理（/aoba/admin）に空白の無い50字の名前のワークスペースがあっても、390px で横にはみ出さず、44px の押せる範囲が重ならない（#462）', async ({
  page,
}) => {
  // 長い名前の行を応答の書き換えで足す。ほかのファイルが残した行に頼らず、走る順に関わらず毎回同じ一覧を測る
  // 空白も折り返せる位置も無い並び（#462 の再現と同じ、Latin の W を50字）
  const longName = 'W'.repeat(50);
  await rewriteOperation(page, workspaceList, { slug: 'aoba' }, (output) => ({
    workspaces: [
      ...output.workspaces.filter((workspace) => SEED_WORKSPACE_IDS.has(workspace.id)),
      {
        id: '019a0000-0000-7000-8000-0000000004f2',
        name: longName,
        member_count: 1,
        leader_count: 1,
        created_on: '2026-10-30',
        closed_at: null,
      },
    ],
  }));
  await expectNarrowLayout(page, 'admin', async (w) => {
    await page.goto('/aoba/admin');
    await expect(page.getByRole('heading', { level: 1, name: w('pageOrgAdmin') })).toBeVisible();
    const table = page.getByRole('table', { name: w('workspaceListLabel', { workspace: w('workspace') }) });
    await expect(table.getByRole('link', { name: longName })).toBeVisible();
    const close = table.getByRole('button', { name: w('workspaceCloseLabel', { name: longName }) });
    await expect(close).toBeVisible();
    // 汎用の検査だけでは、表の横スクロール（.table-wrap は除外される）に逃げた重なりを見逃すので、直接確かめる。
    // 表は横にはみ出さず、名前のリンクと「終了する」の箱が交わらない。書体の幅が変わるので、テーマごとに確かめる
    for (const theme of LAYOUT_THEMES) {
      await applyTheme(page, theme);
      const overflow = await table.locator('xpath=..').evaluate((el) => el.scrollWidth - el.clientWidth);
      expect(overflow, `${theme}: 表が横にはみ出す`).toBeLessThanOrEqual(0);
      const link = await table.getByRole('link', { name: longName }).boundingBox();
      const button = await close.boundingBox();
      expect(link).not.toBeNull();
      expect(button).not.toBeNull();
      const apart =
        link!.y + link!.height <= button!.y ||
        button!.y + button!.height <= link!.y ||
        link!.x + link!.width <= button!.x ||
        button!.x + button!.width <= link!.x;
      expect(apart, `${theme}: 名前のリンクと「終了する」の箱が交わる`).toBe(true);
    }
  });
});
