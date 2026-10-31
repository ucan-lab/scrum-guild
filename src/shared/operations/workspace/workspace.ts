import { z } from 'zod';
import { idSchema } from '../../id.ts';
import { defineOperation } from '../define.ts';

// ワークスペースの枠が使う。
// role は自分の今のロール。所属していない管理者では null。
// definition_of_done_md は完成の定義（Markdown）で、空なら null。バックログの画面と詳細の引き出しの完了の操作の横、設定の画面が使う
export const workspaceInfo = defineOperation({
  name: 'workspace',
  description: 'ワークスペースの名前、閉じた日時、完成の定義（空なら空）と、自分のロール（所属していなければ空）を返す',
  mode: 'read',
  permission: 'member',
  workspace: true,
  input: z.object({ workspace_id: idSchema }),
  output: z.object({
    name: z.string(),
    closed_at: z.string().nullable(),
    definition_of_done_md: z.string().nullable(),
    role: z.enum(['leader', 'member']).nullable(),
  }),
});
