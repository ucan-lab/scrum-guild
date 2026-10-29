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
/**
 * 先頭の YYYY-MM-DD を、UTC の 0 時から数えた日の通し番号にする（タイムゾーンや夏時間で日数がずれない）。
 * 読めない日付と、存在しない日付（2026-02-30 など。Date は 3 月に繰り上げてしまう）は NaN
 * @param {unknown} date
 */
function dayNumber(date) {
  const match = typeof date === 'string' ? /^(\d{4})-(\d{2})-(\d{2})/.exec(date) : null;
  if (!match) return NaN;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const at = new Date(Date.UTC(year, month - 1, day));
  const exists = at.getUTCFullYear() === year && at.getUTCMonth() === month - 1 && at.getUTCDate() === day;
  return exists ? Math.floor(at.getTime() / DAY_MS) : NaN;
}

/**
 * YYYY-MM-DD（先頭）として読める日付か
 * @param {unknown} date
 */
export const isDay = (date) => !Number.isNaN(dayNumber(date));

/**
 * 期間の日数（from と to の両方を含む）。日付が読めないか、to が from より前なら 0
 * @param {{ from: string, to: string }} sprint
 */
export function periodDays(sprint) {
  const days = dayNumber(sprint.to) - dayNumber(sprint.from) + 1;
  return Number.isNaN(days) ? 0 : Math.max(0, days);
}

/**
 * 残りの日数。asOf の日付を含めて数え、最終日は 1、過ぎたら 0、始まる前は期間の日数。
 * 日付が読めないときは 0（画面に NaN を出さない。読めない JSON は validateData が先に断る）
 * @param {{ from: string, to: string }} sprint
 * @param {string} asOf 日本時間の ISO 8601（日付の部分だけを使う）
 */
export function daysLeft(sprint, asOf) {
  const today = dayNumber(asOf);
  if (Number.isNaN(today) || periodDays(sprint) === 0) return 0;
  if (today < dayNumber(sprint.from)) return periodDays(sprint);
  return Math.max(0, dayNumber(sprint.to) - today + 1);
}

/**
 * asOf が期間の前か中か後か。日付が読めないときは during（「開始前」などの印を出さない）
 * @param {{ from: string, to: string }} sprint
 * @param {string} asOf
 * @returns {'before' | 'during' | 'after'}
 */
export function sprintPhase(sprint, asOf) {
  const today = dayNumber(asOf);
  const from = dayNumber(sprint.from);
  const to = dayNumber(sprint.to);
  if (Number.isNaN(today) || Number.isNaN(from) || Number.isNaN(to)) return 'during';
  if (today < from) return 'before';
  return today > to ? 'after' : 'during';
}

const byNumber = (/** @type {BoardIssue} */ a, /** @type {BoardIssue} */ b) => a.number - b.number;

/**
 * 印に出す状態。前に要るものを待つ todo は、着手できないので blocked（待ち）にする
 * @param {BoardIssue} issue
 * @returns {State | 'blocked'}
 */
