import { redirect } from '@sveltejs/kit';
import { callOperation } from '../../../lib/api.ts';
import { isUnauthenticated, loginUrl } from '../../../lib/login-redirect.ts';
import { experienceGrants, experienceSummary } from '../../../shared/operations/experience/index.ts';
import { tokenList } from '../../../shared/operations/session/index.ts';
import type { PageLoad } from './$types';

// 自分の設定の画面が使う値。今は経験値と API トークンの節だけで、ほかの節（基準、休み、テーマなど）は #70 で足す。
// レベルの面（summary）と明細の最初の 50 件（grants）と API トークンの一覧（tokens）を並べて読み、読めなかったものだけを null にする
// （画面は、その節にだけ失敗を出し、「もう一度試す」はその節の操作だけを画面から呼び直す）。
// url は 401 のときだけ読む（読むと、移るたびにこの load が走り直る）
export const load: PageLoad = async ({ params, fetch, url }) => {
  const [summary, grants, tokens] = await Promise.all([
    callOperation(experienceSummary, {}, { slug: params.slug, fetcher: fetch }),
    callOperation(experienceGrants, {}, { slug: params.slug, fetcher: fetch }),
    callOperation(tokenList, {}, { fetcher: fetch }),
  ]);
  if (isUnauthenticated(summary) || isUnauthenticated(grants) || isUnauthenticated(tokens)) {
    redirect(307, loginUrl(url));
  }
  return {
    summary: summary.ok ? summary.data : null,
    grants: grants.ok ? grants.data : null,
    tokens: tokens.ok ? tokens.data.tokens : null,
  };
};
