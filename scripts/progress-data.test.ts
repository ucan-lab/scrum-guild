// 開発ボードのデータを組む純粋な関数（scripts/progress-data.ts）。GitHub は読まず、架空の小さな生データで確かめる
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  buildProgress,
  jstIso,
  lookupsFor,
  parseClosing,
  parseSprintLog,
  pullTargets,
  toRawIssue,
  withoutPulls,
  type ApiIssue,
  type BoardIssue,
  type RawBlocker,
  type RawData,
  type RawIssue,
  type RawPull,
} from './progress-data.ts';

const NOW = new Date('2026-10-30T01:02:03Z');

function issue(number: number, patch: Partial<RawIssue> = {}): RawIssue {
  return {
    number,
    title: `Issue ${number}`,
    state: 'open',
    stateReason: null,
    labels: [],
    milestone: null,
    parent: null,
    body: '',
    ...patch,
  };
}

const closed = (number: number, patch: Partial<RawIssue> = {}): RawIssue =>
  issue(number, { state: 'closed', stateReason: 'completed', ...patch });

function pull(number: number, patch: Partial<RawPull> = {}): RawPull {
  return { number, head: `claude/x-${number}`, body: '', ...patch };
}

function raw(patch: Partial<RawData> = {}): RawData {
  return { issues: [], openPulls: [], mergedPulls: [], blockers: {}, subOrder: {}, comments: {}, ...patch };
}

function board(data: Partial<RawData>): BoardIssue[] {
  return buildProgress(raw(data), NOW).issues;
}

function stateOf(data: Partial<RawData>, number: number): string | undefined {
  return board(data).find((item) => item.number === number)?.s;
}

const logBody = (plan: string[], extra = '') =>
  [
    '## ゴール',
    '',
    '開発ボードを GitHub と合わせる',
    '',
    '## 期間',
    '',
    '2026-10-29〜2026-11-04',
    '',
    '## 作業中の上限',
    '',
    '3',
    '',
    '## 計画',
    '',
    '| 番号 | 題 | ポイント |',
    '| --- | --- | --- |',
    ...plan,
    '| 合計 | | 0 |',
    extra,
  ].join('\n');

const sprintLog = (number: number, n: number, plan: string[], patch: Partial<RawIssue> = {}): RawIssue =>
  issue(number, {
    title: `スプリント ${n}（2026-10-29〜2026-11-04）`,
    labels: ['sprint-log'],
    body: logBody(plan),
    ...patch,
  });

