import { z } from 'zod';
import { themes } from '../../theme.ts';
import { defineOperation } from '../define.ts';

const theme = z.enum(themes);

// 組織の枠が使う。画面の data-theme は me.theme、なければ organization.theme。
// 呼ぶと、この組織に最後に入った日時（users.last_seen_at）を1時間に1回まで書く
export const organizationInfo = defineOperation({
  name: 'organization',
  description: '組織の名前、言葉づかい、既定のテーマと、この組織での自分、所属するワークスペースを返す',
  mode: 'read',
  permission: 'organization',
  input: z.object({}),
  output: z.object({
    organization: z.object({ name: z.string(), vocabulary: z.enum(['game', 'scrum']), theme }),
    me: z.object({ id: z.string(), name: z.string(), is_admin: z.boolean(), theme: theme.nullable() }),
    workspaces: z.array(z.object({ id: z.string(), name: z.string(), role: z.enum(['leader', 'member']) })),
  }),
});
