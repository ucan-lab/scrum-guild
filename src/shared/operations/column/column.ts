import { z } from 'zod';
import { conflictReasonOf } from '../conflict-reason.ts';

// 列の操作を 409 の conflict で断った理由（details.reason）。
// duplicate_name は同じワークスペースに削除していない同じ名前の列がある、limit は完了以外の列が上限（12）に達している、
// last_column は完了以外で最後に残った列を削除しようとした、done_column は完了の列を削除しようとした、
// target_required は移すタスクが残っているのに移し先を送っていない、target_invalid は移し先が削除する列自身か完了の列、
// changed は読んでから書くまでに別の要求が列かタスクを変えたので、やり直しても書けなかった（並べ替えでは task-move.ts の ties もある）
export const columnConflictReasons = [
  'duplicate_name',
  'limit',
  'last_column',
  'done_column',
  'target_required',
  'target_invalid',
  'changed',
] as const;
export type ColumnConflictReason = (typeof columnConflictReasons)[number];

export function columnConflictReasonOf(details: unknown): ColumnConflictReason | undefined {
  return conflictReasonOf(details, columnConflictReasons);
}

// 列の定義。完了の列（is_done）は name が空で、画面が言葉づかいに合わせた名前を辞書から出す。
// task_count は、削除すると移り先へ移る、進行中と先のスプリントの未完了のタスクの数（削除の確かめに出す。完了の列は 0）
export const columnSchema = z.object({
  id: z.string(),
  name: z.string(),
  is_done: z.boolean(),
  task_count: z.number().int(),
});
export type Column = z.output<typeof columnSchema>;
