import { redirect } from '@sveltejs/kit';
import { resolve } from '$app/paths';
import { callOperation } from '../lib/api.ts';
import { landingFor } from '../lib/landing.ts';
import { isUnauthenticated, loginUrl } from '../lib/login-redirect.ts';
import { myOrganizations } from '../shared/operations/organization/index.ts';
import type { PageLoad } from './$types';

// ログインの直後の振り分け。入れる組織が1つで招待が無ければその組織へ、運用者で組織が無ければ運用の画面へ。
// それ以外は、この画面が組織の選択になる
export const load: PageLoad = async ({ fetch, url }) => {
  const result = await callOperation(myOrganizations, {}, { fetcher: fetch });
  if (isUnauthenticated(result)) redirect(307, loginUrl(url));
  if (!result.ok) return { failed: true as const };

  const landing = landingFor(result.data);
  if (landing.to === 'organization') redirect(307, resolve('/[slug]', { slug: landing.slug }));
  if (landing.to === 'operator') redirect(307, resolve('/operator'));
  return { failed: false as const, ...result.data };
};
