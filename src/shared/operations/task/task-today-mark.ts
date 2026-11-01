import { z } from 'zod';
import { idSchema } from '../../id.ts';
import { conflictReasonOf } from '../conflict-reason.ts';
import { defineOperation } from '../define.ts';

// タスクの今日やるの印を付け外すのを 409 の conflict で断った理由（details.reason）。
// not_assignee は担当者本人のタスクでない（担当のいないタスクと、別の人のタスクを含む）、
// completed は完了したタスクに印を付け外そうとした（完了したタスクの印は今日やることの区分に使わない）。
// 読んでから書くまでに別の要求が担当か印を変え続けて 3 回のやり直しを超えたときは、reason の無い conflict
export const taskTodayMarkConflictReasons = ['not_assignee', 'completed'] as const;
export type TaskTodayMarkConflictReason = (typeof taskTodayMarkConflictReasons)[number];

export function taskTodayMarkConflictReasonOf(details: unknown): TaskTodayMarkConflictReason | undefined {
  return conflictReasonOf(details, taskTodayMarkConflictReasons);
}

// タスクに今日やるの印（tasks.today_on）を付けるか外す。印を付けられるのは、担当者本人の未完了のタスクだけ
// （担当者でなければ 409 の conflict、reason は not_assignee。完了していれば reason は completed）。
// 付けるとき（marked が真）の today_on は、そのワークスペースのタイムゾーンでの今日の日付。外すとき（偽）は null。
// すでにその状態なら（付いているところへ付ける、付いていないところを外す）何も書かず、履歴も残さず、今の値を返す。
// 付いている印を付け直しても、日付は今日に書き換えない（持ち越しの日数を変えないため）。
// 無いタスク（別の組織・別のワークスペース・削除済み、バックログでない受信箱とアーカイブのタスクを含む）は 404。閉じたワークスペースは、すでにその状態でも 409 の workspace_closed。
// 書く文は「読んだ担当のまま」「読んだ today_on のまま」「完了していない」「ワークスペースが開いている」を条件にし、
// 負けたら読み直してやり直す（3 回まで。超えたら 409 の conflict）。変更の履歴は {"today_on": [前, 後]}。
// 返すのは、書いた後（か、何も書かなかったとき読んだ）today_on
export const taskTodayMark = defineOperation({
  name: 'task-today-mark',
  description: '自分が担当する未完了のタスクに、今日やるの印を付けるか外す。付ける日付はワークスペースの今日',
  mode: 'write',
  permission: 'member',
  workspace: true,
  input: z.object({
    workspace_id: idSchema,
    task_id: idSchema,
    marked: z.boolean(),
  }),
  output: z.object({ task_id: z.string(), today_on: z.string().nullable() }),
});
