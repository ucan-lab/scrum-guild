import { z } from 'zod';
import { idSchema } from '../../id.ts';
import { defineOperation } from '../define.ts';
import { columnSchema } from './column.ts';

// ワークスペースの列の一覧。スプリントの画面の列の並びと設定が使う。削除した列は返さない。
// 並びは ORDER BY is_done, position, id（完了の列は常に最後。完了の列の name は空）。閉じたワークスペースでも読める
export const columnList = defineOperation({
  name: 'column-list',
  description: 'ワークスペースの列を、並びの順（完了の列は最後）に返す。完了の列の name は空',
  mode: 'read',
  permission: 'member',
  workspace: true,
  input: z.object({ workspace_id: idSchema }),
  output: z.object({ columns: z.array(columnSchema) }),
});
