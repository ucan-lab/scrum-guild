import { z } from 'zod';
import { idSchema } from '../../id.ts';
import { sprintGoalSchema, sprintLengthSchema, sprintNameSchema, sprintStartOnSchema } from '../../sprint.ts';
import { defineOperation } from '../define.ts';
import { sprintSummarySchema } from './sprint.ts';

// planned は名前・開始日・長さ、active は名前・ゴールの送った欄だけを変える。
// goal を planned に送れば not_active、active に期間を送るか closed を変えれば started（409）。
// 変える列が読んだ値のままで状態も変わっていなければ書く。競合時は読み直し、3回までやり直す。
// 無変更なら履歴も残さない。期間の重なりは overlap（409）、暦を外れる最終日は400、無い対象は404。
export const sprintUpdate = defineOperation({
  name: 'sprint-update',
  description: '始まる前の名前・期間、進行中の名前・ゴールを変える。期間はほかのスプリントと重ねられない',
  mode: 'write',
  permission: 'leader',
  workspace: true,
  input: z.object({
    workspace_id: idSchema,
    sprint_id: idSchema,
    name: sprintNameSchema.optional(),
    goal: sprintGoalSchema.optional(),
    start_on: sprintStartOnSchema.optional(),
    length: sprintLengthSchema.optional(),
  }),
  output: z.object({ sprint: sprintSummarySchema }),
});
