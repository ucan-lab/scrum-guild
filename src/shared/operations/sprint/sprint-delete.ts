import { z } from 'zod';
import { idSchema } from '../../id.ts';
import { defineOperation } from '../define.ts';

// 始まる前のスプリント（planned）を削除する。論理削除（deleted_at を書く）で、変更の履歴（delete）も同時に書く。
// 始まったスプリントは 409 の conflict（started）。無いスプリント（別の組織・別のワークスペース・削除済みを含む）は 404。
// 入っていたタスクは同じ batch() でバックログへ戻す（sprint_entries の行を removed で閉じ、タスクの sprint_id、column_id、
// column_position を空にし、タスクごとの変更の履歴 {"sprint": [前, null]} を残す）
export const sprintDelete = defineOperation({
  name: 'sprint-delete',
  description: '始まる前のスプリントを削除する。リーダー（管理者を含む）だけが削除できる',
  mode: 'write',
  permission: 'leader',
  workspace: true,
  input: z.object({ workspace_id: idSchema, sprint_id: idSchema }),
  output: z.object({ sprint_id: z.string() }),
});
