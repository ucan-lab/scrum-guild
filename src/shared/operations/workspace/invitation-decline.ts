import { z } from 'zod';
import { idSchema } from '../../id.ts';
import { defineOperation } from '../define.ts';

// 自分に届いた承諾待ちの招待を辞退する。invitations の status を declined にし、responded_at を書き、change_logs（action: update）を
// 1回の batch で書く。閉じたワークスペースへの招待も辞退できる。
// 無い招待（別の人、別の組織の招待を含む）は 404、承諾待ちでなければ（承諾、辞退、取り消し済み）409 の conflict
export const invitationDecline = defineOperation({
  name: 'invitation-decline',
  description: '自分に届いた承諾待ちの招待を辞退する。変更の履歴にも残す。承諾待ちでなければ 409 の conflict',
  mode: 'write',
  permission: 'invitee',
  input: z.object({ invitation_id: idSchema }),
  output: z.object({ invitation_id: z.string() }),
});
