import { z } from 'zod';
import { idSchema } from '../../id.ts';
import { conflictReasonOf } from '../conflict-reason.ts';
import { defineOperation } from '../define.ts';

// タスクの完了を戻すのを 409 の conflict で断った理由（details.reason）。
// not_completed は完了していないタスクを戻そうとした（2つの画面から同時に戻した後の方を含む）、
// sprint_closed は終了したか削除したスプリントの中で完了したタスクを戻そうとした（終了したスプリントの中身は変えない）、
// parent_completed は完了したストーリーの下のタスクを戻そうとした（先にストーリーの完了を取り消す）、
// changed は読んでから書くまでに別の要求がタスクを変えた（戻してからもう一度完了にした、スプリントが終わったなど）
export const taskReopenConflictReasons = ['not_completed', 'sprint_closed', 'parent_completed', 'changed'] as const;
export type TaskReopenConflictReason = (typeof taskReopenConflictReasons)[number];

export function taskReopenConflictReasonOf(details: unknown): TaskReopenConflictReason | undefined {
  return conflictReasonOf(details, taskReopenConflictReasons);
}

// タスクの完了を戻す。完了した日時と完了にした人を空に戻し、その完了の記録（completions の completed_at が tasks.completed_at と
// 同じ行）を消し、その記録で付いた打ち消されていない経験値（completion_id がその記録のもの）を打ち消しの明細で取り消す。
// 進行中のスプリントの中で完了したタスクは、完了の前にいた列（previous_column_id。空か、削除したか、完了の列なら先頭の完了でない列）の、
// そのスプリントでの末尾へ戻す。スプリントの外で完了したタスクは列なしのまま。sprint_entries は書かない。
// 変更の履歴（entity_type = 'task'、reopen）も同じ batch() で書く。無いタスク（別の組織を含む）は 404、
// 断る理由は taskReopenConflictReasons。sprint_id と column_id は戻した後の値（スプリントの外なら null）
export const taskReopen = defineOperation({
  name: 'task-reopen',
  description:
    'タスクの完了を戻し、完了の前にいた列へ戻す。完了の記録を消し、その完了で付いた経験値を打ち消し、変更の履歴も同時に書く',
  mode: 'write',
  permission: 'member',
  workspace: true,
  input: z.object({ workspace_id: idSchema, task_id: idSchema }),
  output: z.object({ task_id: z.string(), sprint_id: z.string().nullable(), column_id: z.string().nullable() }),
});