describe('状態の読み方', () => {
  test('閉じた Issue は done', () => {
    assert.equal(stateOf({ issues: [closed(1)] }, 1), 'done');
  });

  test('status:accepting は、開いた PR があっても accept', () => {
    const data = {
      issues: [issue(1, { labels: ['status:accepting', 'status:in-progress'] })],
      openPulls: [pull(9, { head: '1-x' })],
    };
    assert.equal(stateOf(data, 1), 'accept');
  });

  test('開いた PR は、ブランチ名の番号の先頭で review', () => {
    assert.equal(stateOf({ issues: [issue(1)], openPulls: [pull(9, { head: '1-add-x' })] }, 1), 'review');
  });

  test('開いた PR は、本文の Refs と Closes と Fixes で review', () => {
    for (const word of ['Refs', 'Closes', 'Fixes', 'closes']) {
      assert.equal(stateOf({ issues: [issue(1)], openPulls: [pull(9, { body: `${word} #1` })] }, 1), 'review', word);
    }
  });

  test('ブランチ名の番号が先頭でないか、番号が別なら review にしない', () => {
    const data = { issues: [issue(1), issue(2)], openPulls: [pull(9, { head: 'fix-1-x', body: 'Refs #2' })] };
    assert.equal(stateOf(data, 1), 'todo');
    assert.equal(stateOf(data, 2), 'review');
  });

  test('PR が付いた Issue の prs に開いた PR の番号が入る', () => {
    const data = { issues: [issue(1)], openPulls: [pull(12, { head: '1-x' }), pull(9, { body: 'Refs #1' })] };
    assert.deepEqual(board(data)[0]?.prs, [9, 12]);
  });

  test('status:in-progress は wip で、PR があれば review', () => {
    const issues = [issue(1, { labels: ['status:in-progress'] })];
    assert.equal(stateOf({ issues }, 1), 'wip');
    assert.equal(stateOf({ issues, openPulls: [pull(9, { head: '1-x' })] }, 1), 'review');
  });

  test('status:in-progress と status:refining が両方あれば wip', () => {
    assert.equal(stateOf({ issues: [issue(1, { labels: ['status:refining', 'status:in-progress'] })] }, 1), 'wip');
  });

  test('status:refining は refining', () => {
    assert.equal(stateOf({ issues: [issue(1, { labels: ['status:refining'] })] }, 1), 'refining');
  });

  test('どれでもなければ todo', () => {
    assert.equal(stateOf({ issues: [issue(1, { labels: ['area:ui'] })] }, 1), 'todo');
  });

  test('子を持つストーリーは、子がすべて done か accept のとき accept', () => {
    const issues = [
      issue(1, { labels: ['story'] }),
      closed(2, { parent: 1 }),
      issue(3, { parent: 1, labels: ['status:accepting'] }),
    ];
    assert.equal(stateOf({ issues }, 1), 'accept');
  });

  test('子に todo や wip があれば親は accept にならない', () => {
    for (const labels of [[], ['status:in-progress']]) {
      const issues = [issue(1, { labels: ['story'] }), closed(2, { parent: 1 }), issue(3, { parent: 1, labels })];
      assert.equal(stateOf({ issues }, 1), 'todo');
    }
  });

  test('子を持つ子にも同じ判定を当て、エピックまで届く', () => {
    const issues = [
      issue(1, { labels: ['epic'] }),
      issue(2, { labels: ['story'], parent: 1 }),
      issue(3, { parent: 2, labels: ['status:accepting'] }),
    ];
    assert.equal(stateOf({ issues }, 2), 'accept');
    assert.equal(stateOf({ issues }, 1), 'accept');
    const pending = [...issues.slice(0, 2), issue(3, { parent: 2 })];
    assert.equal(stateOf({ issues: pending }, 1), 'todo');
  });

  test('子を持つタスクは、子がすべて done か accept でも accept にせず、通常の読み方にする', () => {
    const issues = [issue(1), closed(2, { parent: 1 })];
    assert.equal(stateOf({ issues }, 1), 'todo');
    assert.equal(stateOf({ issues, openPulls: [pull(9, { head: '1-x' })] }, 1), 'review');
    assert.equal(
      stateOf({ issues: [issue(1, { labels: ['status:in-progress'] }), closed(2, { parent: 1 })] }, 1),
      'wip',
    );
  });

  test('親の子がすべて not_planned で閉じていても、子を持つとみなして accept にする', () => {
    const issues = [issue(1, { labels: ['story'] }), closed(2, { parent: 1, stateReason: 'not_planned' })];
    const found = board({ issues });
    assert.equal(found[0]?.s, 'accept');
    assert.deepEqual(found[0]?.children, []);
  });
});

describe('issues の中身', () => {
  test('not_planned と duplicate で閉じた Issue を外し、completed は残す', () => {
    const issues = [
      closed(1, { stateReason: 'not_planned' }),
      closed(2, { stateReason: 'duplicate' }),
      closed(3),
      issue(4),
    ];
    assert.deepEqual(
      board({ issues }).map((item) => item.number),
      [3, 4],
    );
    assert.equal(board({ issues })[0]?.closeReason, 'completed');
  });

  test('外した子は親の children に入れない', () => {
    const issues = [
      issue(1, { labels: ['story'] }),
      issue(2, { parent: 1 }),
      closed(3, { parent: 1, stateReason: 'not_planned' }),
    ];
    assert.deepEqual(board({ issues })[0]?.children, [2]);
  });

  test('sprint-log の Issue は issues に入らない', () => {
    const issues = [
      sprintLog(9, 1, []),
      closed(8, { labels: ['sprint-log'], title: 'スプリント 0（2026-10-22〜2026-10-28）' }),
      issue(1),
    ];
    assert.deepEqual(
      board({ issues }).map((item) => item.number),
      [1],
    );
  });

  test('階層はラベルで決め、子は親のサブ Issue の並びにする', () => {
    const issues = [
      issue(1, { labels: ['epic'] }),
      issue(2, { labels: ['story'], parent: 1 }),
      issue(3, { parent: 2 }),
      issue(4, { parent: 2 }),
      issue(5, { parent: 2 }),
    ];
    const found = board({ issues, subOrder: { 2: [5, 3] } });
    assert.deepEqual(
      found.map((item) => item.level),
      ['epic', 'story', 'task', 'task', 'task'],
    );
    assert.deepEqual(found[1]?.children, [5, 3, 4]);
    assert.equal(found[2]?.parent, 2);
    assert.deepEqual(found[0]?.children, [2]);
  });

  test('ポイントは pt: のラベルで、無ければ null', () => {
    const found = board({ issues: [issue(1, { labels: ['pt:5'] }), issue(2)] });
    assert.equal(found[0]?.pt, 5);
    assert.equal(found[1]?.pt, null);
  });

  test('子を持つストーリーにポイントを数えない', () => {
    const issues = [issue(1, { labels: ['story', 'pt:8'] }), issue(2, { parent: 1, labels: ['pt:3'] })];
    const found = board({ issues });
    assert.equal(found[0]?.pt, null);
    assert.equal(found[1]?.pt, 3);
  });

  test('スプリントは付いた最大の番号、領域は area: の後ろ、マイルストーンは題', () => {
    const found = board({
      issues: [issue(1, { labels: ['sprint:1', 'sprint:2', 'area:ui', 'area:infra', 'bug'], milestone: '初版' })],
    });
    assert.equal(found[0]?.sprint, 2);
    assert.deepEqual(found[0]?.areas, ['ui', 'infra']);
    assert.equal(found[0]?.milestone, '初版');
  });
});