export const displayState = (issue) => (issue.s === 'todo' && issue.waitingOn.length > 0 ? 'blocked' : issue.s);

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
 * 絞り込みは葉に当てる。area が null ならすべて、showDone が false なら done の葉を隠す。残る葉の無い親は木から外す。
 * ノードの totals は、隠した葉も含めた子孫すべての葉から出す（済みを隠しても、進みが 0% に見えないように）。
 * 返す totals は、絞った結果の葉から出す
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
   * data にある子。path（根からの道）にある番号は、輪で止まらないよう飛ばす
   * @param {BoardIssue} issue
   * @param {Set<number>} path
   * @returns {BoardIssue[]}
   */
  const kidsOf = (issue, path) =>
    issue.children.flatMap((n) => {
      const child = index.get(n);
      return child && !path.has(n) ? [child] : [];
    });

  /**
   * kept は絞った結果の葉の合計
   * @param {BoardIssue} issue
   * @param {Set<number>} path
   * @returns {{ node: TreeNode | null, kept: Totals }}
   */
  const build = (issue, path) => {
    const kids = kidsOf(issue, path);
    if (kids.length === 0) {
      const totals = leafTotals(issue);
      return keepLeaf(issue)
        ? { node: { issue, children: [], totals }, kept: totals }
        : { node: null, kept: emptyTotals() };
    }
    const nextPath = new Set(path).add(issue.number);
    const built = kids.map((kid) => build(kid, nextPath));
    const children = built.flatMap(({ node }) => (node ? [node] : []));
    const kept = built.reduce((sum, b) => addTotals(sum, b.kept), emptyTotals());
    if (children.length === 0) return { node: null, kept };
    return { node: { issue, children, totals: allLeafTotals(issue, path) }, kept };
  };

  /**
   * 絞り込みに関わらない、子孫すべての葉の合計
   * @param {BoardIssue} issue
   * @param {Set<number>} path
   * @returns {Totals}
   */
  const allLeafTotals = (issue, path) => {
    const kids = kidsOf(issue, path);
    if (kids.length === 0) return leafTotals(issue);
    const nextPath = new Set(path).add(issue.number);
    return kids.reduce((sum, kid) => addTotals(sum, allLeafTotals(kid, nextPath)), emptyTotals());
  };

  const built = issues
    .filter((issue) => issue.parent === null || !index.has(issue.parent))
    .toSorted(byNumber)
    .map((issue) => build(issue, new Set()));
  const roots = built.flatMap(({ node }) => (node ? [node] : []));
  const epics = roots.filter((node) => node.issue.level === 'epic');
  const orphans = roots.filter((node) => node.issue.level !== 'epic');
  return { epics, orphans, totals: built.reduce((sum, b) => addTotals(sum, b.kept), emptyTotals()) };
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

/* 読み込んだ JSON の検査と整形。描く前に形を確かめ、崩れた JSON で画面が固まらないようにする */

/** @typedef {Record<string, any>} Loose */

/** @param {unknown} value @returns {value is Loose} */
const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
/** @param {unknown} value @returns {value is number} */
const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);
/** @param {unknown} value */
const isNumberOrNull = (value) => value === null || isNumber(value);
/** @param {unknown} value */
const isCount = (value) => isObject(value) && isNumber(value.pt) && isNumber(value.count);

const SPRINT_COUNTS = ['planned', 'plannedDone', 'added', 'addedDone', 'withdrawn', 'accepting', 'wip'];
const ISSUE_LISTS = ['children', 'areas', 'deps', 'waitingOn', 'prs'];

/** @param {unknown} sprint @returns {string | null} */
function sprintProblem(sprint) {
  if (!isObject(sprint)) return 'sprint は null か object が要る';
  if (!isNumber(sprint.n)) return 'sprint.n は数が要る';
  if (!isNumber(sprint.log)) return 'sprint.log は数が要る';
  if (!isDay(sprint.from)) return 'sprint.from は YYYY-MM-DD が要る';
  if (!isDay(sprint.to)) return 'sprint.to は YYYY-MM-DD が要る';
  if (sprint.goal !== null && typeof sprint.goal !== 'string') return 'sprint.goal は文字列か null が要る';
  if (!isNumberOrNull(sprint.wipLimit)) return 'sprint.wipLimit は数か null が要る';
  if (!Array.isArray(sprint.plan)) return 'sprint.plan は配列が要る';
  const row = sprint.plan.find((r) => !isObject(r) || !isNumber(r.number) || !isNumber(r.pt));
  if (row !== undefined) return 'sprint.plan の行は number と pt が要る';
  const count = SPRINT_COUNTS.find((key) => !isCount(sprint[key]));
  return count === undefined ? null : `sprint.${count} は { pt, count } が要る`;
}

