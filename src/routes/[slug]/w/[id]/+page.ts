import { redirect } from '@sveltejs/kit';
import { callOperation } from '../../../../lib/api.ts';
import { isUnauthenticated, loginUrl } from '../../../../lib/login-redirect.ts';
import { backlogTree } from '../../../../shared/operations/task/index.ts';
import type { PageLoad } from './$types';

// バックログの木。読めなかったとき（通信、5xx）は tree が null で、画面は読み込みの失敗を出す。
// ワークスペースが見つからないとき（404、403）は枠が先に「見つからない」を出すので、ここでは同じ null にする。
// url は 401 のときだけ読む（読むと、移るたびにこの load が走り直る）
export const load: PageLoad = async ({ params, fetch, url }) => {
  const result = await callOperation(backlogTree, { workspace_id: params.id }, { slug: params.slug, fetcher: fetch });
  if (isUnauthenticated(result)) redirect(307, loginUrl(url));
  return { tree: result.ok ? result.data : null };
};
