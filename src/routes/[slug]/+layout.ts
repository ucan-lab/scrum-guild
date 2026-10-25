import { redirect } from '@sveltejs/kit';
import { callOperation } from '../../lib/api.ts';
import { isUnauthenticated, loginPath, loginUrl } from '../../lib/login-redirect.ts';
import { myOrganizations, organizationInfo } from '../../shared/operations/organization/index.ts';
import type { LayoutLoad } from './$types';

// 組織の枠が使う値。組織に入れない（無い slug も同じ）ときは organization が null で、
// failure に応答の status と code を入れる（通信の失敗は status が 0、code が null）。
// url は 401 のときだけ読む（読むと、移るたびにこの load が走り直る）
export const load: LayoutLoad = async ({ params, fetch, url }) => {
  const [organization, accountOrganizations] = await Promise.all([
    callOperation(organizationInfo, {}, { slug: params.slug, fetcher: fetch }),
    callOperation(myOrganizations, {}, { fetcher: fetch }),
  ]);
  // ログインの画面の経路が無い間は /login もここに来るので、ログインの画面から同じ画面へ移し続けないよう止める
  if ((isUnauthenticated(organization) || isUnauthenticated(accountOrganizations)) && url.pathname !== loginPath) {
    redirect(307, loginUrl(url));
  }

  return {
    slug: params.slug,
    organization: organization.ok ? organization.data : null,
    failure: organization.ok ? null : { status: organization.status, code: organization.error?.code ?? null },
    // 組織の切り替えの一覧。取れなかったときは切り替えを出さない
    organizations: accountOrganizations.ok ? accountOrganizations.data : null,
  };
};
