// 開発ボードのページの見せ方を組む純粋な関数（.claude/skills/daily-scrum/page/board.js）。架空の小さなデータで確かめる
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  areasOf,
  backlogTree,
  daysLeft,
  featurePhase,
  featureState,
  incrementView,
  issueUrl,
  periodDays,
  planBar,
  pullUrl,
  sprintColumns,
  viewFromHash,
} from '../.claude/skills/daily-scrum/page/board.js';
import type { BoardIssue, HistoryEntry, SprintView } from './progress-data.ts';

function card(number: number, patch: Partial<BoardIssue> = {}): BoardIssue {
  return {
    number,
    title: `Issue ${number}`,
    level: 'task',
    s: 'todo',
    parent: null,
    children: [],
    pt: 1,
    sprint: null,
    areas: [],
    deps: [],
    waitingOn: [],
    prs: [],
    closeReason: null,
    milestone: null,
    ...patch,
  };
}

const count = (pt: number, n = 0) => ({ pt, count: n });

function sprintOf(patch: Partial<SprintView> = {}): SprintView {
  return {
    n: 2,
    log: 90,
    from: '2026-11-05',
    to: '2026-11-11',
    goal: 'ゴール',
    wipLimit: 3,
    plan: [],
    planned: count(0),
    plannedDone: count(0),
    added: count(0),
    addedDone: count(0),
    withdrawn: count(0),
    accepting: count(0),
    wip: count(0),
    ...patch,
  };
}

describe('viewFromHash', () => {
  test('3つの名前はそのまま', () => {
    assert.equal(viewFromHash('#sprint'), 'sprint');
    assert.equal(viewFromHash('#backlog'), 'backlog');
    assert.equal(viewFromHash('#increment'), 'increment');
  });

  test('空と知らない値は sprint', () => {
    assert.equal(viewFromHash(''), 'sprint');
    assert.equal(viewFromHash('#'), 'sprint');
    assert.equal(viewFromHash('#unknown'), 'sprint');
    assert.equal(viewFromHash('#Sprint'), 'sprint');
  });
});

describe('daysLeft', () => {
  const sprint = { from: '2026-11-05', to: '2026-11-11' };

  test('期間の日数は両端を含む', () => {
    assert.equal(periodDays(sprint), 7);
  });

  test('始まる前は期間の日数', () => {
    assert.equal(daysLeft(sprint, '2026-11-01T09:00:00+09:00'), 7);
  });

  test('初日は期間の日数、途中は今日を含めて数える', () => {
    assert.equal(daysLeft(sprint, '2026-11-05T00:00:00+09:00'), 7);
    assert.equal(daysLeft(sprint, '2026-11-08T23:59:59+09:00'), 4);
  });

  test('最終日は 1', () => {
    assert.equal(daysLeft(sprint, '2026-11-11T23:59:59+09:00'), 1);
  });

  test('過ぎたら 0', () => {
    assert.equal(daysLeft(sprint, '2026-11-12T00:00:00+09:00'), 0);
    assert.equal(daysLeft(sprint, '2027-01-01T00:00:00+09:00'), 0);
  });
});

describe('sprintColumns', () => {
  const issues = [
    card(1, { sprint: 2, s: 'todo', waitingOn: [9] }),
    card(2, { sprint: 2, s: 'todo' }),
    card(3, { sprint: 2, s: 'refining' }),
    card(4, { sprint: 2, s: 'wip' }),
    card(5, { sprint: 2, s: 'review', prs: [50] }),
    card(6, { sprint: 2, s: 'accept' }),
    card(7, { sprint: 2, s: 'done' }),
    card(8, { sprint: 1, s: 'done' }),
    card(9, { sprint: null, s: 'todo' }),
  ];
  const columns = sprintColumns(issues, 2);
  const numbers = (key: string) => columns.find((c) => c.key === key)?.issues.map((i) => i.number);

  test('5つの列が決まった順で並ぶ', () => {
    assert.deepEqual(
      columns.map((c) => c.label),
      ['着手できる', '作業中', 'レビュー中', '受け入れ待ち', '済み'],
    );
  });

  test('待ちは着手できる列の下に置く', () => {
    assert.deepEqual(numbers('todo'), [2, 1]);
  });

  test('refining は wip と同じ作業中の列に入る', () => {
    assert.deepEqual(numbers('wip'), [3, 4]);
  });

  test('review、accept、done はそれぞれの列に入る', () => {
    assert.deepEqual(numbers('review'), [5]);
    assert.deepEqual(numbers('accept'), [6]);
    assert.deepEqual(numbers('done'), [7]);
  });

  test('ほかのスプリントと、スプリントの無い Issue は載せない', () => {
    const all = columns.flatMap((c) => c.issues.map((i) => i.number));
    assert.equal(all.includes(8), false);
    assert.equal(all.includes(9), false);
  });
});

