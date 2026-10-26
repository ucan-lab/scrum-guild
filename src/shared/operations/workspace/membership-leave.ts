import { z } from 'zod';
import { idSchema } from '../../id.ts';
import { defineOperation } from '../define.ts';

// ワークスペースから抜ける（自分）か、外す（他人）。user_id は member-list の各行の id（users の ID）。
// 自分なら誰でも抜けられ、他人を外せるのはそのワークスペースのリーダーと管理者だけ（一般のメンバーは 403 の forbidden）。
// 相手は member-list に出る人だけで、ほかは 404（別の組織の ID、もう抜けた人を含む。所属していない管理者が自分を指しても 404）。
// 1回の batch で、所属（left_on、left_at）、所属の change_logs（action: delete）、担当を外すタスクごとの change_logs と、
// そのワークスペースの未完了で削除していない担当のタスク（assignee_user_id、today_on を空にする）を書く。
// 完了の記録と経験値は変えない。所属が終わったら、応答の後にログインできなくなった人のセッションを消す
export const membershipLeave = defineOperation({
  name: 'membership-leave',
  description:
    'ワークスペースから抜けるか、メンバーを外す。担当していた未完了のタスクは担当なしに戻し、変更の履歴に残す。他人を外せるのはリーダーと管理者だけ',
  mode: 'write',
  permission: 'member',
  workspace: true,
  input: z.object({ workspace_id: idSchema, user_id: idSchema }),
  output: z.object({ user_id: z.string() }),
});
