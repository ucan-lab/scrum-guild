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

// スプリントの作成、変更、削除を 409 の conflict で断った理由（details.reason）。
// overlap は同じワークスペースの削除していないスプリント（終了したものも含む）と期間が重なる（2つの画面から同時に作った後の方を含む）、
// started は始まった（進行中か終了した）スプリントを変えようとした、または削除しようとした
export const sprintConflictReasons = ['overlap', 'started'] as const;
export type SprintConflictReason = (typeof sprintConflictReasons)[number];

export function sprintConflictReasonOf(details: unknown): SprintConflictReason | undefined {
  return conflictReasonOf(details, sprintConflictReasons);
}
