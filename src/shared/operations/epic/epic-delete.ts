import { z } from 'zod';
import { idSchema } from '../../id.ts';
import { defineOperation } from '../define.ts';
import { deleteChildrenSchema } from '../delete-children.ts';

// エピックを削除する。論理削除（deleted_at を書く）で、変更の履歴（delete）も同時に書く。完了とクリアの記録、経験値は残る。
// 配下の扱い（children）は必須。keep は配下のストーリーを親なしにし（区分はエピックの区分を写す。位置は親のないストーリーの末尾に、
// 元の並びのまま）、その下のタスクはストーリーの下のまま。delete は配下のストーリーと、その下のタスク（完了したものも含む）を
// まとめて削除する。取り込んだタスクは削除せずアーカイブへ移す。
// 削除できるのは、作った人とリーダー（管理者を含む）。それ以外は 403 の forbidden。
// 無いエピック（別の組織・別のワークスペース・削除済みを含む）は、権限より先に 404
export const epicDelete = defineOperation({
  name: 'epic-delete',
  description:
    'エピックを論理削除する。配下のストーリーを親なしで残すか、まとめて削除するかを選ぶ。作った人とリーダー（管理者を含む）だけが削除できる',
  mode: 'write',
  permission: 'member',
  workspace: true,
  input: z.object({ workspace_id: idSchema, epic_id: idSchema, children: deleteChildrenSchema }),
  output: z.object({ epic_id: z.string() }),
});
