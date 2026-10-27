import { redirect } from '@sveltejs/kit';
import { callOperation } from '../../../../lib/api.ts';
import { filterFromParams, filterInput } from '../../../../lib/backlog-filter.ts';
import { isUnauthenticated, loginUrl } from '../../../../lib/login-redirect.ts';
import { categoryRepositoryList } from '../../../../shared/operations/definition/index.ts';
import { experienceTeamTotal } from '../../../../shared/operations/experience/index.ts';
import { backlogTree } from '../../../../shared/operations/task/index.ts';
import type { PageLoad } from './$types';

// バックログの木。読めなかったとき（通信、5xx）は tree が null で、画面は読み込みの失敗を出す。
// ワークスペースが見つからないとき（404、403）は枠が先に「見つからない」を出すので、ここでは同じ null にする。
// 区分とリポジトリの一覧（起票、エピックとストーリーのダイアログの選択肢、絞り込みの帯）も同時に読む。読めなければ definitions が null で、
// ダイアログは選択肢なしで開く（木は出す）。
// 絞り込みは URL の問い合わせ（assignee、category、repository、epic、q。src/lib/backlog-filter.ts）から読み、サーバーで絞る。
// 読んだ絞り込みは filter で画面に渡す（木がどの絞り込みで読まれたかを、画面が URL ではなくこの値で決める）。
// SvelteKit は読んだ問い合わせのキーだけを見るので、引き出しの `?task=` が替わっても、この load は走り直らない。
// url の残りは 401 のときだけ読む（読むと、移るたびにこの load が走り直る）。
// `app:backlog-tree` は、引き出しが欄を保存した後に、木だけを読み直す印（枠の読み直しが一時的に失敗しても、引き出しと書きかけを失わないため）。
// チーム全体の経験値（teamTotal）は木と並べて読み、読めなければ null で、見出しに出さないだけにする（画面は壊さない）
export const load: PageLoad = async ({ params, fetch, url, depends }) => {
  depends('app:backlog-tree');
  const filter = filterFromParams(url.searchParams);
  const options = { slug: params.slug, fetcher: fetch };
  const [result, definitions, teamTotal] = await Promise.all([
    callOperation(backlogTree, { workspace_id: params.id, ...filterInput(filter) }, options),
    callOperation(categoryRepositoryList, { workspace_id: params.id }, options),
    callOperation(experienceTeamTotal, { workspace_id: params.id }, options),
  ]);
  if (isUnauthenticated(result)) redirect(307, loginUrl(url, result));
  return {
    tree: result.ok ? result.data : null,
    filter,
    definitions: definitions.ok ? definitions.data : null,
    teamTotal: teamTotal.ok ? teamTotal.data.total : null,
  };
};
