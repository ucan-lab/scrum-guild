import { redirect } from '@sveltejs/kit';
import { callOperation } from '../../../../../lib/api.ts';
import { isUnauthenticated, loginUrl } from '../../../../../lib/login-redirect.ts';
import { sprintBoard } from '../../../../../shared/operations/sprint/index.ts';
import type { PageLoad } from './$types';

// スプリントの画面が使う値（進行中のスプリントと、列とカード）。読めなかったとき（通信、5xx）は board が null で、
// 画面は読み込みの失敗を出す。ワークスペースが見つからないとき（404、403）は枠が先に「見つからない」を出すので、ここでは同じ null にする。
// url は 401 のときだけ読む（読むと、移るたびにこの load が走り直る）。
// `app:sprint-board` は、完了にした後と、動かすのが断られた後に、この画面の値だけを読み直す印（枠の load を走らせない）。
// `app:sprints` は計画の画面でスプリントを始めたとき、`app:backlog-tree` は詳細の引き出しでタスクを直したとき
// （完了にした、題を直したなど）に、カードへ映すために読み直す印
export const load: PageLoad = async ({ params, fetch, url, depends }) => {
  depends('app:sprint-board');
  depends('app:sprints');
  depends('app:backlog-tree');
  const result = await callOperation(sprintBoard, { workspace_id: params.id }, { slug: params.slug, fetcher: fetch });
  if (isUnauthenticated(result)) redirect(307, loginUrl(url, result));
  return { board: result.ok ? result.data : null };
};
