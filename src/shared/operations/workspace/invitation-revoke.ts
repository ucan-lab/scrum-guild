import { z } from 'zod';
import { idSchema } from '../../id.ts';
import { defineOperation } from '../define.ts';

// 承諾待ちの招待を取り消す。invitations の status を revoked にし、responded_at を書き、change_logs（action: update）を1回の batch で書く。
// 無い招待（別のワークスペース、別の組織を含む）は 404、承諾待ちでなければ（承諾、辞退、取り消し済み）409 の conflict
export const invitationRevoke = defineOperation({
  name: 'invitation-revoke',
  description: '承諾待ちの招待を取り消す。変更の履歴にも残す。承諾待ちでない招待には 409 の conflict',
  mode: 'write',
  permission: 'leader',
  workspace: true,
  input: z.object({ workspace_id: idSchema, invitation_id: idSchema }),
  output: z.object({ invitation_id: z.string() }),
});
