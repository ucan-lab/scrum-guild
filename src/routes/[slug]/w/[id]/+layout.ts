import { redirect } from '@sveltejs/kit';
import { callOperation } from '../../../../lib/api.ts';
import { isUnauthenticated, loginPath, loginUrl } from '../../../../lib/login-redirect.ts';
import type { WorkspaceView } from '../../../../lib/workspace.ts';
import { workspaceInfo } from '../../../../shared/operations/workspace/index.ts';
import type { LayoutLoad } from './$types';

// 直前に読めたワークスペース。保存の後の読み直し（invalidateAll）が、通信か 5xx で一時的に失敗しても、枠が「読み込めない」に
// 切り替わって引き出しごと消え、書きかけが黙って失われないよう、同じワークスペースの値を保つ。見つからない（404）、入れない（403）、
// 未ログイン（401）は保たない。ブラウザの中だけで動く（SPA）ので、別の人の値が残ることはない
let lastKnown: { key: string; workspace: WorkspaceView } | null = null;

// ワークスペースの枠が使う値。存在しない ID と別の組織の ID は、どちらも 404 の not_found で workspace が null になる
// （どちらかを漏らさない）。所属していない管理者も入れる（role が null）。
// url は 401 のときだけ読む（読むと、移るたびにこの load が走り直る）
export const load: LayoutLoad = async ({ params, fetch, url }) => {
  const result = await callOperation(workspaceInfo, { workspace_id: params.id }, { slug: params.slug, fetcher: fetch });
  if (isUnauthenticated(result) && url.pathname !== loginPath) redirect(307, loginUrl(url));

  const key = `${params.slug}/${params.id}`;
  let workspace: WorkspaceView | null = result.ok
    ? {
        id: params.id,
        name: result.data.name,
        vocabulary: result.data.vocabulary,
        closedAt: result.data.closed_at,
        role: result.data.role,
      }
    : null;
  if (workspace !== null) lastKnown = { key, workspace };
  const transient = !result.ok && (result.status === 0 || result.status >= 500);
  if (workspace === null && transient && lastKnown?.key === key) workspace = lastKnown.workspace;
  return {
    workspace,
    workspaceFailure:
      workspace !== null
        ? null
        : { status: result.ok ? 0 : result.status, code: result.ok ? null : (result.error?.code ?? null) },
  };
};
