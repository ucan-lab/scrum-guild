import { z } from 'zod';
import { conflictReasonOf } from '../conflict-reason.ts';

// 計画の画面が出すスプリントの項目。作る操作と変える操作が、書いた後の値として返す。
// name が null のスプリントは、画面が期間を名前として出す。length は開始日から最終日までの日数（両端を含む）
export const sprintSummarySchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  start_on: z.string(),
  end_on: z.string(),
  length: z.number().int(),
  status: z.enum(['planned', 'active']),
});

export type SprintSummary = z.output<typeof sprintSummarySchema>;

// タスクが入っているスプリント（バックログの木の行とタスクの詳細）。name が null なら、画面が期間を名前として出す
export const sprintRefSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  start_on: z.string(),
  end_on: z.string(),
});

export type SprintRef = z.output<typeof sprintRefSchema>;

// 計画の画面のスプリントの行に並べる、入っているタスクの1行（列の順、その中の column_position、id の順）。
// 完了したタスク（進行中のスプリントの中で完了したもの）も並べ、completed_at で見分ける（外す口を出さない）
export const sprintTaskSchema = z.object({
  id: z.string(),
  title: z.string(),
  points: z.number().int().nullable(),
  assignee: z.object({ id: z.string(), name: z.string() }).nullable(),
  completed_at: z.string().nullable(),
});

export type SprintTask = z.output<typeof sprintTaskSchema>;

// 一覧（sprint-list）の行。スプリントの項目に、入っているタスクを足したもの
export const sprintPlanSchema = sprintSummarySchema.extend({ tasks: z.array(sprintTaskSchema) });

export type SprintPlan = z.output<typeof sprintPlanSchema>;

// スプリントの作成、変更、削除を 409 の conflict で断った理由（details.reason）。
// overlap は同じワークスペースの削除していないスプリント（終了したものも含む）と期間が重なる（2つの画面から同時に作った後の方を含む）、
// started は始まった（進行中か終了した）スプリントを変えようとした、または削除しようとした
export const sprintConflictReasons = ['overlap', 'started'] as const;
export type SprintConflictReason = (typeof sprintConflictReasons)[number];

export function sprintConflictReasonOf(details: unknown): SprintConflictReason | undefined {
  return conflictReasonOf(details, sprintConflictReasons);
}

// タスクの出し入れ（sprint-task-add、sprint-task-remove）を 409 の conflict で断った理由（details.reason）。
// closed は終了したスプリントへ入れようとした、または終了したスプリントから外そうとした（終了したスプリントの中身は変えない）、
// completed は完了したタスクを入れようとした、または外そうとした（外すときは、先に完了を戻す）
export const sprintTaskConflictReasons = ['closed', 'completed'] as const;
export type SprintTaskConflictReason = (typeof sprintTaskConflictReasons)[number];

export function sprintTaskConflictReasonOf(details: unknown): SprintTaskConflictReason | undefined {
  return conflictReasonOf(details, sprintTaskConflictReasons);
}
