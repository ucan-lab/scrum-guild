import { redirect } from '@sveltejs/kit';
import { callOperation } from '../../../../../lib/api.ts';
import { isUnauthenticated, loginUrl } from '../../../../../lib/login-redirect.ts';
import { planSummary, sprintList } from '../../../../../shared/operations/sprint/index.ts';
import type { PageLoad } from './$types';

// 計画の画面が使う値（先と進行中のスプリントと入っているタスク、作るときの初期値）と、集計（ベロシティ、先のスプリントごとの入れたポイント、
// エピックごとの残り）。2つの操作は並べて読む。一覧が読めなかったとき（通信、5xx）は plan が null で、画面は読み込みの失敗を出す。
// 集計だけが読めなかったときは summary が null で、画面は一覧を出して、集計の場所に読み直す口を出す。ワークスペースが見つからないとき（404、403）は枠が先に「見つからない」を出すので、ここでは同じ null にする。
// url は 401 のときだけ読む（読むと、移るたびにこの load が走り直る）。
// `app:sprints` は、作る、直す、削除する、入れる、外した後に、この画面の値だけを読み直す印（枠の load を走らせない）。
// `app:backlog-tree` は、詳細の引き出しでタスクを直したとき（完了にした、題を直したなど）に枠が読み直す印で、入っているタスクの行と、
// 集計（未見積もりの件数、エピックの残り）にも映す
export const load: PageLoad = async ({ params, fetch, url, depends }) => {
  depends('app:sprints');
  depends('app:backlog-tree');
  const [result, summaryResult] = await Promise.all([
    callOperation(sprintList, { workspace_id: params.id }, { slug: params.slug, fetcher: fetch }),
    callOperation(planSummary, { workspace_id: params.id }, { slug: params.slug, fetcher: fetch }),
  ]);
  if (isUnauthenticated(result)) redirect(307, loginUrl(url));
  if (isUnauthenticated(summaryResult)) redirect(307, loginUrl(url));
  return { plan: result.ok ? result.data : null, summary: summaryResult.ok ? summaryResult.data : null };
};
