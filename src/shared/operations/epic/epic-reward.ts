import { z } from 'zod';
import { epicRewardTiers } from '../../experience.ts';
import { idSchema } from '../../id.ts';
import { defineOperation } from '../define.ts';

// エピックのクリア報酬の段階と、依頼主を変える。docs/data-model.md の epics と「書き込みの単位」。
// 共通の決まり:
// - 報酬の変更の権限の種類は member で、依頼主かリーダーかは処理が見る。足りなければ 403 の forbidden。依頼主の変更は leader
// - 無いエピック（別の組織・別のワークスペース・削除済みを含む）は 404。クリアか中止したエピックは 409 の epic_finished
//   （クリアした時点の報酬と依頼主が記録なので、終わった後は変えない）。書き込みの競合に 3 回続けて負けたときは 409 の conflict
// - 今と同じ値への変更は、何も書かず（履歴も残さず）200 で changed を偽にする
// - 履歴は entity_type = 'epic'、action = 'update' で、{"reward_tier": [前, 後]} と {"requester": [{id, name}, {id, name}]}

// クリア報酬の段階を変える。依頼主とリーダー（管理者を含む）だけ。reward_xp は段階の額（XP_EPIC_REWARD）で、払うのはクリアの処理
export const epicRewardUpdate = defineOperation({
  name: 'epic-reward-update',
  description: 'エピックの依頼主とリーダーが、クリア報酬の段階を変える。今と同じ段階なら何もしない',
  mode: 'write',
  permission: 'member',
  workspace: true,
  input: z.object({ workspace_id: idSchema, epic_id: idSchema, reward_tier: z.enum(epicRewardTiers) }),
  output: z.object({
    changed: z.boolean(),
    reward_tier: z.enum(epicRewardTiers),
    reward_xp: z.number().int(),
  }),
});

// 依頼主を替える。リーダー（管理者を含む）だけで、依頼主本人も 403（権限の種類 leader が登録の関数で断る）。
// 替え先は、そのワークスペースに今所属し、無効でなく login_subject のある人（担当にできる人と同じ）で、満たさなければ 404。
// 新しい依頼主を討伐隊へ自動で加えず、前の依頼主も外さない
export const epicRequesterUpdate = defineOperation({
  name: 'epic-requester-update',
  description: 'エピックのリーダーが、依頼主を今所属している別の人に替える。今と同じ人なら何もしない',
  mode: 'write',
  permission: 'leader',
  workspace: true,
  input: z.object({ workspace_id: idSchema, epic_id: idSchema, user_id: idSchema }),
  output: z.object({
    changed: z.boolean(),
    requester: z.object({ id: z.string(), name: z.string(), left: z.boolean() }),
  }),
});
