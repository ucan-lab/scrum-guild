import { redirect } from '@sveltejs/kit';
import { callOperation } from '../../lib/api.ts';
import { isUnauthenticated, loginUrl } from '../../lib/login-redirect.ts';
import { experienceSummary } from '../../shared/operations/experience/index.ts';
import { firstSteps, today } from '../../shared/operations/organization/index.ts';
import type { PageLoad } from './$types';

// today が null のときは読めなかったこと（空の一覧とは別）で、画面は読み込みの失敗を出す。
// experience が null のときは、画面が右の列（経験値とレベル）を省く。
// firstSteps は today とは別の操作で、画面が2回呼ぶ。null（読めなかった）のときと、手順が空のときは、最初にやることの面を置かない
export const load: PageLoad = async ({ params, fetch, url }) => {
  const [todayResult, experienceResult, firstStepsResult] = await Promise.all([
    callOperation(today, {}, { slug: params.slug, fetcher: fetch }),
    callOperation(experienceSummary, {}, { slug: params.slug, fetcher: fetch }),
    callOperation(firstSteps, {}, { slug: params.slug, fetcher: fetch }),
  ]);
  if (isUnauthenticated(todayResult) || isUnauthenticated(experienceResult) || isUnauthenticated(firstStepsResult))
    redirect(307, loginUrl(url));
  return {
    today: todayResult.ok ? todayResult.data : null,
    experience: experienceResult.ok ? experienceResult.data : null,
    firstSteps: firstStepsResult.ok ? firstStepsResult.data : null,
  };
};
