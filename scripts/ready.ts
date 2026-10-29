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
};

// dependencies/blocked_by の要素のうち、判定に使う項目だけ
export type Blocker = { state: string; labels: Label[] };

export type ReadyChanges = { add: number[]; remove: number[] };

// 状態を表すラベル。付いていれば、人かセッションが詰めている・作業している・受け入れを待っているので着手の対象にしない
const BLOCKING_STATUS_LABELS = ['status:refining', 'status:in-progress', 'status:accepting'];

export function readyChanges(
  issues: readonly IssueSummary[],
  blockers: ReadonlyMap<number, readonly Blocker[]>,
): ReadyChanges {
  const add: number[] = [];
  const remove: number[] = [];

  for (const issue of issues) {
    if (issue.pull_request) continue;

    const names = new Set(issue.labels.map((label) => label.name));
    const hasLabel = names.has(READY_LABEL);

    const ownConditions =
      !names.has('epic') &&
      !names.has('sprint-log') &&
      (issue.sub_issues_summary?.total ?? 0) === 0 &&
      [...names].filter((name) => name.startsWith('pt:')).length === 1 &&
      BLOCKING_STATUS_LABELS.every((name) => !names.has(name));

    let ready = ownConditions;
    if (ownConditions) {
      // blocked_by は開いている前に要るもの（受け入れ待ちを含む）の数。0 なら引かずに待ち無し
      const blockedBy = issue.issue_dependencies_summary?.blocked_by ?? 0;
      if (blockedBy > 0) {
        const list = blockers.get(issue.number);
        // 前に要るものを引けていないときは判定できないので、付けも外しもしない
        if (list === undefined) continue;
        ready = list.every(
          (blocker) => blocker.state !== 'open' || blocker.labels.some((label) => label.name === 'status:accepting'),
        );
      }
    }

    if (ready && !hasLabel) add.push(issue.number);
    if (!ready && hasLabel) remove.push(issue.number);
  }

  return { add, remove };
}

type GhResult = { ok: boolean; notFound: boolean; stdout: string; stderr: string };

// シェルを通さず gh を1回呼ぶ
function gh(args: string[]): GhResult {
  const result = spawnSync('gh', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
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
    '.[] | select(.pull_request | not) | {number, labels: [.labels[] | {name}], sub_issues_summary: {total: (.sub_issues_summary.total // 0)}, issue_dependencies_summary: {blocked_by: (.issue_dependencies_summary.blocked_by // 0)}}',
  ]);
  if (!list.ok) {
    console.error(`Issue の一覧を読めなかった: ${list.stderr}`);
    return 1;
  }
  const issues = parseLines<IssueSummary>(list.stdout);

  let failed = 0;
  const blockers = new Map<number, Blocker[]>();
  for (const issue of issues) {
    if ((issue.issue_dependencies_summary?.blocked_by ?? 0) === 0) continue;
    const res = gh([
      'api',
      `repos/${repo}/issues/${issue.number}/dependencies/blocked_by`,
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

  const { add, remove } = readyChanges(issues, blockers);

  for (const n of add) {
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
    } else {
      console.error(`#${n} に ${READY_LABEL} を付けられなかった: ${res.stderr}`);
      failed += 1;
    }
  }
  for (const n of remove) {
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
    } else {
      console.error(`#${n} から ${READY_LABEL} を外せなかった: ${res.stderr}`);
      failed += 1;
    }
  }

  console.log(
    `開いている Issue ${issues.length} 件を数え直した。付けた ${add.length} 件、外した ${remove.length} 件、失敗 ${failed} 件`,
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
