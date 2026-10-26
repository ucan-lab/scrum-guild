import { redirect } from '@sveltejs/kit';
import { callOperation } from '../../../lib/api.ts';
import { isUnauthenticated, loginUrl } from '../../../lib/login-redirect.ts';
import { experienceGrants, experienceSummary } from '../../../shared/operations/experience/index.ts';
import type { PageLoad } from './$types';

// 自分の設定の画面が使う値。今は経験値の節だけで、ほかの節（基準、休み、テーマなど）は #70 で足す。
// レベルの面（summary）と明細の最初の 50 件（grants）を並べて読み、読めなかった方だけを null にする（画面は、その節にだけ失敗を出す）。
// url は 401 のときだけ読む（読むと、移るたびにこの load が走り直る）。
// `app:me-experience` は「もう一度試す」で、この画面の値だけを読み直す印（枠の load を走らせない）
export const load: PageLoad = async ({ params, fetch, url, depends }) => {
  depends('app:me-experience');
  const [summary, grants] = await Promise.all([
    callOperation(experienceSummary, {}, { slug: params.slug, fetcher: fetch }),
    callOperation(experienceGrants, {}, { slug: params.slug, fetcher: fetch }),
  ]);
  if (isUnauthenticated(summary) || isUnauthenticated(grants)) redirect(307, loginUrl(url, summary, grants));
  return {
    summary: summary.ok ? summary.data : null,
    grants: grants.ok ? grants.data : null,
  };
};
