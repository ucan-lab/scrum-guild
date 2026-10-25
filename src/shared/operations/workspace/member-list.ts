import { z } from 'zod';
import { idSchema } from '../../id.ts';
import { defineOperation } from '../define.ts';

const roleSchema = z.enum(['leader', 'member']);

// メンバーの画面が使う。members は今所属していて、無効でなく、login_subject のある人（Google で待っている行は出さない）。
// 並びはリーダーが先、続いて参加日、名前、ID。
// invitations はリーダーと管理者（所属していない管理者を含む）にだけ配列で返し、一般のメンバーには null。
// 承諾待ち（status = 'pending'）で、claim_expires_at が過ぎていないものだけ。invited_on はワークスペースのタイムゾーンでの招待した日（YYYY-MM-DD）
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
        }),
      )
      .nullable(),
  }),
});
