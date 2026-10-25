import { z } from 'zod';
import { taskPointsSchema } from '../../task.ts';

// タスクの詳細の引き出しが出す項目。読む操作と、変える操作が、書いた後の値として返す。
// 本文は長い（1 万字まで）ので、バックログの木（backlog-tree）には載せない
export const taskDetailSchema = z.object({
  id: z.string(),
  title: z.string(),
  body_md: z.string().nullable(),
  points: taskPointsSchema.nullable(),
  due_on: z.string().nullable(),
  link_url: z.string().nullable(),
  // 取り込んだタスク。タイトルとリンクは直せない
  is_imported: z.boolean(),
  // 完了した日時。完了したタスクのポイントは直せない
  completed_at: z.string().nullable(),
  // 呼んだ人が削除できるか（作った人とリーダー、管理者）。画面が削除の操作を出すかを決める
  can_delete: z.boolean(),
});

export type TaskDetail = z.output<typeof taskDetailSchema>;
