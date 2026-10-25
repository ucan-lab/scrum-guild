import { z } from 'zod';
import { idSchema } from '../../id.ts';
import { defineOperation } from '../define.ts';

const roleSchema = z.enum(['leader', 'member']);

// メンバーの画面が使う。members は今所属していて、無効でなく、login_subject のある人（Google で待っている行は出さない）。
// 並びはリーダーが先、続いて参加日、名前、ID。
// invitations はリーダーと管理者（所属していない管理者を含む）にだけ配列で返し、一般のメンバーには null。
// 承諾待ち（status = 'pending'）のものすべて。期限（Google の招待だけが持つ）の過ぎたものも返し、expired で示す。
// リーダーが期限切れに気づいて招待し直せるようにするため（docs/data-model.md の「メールアドレスで待つ指名と招待」）。
// invited_on と expires_on はワークスペースのタイムゾーンでの日付（YYYY-MM-DD）。expires_on は期限の無い GitHub の招待では null
export const memberList = defineOperation({
  name: 'member-list',
  description:
    'ワークスペースに今所属している人の名前、ロール、参加日と、リーダーと管理者には承諾待ちの招待（一般のメンバーには null）を返す',
  mode: 'read',
  permission: 'member',
  workspace: true,
  input: z.object({ workspace_id: idSchema }),
  output: z.object({
    members: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        role: roleSchema,
        joined_on: z.string(),
      }),
    ),
    invitations: z
      .array(
        z.object({
          id: z.string(),
          login_name: z.string(),
          login_provider: z.enum(['github', 'google']),
          role: roleSchema,
          invited_on: z.string(),
          expires_on: z.string().nullable(),
          expired: z.boolean(),
        }),
      )
      .nullable(),
  }),
});
