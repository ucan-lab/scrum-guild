import { z } from 'zod';
import { idSchema } from '../../id.ts';
import { taskPointsSchema, taskTitleSchema } from '../../task.ts';
import { defineOperation } from '../define.ts';
import { backlogTaskSchema } from './backlog-tree.ts';

// 手でタスクを作る。置き場所はバックログ（tray = 'backlog'）。
// 親は story_id で指す。同じワークスペースの、削除していないストーリーでなければ 404、完了したストーリーなら 409 の conflict。
// position は親の配下の末尾（親なしなら、親のないタスクの末尾）。
// 作った人（created_by）は呼んだ人。担当はそのワークスペースに今所属している人だけで、そうでなければ存在しないときと同じ 404。
// 経験値は作ったときには付かず、完了にした時点で（ポイントが 1 以上なら）付く
export const taskCreate = defineOperation({
  name: 'task-create',
  description:
    'バックログにタスクを作る。タイトル、ポイント（未設定か 0、1、2、3、5、8、13）、担当（任意）、親のストーリー（任意）を指す。位置は親の配下の末尾',
  mode: 'write',
  permission: 'member',
  workspace: true,
  input: z.object({
    workspace_id: idSchema,
    title: taskTitleSchema,
    points: taskPointsSchema.nullable().default(null),
    assignee_user_id: idSchema.nullable().default(null),
    story_id: idSchema.nullable().default(null),
  }),
  output: z.object({ task: backlogTaskSchema }),
});
