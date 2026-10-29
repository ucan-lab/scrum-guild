// 開発ボードのページ（index.html）が描く形を、data.json（scripts/progress-data.ts の出力）から組む純粋な関数。
// DOM にも fetch にも触れない。テストは scripts/board-page.test.ts。
// .claude/ は ESLint と Prettier の外なので、型は JSDoc で添える。

/** @typedef {import('../../../../scripts/progress-data.ts').Progress} Progress */
/** @typedef {import('../../../../scripts/progress-data.ts').BoardIssue} BoardIssue */
/** @typedef {import('../../../../scripts/progress-data.ts').SprintView} SprintView */
/** @typedef {import('../../../../scripts/progress-data.ts').HistoryEntry} HistoryEntry */
/** @typedef {import('../../../../scripts/progress-data.ts').State} State */

/** @typedef {{ name: string, desc: string, issues?: number[], phase?: 'first' | 'later' | 'open' }} Feature */
/** @typedef {{ id: string, name: string, screens: string, note?: string, features: Feature[] }} FeatureArea */
/** @typedef {{ areas: FeatureArea[], notGoals: string[] }} Features */

export const REPO_URL = 'https://github.com/ucan-lab/scrum-guild';
export const issueUrl = (/** @type {number} */ n) => `${REPO_URL}/issues/${n}`;
export const pullUrl = (/** @type {number} */ n) => `${REPO_URL}/pull/${n}`;

export const VIEWS = ['sprint', 'backlog', 'increment'];
export const DEFAULT_VIEW = 'sprint';

/**
 * location.hash から見せ方を決める。知らない値と空は sprint
 * @param {string} hash
 * @returns {'sprint' | 'backlog' | 'increment'}
 */