/** @param {unknown} issue @returns {string | null} */
function issueProblem(issue) {
  if (!isObject(issue) || !isNumber(issue.number)) return 'issues の項目は number を持つ object が要る';
  const at = `issues #${issue.number}`;
  if (typeof issue.title !== 'string') return `${at} の title は文字列が要る`;
  if (!['epic', 'story', 'task'].includes(/** @type {string} */ (issue.level))) return `${at} の level が不正`;
  if (!Object.keys(STATE_NAMES).includes(/** @type {string} */ (issue.s))) return `${at} の s が不正`;
  if (!isNumberOrNull(issue.pt)) return `${at} の pt は数か null が要る`;
  if (!isNumberOrNull(issue.parent)) return `${at} の parent は数か null が要る`;
  if (!isNumberOrNull(issue.sprint)) return `${at} の sprint は数か null が要る`;
  const list = ISSUE_LISTS.find((key) => !Array.isArray(issue[key]));
  return list === undefined ? null : `${at} の ${list} は配列が要る`;
}

const STATE_NAMES = { done: 1, accept: 1, review: 1, wip: 1, refining: 1, todo: 1 };

/** @param {unknown} entry @returns {string | null} */
function historyProblem(entry) {
  if (!isObject(entry) || !isNumber(entry.n)) return 'history の項目は n を持つ object が要る';
  const at = `history のスプリント ${entry.n}`;
  if (!isNumber(entry.log)) return `${at} の log は数が要る`;
  if (!isCount(entry.planned)) return `${at} の planned は { pt, count } が要る`;
  if (!isNumber(entry.velocity)) return `${at} の velocity は数が要る`;
  if (!Array.isArray(entry.accepted)) return `${at} の accepted は配列が要る`;
  const bad = entry.accepted.some((a) => !isObject(a) || !isNumber(a.number) || !Array.isArray(a.prs));
  return bad ? `${at} の accepted は { number, prs } の配列が要る` : null;
}

/**
 * data.json（scripts/progress-data.ts の出力）の形を確かめる。正しければ null、不正なら理由の文字列
 * @param {unknown} data
 * @returns {string | null}
 */
export function validateData(data) {
  if (!isObject(data)) return 'JSON の最上位は object が要る';
  if (typeof data.asOf !== 'string' || !isDay(data.asOf)) return 'asOf は日付で始まる文字列が要る';
  if (!Array.isArray(data.issues)) return 'issues は配列が要る';
  if (!Array.isArray(data.history)) return 'history は配列が要る';
  if (data.sprint === undefined) return 'sprint は null か object が要る（キーが無い）';
  if (data.sprint !== null) {
    const problem = sprintProblem(data.sprint);
    if (problem) return problem;
  }
  for (const issue of data.issues) {
    const problem = issueProblem(issue);
    if (problem) return problem;
  }
  for (const entry of data.history) {
    const problem = historyProblem(entry);
    if (problem) return problem;
  }
  return null;
}

const asList = (/** @type {unknown} */ value) => (Array.isArray(value) ? value : []);
const asText = (/** @type {unknown} */ value) => (typeof value === 'string' ? value : '');

/**
 * features.json を描ける形に整える。areas が配列でなければ null。
 * area.features、feature.issues、notGoals は配列でなければ空にし、object でない項目、番号でない Issue、文字列でない項目は捨てる
 * @param {unknown} raw
 * @returns {Features | null}
 */
export function normalizeFeatures(raw) {
  if (!isObject(raw) || !Array.isArray(raw.areas)) return null;
  const areas = raw.areas.filter(isObject).map((area) => {
    const features = asList(area.features)
      .filter(isObject)
      .map((feature) => ({
        name: asText(feature.name),
        desc: asText(feature.desc),
        issues: asList(feature.issues).filter(Number.isInteger),
        phase: /** @type {Feature['phase']} */ (feature.phase),
      }));
    return {
      id: asText(area.id),
      name: asText(area.name),
      screens: asText(area.screens),
      ...(typeof area.note === 'string' ? { note: area.note } : {}),
      features,
    };
  });
  return { areas, notGoals: asList(raw.notGoals).filter((text) => typeof text === 'string') };
}
