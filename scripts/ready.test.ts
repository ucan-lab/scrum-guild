// status:ready を付け外しする判定（scripts/ready.ts の readyChanges）
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { type Blocker, type IssueSummary, readyChanges } from './ready.ts';

function issue(number: number, labels: string[], extra: Partial<IssueSummary> = {}): IssueSummary {
  return {
    number,
    labels: labels.map((name) => ({ name })),
    sub_issues_summary: { total: 0 },
    issue_dependencies_summary: { blocked_by: 0 },
    ...extra,
  };
}

function blocker(state: string, labels: string[] = []): Blocker {
  return { state, labels: labels.map((name) => ({ name })) };
}

const NO_BLOCKERS = new Map<number, Blocker[]>();

describe('付ける', () => {
  test('全条件を満たせば付く', () => {
    assert.deepEqual(readyChanges([issue(1, ['pt:3', 'area:docs'])], NO_BLOCKERS), { add: [1], remove: [] });
  });

  test('既に付いていれば add に出ない', () => {
    assert.deepEqual(readyChanges([issue(1, ['pt:3', 'status:ready'])], NO_BLOCKERS), { add: [], remove: [] });
  });

  test('前に要るものが閉じていれば（blocked_by が 0）引かずに付く', () => {
    const blockers = new Map([[1, [blocker('closed')]]]);
    assert.deepEqual(readyChanges([issue(1, ['pt:3'])], blockers), { add: [1], remove: [] });
  });

  test('前に要るものが受け入れ待ちなら付く', () => {
    const target = issue(1, ['pt:3'], { issue_dependencies_summary: { blocked_by: 1 } });
    const blockers = new Map([[1, [blocker('open', ['status:accepting'])]]]);
    assert.deepEqual(readyChanges([target], blockers), { add: [1], remove: [] });
  });

  test('前に要るものが受け入れ待ちと開いたままの両方なら付かない', () => {
    const target = issue(1, ['pt:3'], { issue_dependencies_summary: { blocked_by: 2 } });
    const blockers = new Map([[1, [blocker('open', ['status:accepting']), blocker('open', ['status:in-progress'])]]]);
    assert.deepEqual(readyChanges([target], blockers), { add: [], remove: [] });
  });
});

describe('付かない', () => {
  const cases: [string, IssueSummary][] = [
    ['pt: が無い', issue(1, ['area:docs'])],
    ['pt: が2つ', issue(1, ['pt:2', 'pt:3'])],
    ['status:refining', issue(1, ['pt:3', 'status:refining'])],
    ['status:in-progress', issue(1, ['pt:3', 'status:in-progress'])],
    ['status:accepting', issue(1, ['pt:3', 'status:accepting'])],
    ['epic', issue(1, ['pt:3', 'epic'])],
    ['子を持つストーリー', issue(1, ['pt:3', 'story'], { sub_issues_summary: { total: 2 } })],
    ['sprint-log', issue(1, ['pt:3', 'sprint-log'])],
    ['前に要るものが開いている', issue(1, ['pt:3'], { issue_dependencies_summary: { blocked_by: 1 } })],
  ];

  for (const [name, target] of cases) {
    test(name, () => {
      const blockers = new Map([[1, [blocker('open', ['status:in-progress'])]]]);
      assert.deepEqual(readyChanges([target], blockers), { add: [], remove: [] });
    });
  }
});

describe('外す', () => {
  for (const [name, target] of [
    ['pt: が無くなった', issue(1, ['status:ready'])],
    ['status:in-progress が付いた', issue(1, ['pt:3', 'status:ready', 'status:in-progress'])],
    ['status:accepting が付いた', issue(1, ['pt:3', 'status:ready', 'status:accepting'])],
    ['子を持つようになった', issue(1, ['pt:3', 'status:ready'], { sub_issues_summary: { total: 1 } })],
    ['前に要るものが開いた', issue(1, ['pt:3', 'status:ready'], { issue_dependencies_summary: { blocked_by: 1 } })],
  ] as const) {
    test(`当てはまらなくなった Issue から外れる: ${name}`, () => {
      const blockers = new Map([[1, [blocker('open')]]]);
      assert.deepEqual(readyChanges([target], blockers), { add: [], remove: [1] });
    });
  }
});

describe('判定できないとき', () => {
  test('前に要るものを引けていなければ、付けも外しもしない', () => {
    const blocked = { issue_dependencies_summary: { blocked_by: 1 } };
    assert.deepEqual(
      readyChanges([issue(1, ['pt:3'], blocked), issue(2, ['pt:3', 'status:ready'], blocked)], NO_BLOCKERS),
      { add: [], remove: [] },
    );
  });

  test('前に要るものに関係なく外れると分かる Issue は、引けていなくても外す', () => {
    const target = issue(1, ['pt:3', 'status:ready', 'status:in-progress'], {
      issue_dependencies_summary: { blocked_by: 1 },
    });
    assert.deepEqual(readyChanges([target], NO_BLOCKERS), { add: [], remove: [1] });
  });
});

describe('PR', () => {
  test('PR は付けも外しもしない', () => {
    const pr = issue(1, ['pt:3'], { pull_request: {} });
    const prWithLabel = issue(2, ['status:ready'], { pull_request: {} });
    assert.deepEqual(readyChanges([pr, prWithLabel], NO_BLOCKERS), { add: [], remove: [] });
  });
});

test('複数の Issue を一度に判定する', () => {
  const result = readyChanges(
    [
      issue(1, ['pt:1']),
      issue(2, ['pt:1', 'status:ready']),
      issue(3, ['status:ready']),
      issue(4, ['pt:2', 'status:in-progress']),
    ],
    NO_BLOCKERS,
  );
  assert.deepEqual(result, { add: [1], remove: [3] });
});
