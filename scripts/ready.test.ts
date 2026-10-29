// status:ready を付け外しする判定（scripts/ready.ts の readyChanges）
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { type Blocker, type IssueSummary, issuesWithOpenPr, readyChanges } from './ready.ts';

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

  test('blocked_by が 0 なら前に要るものの一覧を見ずに付く', () => {
    // blocked_by は開いている前に要るものの数なので、0 なら一覧に何があっても待ちは無い
    const blockers = new Map([[1, [blocker('open')]]]);
    assert.deepEqual(readyChanges([issue(1, ['pt:3'])], blockers), { add: [1], remove: [] });
  });

  test('summary が null でも、子も待ちも無いとみなして付く', () => {
    const target = issue(1, ['pt:3'], { sub_issues_summary: null, issue_dependencies_summary: null });
    assert.deepEqual(readyChanges([target], NO_BLOCKERS), { add: [1], remove: [] });
  });

  test('親の前に要るものが受け入れ待ちだけなら付く', () => {
    const parent = issue(10, ['story'], {
      sub_issues_summary: { total: 1 },
      issue_dependencies_summary: { blocked_by: 1 },
    });
    const blockers = new Map([[10, [blocker('open', ['status:accepting'])]]]);
    assert.deepEqual(readyChanges([parent, issue(1, ['pt:3'], { parent: 10 })], blockers), { add: [1], remove: [] });
  });

  test('親が一覧に無い（閉じている）ときは、親の待ちを見ずに付く', () => {
    assert.deepEqual(readyChanges([issue(1, ['pt:3'], { parent: 99 })], NO_BLOCKERS), { add: [1], remove: [] });
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
  const openWithoutLabels = issue(1, ['pt:3'], { issue_dependencies_summary: { blocked_by: 1 } });

  test('前に要るものがラベルの無いまま開いている', () => {
    const blockers = new Map([[1, [blocker('open')]]]);
    assert.deepEqual(readyChanges([openWithoutLabels], blockers), { add: [], remove: [] });
  });

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
    ['status:refining が付いた', issue(1, ['pt:3', 'status:ready', 'status:refining'])],
    ['epic になった', issue(1, ['pt:3', 'status:ready', 'epic'])],
    ['sprint-log になった', issue(1, ['pt:3', 'status:ready', 'sprint-log'])],
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

  test('引けた前に要るもののうち開いたものが blocked_by より少なければ、付けも外しもしない', () => {
    // 引く間に閉じたか、トークンで見えない前に要るもの（別のリポジトリ）がある。一部だけで判定しない
    const blocked = { issue_dependencies_summary: { blocked_by: 2 } };
    const blockers = new Map([
      [1, [blocker('open', ['status:accepting'])]],
      [2, []],
    ]);
    assert.deepEqual(
      readyChanges([issue(1, ['pt:3'], blocked), issue(2, ['pt:3', 'status:ready'], blocked)], blockers),
      { add: [], remove: [] },
    );
  });

  test('親の前に要るものを引けていなければ、付けも外しもしない', () => {
    const parent = issue(10, ['story'], {
      sub_issues_summary: { total: 2 },
      issue_dependencies_summary: { blocked_by: 1 },
    });
    assert.deepEqual(
      readyChanges(
        [parent, issue(1, ['pt:3'], { parent: 10 }), issue(2, ['pt:3', 'status:ready'], { parent: 10 })],
        NO_BLOCKERS,
      ),
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

describe('親の待ち', () => {
  const blockedParent = (number: number, parent?: number) =>
    issue(number, ['story'], {
      sub_issues_summary: { total: 1 },
      issue_dependencies_summary: { blocked_by: 1 },
      ...(parent === undefined ? {} : { parent }),
    });
  const waiting = (n: number) => [n, [blocker('open', ['status:in-progress'])]] as const;

  test('親のストーリーが開いた前に要るものを待っていれば付かない', () => {
    const blockers = new Map([waiting(10)]);
    assert.deepEqual(readyChanges([blockedParent(10), issue(1, ['pt:3'], { parent: 10 })], blockers), {
      add: [],
      remove: [],
    });
  });

  test('祖先（親の親）が待っていても付かず、付いていれば外れる', () => {
    const middle = issue(10, ['story'], { sub_issues_summary: { total: 2 }, parent: 20 });
    const blockers = new Map([waiting(20)]);
    assert.deepEqual(
      readyChanges(
        [
          blockedParent(20),
          middle,
          issue(1, ['pt:3'], { parent: 10 }),
          issue(2, ['pt:3', 'status:ready'], { parent: 10 }),
        ],
        blockers,
      ),
      { add: [], remove: [2] },
    );
  });

  test('親のつながりが輪になっていても止まる', () => {
    const a = issue(10, ['story'], { sub_issues_summary: { total: 1 }, parent: 11 });
    const b = issue(11, ['story'], { sub_issues_summary: { total: 1 }, parent: 10 });
    assert.deepEqual(readyChanges([a, b, issue(1, ['pt:3'], { parent: 10 })], NO_BLOCKERS), { add: [1], remove: [] });
  });
});

describe('開いた PR', () => {
  test('開いた PR が指す Issue には付かず、付いていれば外れる', () => {
    assert.deepEqual(
      readyChanges(
        [issue(1, ['pt:3']), issue(2, ['pt:3', 'status:ready']), issue(3, ['pt:3'])],
        NO_BLOCKERS,
        new Set([1, 2]),
      ),
      { add: [3], remove: [2] },
    );
  });
});

describe('issuesWithOpenPr', () => {
  test('ブランチ名の先頭の番号と、本文の Refs、Closes、Fixes を拾う', () => {
    const numbers = issuesWithOpenPr([
      { head: '476-status-ready', body: null, sameRepo: true },
      { head: 'claude/x', body: '説明\n\nRefs #12\ncloses #13 と FIXES #14', sameRepo: true },
    ]);
    assert.deepEqual(
      [...numbers].sort((a, b) => a - b),
      [12, 13, 14, 476],
    );
  });

  test('語の途中に現れた閉じる語（prefixes、hrefs）は拾わない', () => {
    assert.deepEqual([...issuesWithOpenPr([{ head: 'x', body: 'prefixes #12 と hrefs #13', sameRepo: true }])], []);
  });

  test('番号の無いブランチ名と、閉じる語の無い番号は拾わない', () => {
    assert.deepEqual([...issuesWithOpenPr([{ head: 'feature-476', body: '#15 を見た', sameRepo: true }])], []);
  });

  test('fork の PR は拾わない（外の人がブランチ名と本文で関係の無い Issue のラベルを外せないように）', () => {
    assert.deepEqual([...issuesWithOpenPr([{ head: '476-x', body: 'Refs #12', sameRepo: false }])], []);
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