describe('前に要るもの', () => {
  const blocker = (number: number, patch: Partial<RawBlocker> = {}): RawBlocker => ({
    number,
    state: 'open',
    labels: [],
    ...patch,
  });

  test('受け入れ待ちの前に要るものは、deps に残して waitingOn に数えない', () => {
    const data = {
      issues: [issue(1)],
      blockers: {
        1: [blocker(5, { labels: ['status:accepting'] }), blocker(3), blocker(4, { state: 'closed' as const })],
      },
    };
    const found = board(data)[0];
    assert.deepEqual(found?.deps, [3, 4, 5]);
    assert.deepEqual(found?.waitingOn, [3]);
  });

  test('前に要るものがすべて受け入れ待ちか閉じていれば waitingOn は空', () => {
    const data = { issues: [issue(1)], blockers: { 1: [blocker(5, { labels: ['status:accepting'] })] } };
    assert.deepEqual(board(data)[0]?.waitingOn, []);
  });

  test('閉じた Issue と、引いていない Issue の deps は空', () => {
    const data = { issues: [closed(1), issue(2)], blockers: { 1: [blocker(5)] } };
    assert.deepEqual(board(data)[0]?.deps, []);
    assert.deepEqual(board(data)[1]?.deps, []);
  });
});

describe('記録の Issue の読み方', () => {
  test('題から番号と期間、本文からゴール、期間、上限、計画の表を読む', () => {
    const body = logBody(['| #12 | 画面を足す | 3 |', '| #13 | 表の \\| を直す | 5 |']);
    const parsed = parseSprintLog('スプリント 2（2026-11-05〜2026-11-11）', body);
    assert.equal(parsed.n, 2);
    assert.equal(parsed.from, '2026-10-29');
    assert.equal(parsed.to, '2026-11-04');
    assert.equal(parsed.goal, '開発ボードを GitHub と合わせる');
    assert.equal(parsed.wipLimit, 3);
    assert.deepEqual(parsed.plan, [
      { number: 12, title: '画面を足す', pt: 3 },
      { number: 13, title: '表の | を直す', pt: 5 },
    ]);
  });

  test('改行が CRLF の本文も読み、本文に期間やゴールが無ければ題の期間を使い、上限と計画は無しになる', () => {
    const parsed = parseSprintLog('スプリント 3（2026-11-12〜2026-11-18）', '## 計画\r\n\r\n| #1 | a | 2 |\r\n');
    assert.deepEqual(parsed.plan, [{ number: 1, title: 'a', pt: 2 }]);
    assert.equal(parsed.from, '2026-11-12');
    assert.equal(parsed.goal, null);
    assert.equal(parsed.wipLimit, null);
  });

  test('題を読めなければ止まる', () => {
    assert.throws(() => parseSprintLog('スプリントの記録', ''), /題を読めない/);
  });

  test('開いた記録が無ければ sprint は null', () => {
    const data = {
      issues: [closed(1, { labels: ['sprint-log'], title: 'スプリント 1（2026-10-22〜2026-10-28）' }), issue(2)],
    };
    assert.equal(buildProgress(raw(data), NOW).sprint, null);
  });

  test('開いた記録が2つなら番号の大きいほうを今のスプリントにする', () => {
    const data = { issues: [sprintLog(20, 2, []), sprintLog(10, 1, [])] };
    assert.equal(buildProgress(raw(data), NOW).sprint?.n, 2);
    assert.equal(buildProgress(raw({ issues: data.issues.toReversed() }), NOW).sprint?.log, 20);
  });
});

