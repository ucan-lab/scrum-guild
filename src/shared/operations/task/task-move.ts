import { z } from 'zod';
import { idSchema } from '../../id.ts';
import { defineOperation } from '../define.ts';

// 移動を 409 の conflict で断った理由（タスクの移動とストーリーの移動で共通）。
// parent_completed は完了した（エピックなら中止した）親の下へ移そうとした、task_completed は完了したタスクを動かそうとした、
// changed は読んでから書くまでに別の要求が並びか親を変えた、ties は同じ値の行が多すぎて振り直さなかった
export const moveConflictReasons = ['parent_completed', 'task_completed', 'changed', 'ties'] as const;
export type MoveConflictReason = (typeof moveConflictReasons)[number];

// 409 の応答の details から理由を取り出す。形が違えば undefined
export function moveConflictReasonOf(details: unknown): MoveConflictReason | undefined {
  if (typeof details !== 'object' || details === null || !('reason' in details)) return undefined;
  const { reason } = details;
  return (moveConflictReasons as readonly unknown[]).includes(reason) ? (reason as MoveConflictReason) : undefined;
}

// バックログのタスクを並べ替える、親を移す。story_id は移す先の親のストーリー（null は親なし）。
// after_task_id は移す先の中で直前に置く行で、null は先頭、省くと末尾。直前の行は、移す先の削除していないバックログのタスク
// （完了したタスクも並びに残っているので指せる）でなければ 404、移すタスク自身なら 400 の invalid_input。
// 移すタスクと親が無い（別の組織を含む）ときは 404、完了したタスクと、完了したストーリーの下へは 409 の conflict。
// 親が変わったときだけ change_logs に {"story": [前, 後]} を残し、ストーリーの下へ移したら区分を空にする。
// 位置は返さない（画面は自分で並べ替え、読み直せば位置の順に並ぶ）。
// 409 の conflict は、理由を details.reason に載せる（moveConflictReasons）。画面はこれで知らせる文を選ぶ
export const taskMove = defineOperation({
  name: 'task-move',
  description:
    'バックログのタスクを並べ替えるか、親のストーリーを移す。移す先の中で、指した行の直後（null は先頭、省くと末尾）に置く',
  mode: 'write',
  permission: 'member',
  workspace: true,
  input: z.object({
    workspace_id: idSchema,
    task_id: idSchema,
    story_id: idSchema.nullable(),
    after_task_id: idSchema.nullable().optional(),
  }),
  output: z.object({ task_id: z.string(), story_id: z.string().nullable() }),
});
