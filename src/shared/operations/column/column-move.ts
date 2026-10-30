import { z } from 'zod';
import { idSchema } from '../../id.ts';
import { defineOperation } from '../define.ts';

// 列を並べ替える。after_column_id は直前に置く完了以外の列で、null は先頭、省くと末尾（完了の列は常に最後で、並びに入らない）。
// 直前の列が無い（削除済み、別のワークスペース、完了の列を含む）ときは 404、動かす列自身なら 400 の invalid_input。
// 動かす列が無い（完了の列、別の組織を含む）ときは 404。409 の conflict の理由は task-move.ts の moveConflictReasons（changed、ties）。
// 並べ替えは変更の履歴に残さない
export const columnMove = defineOperation({
  name: 'column-move',
  description: '列を並べ替える。指した列の直後（null は先頭、省くと末尾）に置く。完了の列は動かせない',
  mode: 'write',
  permission: 'leader',
  workspace: true,
  input: z.object({
    workspace_id: idSchema,
    column_id: idSchema,
    after_column_id: idSchema.nullable().optional(),
  }),
  output: z.object({ column_id: z.string() }),
});
