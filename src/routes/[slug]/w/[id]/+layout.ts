import { redirect } from '@sveltejs/kit';
import { callOperation } from '../../../../lib/api.ts';
import { isUnauthenticated, loginPath, loginUrl } from '../../../../lib/login-redirect.ts';
import type { WorkspaceView } from '../../../../lib/workspace.ts';
import { workspaceInfo } from '../../../../shared/operations/workspace/index.ts';
import type { LayoutLoad } from './$types';

// ワークスペースの枠が使う値。存在しない ID と別の組織の ID は、どちらも 404 の not_found で workspace が null になる
// （どちらかを漏らさない）。所属していない管理者も入れる（role が null）。
// url は 401 のときだけ読む（読むと、移るたびにこの load が走り直る）
export const load: LayoutLoad = async ({ params, fetch, url }) => {
  const result = await callOperation(workspaceInfo, { workspace_id: params.id }, { slug: params.slug, fetcher: fetch });
  if (isUnauthenticated(result) && url.pathname !== loginPath) redirect(307, loginUrl(url));

  const workspace: WorkspaceView | null = result.ok
    ? {
        id: params.id,
        name: result.data.name,
        vocabulary: result.data.vocabulary,
        closedAt: result.data.closed_at,
        role: result.data.role,
      }
    : null;
  return {
    workspace,
    workspaceFailure: result.ok ? null : { status: result.status, code: result.error?.code ?? null },
  };
};
