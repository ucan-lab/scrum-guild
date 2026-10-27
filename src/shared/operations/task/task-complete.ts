import { z } from 'zod';
import { idSchema } from '../../id.ts';
import { defineOperation } from '../define.ts';

// タスクを完了にする。tasks、completions、xp_grants（起票と完了。ポイントが 1 以上のとき）、change_logs を1回の batch で書く。
// 対象は、親のないタスクと、ストーリーの下のタスク。completions の区分は、親のストーリーの親のエピック、ストーリー、タスクの順に、
// 最初に入っているものを写す。無いタスク（別の組織のタスクを含む）は 404、すでに完了なら 409 の conflict
export const taskComplete = defineOperation({
  name: 'task-complete',
  description:
    'タスクを完了にする。完了の記録と、ポイントが 1 以上のときの経験値（起票と完了）、変更の履歴も同時に書く',
  mode: 'write',
  permission: 'member',
  workspace: true,
  input: z.object({ workspace_id: idSchema, task_id: idSchema }),
  // left_sprint は、始まっていないスプリント（か削除したスプリント）に入っていて、完了でそこから外れたか。画面が一言添える
  output: z.object({ task_id: z.string(), completed_at: z.string(), left_sprint: z.boolean() }),
});
