// API の取得はワークフローの gh api が受け持つ。ここでは保存した JSON だけを見て判定する
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { notice, requiredEnv, writeOutput, type Comparison } from './evidence.ts';

export const EVIDENCE_REVIEW_MARKER = '<!-- e2e-evidence-review -->';
export const MAIN_URL_EMPTY = 'EVIDENCE_MAIN_PUBLIC_URL が空';
// 画像を作る ci はこのワークフローだけ。同じ名前の別のワークフローの実行を混ぜない
const CI_WORKFLOW_PATH = '.github/workflows/ci.yml';

export type ReviewPr = {
  number: number;
  state: string;
  draft: boolean;
  base: { ref: string; sha: string };
  head: { sha: string; repo: { full_name: string } | null };
  user: { type: string };
  author_association: string;
};
export type CiRun = {
  id: number;
  head_sha: string;
  event: string;
  status: string;
  path?: string;
  head_repository?: { full_name: string } | null;
};
export type ReviewEvent = {
  action?: string;
  label?: { name: string };
  repository?: { id: number };
  pull_request?: ReviewPr;
  workflow_run?: CiRun & {
    head_repository?: { full_name: string };
    pull_requests: { number: number; base?: { ref?: string; sha?: string; repo?: { id: number } } }[];
  };
};
export type ReviewJob = { name: string; conclusion: string | null };
export type ReviewComment = { body?: string | null; user?: { login?: string } | null };
export type Decision = { run: boolean; reason: string };

// workflow_run の pull_requests は、同じ head のブランチ名の別のリポジトリの PR も含みうる。
// base がこのリポジトリのものだけを使い、番号と比べる base の SHA を同じ要素から取る。
// stacked PR では子の PR も同じ head を持つので、候補と同じく main 向けを優先する
function workflowRunPr(event: ReviewEvent) {
  const repositoryId = event.repository?.id;
  if (repositoryId === undefined) return undefined;
  const own = event.workflow_run?.pull_requests.filter((pr) => pr.base?.repo?.id === repositoryId) ?? [];
  return own.find((pr) => pr.base?.ref === 'main') ?? own[0];
}

export function resolvePrNumber(event: ReviewEvent, candidates: readonly ReviewPr[]): number | undefined {
  if (event.pull_request) return event.pull_request.number;
  const run = event.workflow_run;
  if (!run) return undefined;
  const listed = workflowRunPr(event);
  if (listed) return listed.number;
  // stacked PR は子の PR も同じ head の SHA を持つ。main 向けを優先し、無ければ判定側で断る
  const open = candidates.filter((pr) => pr.state === 'open' && pr.head.sha === run.head_sha);
  return (open.find((pr) => pr.base.ref === 'main') ?? open[0])?.number;
}

// API は新しい順で返すが、ページをまとめても順に依存しないよう実行 ID で選ぶ。
// 同じ実行の再試行は同じ ID の status とジョブを使う。
// fork の PR の ci も同じ head の SHA で走りうるので、PR の head と同じリポジトリの実行だけを選ぶ
export function selectCiRun(event: ReviewEvent, runs: readonly CiRun[]): CiRun | undefined {
  if (event.workflow_run) return event.workflow_run;
  const headRepository = event.pull_request?.head.repo?.full_name;
  return runs
    .filter(
      (run) =>
        run.head_sha === event.pull_request?.head.sha &&
        run.event === 'pull_request' &&
        run.path === CI_WORKFLOW_PATH &&
        headRepository !== undefined &&
        run.head_repository?.full_name === headRepository,
    )
    .reduce<CiRun | undefined>((latest, run) => (!latest || run.id > latest.id ? run : latest), undefined);
}

export function comparisonBaseSha(event: ReviewEvent, pr: ReviewPr): string {
  return workflowRunPr(event)?.base?.sha ?? event.pull_request?.base.sha ?? pr.base.sha;
}

