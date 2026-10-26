import { redirect } from '@sveltejs/kit';
import { callOperation } from '../../../lib/api.ts';
import { isUnauthenticated, loginUrl } from '../../../lib/login-redirect.ts';
import { invitationList } from '../../../shared/operations/workspace/index.ts';
import type { PageLoad } from './$types';

// 招待の画面（/<slug>/invitations）が使う値。組織に入れる人も、承諾待ちの招待だけの人も同じ画面で、組織の枠は
// invitationPage があるとき、枠（左のメニューと上の帯）を出さずにこのページを出す。
// 招待だけの人は、組織の枠の load が届いた招待の一覧を読んでいる（invitationInbox）ので、それを使う。
// 組織に入れる人だけ、ここで読む。list は読めなかったとき（通信、5xx）は null（画面は読み込みの失敗を出す）。
// 組織に入れない（404）ときは、組織の枠が先に「見つからない」を出す。url は 401 のときだけ読む
export const load: PageLoad = async ({ params, fetch, url, parent }) => {
  const { invitationInbox } = await parent();
  if (invitationInbox !== null) return { invitationPage: { list: invitationInbox } };
  const result = await callOperation(invitationList, {}, { slug: params.slug, fetcher: fetch });
  if (isUnauthenticated(result)) redirect(307, loginUrl(url, result));
  return { invitationPage: { list: result.ok ? result.data : null } };
};
