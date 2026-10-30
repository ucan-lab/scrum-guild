// 開発ボードのデータを GitHub から作る（node scripts/progress-data.ts <出力のパス>）。
// GitHub を読む部分（readGitHub）と、JSON を組む部分（buildProgress。I/O を持たない）を分けてある。
// 読み方の根拠は docs/development.md の「スプリントとポイント」と「Issue の状態」、スキルの daily-scrum と backlog-pick。
//
// 出力: { asOf, sprint, issues, history }
//   asOf     作った日時（日本時間の ISO 8601、+09:00 付き）
//   sprint   今のスプリント。開いている記録（sprint-log）が無ければ null、2つ開いていれば番号の大きいほう
//            { n, log, from, to, goal, plan: [{ number, title, pt }],
//              planned, plannedDone, added, addedDone, withdrawn, accepting, wip }
//            数はどれも { pt, count }。wip は作業中の数
//   issues   sprint-log を除く Issue（番号の昇順）。not_planned と duplicate で閉じたものは入れない
//            { number, title, level: epic | story | task, s: done | accept | review | wip | refining | todo,
//              parent, children, pt, sprint, areas, deps, waitingOn, prs, closeReason, milestone }
//            pt は pt: のラベルの数で、子を持つ Issue は null（合計は使う側が子から出す）。
//            sprint は sprint:<番号> の付いた最大の番号、areas は area: の後ろ、
//            deps は開いた Issue の前に要るものすべて、waitingOn はそのうち開いていて status:accepting の無いもの、
//            prs は開いた PR の番号、closeReason は閉じた Issue の state_reason
//   history  閉じた記録のうち締めのコメントのあるもの（番号の昇順）
//            { n, log, planned: { pt, count }, velocity, accepted: [{ number, prs }] }
//            accepted は sprint:<n> が付いて completed で閉じた Issue で、prs はそのマージ済みの PR
// Issue と PR の本文は、計画の表と PR の参照を読むのに使うだけで、出力に入れない
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

export type State = 'done' | 'accept' | 'review' | 'wip' | 'refining' | 'todo';
export type Level = 'epic' | 'story' | 'task';
export type Count = { pt: number; count: number };
export type PlanRow = { number: number; title: string; pt: number };

export type BoardIssue = {
  number: number;
  title: string;
  level: Level;
  s: State;
  parent: number | null;
  children: number[];
  pt: number | null;
  sprint: number | null;
  areas: string[];
  deps: number[];
  waitingOn: number[];
  prs: number[];
  closeReason: string | null;
  milestone: string | null;
};

export type SprintView = {
  n: number;
  log: number;
  from: string;
  to: string;
  goal: string | null;
  plan: PlanRow[];
  planned: Count;
  plannedDone: Count;
  added: Count;
  addedDone: Count;
  withdrawn: Count;
  accepting: Count;
  wip: Count;
};

export type HistoryEntry = {
  n: number;
  log: number;
  planned: Count;
  velocity: number;
  accepted: { number: number; prs: number[] }[];
};

export type Progress = { asOf: string; sprint: SprintView | null; issues: BoardIssue[]; history: HistoryEntry[] };

export type RawIssue = {
  number: number;
  title: string;
  state: 'open' | 'closed';
  stateReason: string | null;
  labels: string[];
  milestone: string | null;
  parent: number | null;
  body: string;
};
export type RawPull = { number: number; head: string; body: string };
export type RawBlocker = { number: number; state: 'open' | 'closed'; labels: string[] };
export type RawData = {
  issues: RawIssue[];
  openPulls: RawPull[];
  mergedPulls: RawPull[];
  // 開いた Issue の番号から前に要るものへ。blocked_by が 0 の Issue は引かないので、キーが無い
  blockers: Record<number, RawBlocker[]>;
  // 親の番号から、サブ Issue の並び（作る順）へ。サブ Issue を持つ親だけ引く
  subOrder: Record<number, number[]>;
  // 閉じた記録の Issue の番号から、コメントの本文へ
  comments: Record<number, string[]>;
};

