import { z } from 'zod';
import { idSchema } from '../../id.ts';
import { dueOnSchema, linkUrlSchema, longTextSchema } from '../../story.ts';
import { taskPointsSchema, taskTitleSchema } from '../../task.ts';
import { defineOperation } from '../define.ts';
import { taskDetailSchema } from './task.ts';

// タスクの欄を変える。送られた欄のうち、今の値と違うものだけを書く（送られない欄は触らない）。
// 引き出しを開いたときの値から変えた欄だけを送ると、別の人が別の欄を直していても両方が残り、同じ欄は後の保存が勝つ。
// 変わる欄が無ければ何も書かない（履歴も残さない）。無いタスク（別の組織・別のワークスペース・削除済みを含む）は 404。
// 断る変更は 409 の conflict:
//   - 完了したタスクのポイント（経験値とスプリントの集計が、完了の記録の値を使うため）
//   - 取り込んだタスクのタイトルとリンク（タイトルは同期で書き直し、リンクは手で作ったタスクだけが持つ）
// 書く文は「読んだ値のままなら」という条件つきで、別の要求が先に同じ欄を変えていたら、読み直してやり直す（3 回まで。超えたら 409 の conflict）。
// 担当（task-assign）、区分、リポジトリは、この操作では変えない。返すのは、書いた後に読み直した値
export const taskUpdate = defineOperation({
  name: 'task-update',
  description:
    'タスクのタイトル、ポイント、期日、リンク、本文のうち、送った欄だけを変える。変わる欄が無ければ何も書かない',
  mode: 'write',
  permission: 'member',
  workspace: true,
  input: z.object({
    workspace_id: idSchema,
    task_id: idSchema,
    title: taskTitleSchema.optional(),
    points: taskPointsSchema.nullable().optional(),
    due_on: dueOnSchema.optional(),
    link_url: linkUrlSchema.optional(),
    body_md: longTextSchema.optional(),
  }),
  output: z.object({ task: taskDetailSchema }),
});
