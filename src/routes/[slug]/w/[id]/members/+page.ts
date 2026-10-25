import { redirect } from '@sveltejs/kit';
import { callOperation } from '../../../../../lib/api.ts';
import { isUnauthenticated, loginUrl } from '../../../../../lib/login-redirect.ts';
import { memberList } from '../../../../../shared/operations/workspace/index.ts';
import type { PageLoad } from './$types';

// メンバーの画面が使う値。読めなかったとき（通信、5xx）は members が null で、画面は読み込みの失敗を出す。
// ワークスペースが見つからないとき（404、403）は枠が先に「見つからない」を出すので、ここでは同じ null にする。
// invitations と seats は、リーダーと管理者だけが受け取る（一般のメンバーは null）。
// url は 401 のときだけ読む（読むと、移るたびにこの load が走り直る）。
// `app:members` は、招待と取り消しの後に、この画面の値だけを読み直す印（枠の load を走らせない）
export const load: PageLoad = async ({ params, fetch, url, depends }) => {
  depends('app:members');
  const result = await callOperation(memberList, { workspace_id: params.id }, { slug: params.slug, fetcher: fetch });
  if (isUnauthenticated(result)) redirect(307, loginUrl(url));
  return {
    members: result.ok ? result.data.members : null,
    invitations: result.ok ? result.data.invitations : null,
    seats: result.ok ? result.data.seats : null,
  };
};
