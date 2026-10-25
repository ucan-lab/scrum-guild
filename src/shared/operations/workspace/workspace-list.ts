import { z } from 'zod';
import { defineOperation } from '../define.ts';

// 組織の管理の画面が使う。閉じたワークスペースも含める。
// member_count は今の所属の人数で、リーダーを含む。leader_count はそのうちのリーダー
export const workspaceList = defineOperation({
  name: 'workspace-list',
  description:
    '組織のすべてのワークスペース（閉じたものを含む）を、名前、今のメンバー数、今のリーダー数、作った日、閉じた日時で返す',
  mode: 'read',
  permission: 'admin',
  input: z.object({}),
  output: z.object({
    workspaces: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        member_count: z.number().int(),
        leader_count: z.number().int(),
        // ワークスペースのタイムゾーンでの作った日（YYYY-MM-DD）
        created_on: z.string(),
        closed_at: z.string().nullable(),
      }),
    ),
  }),
});
