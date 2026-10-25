import { z } from 'zod';
import { idSchema } from '../../id.ts';
import { defineOperation } from '../define.ts';
import { taskDetailSchema } from './task.ts';

// タスクの担当を替える。null で外す。担当の変更は、今日やるの印を消すといった副作用を持つので、task-update と分ける。
// 担当にできるのは、そのワークスペースに今所属している、無効でない人だけで、そうでなければ存在しないときと同じ 404（所属していない管理者も 404）。
// 外す（null）のはいつでもできる。完了したタスクの担当は変えない（409 の conflict。完了の経験値と完了の記録が、完了した時点の担当を使うため）。
// 取り込んだタスクは変えられる。無いタスク（別の組織・別のワークスペース・削除済みを含む）は 404。
// 今と同じ担当を送ったら何も書かない（履歴も残さず、今日やるの印も消さない）。担当が替わったら、同じ文で今日やるの印（today_on）を消す。
// 書く文は「読んだ担当のまま」「完了していない」「新しい担当が今所属している」を条件にし、負けたら読み直してやり直す（3 回まで。超えたら 409 の conflict）。
// 返すのは、書いた後に読み直した値
export const taskAssign = defineOperation({
  name: 'task-assign',
  description:
    'タスクの担当を、ワークスペースに今所属している人に替えるか、外す（null）。担当が替わったら今日やるの印を消す。完了したタスクは替えられない',
  mode: 'write',
  permission: 'member',
  workspace: true,
  input: z.object({
    workspace_id: idSchema,
    task_id: idSchema,
    assignee_user_id: idSchema.nullable(),
  }),
  output: z.object({ task: taskDetailSchema }),
});
