import { z } from 'zod';
import { idSchema } from '../../id.ts';
import { defineOperation } from '../define.ts';

// ワークスペースを閉じる（読み取り専用にする）。workspaces の closed_at と change_logs（action: close）を1回の batch で書く。
// すでに閉じていれば 409 の workspace_closed（登録の関数が止める。書く文の条件も closed_at IS NULL で、読んだ後に閉じられた競合を止める）。
// 接続の停止は、同期が closed_at を見て飛ばす形にするので、ここでは書かない
export const workspaceClose = defineOperation({
  name: 'workspace-close',
  description:
    'ワークスペースを閉じて読み取り専用にする。閉じた日時を書き、変更の履歴にも残す。すでに閉じていれば 409 の workspace_closed',
  mode: 'write',
  permission: 'admin',
  workspace: true,
  input: z.object({ workspace_id: idSchema }),
  output: z.object({ workspace_id: z.string(), closed_at: z.string() }),
});
