import { redirect } from '@sveltejs/kit';
import { callOperation } from '../../lib/api.ts';
import { consentUrl, isTermsRequired, isUnauthenticated, loginUrl } from '../../lib/login-redirect.ts';
import { myOrganizations, organizationInfo } from '../../shared/operations/organization/index.ts';
import { invitationList } from '../../shared/operations/workspace/index.ts';
import type { LayoutLoad } from './$types';

// 組織の枠が使う値。組織に入れない（無い slug も同じ）ときは organization が null で、
// failure に応答の status と code を入れる（通信の失敗は status が 0、code が null）。
// 組織に入れない（404 の not_found）が、組織の選択の届いた招待にこの slug があるとき（承諾待ちの招待だけの人）だけ、
// 届いた招待の一覧（invitation-list）を読んで invitationInbox に入れる。枠はこれがあれば招待の画面を出す。
// 読めなかったとき（通信、5xx）は failure をその応答にして、読み込みの失敗を出す。
// url は 401 と terms_required のときだけ読む（読むと、移るたびにこの load が走り直る）
export const load: LayoutLoad = async ({ params, fetch, url }) => {
  const [organization, accountOrganizations] = await Promise.all([
    callOperation(organizationInfo, {}, { slug: params.slug, fetcher: fetch }),
    callOperation(myOrganizations, {}, { fetcher: fetch }),
  ]);
  // 同意していない（403 の terms_required）ときは、どちらの呼び出しでも同意の画面へ移す。401 の確かめより先に見る
  if (isTermsRequired(organization) || isTermsRequired(accountOrganizations)) {
    redirect(307, consentUrl(url));
  }
  // ログインしていない（401）ときだけ、ログインの画面へ移す。入れる組織を失った人や、停止した組織にしか入れない人は
  // セッションが残るので 401 にならない（組織の操作が 404 か 403 の organization_suspended を返し、組織の枠が画面を出す）
  if (isUnauthenticated(organization) || isUnauthenticated(accountOrganizations)) {
    redirect(307, loginUrl(url));
  }

  let failure = organization.ok ? null : { status: organization.status, code: organization.error?.code ?? null };
  let invitationInbox = null;
  const invited =
    !organization.ok &&
    organization.status === 404 &&
    organization.error?.code === 'not_found' &&
    accountOrganizations.ok &&
    accountOrganizations.data.invitations.some((invitation) => invitation.slug === params.slug);
  if (invited) {
    const inbox = await callOperation(invitationList, {}, { slug: params.slug, fetcher: fetch });
    if (isTermsRequired(inbox)) redirect(307, consentUrl(url));
    if (isUnauthenticated(inbox)) redirect(307, loginUrl(url));
    if (inbox.ok) invitationInbox = inbox.data;
    else if (inbox.status !== 404) failure = { status: inbox.status, code: inbox.error?.code ?? null };
  }

  return {
    slug: params.slug,
    organization: organization.ok ? organization.data : null,
    failure,
    invitationInbox,
    // 組織の切り替えの一覧。取れなかったときは切り替えを出さない
    organizations: accountOrganizations.ok ? accountOrganizations.data : null,
  };
};
