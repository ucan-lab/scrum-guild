// スプリントの画面のカードの移動を、画面の状態（列とカード）の上で計画する。画面は先に並びを替えて読み上げ、
// 同じ移動をサーバー（task-column-move）へ送る。完了の列へは task-column-move で移さず、完了でない列のいちばん後ろの列の
// 「次の列へ」は完了にする（complete。画面が task-complete を呼ぶ）。完了の列のカードは動かさない（完了を戻すのは task-reopen）
import type { SprintBoardColumn } from '../shared/operations/sprint/index.ts';

export type MoveDirection = 'left' | 'right' | 'up' | 'down';

// 動かせなかった端。top と bottom は列の中、prev と next は列の間
export type MoveEdge = 'top' | 'bottom' | 'prev' | 'next';

export type CardMovePlan =
  | { kind: 'edge'; edge: MoveEdge }
  // 次の列が完了の列。画面の並びは替えず、task-complete を呼ぶ
  | { kind: 'complete' }
  | {
      kind: 'moved';
      // 動かした後の列とカード
      columns: SprintBoardColumn[];
      // 動かした先の列と、その中の位置（0 から数える）、その列のカードの数
      column: SprintBoardColumn;
      index: number;
      total: number;
      // task-column-move に送る直前のカード。null は先頭、undefined は末尾（送る側が省く）
      afterTaskId: string | null | undefined;
    };

export type CardPlace = { columnIndex: number; index: number };

export function placeOf(columns: readonly SprintBoardColumn[], taskId: string): CardPlace | null {
  for (const [columnIndex, column] of columns.entries()) {
    const index = column.tasks.findIndex((task) => task.id === taskId);
    if (index !== -1) return { columnIndex, index };
  }
  return null;
}

// 端のボタンを押せないものにするための印。完了の列のカードは動かさないので null。
// 次の列が完了の列なら「次の列へ」は完了にするので端にしない（完了の列が無いときだけ端）。そのときは completes が真で、
// 画面は「次の列へ」の読み上げの名前を完了の操作の名前にする
export function edgesOf(
  columns: readonly SprintBoardColumn[],
  taskId: string,
): { top: boolean; bottom: boolean; prev: boolean; next: boolean; completes: boolean } | null {
  const place = placeOf(columns, taskId);
  if (place === null) return null;
  const column = columns[place.columnIndex]!;
  if (column.is_done) return null;
  const next = columns[place.columnIndex + 1];
  return {
    top: place.index === 0,
    bottom: place.index === column.tasks.length - 1,
    prev: place.columnIndex === 0,
    next: next === undefined,
    completes: next?.is_done === true,
  };
}

export function planCardMove(
  columns: readonly SprintBoardColumn[],
  taskId: string,
  direction: MoveDirection,
): CardMovePlan | null {
  const place = placeOf(columns, taskId);
  if (place === null) return null;
  const source = columns[place.columnIndex]!;
  if (source.is_done) return null;
  const card = source.tasks[place.index]!;

  if (direction === 'up' || direction === 'down') {
    const to = place.index + (direction === 'up' ? -1 : 1);
    if (to < 0) return { kind: 'edge', edge: 'top' };
    if (to >= source.tasks.length) return { kind: 'edge', edge: 'bottom' };
    const tasks = source.tasks.filter((task) => task.id !== taskId);
    tasks.splice(to, 0, card);
    const column = { ...source, tasks };
    return {
      kind: 'moved',
      columns: columns.map((other, i) => (i === place.columnIndex ? column : other)),
      column,
      index: to,
      total: tasks.length,
      afterTaskId: to === 0 ? null : tasks[to - 1]!.id,
    };
  }

  const targetIndex = place.columnIndex + (direction === 'left' ? -1 : 1);
  const target = columns[targetIndex];
  if (target?.is_done === true && direction === 'right') return { kind: 'complete' };
  if (target === undefined || target.is_done) return { kind: 'edge', edge: direction === 'left' ? 'prev' : 'next' };
  // 隣の列へは末尾に置く
  const moved = { ...target, tasks: [...target.tasks, card] };
  const emptied = { ...source, tasks: source.tasks.filter((task) => task.id !== taskId) };
  return {
    kind: 'moved',
    columns: columns.map((other, i) => (i === place.columnIndex ? emptied : i === targetIndex ? moved : other)),
    column: moved,
    index: moved.tasks.length - 1,
    total: moved.tasks.length,
    afterTaskId: undefined,
  };
}