export function viewFromHash(hash) {
  const name = hash.replace(/^#/, '');
  return /** @type {'sprint' | 'backlog' | 'increment'} */ (VIEWS.includes(name) ? name : DEFAULT_VIEW);
}

const DAY_MS = 24 * 60 * 60 * 1000;
// 日付は UTC の 0 時として扱い、タイムゾーンや夏時間で日数がずれないようにする
const dayNumber = (/** @type {string} */ date) => Math.floor(Date.parse(`${date.slice(0, 10)}T00:00:00Z`) / DAY_MS);

/**
 * 期間の日数（from と to の両方を含む）
 * @param {{ from: string, to: string }} sprint
 */
export function periodDays(sprint) {
  return dayNumber(sprint.to) - dayNumber(sprint.from) + 1;
}

/**
 * 残りの日数。asOf の日付を含めて数え、最終日は 1、過ぎたら 0、始まる前は期間の日数
 * @param {{ from: string, to: string }} sprint
 * @param {string} asOf 日本時間の ISO 8601（日付の部分だけを使う）
 */
export function daysLeft(sprint, asOf) {
  const today = dayNumber(asOf);
  if (today < dayNumber(sprint.from)) return periodDays(sprint);
  return Math.max(0, dayNumber(sprint.to) - today + 1);
}

const byNumber = (/** @type {BoardIssue} */ a, /** @type {BoardIssue} */ b) => a.number - b.number;

/** @type {{ key: string, label: string, states: State[] }[]} */
const COLUMNS = [
  { key: 'todo', label: '着手できる', states: ['todo'] },
  { key: 'wip', label: '作業中', states: ['wip', 'refining'] },
  { key: 'review', label: 'レビュー中', states: ['review'] },
  { key: 'accept', label: '受け入れ待ち', states: ['accept'] },
  { key: 'done', label: '済み', states: ['done'] },
];

/**
 * スプリントの Issue（sprint が n のもの）を5つの列に振る。
 * 着手できる列は、待ち（waitingOn あり）を下に置く。それぞれ番号の昇順
 * @param {BoardIssue[]} issues
 * @param {number} n スプリントの番号
 * @returns {{ key: string, label: string, issues: BoardIssue[] }[]}
 */
export function sprintColumns(issues, n) {
  const mine = issues.filter((issue) => issue.sprint === n).toSorted(byNumber);
  return COLUMNS.map(({ key, label, states }) => {
    const inColumn = mine.filter((issue) => states.includes(issue.s));
    const ordered =
      key === 'todo'
        ? [...inColumn.filter((i) => i.waitingOn.length === 0), ...inColumn.filter((i) => i.waitingOn.length > 0)]
        : inColumn;
    return { key, label, issues: ordered };
  });
}

/**
 * 計画の棒の値。total は計画の全体、done は計画の済み、accept は計画の行のうち受け入れ待ちの Issue のポイント
 * @param {SprintView} sprint
 * @param {BoardIssue[]} issues
 */
export function planBar(sprint, issues) {
  const states = new Map(issues.map((issue) => [issue.number, issue.s]));
  const accept = sprint.plan.filter((row) => states.get(row.number) === 'accept').reduce((sum, row) => sum + row.pt, 0);
  return { total: sprint.planned.pt, done: sprint.plannedDone.pt, accept };
}

/**
 * @typedef {{ remaining: number, all: number, ready: number, leaves: number }} Totals
 * remaining は done 以外の葉の pt、all は葉の pt の全体（pt が null の葉は数えない）、
 * ready は todo で waitingOn が空の葉の数、leaves は葉の数
 */
/** @typedef {{ issue: BoardIssue, children: TreeNode[], totals: Totals }} TreeNode */

/** @returns {Totals} */
const emptyTotals = () => ({ remaining: 0, all: 0, ready: 0, leaves: 0 });

/**
 * @param {Totals} a
 * @param {Totals} b
 * @returns {Totals}
 */
const addTotals = (a, b) => ({
  remaining: a.remaining + b.remaining,
  all: a.all + b.all,
  ready: a.ready + b.ready,
  leaves: a.leaves + b.leaves,
});

/**
 * @param {TreeNode[]} nodes
 * @returns {Totals}
 */
export function sumTotals(nodes) {
  return nodes.reduce((sum, node) => addTotals(sum, node.totals), emptyTotals());
}

/** @param {BoardIssue} leaf @returns {Totals} */
function leafTotals(leaf) {
  return {
    remaining: leaf.pt !== null && leaf.s !== 'done' ? leaf.pt : 0,
    all: leaf.pt ?? 0,
    ready: leaf.s === 'todo' && leaf.waitingOn.length === 0 ? 1 : 0,
    leaves: 1,
  };
}

/**
 * プロダクトバックログの木。
 * 親の無い（または親が data に無い）エピックは根、親の無いストーリーとタスクは orphans（エピックの無いもの）に入れる。
 * 絞り込みは葉に当てる。area が null ならすべて、showDone が false なら done の葉を隠す。
 * 残る葉の無い親は木から外し、合計は絞った結果の葉から出す
 * @param {BoardIssue[]} issues
 * @param {{ area?: string | null, showDone?: boolean }} [filter]
 * @returns {{ epics: TreeNode[], orphans: TreeNode[], totals: Totals }}
 */
export function backlogTree(issues, filter = {}) {
  const { area = null, showDone = false } = filter;
  const index = new Map(issues.map((issue) => [issue.number, issue]));

  /** @param {BoardIssue} leaf */
  const keepLeaf = (leaf) => (showDone || leaf.s !== 'done') && (area === null || leaf.areas.includes(area));

  /**
   * @param {BoardIssue} issue
   * @param {Set<number>} path
   * @returns {TreeNode | null}
   */
  const build = (issue, path) => {
    const kids = issue.children.flatMap((n) => {
      const child = index.get(n);
      return child && !path.has(n) ? [child] : [];
    });
    if (kids.length === 0) return keepLeaf(issue) ? { issue, children: [], totals: leafTotals(issue) } : null;
    const nextPath = new Set(path).add(issue.number);
    const children = kids.flatMap((kid) => {
      const node = build(kid, nextPath);
      return node ? [node] : [];
    });
    return children.length === 0 ? null : { issue, children, totals: sumTotals(children) };
  };

  const roots = issues
    .filter((issue) => issue.parent === null || !index.has(issue.parent))
    .toSorted(byNumber)
    .flatMap((issue) => {
      const node = build(issue, new Set());
      return node ? [node] : [];
    });
  const epics = roots.filter((node) => node.issue.level === 'epic');
  const orphans = roots.filter((node) => node.issue.level !== 'epic');
  return { epics, orphans, totals: sumTotals(roots) };
}

/** 作る場所の一覧（絞り込みのボタン用）。issues に現れる area を昇順で */
export function areasOf(/** @type {BoardIssue[]} */ issues) {
  return [...new Set(issues.flatMap((issue) => issue.areas))].toSorted();
}

export const PHASE_LABELS = { first: '初版', later: '後回し', open: '未決' };

/**
 * 機能の段階。phase が無いか知らない値なら first
 * @param {Feature} feature
 * @returns {'first' | 'later' | 'open'}
 */
export function featurePhase(feature) {
  return feature.phase === 'later' || feature.phase === 'open' ? feature.phase : 'first';
}

/**
 * 機能の状態。受け持つ Issue の s がすべて done なら済み、1つでも todo 以外があれば進行中、
 * Issue が無ければ Issue なし、それ以外は未着手。data に無い番号は todo とみなす
 * @param {Feature} feature
 * @param {BoardIssue[]} issues
 * @returns {{ key: 'done' | 'active' | 'idle' | 'none', label: string }}
 */
export function featureState(feature, issues) {
  const numbers = feature.issues ?? [];
  if (numbers.length === 0) return { key: 'none', label: 'Issue なし' };
  const states = new Map(issues.map((issue) => [issue.number, issue.s]));
  const own = numbers.map((n) => states.get(n) ?? 'todo');
  if (own.every((s) => s === 'done')) return { key: 'done', label: '済み' };
  if (own.some((s) => s !== 'todo')) return { key: 'active', label: '進行中' };
  return { key: 'idle', label: '未着手' };
}

/**
 * インクリメントの見せ方。entries は新しい順（スプリントの番号の降順）、
 * bars は古い順で、ベロシティと計画の pt を同じ目盛り（両方の最大値）で割った 0 以上 1 以下の比
 * @param {HistoryEntry[]} history
 */
export function incrementView(history) {
  const entries = history.toSorted((a, b) => b.n - a.n);
  const oldest = history.toSorted((a, b) => a.n - b.n);
  const max = Math.max(0, ...oldest.flatMap((h) => [h.velocity, h.planned.pt]));
  const ratio = (/** @type {number} */ pt) => (max === 0 ? 0 : pt / max);
  const bars = oldest.map((h) => ({
    n: h.n,
    velocity: h.velocity,
    planned: h.planned.pt,
    velocityRatio: ratio(h.velocity),
    plannedRatio: ratio(h.planned.pt),
  }));
  return { entries, bars, max };
}
