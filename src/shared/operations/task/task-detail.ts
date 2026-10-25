import { z } from 'zod';
import { idSchema } from '../../id.ts';
import { defineOperation } from '../define.ts';
import { taskDetailSchema } from './task.ts';

// 詳細の引き出しを開くときに、タスク1件の属性と本文を読む。閉じたワークスペースでも読める。
// 無いタスク（別の組織・別のワークスペース・削除済みを含む）は 404。
// today はワークスペースのタイムゾーンでの今日、week_start は週の始まり（0〜6、0 が日曜）。backlog-tree と同じ決め方で、
// 期日の印（過ぎた、今日、今週、それ以外）は、この2つで決める（ブラウザの時計とタイムゾーンに頼らない）
export const taskDetail = defineOperation({
  name: 'task-detail',
  description:
    'タスク1件のタイトル、本文、ポイント、期日、リンク、担当（今所属しているか付き）、完了の状態、削除できるかと、期日の印を決める今日と週の始まりを返す',
  mode: 'read',
  permission: 'member',
  workspace: true,
  input: z.object({ workspace_id: idSchema, task_id: idSchema }),
  output: z.object({
    task: taskDetailSchema,
    today: z.string(),
    week_start: z.number().int().min(0).max(6),
  }),
});
