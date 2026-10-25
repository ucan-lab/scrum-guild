import { z } from 'zod';
import { idSchema } from '../../id.ts';
import { taskPointsSchema } from '../../task.ts';
import { defineOperation } from '../define.ts';

// バックログの一覧の1行。画面が行に出す項目だけ
export const taskListItemSchema = z.object({
  id: z.string(),
  title: z.string(),
  points: taskPointsSchema.nullable(),
  // 担当。いなければ null。名前は、離脱済みの人でも出す
  assignee: z.object({ id: z.string(), name: z.string() }).nullable(),
});

export type TaskListItem = z.output<typeof taskListItemSchema>;

// バックログの未完了で親のないタスクを position の順に返す。完了したタスクは行を返さず、件数だけ返す
// （使い続けるほど一覧が重くなるため）。親の付いたタスクと木は、バックログと階層の Issue で足す
export const taskList = defineOperation({
  name: 'task-list',
  description: 'バックログの未完了で親のないタスクを position の順と、完了した親のないタスクの件数を返す',
  mode: 'read',
  permission: 'member',
  workspace: true,
  input: z.object({ workspace_id: idSchema }),
  output: z.object({
    tasks: z.array(taskListItemSchema),
    completed_count: z.number().int(),
  }),
});
