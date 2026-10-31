import { redirect } from '@sveltejs/kit';
import { callOperation } from '../../../../lib/api.ts';
import { isUnauthenticated, loginPath, loginUrl } from '../../../../lib/login-redirect.ts';
import { settleWorkspace, type KnownWorkspace, type WorkspaceView } from '../../../../lib/workspace.ts';
import { workspaceInfo } from '../../../../shared/operations/workspace/index.ts';
import type { LayoutLoad } from './$types';

// 直前に読めたワークスペース。一時的な失敗のときだけ保つ（判定は settleWorkspace）。ブラウザの中だけで動く（SPA）ので、別の人の値が残ることはない
let known: KnownWorkspace | null = null;

// ワークスペースの枠が使う値。存在しない ID と別の組織の ID は、どちらも 404 の not_found で workspace が null になる
// （どちらかを漏らさない）。所属していない管理者も入れる（role が null）。
// url は 401 のときだけ読む（読むと、移るたびにこの load が走り直る）。
// `app:workspace` は、引き出しが閉じたことを知った（`workspace_closed`）後と、設定の画面で完成の定義を書いた後に、
// この枠だけを読み直す印（組織の枠の load を走らせない）
export const load: LayoutLoad = async ({ params, fetch, url, depends }) => {
  depends('app:workspace');
  const result = await callOperation(workspaceInfo, { workspace_id: params.id }, { slug: params.slug, fetcher: fetch });
  if (isUnauthenticated(result) && url.pathname !== loginPath) redirect(307, loginUrl(url));

  const loaded: WorkspaceView | null = result.ok
    ? {
        id: params.id,
        name: result.data.name,
        closedAt: result.data.closed_at,
        definitionOfDone: result.data.definition_of_done_md,
        role: result.data.role,
      }
    : null;
  const settled = settleWorkspace(known, `${params.slug}/${params.id}`, loaded, result.ok ? 200 : result.status);
  known = settled.known;
  return {
    workspace: settled.workspace,
    workspaceFailure:
      settled.workspace !== null
        ? null
        : { status: result.ok ? 0 : result.status, code: result.ok ? null : (result.error?.code ?? null) },
  };
};
