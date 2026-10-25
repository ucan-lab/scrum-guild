import { z } from 'zod';
import { idSchema } from '../../id.ts';
import { defineOperation } from '../define.ts';

// タスクを削除する。論理削除（deleted_at を書く）で、完了の記録と経験値は残る。変更の履歴（delete）も同時に書く。
// 削除できるのは、作った人とリーダー（管理者を含む）。それ以外は 403 の forbidden。
// 取り込んだタスクは、権限があっても 409 の conflict で断る（削除でなくアーカイブで外す。docs/requirements.md の「削除」）。
// 無いタスク（別の組織・別のワークスペース・削除済みを含む）は 404。権限より先に、存在で決める
export const taskDelete = defineOperation({
  name: 'task-delete',
  description:
    '手で作ったタスクを論理削除する。作った人とリーダー（管理者を含む）だけが削除できる。取り込んだタスクは削除できない（アーカイブで外す）',
  mode: 'write',
  permission: 'member',
  workspace: true,
  input: z.object({ workspace_id: idSchema, task_id: idSchema }),
  output: z.object({ task_id: z.string() }),
});
