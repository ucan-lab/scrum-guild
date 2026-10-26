import { redirect } from '@sveltejs/kit';
import { callOperation } from '../../../../lib/api.ts';
import { isUnauthenticated, loginUrl } from '../../../../lib/login-redirect.ts';
import { categoryRepositoryList } from '../../../../shared/operations/definition/index.ts';
import { backlogTree } from '../../../../shared/operations/task/index.ts';
import type { PageLoad } from './$types';

// バックログの木。読めなかったとき（通信、5xx）は tree が null で、画面は読み込みの失敗を出す。
// ワークスペースが見つからないとき（404、403）は枠が先に「見つからない」を出すので、ここでは同じ null にする。
// 区分とリポジトリの一覧（起票、エピックとストーリーのダイアログの選択肢）も同時に読む。読めなければ definitions が null で、
// ダイアログは選択肢なしで開く（木は出す）。
// url は 401 のときだけ読む（読むと、移るたびにこの load が走り直る）。
// `app:backlog-tree` は、引き出しが欄を保存した後に、木だけを読み直す印（枠の読み直しが一時的に失敗しても、引き出しと書きかけを失わないため）
export const load: PageLoad = async ({ params, fetch, url, depends }) => {
  depends('app:backlog-tree');
  const options = { slug: params.slug, fetcher: fetch };
  const [result, definitions] = await Promise.all([
    callOperation(backlogTree, { workspace_id: params.id }, options),
    callOperation(categoryRepositoryList, { workspace_id: params.id }, options),
  ]);
  if (isUnauthenticated(result)) redirect(307, loginUrl(url, result));
  return { tree: result.ok ? result.data : null, definitions: definitions.ok ? definitions.data : null };
};
