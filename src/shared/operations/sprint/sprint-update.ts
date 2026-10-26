import { z } from 'zod';
import { idSchema } from '../../id.ts';
import { sprintLengthSchema, sprintNameSchema, sprintStartOnSchema } from '../../sprint.ts';
import { defineOperation } from '../define.ts';
import { sprintSummarySchema } from './sprint.ts';

// 始まる前のスプリント（planned）の名前、開始日、長さのうち、送った欄だけを変える。書き方は story-update と同じで、
// 今の値と違う列（name、start_on、end_on）だけを「読んだ値のままなら」という条件つきで書く（別の要求が先に同じ列を変えていたら、
// 読み直してやり直す。3 回まで。超えたら 409 の conflict）。変わる列が無ければ何も書かない（履歴も残さない）。
// 期間がほかのスプリントと重なれば 409 の conflict（overlap）、始まったスプリントは 409 の conflict（started）。
// 最終日が暦を外れる組み合わせは 400。無いスプリント（別の組織・別のワークスペース・削除済みを含む）は 404。返すのは、書いた後に読み直した値
export const sprintUpdate = defineOperation({
  name: 'sprint-update',
  description:
    '始まる前のスプリントの名前、開始日、長さのうち、送った欄だけを変える。期間はほかのスプリントと重ねられない',
  mode: 'write',
  permission: 'leader',
  workspace: true,
  input: z.object({
    workspace_id: idSchema,
    sprint_id: idSchema,
    name: sprintNameSchema.optional(),
    start_on: sprintStartOnSchema.optional(),
    length: sprintLengthSchema.optional(),
  }),
  output: z.object({ sprint: sprintSummarySchema }),
});
