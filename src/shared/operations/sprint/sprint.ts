import { z } from 'zod';
import { conflictReasonOf } from '../conflict-reason.ts';

// 計画の画面が出すスプリントの項目。作る操作と変える操作が、書いた後の値として返す。
// name が null のスプリントは、画面が期間を名前として出す。length は開始日から最終日までの日数（両端を含む）。
// goal は始めるときに書くゴールで、始まっていないスプリントと、ゴールを書かずに始めたスプリントは null
export const sprintSummarySchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  goal: z.string().nullable(),
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

// スプリントの画面（sprint-board）のカード。完了したタスクは completed_at を持つ。
// story は親のストーリー（カードの上に題を添える）。親のないタスクは null。
// due_on（期日）と repository（振ったリポジトリ。削除したものは null）は、カードの .card-meta に出す。
// reopenable は、完了を戻せる（task-reopen）完了したカード。完了したストーリーの下のカードと、完了していないカードは偽
// （書き込めるか、閉じたワークスペースかは画面が見る）
export const sprintBoardTaskSchema = z.object({
  id: z.string(),
  title: z.string(),
  points: z.number().int().nullable(),
  assignee: z.object({ id: z.string(), name: z.string() }).nullable(),
  completed_at: z.string().nullable(),
  reopenable: z.boolean(),
  story: z.object({ id: z.string(), title: z.string() }).nullable(),
  due_on: z.string().nullable(),
  repository: z.object({ id: z.string(), name: z.string() }).nullable(),
});

export type SprintBoardTask = z.output<typeof sprintBoardTaskSchema>;

// 列（完了の列は name が null で is_done が真。画面は辞書の「完了」を出す）と、その列のカード（列の中の並びの順）
export const sprintBoardColumnSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  is_done: z.boolean(),
  tasks: z.array(sprintBoardTaskSchema),
});

export type SprintBoardColumn = z.output<typeof sprintBoardColumnSchema>;

// 一覧（sprint-list）の行。スプリントの項目に、入っているタスクを足したもの
export const sprintPlanSchema = sprintSummarySchema.extend({ tasks: z.array(sprintTaskSchema) });

export type SprintPlan = z.output<typeof sprintPlanSchema>;

// スプリントの作成、変更、削除、開始を 409 の conflict で断った理由（details.reason）。
// overlap は同じワークスペースの削除していないスプリント（終了したものも含む）と期間が重なる（2つの画面から同時に作った後の方を含む）、
// started は始まった（進行中か終了した）スプリントを変えようとした、削除しようとした、または始めようとした、
// active_exists は進行中のスプリントが既にあるのに始めようとした（2つの画面から同時に始めた後の方を含む）、
// ended は最終日がワークスペースの今日より前のスプリントを始めようとした
export const sprintConflictReasons = ['overlap', 'started', 'active_exists', 'ended'] as const;
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
