// 着手できる Issue に status:ready を付け、当てはまらなくなったら外す（.github/workflows/ready.yml が動かす。docs/development.md の「Issue の状態」）。
// ワークフローは pnpm install をしないので、node: の組み込みだけを import する
import { spawnSync } from 'node:child_process';

export const READY_LABEL = 'status:ready';

type Label = { name: string };

// GitHub の issues?state=open の一覧の要素のうち、判定に使う項目だけ
export type IssueSummary = {
  number: number;
  labels: Label[];
  pull_request?: unknown;
  sub_issues_summary?: { total: number } | null;
  issue_dependencies_summary?: { blocked_by: number } | null;
  // 親の Issue の番号。無ければ null か未定義
  parent?: number | null;
};

// 開いた PR のうち、指す Issue を拾うのに使う項目だけ
export type OpenPr = { head: string; body: string | null; sameRepo: boolean };

// dependencies/blocked_by の要素のうち、判定に使う項目だけ
export type Blocker = { state: string; labels: Label[] };

export type ReadyChanges = { add: number[]; remove: number[] };

// 状態を表すラベル。付いていれば、人かセッションが詰めている・作業している・受け入れを待っているので着手の対象にしない
const BLOCKING_STATUS_LABELS = ['status:refining', 'status:in-progress', 'status:accepting'];

const PR_REFERENCE = /(?:closes|fixes|refs) #([0-9]+)/gi;

// 開いた PR が指す Issue の番号。backlog-pick と同じく、ブランチ名の先頭の <番号>- と、本文の Closes、Fixes、Refs を拾う。
// fork の PR はブランチ名も本文も外の人が決めるので拾わない（関係の無い Issue のラベルを外させない）
export function issuesWithOpenPr(prs: readonly OpenPr[]): Set<number> {
  const numbers = new Set<number>();
  for (const pr of prs) {
    if (!pr.sameRepo) continue;
    const branch = /^([0-9]+)-/.exec(pr.head);
    if (branch) numbers.add(Number(branch[1]));
    for (const match of (pr.body ?? '').matchAll(PR_REFERENCE)) numbers.add(Number(match[1]));
  }
  return numbers;
}

type Wait = 'none' | 'waiting' | 'unknown';

// 1つの Issue 自身の前に要るものの待ち
function ownWait(issue: IssueSummary, blockers: ReadonlyMap<number, readonly Blocker[]>): Wait {
  // blocked_by は開いている前に要るもの（受け入れ待ちを含む）の数。0 なら引かずに待ち無し
  const blockedBy = issue.issue_dependencies_summary?.blocked_by ?? 0;
  if (blockedBy === 0) return 'none';
  const list = blockers.get(issue.number);
  if (list === undefined) return 'unknown';
  const open = list.filter((blocker) => blocker.state === 'open');
  // 引く間に閉じたか、トークンで見えない前に要るもの（別のリポジトリ）があると数が合わない。一部だけで判定しない
  if (open.length < blockedBy) return 'unknown';
  return open.every((blocker) => blocker.labels.some((label) => label.name === 'status:accepting'))
    ? 'none'
    : 'waiting';
}

// 自分と祖先（親のストーリー、エピック）の待ち。一覧に無い親（閉じている）から上は見ない
function lineageWait(
  issue: IssueSummary,
  byNumber: ReadonlyMap<number, IssueSummary>,
  blockers: ReadonlyMap<number, readonly Blocker[]>,
): Wait {
  let result: Wait = 'none';
  const seen = new Set<number>();
  for (let current: IssueSummary | undefined = issue; current && !seen.has(current.number);) {
    seen.add(current.number);
    const wait = ownWait(current, blockers);
    if (wait === 'waiting') return 'waiting';
    if (wait === 'unknown') result = 'unknown';
    current = current.parent == null ? undefined : byNumber.get(current.parent);
  }
  return result;
}

export function readyChanges(
  issues: readonly IssueSummary[],
  blockers: ReadonlyMap<number, readonly Blocker[]>,
  withOpenPr: ReadonlySet<number> = new Set(),
): ReadyChanges {
  const add: number[] = [];
  const remove: number[] = [];
  const byNumber = new Map(issues.filter((issue) => !issue.pull_request).map((issue) => [issue.number, issue]));

  for (const issue of byNumber.values()) {
    const names = new Set(issue.labels.map((label) => label.name));
    const hasLabel = names.has(READY_LABEL);

    const ownConditions =
      !names.has('epic') &&
      !names.has('sprint-log') &&
      (issue.sub_issues_summary?.total ?? 0) === 0 &&
      [...names].filter((name) => name.startsWith('pt:')).length === 1 &&
      BLOCKING_STATUS_LABELS.every((name) => !names.has(name)) &&
      !withOpenPr.has(issue.number);

    let ready = ownConditions;
    if (ownConditions) {
      const wait = lineageWait(issue, byNumber, blockers);
      // 前に要るものを引けていないときは判定できないので、付けも外しもしない
      if (wait === 'unknown') continue;
      ready = wait === 'none';
    }

    if (ready && !hasLabel) add.push(issue.number);
    if (!ready && hasLabel) remove.push(issue.number);
  }

  return { add, remove };
}

