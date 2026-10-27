import { z } from 'zod';
import { idSchema } from '../../id.ts';
import { defineOperation } from '../define.ts';

// スプリントからタスクを外し、バックログへ戻す。sprint_entries の行を removed で閉じ、タスクの sprint_id、column_id、
// column_position を空にし、変更の履歴（{"sprint": [前, null]}）を残す。完了したタスクは 409 の conflict（completed。先に完了を戻す）、
// 終了したスプリントからは 409 の conflict（closed）。スプリントかタスクが無い（別の組織・別のワークスペース・削除済み、
// そのスプリントに入っていないタスクを含む）ときは 404
export const sprintTaskRemove = defineOperation({
  name: 'sprint-task-remove',
  description: 'スプリントからタスクを外してバックログへ戻す。完了したタスクと、終了したスプリントからは外せない',
  mode: 'write',
  permission: 'member',
  workspace: true,
  input: z.object({ workspace_id: idSchema, sprint_id: idSchema, task_id: idSchema }),
  output: z.object({ task_id: z.string() }),
});
