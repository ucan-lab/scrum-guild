import { z } from 'zod';
import { idSchema } from '../../id.ts';
import { defineOperation } from '../define.ts';
import { sprintPlanSchema } from './sprint.ts';

// 計画の画面が並べる、削除していない先のスプリント（planned）と進行中のスプリント（active）を開始日の順に返す。
// 各スプリントには、入っている削除していないタスク（tasks。件数はその長さ）を、列の順（ORDER BY is_done, position）、
// その中の column_position、id の順で添える。
// あわせて、作るときの初期値（前のスプリントの最終日の翌日と同じ長さ。前が無ければ、今日より後で最初の週の始まりと 14 日）と、
// ワークスペースのタイムゾーンでの今日の日付を返す。閉じたワークスペースでも読める
export const sprintList = defineOperation({
  name: 'sprint-list',
  description:
    '先のスプリントと進行中のスプリントを、入っているタスクと一緒に開始日の順に返し、作るときの初期値（開始日と長さ）を添える',
  mode: 'read',
  permission: 'member',
  workspace: true,
  input: z.object({ workspace_id: idSchema }),
  output: z.object({
    sprints: z.array(sprintPlanSchema),
    defaults: z.object({ start_on: z.string(), length: z.number().int() }),
  }),
});