const SPRINT_LOG = 'sprint-log';
const ACCEPTING = 'status:accepting';
const IN_PROGRESS = 'status:in-progress';
const REFINING = 'status:refining';
const CLOSING_HEADING = '## 締め';
// 重複と対応しないものは作業ではないので、ボードから外す
const DROPPED_REASONS = new Set(['not_planned', 'duplicate']);
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

// 実行する環境のタイムゾーンに依らず日本時間で出すため、9 時間ずらした UTC の壁時計を切り出す
export function jstIso(now: Date): string {
  return `${new Date(now.getTime() + JST_OFFSET_MS).toISOString().slice(0, 19)}+09:00`;
}

const isDropped = (issue: RawIssue): boolean =>
  issue.state === 'closed' && issue.stateReason !== null && DROPPED_REASONS.has(issue.stateReason);
const isAccepted = (issue: RawIssue): boolean => issue.state === 'closed' && issue.stateReason === 'completed';

function pointsOf(labels: string[]): number | null {
  for (const label of labels) {
    const match = /^pt:(\d+)$/.exec(label);
    if (match) return Number(match[1]);
  }
  return null;
}

function sprintsOf(labels: string[]): number[] {
  return labels.flatMap((label) => {
    const match = /^sprint:(\d+)$/.exec(label);
    return match ? [Number(match[1])] : [];
  });
}

function levelOf(labels: string[]): Level {
  if (labels.includes('epic')) return 'epic';
  if (labels.includes('story')) return 'story';
  return 'task';
}

// Issue を指す PR は、ブランチ名の `<番号>-` の先頭か、本文の Refs、Closes、Fixes で引く
// （backlog-pick と同じ。クラウドのブランチ（claude/*）は番号を持たず、決まりの前の PR は Closes で指している）
export function pullTargets(pull: RawPull): number[] {
  const found = new Set<number>();
  const head = /^(\d+)-/.exec(pull.head);
  if (head) found.add(Number(head[1]));
  for (const match of pull.body.matchAll(/\b(?:closes|fixes|refs) #(\d+)/gi)) found.add(Number(match[1]));
  return [...found];
}

function pullsByIssue(pulls: RawPull[]): Map<number, number[]> {
  const out = new Map<number, number[]>();
  for (const pull of pulls) {
    for (const target of pullTargets(pull)) out.set(target, [...(out.get(target) ?? []), pull.number]);
  }
  for (const [target, numbers] of out)
    out.set(
      target,
      numbers.toSorted((a, b) => a - b),
    );
  return out;
}

// 子は各 Issue の parent を親の側に集めて作り、並びは親のサブ Issue の並びに合わせる
function childrenByParent(work: RawIssue[], subOrder: Record<number, number[]>): Map<number, number[]> {
  const byParent = new Map<number, number[]>();
  for (const issue of work) {
    if (issue.parent !== null) byParent.set(issue.parent, [...(byParent.get(issue.parent) ?? []), issue.number]);
  }
  const out = new Map<number, number[]>();
  for (const [parent, found] of byParent) {
    const listed = (subOrder[parent] ?? []).filter((n) => found.includes(n));
    const rest = found.filter((n) => !listed.includes(n)).toSorted((a, b) => a - b);
    out.set(parent, [...listed, ...rest]);
  }
  return out;
}

// 子を持つストーリーとエピックが開いていて、子がすべて done か accept なら accept（子を持つ子にも同じ判定を当てる）。
// 子を持つタスクは通常の読み方にする。閉じた子は、除外される not_planned のものも done に数える
function stateReader(
  byNumber: Map<number, RawIssue>,
  children: Map<number, number[]>,
  openPrs: Map<number, number[]>,
): (number: number) => State {
  const memo = new Map<number, State>();
  const visiting = new Set<number>();
  const read = (number: number): State => {
    const hit = memo.get(number);
    if (hit) return hit;
    const issue = byNumber.get(number);
    // 親子の輪（GitHub は作らせない）で止まらないための保険
    if (!issue || visiting.has(number)) return 'todo';
    visiting.add(number);
    const kids = children.get(number) ?? [];
    let state: State;
    if (issue.state === 'closed') state = 'done';
    else if (issue.labels.includes(ACCEPTING)) state = 'accept';
    else if (
      levelOf(issue.labels) !== 'task' &&
      kids.length > 0 &&
      kids.every((kid) => ['done', 'accept'].includes(read(kid)))
    )
      state = 'accept';
    else if (openPrs.has(number)) state = 'review';
    else if (issue.labels.includes(IN_PROGRESS)) state = 'wip';
    else if (issue.labels.includes(REFINING)) state = 'refining';
    else state = 'todo';
    visiting.delete(number);
    memo.set(number, state);
    return state;
  };
  return read;
}

function sections(body: string): Map<string, string> {
  const out = new Map<string, string>();
  let name: string | null = null;
  let lines: string[] = [];
  const flush = () => {
    if (name !== null) out.set(name, lines.join('\n').trim());
  };
  for (const line of body.replace(/\r\n?/g, '\n').split('\n')) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      flush();
      name = heading[1] ?? '';
      lines = [];
    } else {
      lines.push(line);
    }
  }
  flush();
  return out;
}

