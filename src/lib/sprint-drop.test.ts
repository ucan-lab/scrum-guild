import { describe, expect, test } from 'vitest';
import type { SprintBoardColumn, SprintBoardTask } from '../shared/operations/sprint/index.ts';
import { gapAbove, isGrabbable, resolveSprintDrop, type SprintDropTarget } from './sprint-drop.ts';

function card(id: string, extra: Partial<SprintBoardTask> = {}): SprintBoardTask {
  return {
    id,
    title: id,
    points: null,
    assignee: null,
    completed_at: null,
    reopenable: false,
    story: null,
    due_on: null,
    repository: null,
    ...extra,
  };
}

const completed = (id: string, reopenable: boolean) =>
  card(id, { completed_at: '2026-10-20T00:00:00.000Z', reopenable });

const columns: SprintBoardColumn[] = [
  { id: 'c1', name: '出発前', is_done: false, tasks: [card('a'), card('b'), card('c')] },
  { id: 'c2', name: '遂行中', is_done: false, tasks: [card('d')] },
  { id: 'c3', name: '査定中', is_done: false, tasks: [] },
  { id: 'done', name: null, is_done: true, tasks: [completed('z', true), completed('y', true), completed('x', false)] },
];

const onCard = (id: string): SprintDropTarget => ({ kind: 'card', id });
const onColumn = (id: string): SprintDropTarget => ({ kind: 'column', id });
const ids = (list: readonly SprintBoardColumn[]) => list.map((column) => column.tasks.map((task) => task.id));

describe('gapAbove', () => {
  const boxes = [
    { id: 'a', top: 100, bottom: 160 },
    { id: 'b', top: 168, bottom: 230 },
    { id: 'c', top: 238, bottom: 300 },
  ];

  test('カードとカードの間の隙間では、上のカードを返す', () => {
    expect(gapAbove(boxes, 164)).toBe('a');
    expect(gapAbove(boxes, 160)).toBe('a');
    expect(gapAbove(boxes, 234)).toBe('b');
  });

  test('カードの上、最後のカードの下、カードの中、カードが1枚以下では null（列の末尾として扱う）', () => {
    expect(gapAbove(boxes, 90)).toBeNull();
    expect(gapAbove(boxes, 310)).toBeNull();
    expect(gapAbove(boxes, 200)).toBeNull();
    expect(gapAbove(boxes.slice(0, 1), 165)).toBeNull();
    expect(gapAbove([], 165)).toBeNull();
  });
});

describe('isGrabbable', () => {
  test('完了していないカードと、完了の列で戻せるカードだけつかめる', () => {
    expect(isGrabbable(columns, 'a')).toBe(true);
    expect(isGrabbable(columns, 'z')).toBe(true);
    // 完了したストーリーの下のカードは戻せないのでつかめない
    expect(isGrabbable(columns, 'x')).toBe(false);
    expect(isGrabbable(columns, 'nope')).toBe(false);
  });
});

describe('resolveSprintDrop: 列の中の並べ替え', () => {
  test('カードの前に落とすと、そのカードの前に入り、前の線を示す', () => {
    const drop = resolveSprintDrop(columns, 'c', onCard('a'), 'before');
    expect(drop?.mark).toEqual({ target: onCard('a'), operation: 'before' });
    expect(drop?.taskId).toBe('c');
    expect(drop?.plan.kind).toBe('moved');
    if (drop?.plan.kind !== 'moved') return;
    expect(ids(drop.plan.columns)).toEqual([['c', 'a', 'b'], ['d'], [], ['z', 'y', 'x']]);
    expect(drop.plan).toMatchObject({ index: 0, total: 3, afterTaskId: null });
    expect(drop.plan.column.id).toBe('c1');
  });

  test('カードの後ろに落とすと、直前のカードを渡す', () => {
    const drop = resolveSprintDrop(columns, 'a', onCard('b'), 'after');
    expect(drop?.mark).toEqual({ target: onCard('b'), operation: 'after' });
    if (drop?.plan.kind !== 'moved') throw new Error('moved ではない');
    expect(ids(drop.plan.columns)[0]).toEqual(['b', 'a', 'c']);
    expect(drop.plan).toMatchObject({ index: 1, total: 3, afterTaskId: 'b' });
  });

  test('同じ列の末尾のカードの後ろへは、直前のカードを渡して末尾に入れる', () => {
    const drop = resolveSprintDrop(columns, 'a', onCard('c'), 'after');
    if (drop?.plan.kind !== 'moved') throw new Error('moved ではない');
    expect(ids(drop.plan.columns)[0]).toEqual(['b', 'c', 'a']);
    expect(drop.plan).toMatchObject({ index: 2, total: 3, afterTaskId: 'c' });
  });

  test('元と同じ位置（自分自身、隣の前後）には何も示さない', () => {
    expect(resolveSprintDrop(columns, 'b', onCard('b'), 'before')).toBeNull();
    expect(resolveSprintDrop(columns, 'b', onCard('b'), 'after')).toBeNull();
    // b の前は a の後ろと同じ位置
    expect(resolveSprintDrop(columns, 'b', onCard('a'), 'after')).toBeNull();
    expect(resolveSprintDrop(columns, 'b', onCard('c'), 'before')).toBeNull();
    // 末尾のカードを、自分の列の末尾へ
    expect(resolveSprintDrop(columns, 'c', onColumn('c1'), 'into')).toBeNull();
  });

  test('列の末尾の枠に落とすと、列を囲み、末尾に入る（直前のカードは省く）', () => {
    const drop = resolveSprintDrop(columns, 'a', onColumn('c1'), 'into');
    expect(drop?.mark).toEqual({ target: onColumn('c1'), operation: 'into' });
    if (drop?.plan.kind !== 'moved') throw new Error('moved ではない');
    expect(ids(drop.plan.columns)[0]).toEqual(['b', 'c', 'a']);
    expect(drop.plan).toMatchObject({ index: 2, total: 3, afterTaskId: undefined });
  });
});

