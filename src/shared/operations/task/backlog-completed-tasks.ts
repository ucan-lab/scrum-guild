import { z } from 'zod';
import { idSchema } from '../../id.ts';
import { taskPointsSchema } from '../../task.ts';
import { defineOperation } from '../define.ts';

// 続きの位置。completed_at は tasks に書く形（toISOString の、ミリ秒まで UTC の日時）だけを受け付ける。
// 並べ順（completed_at の降順、同じなら id の降順）の最後の行を指し、次の before に渡すと、その行より後ろ（古い方）から読む
const cursorSchema = z.object({ completed_at: z.iso.datetime({ precision: 3 }), id: idSchema });

// 完了したバックログのタスクの1行。画面が行に出す項目だけ。本文と受け入れ基準は載せず、題から引き出しを開いて読む
export const completedBacklogTaskSchema = z.object({
  id: z.string(),
  title: z.string(),
  // 今のポイント。完了したタスクのポイントは変えられないので、完了した時点の値と同じ。未見積もりは null
  points: taskPointsSchema.nullable(),
  // 完了した日時（UTC）。画面はブラウザのタイムゾーンの日付にして出す
  completed_at: z.string(),
  // 今の担当。いなければ null。名前は、離脱済みの人でも出す
  assignee: z.object({ id: z.string(), name: z.string() }).nullable(),
});

// バックログの木（backlog-tree）は完了したタスクの行を返さず件数だけ返す。画面で完了の折りたたみを開いたときに、この操作で行を読む。
// 対象は、削除していない、完了した、バックログ（tray = 'backlog'）のタスク。story_id にストーリーの ID を渡すとその配下、null なら親のないもの。
// ストーリーが無い（別の組織、別のワークスペース、削除済みを含む）ときは 404。完了したストーリーは読める。閉じたワークスペースでも読める。
// 並べ順は completed_at の降順、同じなら id の降順。続きは、応答の next を次の before に渡して読む。
// limit は1回に返す件数の上限（1〜200、既定20）。木を読み直すとき、画面は出していた件数ぶんを limit に渡して先頭から読み直す
export const backlogCompletedTasks = defineOperation({
  name: 'backlog-completed-tasks',
  description: '完了したバックログのタスクを新しい順に読み、続きの印を返す',
  mode: 'read',
  permission: 'member',
  workspace: true,
  input: z.object({
    workspace_id: idSchema,
    // ストーリーの ID か、null（親のないタスク）
    story_id: idSchema.nullable(),
    // 前の応答の next。省くと先頭（いちばん新しい完了）から読む
    before: cursorSchema.optional(),
    limit: z.number().int().min(1).max(200).default(20),
  }),
  output: z.object({
    // 並べ順のとおり。limit 件まで
    tasks: z.array(completedBacklogTaskSchema),
    // 続きがあれば、tasks の最後の行の位置。無ければ null
    next: cursorSchema.nullable(),
  }),
});
export type CompletedBacklogTask = z.output<typeof completedBacklogTaskSchema>;
export type CompletedBacklogCursor = z.output<typeof cursorSchema>;