export function parseSprintTitle(title: string): { n: number; from: string; to: string } {
  const match = /^スプリント\s*(\d+)\s*[（(]\s*(\d{4}-\d{2}-\d{2})\s*〜\s*(\d{4}-\d{2}-\d{2})\s*[）)]/.exec(title);
  if (!match) throw new Error(`記録の Issue の題を読めない: ${title}`);
  return { n: Number(match[1]), from: match[2] ?? '', to: match[3] ?? '' };
}

export type SprintLog = {
  n: number;
  from: string;
  to: string;
  goal: string | null;
  plan: PlanRow[];
};

// 記録の Issue の題（番号と期間）と本文（ゴール、期間、計画の表）を読む。計画の表は番号、題、ポイントの列を読み、後ろの列は読み捨てる
export function parseSprintLog(title: string, body: string): SprintLog {
  const head = parseSprintTitle(title);
  const parts = sections(body);
  const period = /(\d{4}-\d{2}-\d{2})\s*〜\s*(\d{4}-\d{2}-\d{2})/.exec(parts.get('期間') ?? '');
  const plan: PlanRow[] = [];
  for (const line of (parts.get('計画') ?? '').split('\n')) {
    // 題の `|` は `\|` で書かれるので、`\` の付かない `|` で区切って列の位置で読む。PR の列など4列目以降は人が自由に書くため中身を問わず読み捨てる
    const [lead, numberCell, titleCell, pointCell] = line.trim().split(/(?<!\\)\|/);
    const rowNumber = /^\s*#(\d+)\s*$/.exec(numberCell ?? '');
    const rowPoint = /^\s*(\d+)\s*$/.exec(pointCell ?? '');
    if (lead !== '' || !rowNumber || !rowPoint) continue;
    const number = Number(rowNumber[1]);
    // 同じ番号の行が2つあっても二重に数えないよう、最初の行だけ取る
    if (plan.some((existing) => existing.number === number)) continue;
    plan.push({ number, title: (titleCell ?? '').trim().replace(/\\\|/g, '|'), pt: Number(rowPoint[1]) });
  }
  return {
    n: head.n,
    from: period?.[1] ?? head.from,
    to: period?.[2] ?? head.to,
    goal: parts.get('ゴール') || null,
    plan,
  };
}

// 締めのコメントの表の「計画」の行（ポイント、件数）と `ベロシティ:` の行を読む。読めなければ null
export function parseClosing(comment: string): { planned: Count; velocity: number } | null {
  const text = comment.replace(/\r\n?/g, '\n');
  const planned = /^\|\s*計画\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|/m.exec(text);
  const velocity = /^ベロシティ\s*[:：]\s*(\d+)/m.exec(text);
  if (!planned || !velocity) return null;
  return { planned: { pt: Number(planned[1]), count: Number(planned[2]) }, velocity: Number(velocity[1]) };
}

const tally = (points: number[]): Count => ({ pt: points.reduce((sum, pt) => sum + pt, 0), count: points.length });

type SprintInput = {
  log: RawIssue;
  work: RawIssue[];
  pointsOfIssue: (issue: RawIssue) => number | null;
  openPrs: Map<number, number[]>;
};

