import { z } from 'zod';
import { idSchema } from '../../id.ts';
import { defineOperation } from '../define.ts';
import { taskDetailSchema } from './task.ts';

// 詳細の引き出しを開くときに、タスク1件の属性と本文を読む。閉じたワークスペースでも読める。
// 無いタスク（別の組織・別のワークスペース・削除済みを含む）は 404
export const taskDetail = defineOperation({
  name: 'task-detail',
  description: 'タスク1件のタイトル、本文、ポイント、期日、リンク、完了の状態、削除できるかを返す',
  mode: 'read',
  permission: 'member',
  workspace: true,
  input: z.object({ workspace_id: idSchema, task_id: idSchema }),
  output: z.object({ task: taskDetailSchema }),
});