describe('スプリントの数', () => {
  const planned = [
    '| #1 | 済み | 3 |',
    '| #2 | 受け入れ待ち | 2 |',
    '| #3 | 作業中 | 5 |',
    '| #4 | ラベルを外した | 1 |',
    '| #5 | 対応しない | 2 |',
    '| #6 | 計画の済み（ポイントを後で変えた） | 3 |',
  ];

  function sprintOf(extra: RawIssue[] = [], patch: Partial<RawData> = {}) {
    const issues = [
      sprintLog(100, 1, planned),
      closed(1, { labels: ['sprint:1', 'pt:3'] }),
      issue(2, { labels: ['sprint:1', 'pt:2', 'status:accepting'] }),
      issue(3, { labels: ['sprint:1', 'pt:5', 'status:in-progress'] }),
      issue(4, { labels: ['pt:1'] }),
      closed(5, { labels: ['sprint:1', 'pt:2'], stateReason: 'not_planned' }),
      closed(6, { labels: ['sprint:1', 'pt:8'] }),
      ...extra,
    ];
    const sprint = buildProgress(raw({ issues, ...patch }), NOW).sprint;
    assert.ok(sprint);
    return sprint;
  }

  test('計画は記録の表の合計と件数で、計画の済みは受け入れで閉じたもの（ポイントは、ラベルが変わっても表の値）', () => {
    const sprint = sprintOf();
    assert.deepEqual(sprint.planned, { pt: 16, count: 6 });
    assert.deepEqual(sprint.plannedDone, { pt: 6, count: 2 });
  });

  test('ラベルを外した Issue と not_planned で閉じた Issue を取り下げに数える', () => {
    assert.deepEqual(sprintOf().withdrawn, { pt: 3, count: 2 });
  });

  test('受け入れで閉じたものは、sprint のラベルが無くても取り下げに数えない', () => {
    const without = buildProgress(
      raw({ issues: [sprintLog(100, 1, ['| #1 | a | 3 |']), closed(1, { labels: ['pt:3'] })] }),
      NOW,
    ).sprint;
    assert.deepEqual(without?.withdrawn, { pt: 0, count: 0 });
    assert.deepEqual(without?.plannedDone, { pt: 3, count: 1 });
  });

  test('途中で足した分は、計画に無い sprint のラベル付きで、その済みは受け入れで閉じたもの', () => {
    const sprint = sprintOf([
      issue(7, { labels: ['sprint:1', 'pt:2'] }),
      closed(8, { labels: ['sprint:1', 'pt:3'] }),
      closed(9, { labels: ['sprint:1', 'pt:5'], stateReason: 'not_planned' }),
      issue(10, { labels: ['sprint:2', 'pt:5'] }),
    ]);
    // not_planned で閉じた #9 も、計画に無い sprint のラベル付きなので数える（済みには入れない）
    assert.deepEqual(sprint.added, { pt: 10, count: 3 });
    assert.deepEqual(sprint.addedDone, { pt: 3, count: 1 });
  });

  test('duplicate で閉じた途中で足した分も added に数え、addedDone には数えない', () => {
    const sprint = sprintOf([closed(7, { labels: ['sprint:1', 'pt:2'], stateReason: 'duplicate' })]);
    assert.deepEqual(sprint.added, { pt: 2, count: 1 });
    assert.deepEqual(sprint.addedDone, { pt: 0, count: 0 });
  });

  test('計画の表に同じ番号が2行あっても、二重に数えない', () => {
    const sprint = buildProgress(
      raw({
        issues: [
          sprintLog(100, 1, ['| #1 | a | 3 |', '| #2 | b | 2 |', '| #1 | a | 3 |']),
          closed(1, { labels: ['sprint:1'] }),
        ],
      }),
      NOW,
    ).sprint;
    assert.deepEqual(sprint?.plan, [
      { number: 1, title: 'a', pt: 3 },
      { number: 2, title: 'b', pt: 2 },
    ]);
    assert.deepEqual(sprint?.planned, { pt: 5, count: 2 });
    assert.deepEqual(sprint?.plannedDone, { pt: 3, count: 1 });
  });

  test('受け入れ待ちは、sprint のラベル付きで開いていて status:accepting のあるもの', () => {
    const sprint = sprintOf([
      issue(7, { labels: ['sprint:1', 'pt:3', 'status:accepting'] }),
      issue(8, { labels: ['pt:1', 'status:accepting'] }),
    ]);
    assert.deepEqual(sprint.accepting, { pt: 5, count: 2 });
  });

  test('作業中は、スプリントの外も含め、in-progress か開いた PR があって accepting の無いもの', () => {
    const sprint = sprintOf(
      [
        issue(7, { labels: ['pt:2', 'status:in-progress'] }),
        issue(8, { labels: ['pt:3'] }),
        issue(9, { labels: ['pt:1', 'status:in-progress', 'status:accepting'] }),
        issue(11, { labels: ['sprint:1', 'pt:1'] }),
      ],
      { openPulls: [pull(50, { head: '8-x' }), pull(51, { head: '11-x' })] },
    );
    // #3（計画の 5）、#7（2）、#8（3）、#11（途中で足した分の 1）
    assert.deepEqual(sprint.wip, { pt: 11, count: 4 });
    assert.equal(sprint.wipLimit, 3);
  });

  test('番号、期間、ゴール、計画の一覧を持つ', () => {
    const sprint = sprintOf();
    assert.equal(sprint.n, 1);
    assert.equal(sprint.log, 100);
    assert.equal(sprint.from, '2026-10-29');
    assert.equal(sprint.to, '2026-11-04');
    assert.equal(sprint.goal, '開発ボードを GitHub と合わせる');
    assert.equal(sprint.plan.length, 6);
  });
});