function buildSprint({ log, work, pointsOfIssue, openPrs }: SprintInput): SprintView {
  const parsed = parseSprintLog(log.title, log.body);
  const label = `sprint:${parsed.n}`;
  const byNumber = new Map(work.map((issue) => [issue.number, issue]));
  const planned = new Map(parsed.plan.map((row) => [row.number, row]));
  // 計画の一覧にある Issue のポイントは記録の値、ほかは pt: のラベルの数
  const pointsFor = (issue: RawIssue): number => planned.get(issue.number)?.pt ?? pointsOfIssue(issue) ?? 0;
  const labeled = work.filter((issue) => issue.labels.includes(label));

  const rows = parsed.plan.map((row) => ({ row, issue: byNumber.get(row.number) }));
  // ラベルを外してバックログに戻したものと、not_planned で閉じたもの。受け入れで閉じたものは、ラベルが無くても済み
  const withdrawn = rows.filter(
    ({ issue }) => !issue || isDropped(issue) || (!isAccepted(issue) && !issue.labels.includes(label)),
  );
  // 途中で足した分は、docs/development.md の定義どおり、計画に無い sprint:<番号> 付きすべて（not_planned で閉じたものも含む）
  const added = labeled.filter((issue) => !planned.has(issue.number));

  return {
    n: parsed.n,
    log: log.number,
    from: parsed.from,
    to: parsed.to,
    goal: parsed.goal,
    plan: parsed.plan,
    planned: tally(parsed.plan.map((row) => row.pt)),
    plannedDone: tally(rows.filter(({ issue }) => issue && isAccepted(issue)).map(({ row }) => row.pt)),
    added: tally(added.map(pointsFor)),
    addedDone: tally(added.filter(isAccepted).map(pointsFor)),
    withdrawn: tally(withdrawn.map(({ row }) => row.pt)),
    accepting: tally(
      labeled.filter((issue) => issue.state === 'open' && issue.labels.includes(ACCEPTING)).map(pointsFor),
    ),
    // スプリントの外も含む
    wip: tally(
      work
        .filter(
          (issue) =>
            issue.state === 'open' &&
            !issue.labels.includes(ACCEPTING) &&
            (issue.labels.includes(IN_PROGRESS) || openPrs.has(issue.number)),
        )
        .map(pointsFor),
    ),
  };
}

function buildHistory(
  logs: RawIssue[],
  work: RawIssue[],
  mergedPrs: Map<number, number[]>,
  comments: Record<number, string[]>,
): { history: HistoryEntry[]; warnings: string[] } {
  const out: HistoryEntry[] = [];
  const warnings: string[] = [];
  for (const log of logs.filter((issue) => issue.state === 'closed')) {
    // 締めのコメントの無い記録は飛ばす
    const closing = (comments[log.number] ?? []).filter((body) => body.startsWith(CLOSING_HEADING)).at(-1);
    if (closing === undefined) continue;
    // 読めない記録1つで全体を止めないよう、飛ばして知らせる
    let n: number;
    try {
      n = parseSprintTitle(log.title).n;
    } catch {
      warnings.push(`記録 #${log.number} の題を読めないので、履歴から飛ばした`);
      continue;
    }
    const parsed = parseClosing(closing);
    if (!parsed) {
      warnings.push(`記録 #${log.number} の締めのコメントの「計画」の行かベロシティを読めないので、履歴から飛ばした`);
      continue;
    }
    const label = `sprint:${n}`;
    out.push({
      n,
      log: log.number,
      ...parsed,
      accepted: work
        .filter((issue) => isAccepted(issue) && issue.labels.includes(label))
        .toSorted((a, b) => a.number - b.number)
        .map((issue) => ({ number: issue.number, prs: mergedPrs.get(issue.number) ?? [] })),
    });
  }
  return { history: out.toSorted((a, b) => a.n - b.n), warnings };
}

// warnings は JSON に書かず、呼び出し側が stderr に出す（組む部分に I/O を持たせないため）
export type Built = Progress & { warnings: string[] };

