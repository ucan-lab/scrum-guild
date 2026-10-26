import { z } from 'zod';
import { idSchema } from '../../id.ts';
import { taskPointsSchema } from '../../task.ts';
import { defineOperation } from '../define.ts';
import { definitionRefSchema } from '../definition/definition.ts';
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
  // 引き継ぎを解いた区分（親のエピック、親のストーリー、タスク自身の順）。無ければ null
  category: definitionRefSchema.nullable(),
  // 振ったリポジトリ。無ければ null
  repository: definitionRefSchema.nullable(),
});

export type BacklogTask = z.output<typeof backlogTaskSchema>;

// 木の行が使う項目だけ。受け入れ基準と本文は長いので載せず、ダイアログを開くときに story-get で読む。
// 親は、エピックの行の配下に並べることで示す（epic_id は載せない）
export const backlogStorySchema = storyDetailSchema
  .omit({
    acceptance_criteria_md: true,
    body_md: true,
    epic_id: true,
    category: true,
  })
  .extend({
    // 引き継ぎを解いた区分（親のエピック、ストーリー自身の順）。無ければ null
    category: definitionRefSchema.nullable(),
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

// 木のエピックの行。本文は長いので載せず、ダイアログを開くときに epic-get で読む
export const backlogEpicSchema = z.object({
  id: z.string(),
  title: z.string(),
  due_on: z.string().nullable(),
  link_url: z.string().nullable(),
  // 完了（クリア）した日時と、中止した日時。どちらかが入っていれば、ストーリーの親に選べない
  completed_at: z.string().nullable(),
  canceled_at: z.string().nullable(),
  // 振った区分。配下のストーリーとタスクが引き継ぐ。無ければ null
  category: definitionRefSchema.nullable(),
  // 配下の削除していないストーリー（position の順。完了したものも含む）
  stories: z.array(backlogStorySchema),
  // 配下のストーリーのタスクのポイントの合計。未見積もりは 0
  points_done: z.number().int(),
  points_all: z.number().int(),
});

export type BacklogEpic = z.output<typeof backlogEpicSchema>;

// バックログの木。最上段は「エピック」「親のないストーリー」「親のない未完了のタスク」の3段で、それぞれ position の順。
// エピックは、完了と中止したものも含めて、削除していないものを返す。
// 完了したタスクは行を返さず件数だけ返す（使い続けるほど重くなるため）。件数に上限は付けない。
// today はワークスペースのタイムゾーンでの今日、week_start は週の始まり（0〜6、0 が日曜）。期日の印はこの2つで決める
// （ブラウザの時計とタイムゾーンに頼らない）
export const backlogTree = defineOperation({
  name: 'backlog-tree',
  description:
    'バックログの木を返す。エピック（配下のストーリーとポイントの合計つき）、親のないストーリー（配下の未完了のタスク、完了した件数、ポイントの合計つき）と、親のない未完了のタスク、完了した親のないタスクの件数',
  mode: 'read',
  permission: 'member',
  workspace: true,
  input: z.object({ workspace_id: idSchema }),
  output: z.object({
    today: z.string(),
    week_start: z.number().int().min(0).max(6),
    epics: z.array(backlogEpicSchema),
    stories: z.array(backlogStorySchema),
    tasks: z.array(backlogTaskSchema),
    completed_count: z.number().int(),
  }),
});