describe('履歴', () => {
  const closing = (planned: string, velocity: string) =>
    [
      '## 締め（2026-11-04）',
      '',
      '| 数 | ポイント | 件数 |',
      '| --- | --- | --- |',
      `| 計画 | ${planned} |`,
      '| 計画の済み | 10 | 3 |',
      '',
      `ベロシティ: ${velocity}`,
      '持ち越し先: スプリント 2（#7）',
    ].join('\n');

  test('締めのコメントの「計画」の行と「ベロシティ:」の行を読む', () => {
    assert.deepEqual(parseClosing(closing('17 | 5', '12')), { planned: { pt: 17, count: 5 }, velocity: 12 });
    assert.equal(parseClosing('ベロシティ: 3'), null);
  });

  test('締めのコメントの無い記録は飛ばし、あるものは番号の昇順に並べる', () => {
    const issues = [
      closed(30, { labels: ['sprint-log'], title: 'スプリント 3（2026-11-12〜2026-11-18）' }),
      closed(10, { labels: ['sprint-log'], title: 'スプリント 1（2026-10-22〜2026-10-28）' }),
      closed(20, { labels: ['sprint-log'], title: 'スプリント 2（2026-10-29〜2026-11-04）' }),
      sprintLog(40, 4, []),
    ];
    const comments = {
      10: ['雑談', closing('8 | 3', '6')],
      20: ['進み具合のメモ'],
      30: [closing('10 | 4', '9')],
      40: [closing('1 | 1', '1')],
    };
    const history = buildProgress(raw({ issues, comments }), NOW).history;
    assert.deepEqual(
      history.map(({ n, log, planned, velocity }) => ({ n, log, planned, velocity })),
      [
        { n: 1, log: 10, planned: { pt: 8, count: 3 }, velocity: 6 },
        { n: 3, log: 30, planned: { pt: 10, count: 4 }, velocity: 9 },
      ],
    );
  });

  test('読めない締めのコメントの記録は、止まらずに履歴から飛ばし、記録の番号を添えた警告を返す', () => {
    const issues = [
      closed(10, { labels: ['sprint-log'], title: 'スプリント 1（2026-10-22〜2026-10-28）' }),
      closed(20, { labels: ['sprint-log'], title: 'スプリント 2（2026-10-29〜2026-11-04）' }),
    ];
    const built = buildProgress(
      raw({ issues, comments: { 10: ['## 締め\n\n数が無い'], 20: [closing('8 | 3', '6')] } }),
      NOW,
    );
    assert.deepEqual(
      built.history.map((entry) => entry.log),
      [20],
    );
    assert.equal(built.warnings.length, 1);
    assert.match(built.warnings[0] ?? '', /#10/);
  });

  test('題を読めない閉じた記録も、締めのコメントがあれば警告して飛ばし、無ければ黙って飛ばす', () => {
    const issues = [
      closed(10, { labels: ['sprint-log'], title: '記録' }),
      closed(11, { labels: ['sprint-log'], title: '記録 2' }),
    ];
    const built = buildProgress(raw({ issues, comments: { 10: [closing('8 | 3', '6')] } }), NOW);
    assert.deepEqual(built.history, []);
    assert.equal(built.warnings.length, 1);
    assert.match(built.warnings[0] ?? '', /#10/);
  });

  test('警告が無ければ warnings は空', () => {
    assert.deepEqual(buildProgress(raw(), NOW).warnings, []);
  });

  test('受け入れで閉じた Issue と、そのマージ済みの PR を当てる', () => {
    const issues = [
      closed(10, { labels: ['sprint-log'], title: 'スプリント 1（2026-10-22〜2026-10-28）' }),
      closed(2, { labels: ['sprint:1'] }),
      closed(1, { labels: ['sprint:1'] }),
      closed(3, { labels: ['sprint:1'] }),
      closed(4, { labels: ['sprint:1'], stateReason: 'not_planned' }),
      issue(5, { labels: ['sprint:1', 'status:accepting'] }),
      closed(6, { labels: ['sprint:2'] }),
    ];
    const mergedPulls = [
      pull(70, { head: '1-a' }),
      pull(71, { head: 'claude/b', body: 'Refs #1\nRefs #2' }),
      pull(72, { head: '6-x' }),
    ];
    const history = buildProgress(raw({ issues, mergedPulls, comments: { 10: [closing('8 | 3', '6')] } }), NOW).history;
    assert.deepEqual(history[0]?.accepted, [
      { number: 1, prs: [70, 71] },
      { number: 2, prs: [71] },
      { number: 3, prs: [] },
    ]);
  });
});

describe('PR の当て方', () => {
  test('ブランチ名の番号と本文の参照を、重ねずに拾う', () => {
    assert.deepEqual(
      pullTargets(pull(1, { head: '12-x', body: 'Refs #12\nCloses #13\nfixes #14\nRefs #12' })).toSorted(),
      [12, 13, 14],
    );
  });

  test('閉じる語でない言及は拾わない', () => {
    assert.deepEqual(pullTargets(pull(1, { head: 'claude/x', body: 'see #12, related to #13' })), []);
  });
});

describe('作った日時', () => {
  test('asOf は日本時間で +09:00 が付く', () => {
    assert.equal(jstIso(new Date('2026-10-30T01:02:03Z')), '2026-10-30T10:02:03+09:00');
    assert.equal(jstIso(new Date('2026-10-29T16:00:00Z')), '2026-10-30T01:00:00+09:00');
    assert.equal(buildProgress(raw(), NOW).asOf, '2026-10-30T10:02:03+09:00');
  });
});

describe('本文を出力に入れない', () => {
  test('Issue、記録、PR、コメントの本文の目印が JSON に出ない', () => {
    const marker = 'MARKER-BODY-SHOULD-NOT-LEAK';
    const data = raw({
      issues: [
        issue(1, { body: `${marker} issue` }),
        closed(2, { body: `${marker} closed`, labels: ['sprint:1'] }),
        // 記録の本文はゴールと計画の表だけを読み、ほかの行は出さない
        sprintLog(100, 1, ['| #1 | a | 3 |'], { body: `${logBody(['| #1 | a | 3 |'])}\n\n## メモ\n\n${marker} log` }),
        closed(200, { labels: ['sprint-log'], title: 'スプリント 0（2026-10-22〜2026-10-28）' }),
      ],
      openPulls: [pull(9, { head: '1-x', body: `${marker} open pull\nRefs #1` })],
      mergedPulls: [pull(8, { head: '2-x', body: `${marker} merged pull\nRefs #2` })],
      comments: { 200: [`## 締め（2026-10-28）\n\n| 計画 | 3 | 1 |\n\nベロシティ: 3\n${marker} comment`] },
    });
    const { warnings, ...progress } = buildProgress(data, NOW);
    assert.deepEqual(warnings, []);
    const json = JSON.stringify(progress);
    assert.equal(json.includes(marker), false);
    // 目印が消えただけで中身まで消えていないことも確かめる
    assert.equal(progress.issues.find((item) => item.number === 1)?.prs[0], 9);
    assert.deepEqual(progress.history[0]?.planned, { pt: 3, count: 1 });
  });
});

describe('GitHub の値の変換', () => {
  const api = (number: number, patch: Partial<ApiIssue> = {}): ApiIssue => ({
    number,
    title: `Issue ${number}`,
    state: 'open',
    state_reason: null,
    labels: [],
    milestone: null,
    body: null,
    ...patch,
  });

  test('toRawIssue は parent_issue_url の末尾から親の番号を取り、ラベル名、マイルストーンの題、本文の既定を変換する', () => {
    const converted = toRawIssue(
      api(5, {
        state: 'closed',
        state_reason: 'completed',
        labels: [{ name: 'story' }, { name: 'area:ui' }],
        milestone: { title: '初版' },
        parent_issue_url: 'https://api.github.com/repos/example/guild/issues/42',
        body: '本文',
      }),
    );
    assert.deepEqual(converted, {
      number: 5,
      title: 'Issue 5',
      state: 'closed',
      stateReason: 'completed',
      labels: ['story', 'area:ui'],
      milestone: '初版',
      parent: 42,
      body: '本文',
    });
    assert.equal(toRawIssue(api(6)).parent, null);
    assert.equal(toRawIssue(api(6, { parent_issue_url: null })).parent, null);
    assert.equal(toRawIssue(api(6)).body, '');
    assert.equal(toRawIssue(api(6)).milestone, null);
  });

  test('withoutPulls は pull_request を持つものを外す', () => {
    const found = withoutPulls([api(1), api(2, { pull_request: { url: 'https://example.invalid/pulls/2' } }), api(3)]);
    assert.deepEqual(
      found.map((item) => item.number),
      [1, 3],
    );
  });

  test('前に要るものは、total_blocked_by が 0 でない開いた Issue で引く（前提がすべて閉じていても）', () => {
    const summary = (blockedBy: number, total: number) => ({ blocked_by: blockedBy, total_blocked_by: total });
    // blocked_by（開いた前提の数）は 0 でも、閉じた前提があれば引いて deps に残す
    assert.equal(lookupsFor(api(1, { issue_dependencies_summary: summary(0, 2) })).blockers, true);
    assert.equal(lookupsFor(api(1, { issue_dependencies_summary: summary(1, 1) })).blockers, true);
    assert.equal(lookupsFor(api(1, { issue_dependencies_summary: summary(0, 0) })).blockers, false);
    assert.equal(lookupsFor(api(1)).blockers, false);
    // 閉じた Issue の deps は持たない
    assert.equal(lookupsFor(api(1, { state: 'closed', issue_dependencies_summary: summary(0, 2) })).blockers, false);
  });

  test('sub_issues は sub_issues_summary.total が 0 でない Issue で引く', () => {
    assert.equal(lookupsFor(api(1, { sub_issues_summary: { total: 3 } })).subIssues, true);
    assert.equal(lookupsFor(api(1, { state: 'closed', sub_issues_summary: { total: 3 } })).subIssues, true);
    assert.equal(lookupsFor(api(1, { sub_issues_summary: { total: 0 } })).subIssues, false);
    assert.equal(lookupsFor(api(1)).subIssues, false);
  });

  test('記録の Issue は、閉じたものだけコメントを引き、前に要るものとサブ Issue は引かない', () => {
    const log = (state: 'open' | 'closed') =>
      api(9, {
        state,
        labels: [{ name: 'sprint-log' }],
        issue_dependencies_summary: { blocked_by: 1, total_blocked_by: 1 },
        sub_issues_summary: { total: 1 },
      });
    assert.deepEqual(lookupsFor(log('closed')), { comments: true, blockers: false, subIssues: false });
    assert.deepEqual(lookupsFor(log('open')), { comments: false, blockers: false, subIssues: false });
    assert.equal(lookupsFor(api(1)).comments, false);
  });
});

describe('コマンドの引数', () => {
  test('出力のパスが無ければ、使い方を stderr に出して終了コード 1 になる（gh は呼ばない）', () => {
    const script = fileURLToPath(new URL('./progress-data.ts', import.meta.url));
    const result = spawnSync(process.execPath, [script], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /使い方: node scripts\/progress-data\.ts <出力のパス>/);
    assert.equal(result.stdout, '');
  });
});
