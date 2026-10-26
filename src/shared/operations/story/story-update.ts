import { z } from 'zod';
import { idSchema } from '../../id.ts';
import { dueOnSchema, linkUrlSchema, longTextSchema, storyTitleSchema } from '../../story.ts';
import { defineOperation } from '../define.ts';
import { storyDetailSchema } from './story.ts';

// ストーリーの欄を変える。送られた欄のうち、今の値と違うものだけを書く（送られない欄は触らない）。
// ダイアログを開いたときの値から変えた欄だけを送ると、別の人が別の欄を直していても両方が残り、同じ欄は後の保存が勝つ。
// 変わる欄が無ければ何も書かない（履歴も残さない）。無いストーリー（別の組織・別のワークスペース・削除済みを含む）は 404。
// 書く文は「読んだ値のままなら」という条件つきで、別の要求が先に同じ欄を変えていたら、読み直してやり直す（3 回まで。超えたら 409 の conflict）。
// 区分（category_id）は親のないストーリーだけが持つ。エピックの下のストーリーへ送ると 409 の conflict（has_parent）、
// 同じワークスペースの削除していない区分でなければ 404。
// 返すのは、書いた後に読み直した値
export const storyUpdate = defineOperation({
  name: 'story-update',
  description:
    'ストーリーのタイトル、受け入れ基準、本文、期日、リンク、区分（親のないものだけ）のうち、送った欄だけを変える。変わる欄が無ければ何も書かない',
  mode: 'write',
  permission: 'member',
  workspace: true,
  input: z.object({
    workspace_id: idSchema,
    story_id: idSchema,
    title: storyTitleSchema.optional(),
    acceptance_criteria_md: longTextSchema.optional(),
    body_md: longTextSchema.optional(),
    due_on: dueOnSchema.optional(),
    link_url: linkUrlSchema.optional(),
    category_id: idSchema.nullable().optional(),
  }),
  output: z.object({ story: storyDetailSchema }),
});