type GhResult = { ok: boolean; notFound: boolean; stdout: string; stderr: string };

// シェルを通さず gh を1回呼ぶ
function gh(args: string[]): GhResult {
  // gh が止まっても、ジョブの timeout-minutes まで全体を待たせない
  const result = spawnSync('gh', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: 60_000 });
  const stderr = result.error ? result.error.message : result.stderr;
  return {
    ok: result.status === 0,
    notFound: stderr.includes('HTTP 404'),
    stdout: result.stdout ?? '',
    stderr: stderr.trim(),
  };
}

function parseLines<T>(stdout: string): T[] {
  return stdout
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as T);
}

function run(repo: string): number {
  // 題と本文はログにも読み込みにも要らないので、jq で判定に使う項目だけに絞る
  const list = gh([
    'api',
    `repos/${repo}/issues?state=open&per_page=100`,
    '--paginate',
    '--jq',
    '.[] | select(.pull_request | not) | {number, labels: [.labels[] | {name}], sub_issues_summary: {total: (.sub_issues_summary.total // 0)}, issue_dependencies_summary: {blocked_by: (.issue_dependencies_summary.blocked_by // 0)}, parent: (.parent_issue_url // "" | split("/") | last | if . == "" then null else tonumber end)}',
  ]);
  if (!list.ok) {
    console.error(`Issue の一覧を読めなかった: ${list.stderr}`);
    return 1;
  }
  const issues = parseLines<IssueSummary>(list.stdout);

  // PR の本文は指す番号を拾うためだけに読み、ログには出さない
  const pulls = gh([
    'api',
    `repos/${repo}/pulls?state=open&per_page=100`,
    '--paginate',
    '--jq',
    '.[] | {head: .head.ref, body, sameRepo: (.head.repo.full_name == .base.repo.full_name)}',
  ]);
  if (!pulls.ok) {
    console.error(`開いた PR の一覧を読めなかった: ${pulls.stderr}`);
    return 1;
  }
  const withOpenPr = issuesWithOpenPr(parseLines<OpenPr>(pulls.stdout));

  let failed = 0;
  let added = 0;
  let removed = 0;
  const blockers = new Map<number, Blocker[]>();
  for (const issue of issues) {
    if ((issue.issue_dependencies_summary?.blocked_by ?? 0) === 0) continue;
    const res = gh([
      'api',
      `repos/${repo}/issues/${issue.number}/dependencies/blocked_by?per_page=100`,
      '--paginate',
      '--jq',
      '.[] | {state, labels: [.labels[] | {name}]}',
    ]);
    if (!res.ok) {
      // 引けなかった Issue は blockers に入れず、readyChanges が変えないままにする
      console.error(`#${issue.number} の前に要るものを読めなかった: ${res.stderr}`);
      failed += 1;
      continue;
    }
    blockers.set(issue.number, parseLines<Blocker>(res.stdout));
  }

  const { add, remove } = readyChanges(issues, blockers, withOpenPr);

  // 一覧を読んでから書くまでの間に閉じた Issue には触らない。読めなければ失敗に数えて見送る
  const stillOpen = (n: number): boolean => {
    const res = gh(['api', `repos/${repo}/issues/${n}`, '--jq', '.state']);
    if (!res.ok) {
      console.error(`#${n} の状態を読めなかった: ${res.stderr}`);
      failed += 1;
      return false;
    }
    if (res.stdout.trim() !== 'open') {
      console.log(`#${n} は閉じたので触らない`);
      return false;
    }
    return true;
  };

  for (const n of add) {
    if (!stillOpen(n)) continue;
    const res = gh([
      'api',
      '-X',
      'POST',
      `repos/${repo}/issues/${n}/labels`,
      '-f',
      `labels[]=${READY_LABEL}`,
      '--silent',
    ]);
    if (res.ok) {
      console.log(`#${n} に ${READY_LABEL} を付けた`);
      added += 1;
    } else {
      console.error(`#${n} に ${READY_LABEL} を付けられなかった: ${res.stderr}`);
      failed += 1;
    }
  }
  for (const n of remove) {
    if (!stillOpen(n)) continue;
    const res = gh([
      'api',
      '-X',
      'DELETE',
      `repos/${repo}/issues/${n}/labels/${encodeURIComponent(READY_LABEL)}`,
      '--silent',
    ]);
    // 同時に誰かが外したラベルを外すと 404 が返る。それは成功と同じに扱う
    if (res.ok || res.notFound) {
      console.log(`#${n} から ${READY_LABEL} を外した`);
      removed += 1;
    } else {
      console.error(`#${n} から ${READY_LABEL} を外せなかった: ${res.stderr}`);
      failed += 1;
    }
  }

  console.log(
    `開いている Issue ${issues.length} 件を数え直した。付けた ${added} 件、外した ${removed} 件、失敗 ${failed} 件`,
  );
  return failed > 0 ? 1 : 0;
}

if (import.meta.main) {
  const repo = process.env.REPO;
  if (!repo) {
    console.error('環境変数 REPO（owner/name）が無い');
    process.exit(1);
  }
  process.exit(run(repo));
}