export function buildProgress(raw: RawData, now: Date): Built {
  const logs = raw.issues.filter((issue) => issue.labels.includes(SPRINT_LOG));
  const work = raw.issues.filter((issue) => !issue.labels.includes(SPRINT_LOG));
  const byNumber = new Map(work.map((issue) => [issue.number, issue]));
  const openPrs = pullsByIssue(raw.openPulls);
  const mergedPrs = pullsByIssue(raw.mergedPulls);
  const children = childrenByParent(work, raw.subOrder);
  const stateOf = stateReader(byNumber, children, openPrs);
  // 子を持つ Issue のポイントは子の合計なので、自分のラベルは数えない
  const pointsOfIssue = (issue: RawIssue): number | null =>
    children.has(issue.number) ? null : pointsOf(issue.labels);

  const issues = work
    .filter((issue) => !isDropped(issue))
    .toSorted((a, b) => a.number - b.number)
    .map((issue): BoardIssue => {
      const isOpen = issue.state === 'open';
      const blockers = isOpen ? (raw.blockers[issue.number] ?? []) : [];
      return {
        number: issue.number,
        title: issue.title,
        level: levelOf(issue.labels),
        s: stateOf(issue.number),
        parent: issue.parent,
        children: (children.get(issue.number) ?? []).filter((kid) => !isDropped(byNumber.get(kid) as RawIssue)),
        pt: pointsOfIssue(issue),
        sprint: sprintsOf(issue.labels).reduce<number | null>((max, n) => (max === null || n > max ? n : max), null),
        areas: issue.labels.filter((l) => l.startsWith('area:')).map((l) => l.slice('area:'.length)),
        deps: blockers.map((b) => b.number).toSorted((a, b) => a - b),
        // 前に要るものが受け入れ待ちの間は待ちに数えない（実装を止めず、動作の確認を受け入れでまとめて行うため）
        waitingOn: blockers
          .filter((b) => b.state === 'open' && !b.labels.includes(ACCEPTING))
          .map((b) => b.number)
          .toSorted((a, b) => a - b),
        prs: openPrs.get(issue.number) ?? [],
        closeReason: isOpen ? null : issue.stateReason,
        milestone: issue.milestone,
      };
    });

  const { history, warnings } = buildHistory(logs, work, mergedPrs, raw.comments);

  // 今のスプリントは開いている記録。2つ開いていれば番号の大きいほう。題を読めない記録は飛ばし、どれも読めなければ止まる
  const openLogs = logs.filter((issue) => issue.state === 'open');
  const readable = openLogs.flatMap((log) => {
    try {
      return [{ log, n: parseSprintTitle(log.title).n }];
    } catch (error) {
      if (openLogs.length === 1) throw error;
      warnings.push(`開いた記録 #${log.number} の題を読めないので飛ばした`);
      return [];
    }
  });
  if (openLogs.length > 0 && readable.length === 0) throw new Error('開いた記録の題をどれも読めない');
  const current = readable.toSorted((a, b) => b.n - a.n)[0];
  const sprint = current ? buildSprint({ log: current.log, work, pointsOfIssue, openPrs }) : null;
  // 表の形が崩れると、計画が空になってスプリントの Issue がすべて途中で足した分に見えるため、黙らずに知らせる
  if (sprint && sprint.plan.length === 0) warnings.push(`記録 #${sprint.log} の計画の表を1行も読めない`);
  return { asOf: jstIso(now), sprint, issues, history, warnings };
}

export type ApiIssue = {
  number: number;
  title: string;
  state: 'open' | 'closed';
  state_reason: string | null;
  labels: { name: string }[];
  milestone: { title: string } | null;
  parent_issue_url?: string | null;
  body: string | null;
  pull_request?: unknown;
  issue_dependencies_summary?: { blocked_by: number; total_blocked_by: number };
  sub_issues_summary?: { total: number };
};
type ApiPull = { number: number; head: { ref: string }; body: string | null; merged_at: string | null };
type ApiBlocker = { number: number; state: 'open' | 'closed'; labels: { name: string }[] };
type ApiComment = { body: string };

// gh の出力は大きくなりうる
const MAX_BUFFER = 512 * 1024 * 1024;

