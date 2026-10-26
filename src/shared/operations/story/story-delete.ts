import { z } from 'zod';
import { idSchema } from '../../id.ts';
import { defineOperation } from '../define.ts';
import { deleteChildrenSchema } from '../delete-children.ts';

// ストーリーを削除する。論理削除（deleted_at を書く）で、変更の履歴（delete）も同時に書く。完了の記録と経験値は残る。
// 配下の扱い（children）は必須。keep は配下のタスクを親なしにし（区分はストーリーが引き継いでいた区分を写す。位置は親のないタスクの
// 末尾に、元の並びのまま）、delete は配下のタスク（完了したものも含む）をまとめて削除する。取り込んだタスクは削除せずアーカイブへ移す。
// 削除できるのは、作った人とリーダー（管理者を含む）。それ以外は 403 の forbidden。
// 無いストーリー（別の組織・別のワークスペース・削除済みを含む）は、権限より先に 404
export const storyDelete = defineOperation({
  name: 'story-delete',
  description:
    'ストーリーを論理削除する。配下のタスクを親なしで残すか、まとめて削除するかを選ぶ。作った人とリーダー（管理者を含む）だけが削除できる',
  mode: 'write',
  permission: 'member',
  workspace: true,
  input: z.object({ workspace_id: idSchema, story_id: idSchema, children: deleteChildrenSchema }),
  output: z.object({ story_id: z.string() }),
});
