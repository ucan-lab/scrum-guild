import { z } from 'zod';
import { idSchema } from '../../id.ts';
import { defineOperation } from '../define.ts';

// エピックを並べ替える。並べる範囲は、ワークスペースの削除していないエピックの全部（完了と中止したエピックも含む）。
// after_epic_id は直前に置くエピックで、null は先頭、省くと末尾。直前のエピックが無い（削除済み、別のワークスペースや
// 別の組織を含む）か、移すエピックが無ければ 404、移すエピック自身なら 400 の invalid_input。
// 409 の conflict の理由は task-move.ts の moveConflictReasons（changed、ties）。親が無いので、並べ替えは変更の履歴に残さない
export const epicMove = defineOperation({
  name: 'epic-move',
  description: 'エピックを並べ替える。指したエピックの直後（null は先頭、省くと末尾）に置く',
  mode: 'write',
  permission: 'member',
  workspace: true,
  input: z.object({
    workspace_id: idSchema,
    epic_id: idSchema,
    after_epic_id: idSchema.nullable().optional(),
  }),
  output: z.object({ epic_id: z.string() }),
});
