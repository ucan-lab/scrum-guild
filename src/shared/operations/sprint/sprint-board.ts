import { z } from 'zod';
import { idSchema } from '../../id.ts';
import { defineOperation } from '../define.ts';
import { sprintBoardColumnSchema, sprintSummarySchema } from './sprint.ts';

// スプリントの画面が並べる、進行中のスプリントと、列とカード。進行中のスプリントが無ければ sprint は null で columns は空。
// 列は削除していないもので、ORDER BY is_done, position, id の順（完了の列は最後）。カードは、その列に入っている削除していない
// タスクを column_position、id の順に並べる。完了したタスク（completed_at がある）は完了の列に置く。
// 親のストーリーの題と担当の名前、期日、リポジトリの名前も添える。today はワークスペースのタイムゾーンでの今日の日付
// （「N 日のうち M 日目」と期日の印を出す）で、week_start はワークスペースの週の始まり。
// 閉じたワークスペースでも読める
export const sprintBoard = defineOperation({
  name: 'sprint-board',
  description: '進行中のスプリントの列とカードを、列の中の並びの順に返す。進行中が無ければ sprint は null',
  mode: 'read',
  permission: 'member',
  workspace: true,
  input: z.object({ workspace_id: idSchema }),
  output: z.object({
    sprint: sprintSummarySchema.nullable(),
    columns: z.array(sprintBoardColumnSchema),
    today: z.string(),
    // 週の始まり（0 が日曜）。カードの期日の印を決める
    week_start: z.number().int(),
  }),
});