describe('planBar', () => {
  test('計画のうち accept の Issue の pt を重ねる値にする', () => {
    const sprint = sprintOf({
      plan: [
        { number: 1, title: 'a', pt: 3 },
        { number: 2, title: 'b', pt: 5 },
        { number: 3, title: 'c', pt: 2 },
        { number: 4, title: 'd', pt: 1 },
      ],
      planned: count(11, 4),
      plannedDone: count(3, 1),
    });
    const issues = [
      card(1, { s: 'done' }),
      card(2, { s: 'accept' }),
      card(3, { s: 'accept' }),
      // 計画に無い accept は数えない
      card(8, { s: 'accept', pt: 13 }),
    ];
    assert.deepEqual(planBar(sprint, issues), { total: 11, done: 3, accept: 7 });
  });

  test('data に無い計画の行は accept に数えない', () => {
    const sprint = sprintOf({ plan: [{ number: 1, title: 'a', pt: 3 }], planned: count(3, 1) });
    assert.deepEqual(planBar(sprint, []), { total: 3, done: 0, accept: 0 });
  });
});

describe('backlogTree', () => {
  const issues = [
    card(1, { level: 'epic', children: [2, 3], pt: null }),
    card(2, { level: 'story', parent: 1, children: [4, 5, 6], pt: null }),
    card(3, { level: 'story', parent: 1, children: [], pt: 5, areas: ['web'], s: 'todo' }),
    card(4, { parent: 2, pt: 3, areas: ['api'], s: 'done' }),
    card(5, { parent: 2, pt: 2, areas: ['api', 'web'], s: 'todo' }),
    card(6, { parent: 2, pt: null, areas: ['web'], s: 'todo', waitingOn: [5] }),
    card(7, { level: 'story', children: [8], pt: null }),
    card(8, { parent: 7, pt: 4, areas: ['db'], s: 'wip' }),
    card(9, { pt: 1, areas: ['web'], s: 'todo' }),
  ];

  test('エピックの木と、エピックの無いものの束に分ける', () => {
    const tree = backlogTree(issues, { showDone: true });
    assert.deepEqual(
      tree.epics.map((n) => n.issue.number),
      [1],
    );
    assert.deepEqual(
      tree.orphans.map((n) => n.issue.number),
      [7, 9],
    );
    assert.deepEqual(
      tree.epics[0]?.children.map((n) => n.issue.number),
      [2, 3],
    );
    assert.deepEqual(
      tree.epics[0]?.children[0]?.children.map((n) => n.issue.number),
      [4, 5, 6],
    );
  });

  test('親の無いタスクは束に入る', () => {
    const tree = backlogTree(issues, { showDone: true });
    assert.equal(tree.orphans.find((n) => n.issue.number === 9)?.children.length, 0);
  });

  test('合計は葉から出す（pt が null の葉は pt に数えない、着手できる数は todo で待ちの無い葉）', () => {
    const tree = backlogTree(issues, { showDone: true });
    const story = tree.epics[0]?.children[0];
    assert.deepEqual(story?.totals, { remaining: 2, all: 5, ready: 1, leaves: 3 });
    assert.deepEqual(tree.epics[0]?.totals, { remaining: 7, all: 10, ready: 2, leaves: 4 });
    assert.deepEqual(tree.totals, { remaining: 7 + 4 + 1, all: 10 + 4 + 1, ready: 3, leaves: 6 });
  });

  test('既定は済みを隠し、隠した分は合計にも入らない', () => {
    const tree = backlogTree(issues);
    const story = tree.epics[0]?.children[0];
    assert.deepEqual(
      story?.children.map((n) => n.issue.number),
      [5, 6],
    );
    assert.deepEqual(story?.totals, { remaining: 2, all: 2, ready: 1, leaves: 2 });
  });

  test('済みの葉しか無い親は木から外れる', () => {
    const done = [card(1, { level: 'story', children: [2], pt: null }), card(2, { parent: 1, s: 'done' })];
    const tree = backlogTree(done);
    assert.deepEqual(tree.orphans, []);
    assert.deepEqual(tree.totals, { remaining: 0, all: 0, ready: 0, leaves: 0 });
  });

  test('作る場所で絞ると、その場所を持つ葉だけが残る', () => {
    const tree = backlogTree(issues, { area: 'api', showDone: true });
    assert.deepEqual(
      tree.epics[0]?.children.map((n) => n.issue.number),
      [2],
    );
    assert.deepEqual(
      tree.epics[0]?.children[0]?.children.map((n) => n.issue.number),
      [4, 5],
    );
    assert.deepEqual(tree.orphans, []);
    assert.deepEqual(tree.totals, { remaining: 2, all: 5, ready: 1, leaves: 2 });
  });

  test('作る場所と済みの隠しは重ねて効く', () => {
    const tree = backlogTree(issues, { area: 'api' });
    assert.deepEqual(tree.totals, { remaining: 2, all: 2, ready: 1, leaves: 1 });
  });

  test('当たる葉が無い作る場所は空', () => {
    const tree = backlogTree(issues, { area: 'none' });
    assert.deepEqual(tree.epics, []);
    assert.deepEqual(tree.orphans, []);
  });

  test('親が data に無いタスクは束に入る', () => {
    const tree = backlogTree([card(5, { parent: 99 })]);
    assert.deepEqual(
      tree.orphans.map((n) => n.issue.number),
      [5],
    );
  });

  test('data に無い子の番号は飛ばす', () => {
    const tree = backlogTree([card(1, { level: 'story', children: [2, 3], pt: null }), card(2, { parent: 1, pt: 2 })]);
    assert.deepEqual(tree.totals, { remaining: 2, all: 2, ready: 1, leaves: 1 });
  });

  test('作る場所の一覧は重ならず昇順', () => {
    assert.deepEqual(areasOf(issues), ['api', 'db', 'web']);
  });
});

