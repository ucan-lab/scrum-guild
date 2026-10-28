import { z } from 'zod';
import { idSchema } from '../../id.ts';
import { conflictReasonOf } from '../conflict-reason.ts';
import { defineOperation } from '../define.ts';

// カードの移動を 409 の conflict で断った理由（details.reason）。
// done_column は完了の列へ移そうとした（完了にするのは task-complete）、
// task_completed は完了したタスクを動かそうとした、
// not_active はタスクが進行中のスプリントに入っていない（始まっていない、終了した）、
// changed は読んでから書くまでに別の要求が列か並びを変えた、ties は同じ値の行が多すぎて振り直さなかった
export const columnMoveConflictReasons = ['done_column', 'task_completed', 'not_active', 'changed', 'ties'] as const;
export type ColumnMoveConflictReason = (typeof columnMoveConflictReasons)[number];

export function columnMoveConflictReasonOf(details: unknown): ColumnMoveConflictReason | undefined {
  return conflictReasonOf(details, columnMoveConflictReasons);
}

// 進行中のスプリントの中のカード（タスク）を、列の間で移すか、列の中で並べ替える。column_id は移す先の列（今の列でもよい）。
// after_task_id は移す先の列の中で直前に置くカードで、null は先頭、省くと末尾。位置（column_position）はサーバーが隣のカードから決める。
// 直前のカードは、同じスプリントの移す先の列の削除していないタスクでなければ 404、移すタスク自身なら 400 の invalid_input。
// 移すタスクと列が無い（別の組織を含む）ときと、タスクがスプリントに入っていないときは 404。
// 完了の列へ移すことと、完了したタスクを動かすことと、進行中でないスプリントの中のタスクを動かすことは 409 の conflict
// （理由は columnMoveConflictReasons）。列が変わったときだけ change_logs に {"column": [前, 後]} を残し、列の中の並べ替えは残さない
export const taskColumnMove = defineOperation({
  name: 'task-column-move',
  description:
    '進行中のスプリントのカードを列の間で移すか、列の中で並べ替える。移す先の列の中で、指したカードの直後（null は先頭、省くと末尾）に置く。完了の列へは移せない',
  mode: 'write',
  permission: 'member',
  workspace: true,
  input: z.object({
    workspace_id: idSchema,
    task_id: idSchema,
    column_id: idSchema,
    after_task_id: idSchema.nullable().optional(),
  }),
  output: z.object({ task_id: z.string(), column_id: z.string() }),
});
