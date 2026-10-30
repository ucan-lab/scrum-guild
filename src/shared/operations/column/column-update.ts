import { z } from 'zod';
import { columnNameSchema } from '../../column.ts';
import { idSchema } from '../../id.ts';
import { defineOperation } from '../define.ts';
import { columnSchema } from './column.ts';

// 列の名前を直す。今の名前と違うときだけ、読んだ名前のままなら、という条件つきで書き、変更の履歴
// （entity_type = 'workspace'、update、{"column": [{id, name: 前}, {id, name: 後}]}）を残す。
// 同じ名前の列があれば 409 の conflict（duplicate_name）。完了の列は名前を持たず直せないので、無い列（別の組織、別のワークスペース、
// 削除済みを含む）と同じ 404
export const columnUpdate = defineOperation({
  name: 'column-update',
  description: '列の名前を直す。完了の列は直せない',
  mode: 'write',
  permission: 'leader',
  workspace: true,
  input: z.object({ workspace_id: idSchema, column_id: idSchema, name: columnNameSchema }),
  output: z.object({ column: columnSchema }),
});
