import { z } from 'zod';
import { idSchema } from '../../id.ts';
import { conflictReasonOf } from '../conflict-reason.ts';
import { defineOperation } from '../define.ts';

// ストーリーの完了と取り消しを 409 の conflict で断った理由（details.reason）。
// open_tasks は配下に未完了のタスクが残っている、completed はすでに完了している（2つの画面から同時に完了にした後の方を含む）、
// not_completed は完了していないストーリーを取り消そうとした、parent_completed は親のエピックが完了か中止している（完了と取り消しの両方）、
// changed は読んでから書くまでに別の要求が受け取り手を変えた（やり直しても書けなかった）
export const storyCompletionConflictReasons = [
  'open_tasks',
  'completed',
  'not_completed',
  'parent_completed',
  'changed',
] as const;
export type StoryCompletionConflictReason = (typeof storyCompletionConflictReasons)[number];

export function storyCompletionConflictReasonOf(details: unknown): StoryCompletionConflictReason | undefined {
  return conflictReasonOf(details, storyCompletionConflictReasons);
}

// ストーリーを手で完了にする。配下に削除していない未完了のバックログのタスクがあれば 409 の conflict（open_tasks）。
// 親のエピックが完了か中止していれば 409 の conflict（parent_completed。完了にすると取り消せなくなるため）。
// 配下にタスクが1件も無いストーリーも完了にできる。完了の経験値（story_completed）は、配下のタスクで打ち消されていない
// 完了の経験値（task_completed）を受け取った人に1人1回ずつ、今そのワークスペースに所属している人だけに付ける。
// 変更の履歴（entity_type = 'story'、complete）も同じ batch() で書く。無いストーリー（別の組織を含む）は 404
export const storyComplete = defineOperation({
  name: 'story-complete',
  description:
    '配下のタスクがすべて完了したストーリーを完了にし、配下のタスクで完了の経験値を受け取った人に経験値を付ける',
  mode: 'write',
  permission: 'member',
  workspace: true,
  input: z.object({ workspace_id: idSchema, story_id: idSchema }),
  output: z.object({ story_id: z.string(), completed_at: z.string() }),
});
