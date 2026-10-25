import { callOperation } from '../../../lib/api.ts';
import { workspaceList } from '../../../shared/operations/workspace/index.ts';
import type { PageLoad } from './$types';

// 組織の管理の画面が使う値。管理者でなければ、一覧を読まずに「見つからない」と同じ扱いにする。
// 一覧を読めなかったとき（通信、5xx）は workspaces が null で、画面は読み込みの失敗を出す
export const load: PageLoad = async ({ params, fetch, parent }) => {
  const { organization } = await parent();
  if (organization === null || !organization.me.is_admin) return { forbidden: true, workspaces: null };
  const result = await callOperation(workspaceList, {}, { slug: params.slug, fetcher: fetch });
  return { forbidden: false, workspaces: result.ok ? result.data.workspaces : null };
};
