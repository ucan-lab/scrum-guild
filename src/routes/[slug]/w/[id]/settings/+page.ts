import { redirect } from '@sveltejs/kit';
import { callOperation } from '../../../../../lib/api.ts';
import { isUnauthenticated, loginUrl } from '../../../../../lib/login-redirect.ts';
import { columnList } from '../../../../../shared/operations/column/index.ts';
import { categoryRepositoryList } from '../../../../../shared/operations/definition/index.ts';
import type { PageLoad } from './$types';

// ワークスペースの設定の画面が使う値。開けるのは、そのワークスペースのリーダーと管理者だけ（forbidden が真なら「入れない」の案内）。
// 一般のメンバーには一覧を読まない（API の書く操作もリーダーと管理者だけが通る）。
// 区分とリポジトリの一覧（category-repository-list）と列の一覧（column-list）を並べて読み、どちらかが読めなかったとき（通信、5xx）は
// definitions が null で、画面は読み込みの失敗を出す。
// ワークスペースが見つからないとき（404、403）は枠が先に「見つからない」を出すので、ここでは同じ null にする。
// `app:workspace-settings` は、節で書いた後に、この画面の値だけを読み直す印（枠の load を走らせない）
export const load: PageLoad = async ({ params, fetch, url, depends, parent }) => {
  depends('app:workspace-settings');
  const { workspace, organization } = await parent();
  const allowed = workspace !== null && (workspace.role === 'leader' || organization?.me.is_admin === true);
  if (!allowed) return { forbidden: true, definitions: null };
  const [result, columns] = await Promise.all([
    callOperation(categoryRepositoryList, { workspace_id: params.id }, { slug: params.slug, fetcher: fetch }),
    callOperation(columnList, { workspace_id: params.id }, { slug: params.slug, fetcher: fetch }),
  ]);
  if (isUnauthenticated(result)) redirect(307, loginUrl(url, result));
  if (isUnauthenticated(columns)) redirect(307, loginUrl(url, columns));
  return {
    forbidden: false,
    definitions: result.ok && columns.ok ? { ...result.data, columns: columns.data.columns } : null,
  };
};
