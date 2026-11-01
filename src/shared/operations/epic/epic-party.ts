import { z } from 'zod';
import { idSchema } from '../../id.ts';
import { defineOperation } from '../define.ts';

// 討伐隊（epic_party_members）に加わる、抜ける、割り振る。docs/data-model.md の epic_party_members と「書き込みの単位」。
// 共通の決まり:
// - 討伐隊に入れるのは、そのワークスペースに今所属し、無効でなく login_subject のある人だけ（担当にできる人と同じ）。
//   満たさなければ 404（所属していない管理者の受注も 404）
// - 無いエピック（別の組織・別のワークスペース・削除済みを含む）は 404。クリアか中止したエピックは 409 の epic_finished
//   （クリアした時点の討伐隊が報酬の記録なので、終わった後は討伐隊を変えない）。書き込みの競合に 3 回続けて負けたときは 409 の conflict
// - 既に討伐隊にいれば（入り方を問わず）何も書かずに 200。抜けるときに討伐隊にいなければ、何も書かずに 200。
//   changed は、この要求が行を足したか消したか
// - 履歴は entity_type = 'epic'、action = 'update' で、{"party_member": [null, {id, name, via}]}（抜けたら逆）
const partyOutput = z.object({ changed: z.boolean() });

// 呼んだ人が自分で受注する（joined_via = 'self'）
export const epicPartyJoin = defineOperation({
  name: 'epic-party-join',
  description: '呼んだ人がエピックを受注して討伐隊に加わる。既に討伐隊にいれば何もしない',
  mode: 'write',
  permission: 'member',
  workspace: true,
  input: z.object({ workspace_id: idSchema, epic_id: idSchema }),
  output: partyOutput,
});

// 呼んだ人が自分の行を消す。外せるのは本人だけ
export const epicPartyLeave = defineOperation({
  name: 'epic-party-leave',
  description: '呼んだ人がエピックの討伐隊を抜ける。討伐隊にいなければ何もしない',
  mode: 'write',
  permission: 'member',
  workspace: true,
  input: z.object({ workspace_id: idSchema, epic_id: idSchema }),
  output: partyOutput,
});

// 依頼主とリーダー（管理者を含む）が、今所属している人を討伐隊に割り振る（joined_via = 'assigned'）。
// 権限の種類は member で、依頼主かどうかは処理が見る。それ以外の人は 403 の forbidden
export const epicPartyAssign = defineOperation({
  name: 'epic-party-assign',
  description: 'エピックの依頼主とリーダーが、今所属している人を討伐隊に割り振る。既に討伐隊にいれば何もしない',
  mode: 'write',
  permission: 'member',
  workspace: true,
  input: z.object({ workspace_id: idSchema, epic_id: idSchema, user_id: idSchema }),
  output: partyOutput,
});