describe('resolveSprintDrop: 別の列へ', () => {
  test('隣でない列のカードの前に落とせる', () => {
    const drop = resolveSprintDrop(columns, 'a', onCard('d'), 'before');
    if (drop?.plan.kind !== 'moved') throw new Error('moved ではない');
    expect(ids(drop.plan.columns)).toEqual([['b', 'c'], ['a', 'd'], [], ['z', 'y', 'x']]);
    expect(drop.plan).toMatchObject({ index: 0, total: 2, afterTaskId: null });
    expect(drop.plan.column.id).toBe('c2');
  });

  test('列の末尾に落とすと、隣でない列でも末尾に入る', () => {
    const drop = resolveSprintDrop(columns, 'a', onColumn('c2'), 'into');
    if (drop?.plan.kind !== 'moved') throw new Error('moved ではない');
    expect(ids(drop.plan.columns)).toEqual([['b', 'c'], ['d', 'a'], [], ['z', 'y', 'x']]);
    expect(drop.plan).toMatchObject({ index: 1, total: 2, afterTaskId: undefined });
  });

  test('カードの無い列にも落とせる', () => {
    const drop = resolveSprintDrop(columns, 'd', onColumn('c3'), 'into');
    if (drop?.plan.kind !== 'moved') throw new Error('moved ではない');
    expect(ids(drop.plan.columns)).toEqual([['a', 'b', 'c'], [], ['d'], ['z', 'y', 'x']]);
    expect(drop.plan).toMatchObject({ index: 0, total: 1, afterTaskId: undefined });
  });

  test('列のカードに into で重ねても、その列の末尾になる', () => {
    const drop = resolveSprintDrop(columns, 'a', onCard('d'), 'into');
    expect(drop?.mark).toEqual({ target: onColumn('c2'), operation: 'into' });
  });

  test('元の配列は変えない', () => {
    const before = ids(columns);
    resolveSprintDrop(columns, 'a', onCard('d'), 'before');
    expect(ids(columns)).toEqual(before);
  });
});

describe('resolveSprintDrop: 完了の列へ', () => {
  test('完了の列のどこに重ねても、列を囲み、complete を返す（画面の並びは替えない）', () => {
    for (const target of [onColumn('done'), onCard('z'), onCard('x')]) {
      for (const operation of ['before', 'after', 'into'] as const) {
        const drop = resolveSprintDrop(columns, 'd', target, operation);
        expect(drop?.mark).toEqual({ target: onColumn('done'), operation: 'into' });
        expect(drop?.plan).toEqual({ kind: 'complete' });
      }
    }
  });

  test('隣でない列からも完了にできる', () => {
    expect(resolveSprintDrop(columns, 'a', onColumn('done'), 'into')?.plan).toEqual({ kind: 'complete' });
  });

  test('完了の列の中への落とし直しは何も示さない', () => {
    expect(resolveSprintDrop(columns, 'z', onColumn('done'), 'into')).toBeNull();
    expect(resolveSprintDrop(columns, 'z', onCard('y'), 'after')).toBeNull();
  });
});

describe('resolveSprintDrop: 完了の列から', () => {
  test('完了でない列のカードの前に落とすと、reopen を返し、画面の並びは替えない', () => {
    const drop = resolveSprintDrop(columns, 'z', onCard('b'), 'before');
    expect(drop?.mark).toEqual({ target: onCard('b'), operation: 'before' });
    expect(drop?.plan).toMatchObject({ kind: 'reopen', index: 1, total: 4, afterTaskId: 'a' });
    if (drop?.plan.kind !== 'reopen') return;
    expect(drop.plan.column.id).toBe('c1');
    expect(drop.plan.column.tasks.map((task) => task.id)).toEqual(['a', 'b', 'c']);
  });

  test('列の先頭の前なら先頭（null）、列の末尾なら直前のカードを省く', () => {
    expect(resolveSprintDrop(columns, 'z', onCard('a'), 'before')?.plan).toMatchObject({
      kind: 'reopen',
      index: 0,
      afterTaskId: null,
    });
    expect(resolveSprintDrop(columns, 'y', onColumn('c2'), 'into')?.plan).toMatchObject({
      kind: 'reopen',
      index: 1,
      total: 2,
      afterTaskId: undefined,
    });
    expect(resolveSprintDrop(columns, 'y', onColumn('c3'), 'into')?.plan).toMatchObject({
      kind: 'reopen',
      index: 0,
      total: 1,
      afterTaskId: undefined,
    });
  });

  test('戻せないカード（完了したストーリーの下）はつかめない', () => {
    expect(resolveSprintDrop(columns, 'x', onColumn('c1'), 'into')).toBeNull();
    expect(resolveSprintDrop(columns, 'x', onCard('a'), 'before')).toBeNull();
  });
});

describe('resolveSprintDrop: 落とせない場所', () => {
  test('無いカードと無い列は null', () => {
    expect(resolveSprintDrop(columns, 'nope', onColumn('c1'), 'into')).toBeNull();
    expect(resolveSprintDrop(columns, 'a', onCard('nope'), 'before')).toBeNull();
    expect(resolveSprintDrop(columns, 'a', onColumn('nope'), 'into')).toBeNull();
  });
});
