import { redirect } from '@sveltejs/kit';
import { callOperation } from '../../../lib/api.ts';
import { isUnauthenticated, loginUrl } from '../../../lib/login-redirect.ts';
import { workspaceList } from '../../../shared/operations/workspace/index.ts';
import type { PageLoad } from './$types';

// 組織の管理の画面が使う値。管理者でなければ、一覧を読まずに「見つからない」と同じ扱いにする。
// 一覧を読めなかったとき（通信、5xx）は workspaces が null で、画面は読み込みの失敗を出す。
// 枠を読んだ後にセッションが切れていたら（401）、ログインへ移す。url は 401 のときだけ読む（読むと、移るたびにこの load が走り直る）
export const load: PageLoad = async ({ params, fetch, parent, url }) => {
  const { organization } = await parent();
  if (organization === null || !organization.me.is_admin) return { forbidden: true, workspaces: null };
  const result = await callOperation(workspaceList, {}, { slug: params.slug, fetcher: fetch });
  if (isUnauthenticated(result)) redirect(307, loginUrl(url));
  return { forbidden: false, workspaces: result.ok ? result.data.workspaces : null };
};
