import { z } from 'zod';
import { epicTitleSchema } from '../../epic.ts';
import { idSchema } from '../../id.ts';
import { dueOnSchema, linkUrlSchema, longTextSchema } from '../../story.ts';
import { defineOperation } from '../define.ts';
import { epicDetailSchema } from './epic.ts';

// エピックの欄を変える。書き方は story-update と同じ。送られた欄のうち、今の値と違うものだけを、
// 「読んだ値のままなら」という条件つきで書く（別の要求が先に同じ欄を変えていたら、読み直してやり直す。3 回まで。超えたら 409 の conflict）。
// 変わる欄が無ければ何も書かない（履歴も残さない）。無いエピック（別の組織・別のワークスペース・削除済みを含む）は 404。
// 返すのは、書いた後に読み直した値
export const epicUpdate = defineOperation({
  name: 'epic-update',
  description: 'エピックのタイトル、本文、期日、リンクのうち、送った欄だけを変える。変わる欄が無ければ何も書かない',
  mode: 'write',
  permission: 'member',
  workspace: true,
  input: z.object({
    workspace_id: idSchema,
    epic_id: idSchema,
    title: epicTitleSchema.optional(),
    body_md: longTextSchema.optional(),
    due_on: dueOnSchema.optional(),
    link_url: linkUrlSchema.optional(),
  }),
  output: z.object({ epic: epicDetailSchema }),
});
