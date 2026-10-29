import { describe, expect, test } from 'vitest';
import type { SprintBoardColumn } from '../shared/operations/sprint/index.ts';
import { edgesOf, placeOf, planCardMove } from './sprint-board.ts';

function card(id: string) {
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
  };
}

const columns: SprintBoardColumn[] = [
  { id: 'c1', name: '出発前', is_done: false, tasks: [card('a'), card('b'), card('c')] },
  { id: 'c2', name: '遂行中', is_done: false, tasks: [card('d')] },
  {
    id: 'done',
    name: null,
    is_done: true,
    tasks: [{ ...card('z'), completed_at: '2026-10-20T00:00:00.000Z', reopenable: true }],
  },
];

const ids = (list: SprintBoardColumn[]) => list.map((column) => column.tasks.map((task) => task.id));

describe('placeOf', () => {
  test('カードの列と位置を返し、無ければ null', () => {
    expect(placeOf(columns, 'b')).toEqual({ columnIndex: 0, index: 1 });
    expect(placeOf(columns, 'z')).toEqual({ columnIndex: 2, index: 0 });
    expect(placeOf(columns, 'nope')).toBeNull();
  });
});

describe('edgesOf', () => {
  test('列の端を返し、最後の完了でない列の先（完了の列）は端にしない（完了にする）', () => {
    expect(edgesOf(columns, 'a')).toEqual({ top: true, bottom: false, prev: true, next: false });
    expect(edgesOf(columns, 'c')).toEqual({ top: false, bottom: true, prev: true, next: false });
    expect(edgesOf(columns, 'd')).toEqual({ top: true, bottom: true, prev: false, next: false });
  });

  test('完了の列が無ければ、最後の列の先を端にする', () => {
    const open = columns.filter((column) => !column.is_done);
    expect(edgesOf(open, 'd')).toEqual({ top: true, bottom: true, prev: false, next: true });
    expect(planCardMove(open, 'd', 'right')).toEqual({ kind: 'edge', edge: 'next' });
  });

  test('完了の列のカードは動かさない', () => {
    expect(edgesOf(columns, 'z')).toBeNull();
    expect(planCardMove(columns, 'z', 'left')).toBeNull();
  });
});

describe('planCardMove', () => {
  test('下へ動かすと次のカードの直後に入り、直前のカードを返す', () => {
    const plan = planCardMove(columns, 'a', 'down');
    expect(plan).toMatchObject({ kind: 'moved', index: 1, total: 3, afterTaskId: 'b' });
    expect(plan?.kind === 'moved' && ids(plan.columns)).toEqual([['b', 'a', 'c'], ['d'], ['z']]);
  });

  test('上へ動かして先頭になるなら、直前は null', () => {
    const plan = planCardMove(columns, 'b', 'up');
    expect(plan).toMatchObject({ kind: 'moved', index: 0, afterTaskId: null });
    expect(plan?.kind === 'moved' && ids(plan.columns)[0]).toEqual(['b', 'a', 'c']);
  });

  test('列の端では動かさず、どの端かを返す', () => {
    expect(planCardMove(columns, 'a', 'up')).toEqual({ kind: 'edge', edge: 'top' });
    expect(planCardMove(columns, 'c', 'down')).toEqual({ kind: 'edge', edge: 'bottom' });
    expect(planCardMove(columns, 'a', 'left')).toEqual({ kind: 'edge', edge: 'prev' });
  });

  test('隣の列へは末尾に移し、直前のカードを送らない', () => {
    const plan = planCardMove(columns, 'a', 'right');
    expect(plan).toMatchObject({ kind: 'moved', index: 1, total: 2, afterTaskId: undefined });
    expect(plan?.kind === 'moved' && plan.column.id).toBe('c2');
    expect(plan?.kind === 'moved' && ids(plan.columns)).toEqual([['b', 'c'], ['d', 'a'], ['z']]);
  });

  test('最後の完了でない列から次の列へは、移さずに完了にする', () => {
    expect(planCardMove(columns, 'd', 'right')).toEqual({ kind: 'complete' });
    // 左へは今までどおり移す
    expect(planCardMove(columns, 'd', 'left')).toMatchObject({ kind: 'moved', afterTaskId: undefined });
  });

  test('元の列を書き換えない', () => {
    planCardMove(columns, 'a', 'right');
    expect(ids(columns)).toEqual([['a', 'b', 'c'], ['d'], ['z']]);
  });
});
