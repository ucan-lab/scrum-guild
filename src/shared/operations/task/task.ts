import { z } from 'zod';
import { taskPointsSchema } from '../../task.ts';
import { definitionRefSchema, resolvedCategorySchema } from '../definition/definition.ts';
import { sprintRefSchema } from '../sprint/sprint.ts';

// タスクの詳細の引き出しが出す項目。読む操作と、変える操作が、書いた後の値として返す。
// 本文は長い（1 万字まで）ので、バックログの木（backlog-tree）には載せない
export const taskDetailSchema = z.object({
  id: z.string(),
  title: z.string(),
  body_md: z.string().nullable(),
  points: taskPointsSchema.nullable(),
  due_on: z.string().nullable(),
  link_url: z.string().nullable(),
  // 担当。いなければ null。left は、今そのワークスペースに所属していない（抜けた、無効にされた）こと。
  // 抜けた人でも名前を残し、画面は「（離脱済み）」を添える
  assignee: z.object({ id: z.string(), name: z.string(), left: z.boolean() }).nullable(),
  // 取り込んだタスク。タイトルとリンクは直せない
  is_imported: z.boolean(),
  // 完了した日時。完了したタスクのポイントは直せない
  completed_at: z.string().nullable(),
  // 完了を戻せるか（task-reopen）。完了していて、書き込めて（閉じていないワークスペース）、断る理由（終了したか削除したスプリントの中で
  // 完了した、完了したストーリーの下にある）に当たらないとき。画面が完了の帯に「戻す」を出すかを決める
  reopenable: z.boolean(),
  // 呼んだ人が削除できるか（作った人とリーダー、管理者）。画面が削除の操作を出すかを決める
  can_delete: z.boolean(),
  // 親のストーリー。親のあるタスクは区分を振れない（親から引き継ぐ）
  story_id: z.string().nullable(),
  // 引き継ぎを解いた区分（親のエピック、親のストーリー、タスク自身の順）。inherited は親から引き継いだもの
  category: resolvedCategorySchema.nullable(),
  // 振ったリポジトリ。親から引き継がない
  repository: definitionRefSchema.nullable(),
  // 入っているスプリント（削除していないもの）。入っていなければ null
  sprint: sprintRefSchema.nullable(),
});

export type TaskDetail = z.output<typeof taskDetailSchema>;
