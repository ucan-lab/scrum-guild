import { z } from 'zod';
import { idSchema } from '../../id.ts';
import { sprintEndOn, sprintLengthSchema, sprintNameSchema, sprintStartOnSchema } from '../../sprint.ts';
import { defineOperation } from '../define.ts';
import { sprintSummarySchema } from './sprint.ts';

// 先のスプリント（planned）を作る。開始日、長さ（1〜28 日）、名前（任意。空は null）を指す。開始日が今日より前でも作れる。
// 同じワークスペースの削除していないスプリント（終了したものも含む）と期間が重なれば 409 の conflict（details.reason は overlap）。
// 重なりは書く文の条件で見るので、2つの画面から同時に作っても重ならない。変更の履歴（entity_type = 'sprint'、create）も同時に書く
export const sprintCreate = defineOperation({
  name: 'sprint-create',
  description:
    '先のスプリントを作る。開始日、長さ（1〜28 日）、名前（任意）を指す。期間はほかのスプリントと重ねられない',
  mode: 'write',
  permission: 'leader',
  workspace: true,
  input: z
    .object({
      workspace_id: idSchema,
      start_on: sprintStartOnSchema,
      length: sprintLengthSchema,
      name: sprintNameSchema.default(null),
    })
    .refine((input) => sprintEndOn(input.start_on, input.length) !== null, {
      message: '最終日が暦を外れる',
      path: ['length'],
    }),
  output: z.object({ sprint: sprintSummarySchema }),
});
