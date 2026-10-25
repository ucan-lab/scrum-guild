import { z } from 'zod';
import { idSchema } from '../../id.ts';
import { taskPointsSchema } from '../../task.ts';
import { defineOperation } from '../define.ts';
import { storyDetailSchema } from '../story/story.ts';

// バックログの木のタスクの1行。画面が行に出す項目だけ
export const backlogTaskSchema = z.object({
  id: z.string(),
  title: z.string(),
  points: taskPointsSchema.nullable(),
  // 期日（YYYY-MM-DD）。振っていなければ null
  due_on: z.string().nullable(),
  // 担当。いなければ null。名前は、離脱済みの人でも出す
  assignee: z.object({ id: z.string(), name: z.string() }).nullable(),
});

export type BacklogTask = z.output<typeof backlogTaskSchema>;

// 木の行が使う項目だけ。受け入れ基準と本文は長いので載せず、ダイアログを開くときに story-get で読む
export const backlogStorySchema = storyDetailSchema.omit({ acceptance_criteria_md: true, body_md: true }).extend({
  // 完了した日時。完了したストーリーは、タスクの親に選べない
  completed_at: z.string().nullable(),
  // 配下の未完了のタスク（position の順）
  tasks: z.array(backlogTaskSchema),
  // 配下の完了したタスクの件数。行は返さない
  completed_task_count: z.number().int(),
  // 配下の削除していないタスクのポイントの合計。未見積もりは 0
  points_done: z.number().int(),
  points_all: z.number().int(),
});

export type BacklogStory = z.output<typeof backlogStorySchema>;

// バックログの木。最上段は「親のないストーリー」と「親のない未完了のタスク」の2段で、それぞれ position の順。
// 完了したタスクは行を返さず件数だけ返す（使い続けるほど重くなるため）。件数に上限は付けない。
// today はワークスペースのタイムゾーンでの今日、week_start は週の始まり（0〜6、0 が日曜）。期日の印はこの2つで決める
// （ブラウザの時計とタイムゾーンに頼らない）。エピックの下のストーリーは、エピックの画面の Issue で足す
export const backlogTree = defineOperation({
  name: 'backlog-tree',
  description:
    'バックログの木を返す。親のないストーリー（配下の未完了のタスク、完了した件数、ポイントの合計つき）と、親のない未完了のタスク、完了した親のないタスクの件数',
  mode: 'read',
  permission: 'member',
  workspace: true,
  input: z.object({ workspace_id: idSchema }),
  output: z.object({
    today: z.string(),
    week_start: z.number().int().min(0).max(6),
    stories: z.array(backlogStorySchema),
    tasks: z.array(backlogTaskSchema),
    completed_count: z.number().int(),
  }),
});
