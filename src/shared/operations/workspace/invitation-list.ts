import { z } from 'zod';
import { themes } from '../../theme.ts';
import { defineOperation } from '../define.ts';

// 招待の画面（/<slug>/invitations と、組織に入れず招待だけがある人の組織の枠）が使う。
// invitations は、この組織のワークスペースへの承諾待ちの招待のうち、呼んだ人のアカウントに結んだログイン（手段と ID の組のどれか）に
// 当たるもの。Google の招待で login_subject が空のもの（URL から結ぶ前）は当たらない。閉じたワークスペースへの招待も出し、closed で示す
// （承諾はできず、辞退はできる）。並びは招待した日時、ID の順。invited_by_name は招待した人の今の名前（組織で絞った users）。
// invited_on は招待した日（ワークスペースのタイムゾーンの YYYY-MM-DD）。
// organization は組織の名前と既定のテーマ。招待だけの人は organization の操作を読めないので、画面がこれでテーマを当てる
export const invitationList = defineOperation({
  name: 'invitation-list',
  description: '自分に届いた、この組織のワークスペースへの承諾待ちの招待と、組織の名前、既定のテーマを返す',
  mode: 'read',
  permission: 'invitee',
  input: z.object({}),
  output: z.object({
    organization: z.object({
      name: z.string(),
      theme: z.enum(themes),
    }),
    invitations: z.array(
      z.object({
        invitation_id: z.string(),
        workspace_id: z.string(),
        workspace_name: z.string(),
        closed: z.boolean(),
        role: z.enum(['leader', 'member']),
        invited_by_name: z.string(),
        invited_on: z.string(),
      }),
    ),
  }),
});