// シェルを通さず、パイプもせずに gh を1回ずつ呼ぶ
function gh(args: string[]): string {
  return execFileSync('gh', ['api', ...args], {
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
}

// --slurp で、ページごとの配列を1つの JSON に束ねて読む
function ghPages<T>(path: string): T[] {
  return (JSON.parse(gh([path, '--paginate', '--slurp'])) as T[][]).flat();
}

// Issue の一覧には PR も混ざる
export const withoutPulls = (issues: ApiIssue[]): ApiIssue[] => issues.filter((issue) => !issue.pull_request);

// Issue ごとに追加で引くもの。前に要るものは、閉じたものも deps に残すため total_blocked_by（閉じたものも数える）で決める
// （blocked_by は開いたものだけの数なので、前提がすべて閉じた Issue の deps が欠ける）
export function lookupsFor(issue: ApiIssue): { comments: boolean; blockers: boolean; subIssues: boolean } {
  if (issue.labels.some((label) => label.name === SPRINT_LOG)) {
    return { comments: issue.state === 'closed', blockers: false, subIssues: false };
  }
  return {
    comments: false,
    blockers: issue.state === 'open' && (issue.issue_dependencies_summary?.total_blocked_by ?? 0) > 0,
    subIssues: (issue.sub_issues_summary?.total ?? 0) > 0,
  };
}

export function toRawIssue(issue: ApiIssue): RawIssue {
  return {
    number: issue.number,
    title: issue.title,
    state: issue.state,
    stateReason: issue.state_reason,
    labels: issue.labels.map((label) => label.name),
    milestone: issue.milestone?.title ?? null,
    parent: issue.parent_issue_url ? Number(issue.parent_issue_url.split('/').at(-1)) : null,
    body: issue.body ?? '',
  };
}

const toRawPull = (pull: ApiPull): RawPull => ({ number: pull.number, head: pull.head.ref, body: pull.body ?? '' });

export function readGitHub(): RawData {
  const apiIssues = withoutPulls(ghPages<ApiIssue>('repos/{owner}/{repo}/issues?state=all&per_page=100'));
  const issues = apiIssues.map(toRawIssue);
  const openPulls = ghPages<ApiPull>('repos/{owner}/{repo}/pulls?state=open&per_page=100').map(toRawPull);
  const mergedPulls = ghPages<ApiPull>('repos/{owner}/{repo}/pulls?state=closed&per_page=100')
    .filter((pull) => pull.merged_at)
    .map(toRawPull);

  const blockers: RawData['blockers'] = {};
  const subOrder: RawData['subOrder'] = {};
  const comments: RawData['comments'] = {};
  for (const issue of apiIssues) {
    const lookups = lookupsFor(issue);
    if (lookups.comments) {
      comments[issue.number] = ghPages<ApiComment>(
        `repos/{owner}/{repo}/issues/${issue.number}/comments?per_page=100`,
      ).map((comment) => comment.body);
    }
    if (lookups.blockers) {
      blockers[issue.number] = ghPages<ApiBlocker>(
        `repos/{owner}/{repo}/issues/${issue.number}/dependencies/blocked_by?per_page=100`,
      ).map((b) => ({ number: b.number, state: b.state, labels: b.labels.map((label) => label.name) }));
    }
    if (lookups.subIssues) {
      subOrder[issue.number] = ghPages<{ number: number }>(
        `repos/{owner}/{repo}/issues/${issue.number}/sub_issues?per_page=100`,
      ).map((sub) => sub.number);
    }
  }
  return { issues, openPulls, mergedPulls, blockers, subOrder, comments };
}

// import されたとき（テスト）に gh を呼ばないよう、直に動かしたときだけ動く
if (import.meta.main) {
  const out = process.argv[2];
  if (!out) {
    console.error('使い方: node scripts/progress-data.ts <出力のパス>');
    process.exit(1);
  }
  const { warnings, ...progress } = buildProgress(readGitHub(), new Date());
  for (const warning of warnings) console.error(`警告: ${warning}`);
  writeFileSync(out, `${JSON.stringify(progress, null, 2)}\n`);
  console.log(`${out} に書いた（Issue ${progress.issues.length} 件、スプリント ${progress.sprint?.n ?? 'なし'}）`);
}