describe('featureState', () => {
  const issues = [
    card(1, { s: 'done' }),
    card(2, { s: 'done' }),
    card(3, { s: 'todo' }),
    card(4, { s: 'wip' }),
    card(5, { s: 'accept' }),
  ];
  const feature = (numbers?: number[]) => ({ name: 'f', desc: 'd', issues: numbers });

  test('Issue が無ければ Issue なし', () => {
    assert.equal(featureState(feature(), issues).key, 'none');
    assert.equal(featureState(feature([]), issues).label, 'Issue なし');
  });

  test('すべて done なら済み', () => {
    assert.deepEqual(featureState(feature([1, 2]), issues), { key: 'done', label: '済み' });
  });

  test('todo 以外が1つでもあれば進行中', () => {
    assert.equal(featureState(feature([1, 3]), issues).label, '進行中');
    assert.equal(featureState(feature([3, 4]), issues).label, '進行中');
    assert.equal(featureState(feature([5]), issues).label, '進行中');
  });

  test('すべて todo なら未着手', () => {
    assert.deepEqual(featureState(feature([3]), issues), { key: 'idle', label: '未着手' });
  });

  test('data に無い番号は todo とみなす', () => {
    assert.equal(featureState(feature([999]), issues).key, 'idle');
    assert.equal(featureState(feature([3, 999]), issues).key, 'idle');
    // done と todo が混ざれば、すべて done ではないので進行中
    assert.equal(featureState(feature([1, 999]), issues).key, 'active');
    assert.equal(featureState(feature([4, 999]), issues).key, 'active');
  });
});

describe('featurePhase', () => {
  test('phase が無ければ first', () => {
    assert.equal(featurePhase({ name: 'f', desc: 'd' }), 'first');
  });

  test('later と open はそのまま', () => {
    assert.equal(featurePhase({ name: 'f', desc: 'd', phase: 'later' }), 'later');
    assert.equal(featurePhase({ name: 'f', desc: 'd', phase: 'open' }), 'open');
  });
});

describe('incrementView', () => {
  const entry = (n: number, planned: number, velocity: number): HistoryEntry => ({
    n,
    log: 100 + n,
    planned: count(planned, 1),
    velocity,
    accepted: [],
  });

  test('history が空でも崩れない', () => {
    assert.deepEqual(incrementView([]), { entries: [], bars: [], max: 0 });
  });

  test('一覧は新しい順、棒は古い順で、同じ目盛り（最大値で割る）', () => {
    const view = incrementView([entry(2, 20, 10), entry(1, 10, 5), entry(3, 15, 15)]);
    assert.deepEqual(
      view.entries.map((e) => e.n),
      [3, 2, 1],
    );
    assert.deepEqual(
      view.bars.map((b) => b.n),
      [1, 2, 3],
    );
    assert.equal(view.max, 20);
    assert.deepEqual(
      view.bars.map((b) => [b.velocityRatio, b.plannedRatio]),
      [
        [0.25, 0.5],
        [0.5, 1],
        [0.75, 0.75],
      ],
    );
  });

  test('すべて 0 なら比も 0（0 で割らない）', () => {
    const view = incrementView([entry(1, 0, 0)]);
    assert.deepEqual(view.bars[0], { n: 1, velocity: 0, planned: 0, velocityRatio: 0, plannedRatio: 0 });
  });

  test('入力の並びを変えない', () => {
    const history = [entry(2, 1, 1), entry(1, 1, 1)];
    incrementView(history);
    assert.deepEqual(
      history.map((h) => h.n),
      [2, 1],
    );
  });
});

describe('リンク', () => {
  test('Issue と PR の URL', () => {
    assert.equal(issueUrl(12), 'https://github.com/ucan-lab/scrum-guild/issues/12');
    assert.equal(pullUrl(34), 'https://github.com/ucan-lab/scrum-guild/pull/34');
  });
});

describe('スプリントが無い JSON', () => {
  test('sprint が null でも、木と履歴は組める', () => {
    const progress = { asOf: '2026-10-29T19:32:11+09:00', sprint: null, issues: [card(1)], history: [] };
    assert.equal(backlogTree(progress.issues).totals.leaves, 1);
    assert.deepEqual(incrementView(progress.history).entries, []);
  });
});
