import { redirect } from '@sveltejs/kit';
import { resolve } from '$app/paths';
import { callOperation } from '../../lib/api.ts';
import { consentUrl, isTermsRequired, isUnauthenticated, loginUrl } from '../../lib/login-redirect.ts';
import { listOrganizations } from '../../shared/operations/operator/index.ts';
import type { PageLoad } from './$types';

// 運用の画面。組織の一覧を取る。ログインしていなければログインの画面へ、同意していなければ同意の画面へ、
// 運用者でなければ組織の選択（/）へ戻す（同じ 403 でも terms_required を先に見る）
export const load: PageLoad = async ({ fetch, url }) => {
  const result = await callOperation(listOrganizations, {}, { fetcher: fetch });
  if (isTermsRequired(result)) redirect(307, consentUrl(url));
  if (isUnauthenticated(result)) redirect(307, loginUrl(url));
  if (!result.ok && result.status === 403) redirect(307, resolve('/'));
  if (!result.ok) return { failed: true as const };
  return { failed: false as const, organizations: result.data.organizations };
};