export function decideReview(input: {
  event: ReviewEvent;
  repository: string;
  pr?: ReviewPr;
  ci?: CiRun;
  jobs: readonly ReviewJob[];
  comments: readonly ReviewComment[];
  mainUrl: string;
}): Decision {
  const { event, pr, ci, jobs, comments } = input;
  const skip = (reason: string): Decision => ({ run: false, reason });
  if (event.action === 'labeled' && event.label?.name !== 'ai-review') return skip('ai-review のラベルでない');
  if (!pr) return skip('PR が見つからない');
  if (pr.state !== 'open') return skip('PR が開いていない');
  if (pr.draft) return skip('ドラフト');
  if (pr.base.ref !== 'main') return skip('base が main でない');
  if (pr.head.repo?.full_name !== input.repository) return skip('head が同じリポジトリでない');
  if (pr.user.type === 'Bot') return skip('作成者が Bot');
  if (!['OWNER', 'COLLABORATOR'].includes(pr.author_association)) return skip('作成者に書き込み権限が無い');
  // workflow_run の payload はそのまま信じず、main の ci.yml が同じリポジトリの head で動いた実行だけを使う
  if (
    event.workflow_run &&
    (event.workflow_run.path !== CI_WORKFLOW_PATH || event.workflow_run.head_repository?.full_name !== input.repository)
  )
    return skip('ci が main の ci.yml の実行でない');
  if (!ci || ci.status !== 'completed') return skip('ci が無いか、まだ完了していない');
  // 完了を待つ間に push された古い実行の画像と、新しい head の差分を混ぜない
  if (ci.event !== 'pull_request' || ci.head_sha !== pr.head.sha) return skip('ci が今の PR の head でない');
  const e2e = jobs.filter((job) => /^e2e \(\d+\)$/.test(job.name));
  if (!e2e.length || e2e.some((job) => job.conclusion !== 'success')) return skip('e2e が成功していない');
  if (!jobs.some((job) => job.name === 'evidence' && job.conclusion === 'success'))
    return skip('evidence が成功していない');
  // 判定のコメントは目印で始める。evidence のコメントはテスト名を並べるので、途中に目印の文字があっても数えない
  if (
    event.action !== 'labeled' &&
    comments.some(
      (comment) => comment.user?.login === 'github-actions[bot]' && comment.body?.startsWith(EVIDENCE_REVIEW_MARKER),
    )
  )
    return skip('自動の判定は既にコメントがある');
  if (!input.mainUrl.trim()) return skip(MAIN_URL_EMPTY);
  return { run: true, reason: '画像を比較する条件を満たす' };
}

export function decideScreens(comparison: Comparison): Decision {
  return comparison.changed.length + comparison.added.length > 0
    ? { run: true, reason: '変わった画面か新しい画面がある' }
    : { run: false, reason: '変わった画面と新しい画面が無い' };
}

if (import.meta.main) {
  const [mode, rawDir] = process.argv.slice(2);
  if (!rawDir) throw new Error('取得した JSON のディレクトリが要る');
  const read = <T>(name: string): T => JSON.parse(readFileSync(join(rawDir, name), 'utf8')) as T;
  const event = JSON.parse(readFileSync(requiredEnv('GITHUB_EVENT_PATH'), 'utf8')) as ReviewEvent;
  if (mode === 'resolve') {
    const number = resolvePrNumber(event, read<ReviewPr[][]>('candidates.json').flat());
    writeOutput('pr_number', number === undefined ? '' : String(number));
    if (number === undefined) console.log('run=false: PR が見つからない。画面数: 未比較');
  } else if (mode === 'ci') {
    const run = selectCiRun(
      event,
      read<{ workflow_runs: CiRun[] }[]>('runs.json').flatMap((p) => p.workflow_runs),
    );
    writeFileSync(join(rawDir, 'ci.json'), JSON.stringify(run ?? null));
    writeOutput('ci_run_id', run?.status === 'completed' ? String(run.id) : '');
    if (!run || run.status !== 'completed') console.log('run=false: ci が無いか、まだ完了していない。画面数: 未比較');
  } else if (mode === 'decide') {
    const pr = read<ReviewPr>('pr.json');
    const result = decideReview({
      event,
      repository: requiredEnv('GITHUB_REPOSITORY'),
      pr,
      ci: read<CiRun | null>('ci.json') ?? undefined,
      jobs: read<{ jobs: ReviewJob[] }[]>('jobs.json').flatMap((p) => p.jobs),
      comments: read<ReviewComment[][]>('comments.json').flat(),
      mainUrl: process.env.EVIDENCE_MAIN_PUBLIC_URL ?? '',
    });
    writeOutput('run', result.run);
    writeOutput('base_sha', comparisonBaseSha(event, pr));
    writeOutput('head_sha', pr.head.sha);
    console.log(`run=${result.run}: ${result.reason}。画面数: 未比較`);
    // 他の理由で止まったときに「URL が空」と出すと、設定の誤りと取り違える
    if (result.reason === MAIN_URL_EMPTY) notice('画面の判定を飛ばす', result.reason);
  } else {
    throw new Error('使い方: node scripts/evidence-review-decide.ts <resolve|ci|decide> <JSON のディレクトリ>');
  }
}
