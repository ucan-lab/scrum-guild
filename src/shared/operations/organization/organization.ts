import { z } from 'zod';
import { themes } from '../../theme.ts';
import { defineOperation } from '../define.ts';

const theme = z.enum(themes);

// 組織の枠が使う。画面の data-theme は me.theme、なければ organization.theme。
// 読む操作だが、呼ぶと、この組織に最後に入った日時（users.last_seen_at）を1時間に1回まで書く。
// この書き込みは応答を待たせず、失敗しても応答は返す
export const organizationInfo = defineOperation({
  name: 'organization',
  description:
    '組織の名前、既定のテーマと、この組織での自分、所属するワークスペースを返す。呼ぶと last_seen_at を書く（1時間に1回まで）',
  mode: 'read',
  permission: 'organization',
  input: z.object({}),
  output: z.object({
    organization: z.object({
      name: z.string(),
      theme,
      // 組織にワークスペースが1つでもあるか（所属していないものと、閉じたものを含む）。最初のワークスペースを作る案内の判定に使う
      has_workspaces: z.boolean(),
    }),
    // level は自分のレベル（組織の中の経験値の合計から出す）。アカウントのメニューの紋章に使い、経験値の数値は返さない
    me: z.object({
      id: z.string(),
      name: z.string(),
      is_admin: z.boolean(),
      theme: theme.nullable(),
      level: z.number().int(),
    }),
    workspaces: z.array(z.object({ id: z.string(), name: z.string(), role: z.enum(['leader', 'member']) })),
  }),
});
