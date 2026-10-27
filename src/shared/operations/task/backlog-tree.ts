import { z } from 'zod';
import { backlogQuerySchema } from '../../backlog-filter.ts';
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
    // 配下の未完了のタスクの件数。絞っても全体の値（絞って出していない行も数える。完了にできるかの判定に使う）
    open_task_count: z.number().int(),
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

// 絞り込みの帯の選択肢のうち、木から作れないもの（絞ると木から消えるため）。区分とリポジトリは category-repository-list で読む。
// - assignees: 今所属している人（current が真。名前の順）と、その後に、離脱した人のうち未完了のバックログのタスクの担当に残っている人
// - epics: 削除していないエピック（完了と中止したものも含め、position の順。finished は完了か中止したもの）
// - stories: 絞っているときだけ、完了していないストーリーを木の順（エピックの順にその下のもの、続けて親のないもの）で返す。
//   絞って木から消えたストーリーも、起票と親を移すダイアログで親に選べるようにするため。絞っていなければ null（木から作れる）
export const backlogChoicesSchema = z.object({
  assignees: z.array(z.object({ id: z.string(), name: z.string(), current: z.boolean() })),
  epics: z.array(z.object({ id: z.string(), title: z.string(), finished: z.boolean() })),
  stories: z
    .array(
      z.object({
        id: z.string(),
        title: z.string(),
        epic_id: z.string().nullable(),
        // 引き継ぎを解いた区分（起票のダイアログが、この親を選んだときに出す）
        category: definitionRefSchema.nullable(),
      }),
    )
    .nullable(),
});

export type BacklogChoices = z.output<typeof backlogChoicesSchema>;

// 絞り込みの値。ID か null（なし）。省けば絞らない（すべて）
const filterRefSchema = idSchema.nullable().optional();

// バックログの木。最上段は「エピック」「親のないストーリー」「親のない未完了のタスク」の3段で、それぞれ position の順。
// エピックは、完了と中止したものも含めて、削除していないものを返す。
// 完了したタスクは行を返さず件数だけ返す（使い続けるほど重くなるため）。件数に上限は付けない（5 万件で測った数は docs/data-model.md）。
// today はワークスペースのタイムゾーンでの今日、week_start は週の始まり（0〜6、0 が日曜）。期日の印はこの2つで決める
// （ブラウザの時計とタイムゾーンに頼らない）。
// 絞り込み（docs/requirements.md の「絞り込みと検索」）。どれも省けば絞らず、省いたときの応答は絞り込みを足す前と同じ。
// 違う種類の絞り込みは「かつ」で組み合わせる。当たったかどうかはタスクで決め、当たったタスクの親のストーリーとエピックを道筋として残す。
// - assignee_user_id: 担当の ID か、'me'（呼んだ人）か、null（担当なし）
// - category_id: 引き継ぎを解いた区分（エピック、ストーリー、タスクの順）の ID か null（区分なし）
// - repository_id: リポジトリの ID か null（リポジトリなし）
// - epic_id: エピックの ID か null（エピックなし。親のないストーリーと親のないタスクだけ）
// - query: タイトルの検索。空白（半角、全角）で語に分け、どの語も1つの行のタイトルに含むときに当たる（instr と lower。英字の大文字と小文字は区別しない）
// 区分、エピック、検索は、ストーリーとエピックそのものにも当てる。親が当たれば、配下のタスクのうちほかの条件にも当たるものを全部出す。
// 担当かリポジトリでも絞っているときは、当たるタスクを持たない親を出さない。
// 別のワークスペースや別の組織の ID は、何にも当たらない（404 にはしない）。
// 絞っても、ポイントの合計と完了の件数は、そのストーリーとエピックの全体の値を返す。絞っているときは、親のない完了の件数を返さない（null）
export const backlogTree = defineOperation({
  name: 'backlog-tree',
  description:
    'バックログの木を返す。エピック（配下のストーリーとポイントの合計つき）、親のないストーリー（配下の未完了のタスク、完了した件数、ポイントの合計つき）と、親のない未完了のタスク、完了した親のないタスクの件数、絞り込みの担当とエピックの選択肢。担当、区分、リポジトリ、エピック、タイトルの検索で絞れる',
  mode: 'read',
  permission: 'member',
  workspace: true,
  input: z.object({
    workspace_id: idSchema,
    assignee_user_id: z
      .union([z.literal('me'), idSchema])
      .nullable()
      .optional(),
    category_id: filterRefSchema,
    repository_id: filterRefSchema,
    epic_id: filterRefSchema,
    query: backlogQuerySchema.optional(),
  }),
  output: z.object({
    today: z.string(),
    week_start: z.number().int().min(0).max(6),
    epics: z.array(backlogEpicSchema),
    stories: z.array(backlogStorySchema),
    tasks: z.array(backlogTaskSchema),
    completed_count: z.number().int().nullable(),
    choices: backlogChoicesSchema,
  }),
});
