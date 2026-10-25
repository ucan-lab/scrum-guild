import { z } from 'zod';
import { idSchema } from '../../id.ts';
import { defineOperation } from '../define.ts';

// バックログのタスクを並べ替える、親を移す。story_id は移す先の親のストーリー（null は親なし）。
// after_task_id は移す先の中で直前に置く行で、null は先頭、省くと末尾。直前の行は、移す先の削除していないバックログのタスク
// （完了したタスクも並びに残っているので指せる）でなければ 404、移すタスク自身なら 400 の invalid_input。
// 移すタスクと親が無い（別の組織を含む）ときは 404、完了したタスクと、完了したストーリーの下へは 409 の conflict。
// 親が変わったときだけ change_logs に {"story": [前, 後]} を残し、ストーリーの下へ移したら区分を空にする。
// 位置は返さない（画面は自分で並べ替え、読み直せば位置の順に並ぶ）
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
