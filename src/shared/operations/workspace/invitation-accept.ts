import { z } from 'zod';
import { idSchema } from '../../id.ts';
import { defineOperation } from '../define.ts';

// 自分に届いた承諾待ちの招待を承諾し、そのワークスペースのメンバーになる。同じ組織に同じログインの users の行が無ければ作り
// （名前はログインの手段の側の名前）、あればその行のまま所属する（前に抜けた人は同じユーザーとして戻り、経験値も引き継ぐ）。
// users、memberships、invitations（accepted）、change_logs（招待の更新と所属の作成の2行）を1回の batch で書く。
// 断る順は、無い（別の人、別の組織の招待を含む）404、承諾待ちでない 409 の conflict、閉じたワークスペース 409 の workspace_closed、
// 既にそのワークスペースに所属している 409 の already_member。この組織で無効にされた人は、組織に入れないので 404。
// 人数の上限は見ない（承諾待ちの招待は、もう人数に数えている）。workspace_id は、画面が移る先
export const invitationAccept = defineOperation({
  name: 'invitation-accept',
  description:
    '自分に届いた承諾待ちの招待を承諾して、そのワークスペースのメンバーになる。変更の履歴にも残す。承諾待ちでなければ 409',
  mode: 'write',
  permission: 'invitee',
  input: z.object({ invitation_id: idSchema }),
  output: z.object({ workspace_id: z.string() }),
});
