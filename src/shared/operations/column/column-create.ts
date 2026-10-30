import { z } from 'zod';
import { columnNameSchema } from '../../column.ts';
import { idSchema } from '../../id.ts';
import { defineOperation } from '../define.ts';
import { columnSchema } from './column.ts';

// 列を足す。位置は完了以外の列の末尾（完了の列は常にその後ろ）。名前は前後の空白を除いて 1〜30 字で、同じワークスペースの
// 削除していない完了以外の列と同じ名前は 409 の conflict（duplicate_name）。削除していない完了以外の列が 12 件あれば
// 409 の conflict（limit）。どちらも書く文の条件で守る。変更の履歴（entity_type = 'workspace'、update、{"column": [null, {id, name}]}）も
// 同じ batch() で書く。閉じたワークスペースは 409 の workspace_closed
export const columnCreate = defineOperation({
  name: 'column-create',
  description: '列を足す。位置は完了以外の列の末尾',
  mode: 'write',
  permission: 'leader',
  workspace: true,
  input: z.object({ workspace_id: idSchema, name: columnNameSchema }),
  output: z.object({ column: columnSchema }),
});
