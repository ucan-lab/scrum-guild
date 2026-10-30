// スプリントの画面のカードのドラッグの判定。つかんだカードと、重ねた先（カードの前か後ろ、または列そのもの）から、
// 示す印と、落としたときの計画を決める。DOM と描画には触れない。計画は sprint-board.ts の planCardMove と同じ形で、
// 画面の並びを先に替える moved に加えて、完了の列へ落とす complete と、完了の列から落とす reopen を持つ。
//
// 決まり:
// - つかめるのは、完了していないカードと、完了の列で戻せる（reopenable）カード。完了したストーリーの下のカードはつかめない（null）
// - カードの前（before）か後ろ（after）は、その列の中のカードとカードの間の線。列の末尾（into）は列を囲む。
//   カードの無い所と列の頭は、列の末尾に入る
// - 完了の列は、カードに重ねても、列に重ねても、列を囲む（位置の線は出さない）。完了でないカードを落とすと complete（画面の並びは替えない）。
//   完了の列のカードを完了の列の中へ落とし直しても、何も示さない（null）
// - 完了の列のカードを完了でない列へ落とすと reopen。task-reopen で戻してから、落とした列と位置へ task-column-move を続ける。
//   戻す前に画面の並びは替えない（task-reopen は列を渡せず、戻した列は task-reopen が決めるため）
// - 元と同じ位置なら null（何も示さず、何も送らない）
import type { SprintBoardColumn } from '../shared/operations/sprint/index.ts';
import { insertAround, insertAtEnd } from './list-drop.ts';
import { placeOf, type CardMovePlan } from './sprint-board.ts';

// 重ねる先。カードか、列そのもの
export type SprintDropTarget = { kind: 'card'; id: string } | { kind: 'column'; id: string };

// card は重ねたカードの上半分（before）か下半分（after）。into は列を囲む
export type SprintDropOperation = 'before' | 'after' | 'into';

// 印を付ける先。before と after はカード、into は列
export type SprintDropMark = { target: SprintDropTarget; operation: SprintDropOperation };

// 画面の並びを先に替えて、task-column-move を送る
export type MovedPlan = Extract<CardMovePlan, { kind: 'moved' }>;

// 完了の列のカードを、完了でない列へ落とす。column は落とす列（今の並び）、index と total は落とした後のその列での位置（0 から数える）と件数、
// afterTaskId は戻した後に task-column-move へ送る直前のカード（null は先頭、undefined は末尾で省く）
export type ReopenPlan = {
  kind: 'reopen';
  column: SprintBoardColumn;
  index: number;
  total: number;
  afterTaskId: string | null | undefined;
};

export type SprintDropPlan = MovedPlan | Extract<CardMovePlan, { kind: 'complete' }> | ReopenPlan;

export type SprintDrop = {
  // つかんだカード
  taskId: string;
  mark: SprintDropMark;
  plan: SprintDropPlan;
};

// つかめるカードか（書き込めるかは、呼ぶ側が見る）。完了の列では、戻せるカードだけ
export function isGrabbable(columns: readonly SprintBoardColumn[], taskId: string): boolean {
  const place = placeOf(columns, taskId);
  if (place === null) return false;
  const column = columns[place.columnIndex]!;
  return column.is_done ? column.tasks[place.index]!.reopenable : true;
}

export function resolveSprintDrop(
  columns: readonly SprintBoardColumn[],
  taskId: string,
  target: SprintDropTarget,
  operation: SprintDropOperation,
): SprintDrop | null {
  if (!isGrabbable(columns, taskId)) return null;
  const from = placeOf(columns, taskId)!;
  const source = columns[from.columnIndex]!;
  const card = source.tasks[from.index]!;

  // 重ねたカードの列を行き先にする。列そのものなら、その列
  const anchorId = target.kind === 'card' ? target.id : null;
  const toIndex =
    target.kind === 'card'
      ? (placeOf(columns, target.id)?.columnIndex ?? -1)
      : columns.findIndex((column) => column.id === target.id);
  if (toIndex === -1) return null;
  const dest = columns[toIndex]!;

  // 完了の列は、どこに重ねても列を囲む
  if (dest.is_done) {
    if (source.is_done) return null;
    return { taskId, mark: { target: { kind: 'column', id: dest.id }, operation: 'into' }, plan: { kind: 'complete' } };
  }

  const ids = dest.tasks.map((task) => task.id);
  const around = anchorId !== null && operation !== 'into';
  const insertion = around ? insertAround(ids, taskId, anchorId, operation) : insertAtEnd(ids, taskId);
  if (insertion === null) return null;
  const mark: SprintDropMark = around
    ? { target: { kind: 'card', id: anchorId }, operation }
    : { target: { kind: 'column', id: dest.id }, operation: 'into' };

  if (source.is_done) {
    return {
      taskId,
      mark,
      plan: {
        kind: 'reopen',
        column: dest,
        index: insertion.index,
        total: ids.length + 1,
        afterTaskId: insertion.afterId,
      },
    };
  }

  const tasks = dest.tasks.filter((task) => task.id !== taskId);
  tasks.splice(insertion.index, 0, card);
  const moved = { ...dest, tasks };
  const emptied = { ...source, tasks: source.tasks.filter((task) => task.id !== taskId) };
  return {
    taskId,
    mark,
    plan: {
      kind: 'moved',
      columns: columns.map((column, i) => (i === toIndex ? moved : i === from.columnIndex ? emptied : column)),
      column: moved,
      index: insertion.index,
      total: tasks.length,
      afterTaskId: insertion.afterId,
    },
  };
}
