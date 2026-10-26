import { z } from 'zod';
import { idSchema } from '../../id.ts';
import { defineOperation } from '../define.ts';

// メンバーのロールを付け替える（リーダーにする、一般に戻す。自分も戻せる）。user_id は member-list の各行の id（users の ID）。
// 相手は member-list に出る人（そのワークスペースに今所属し、無効でなく、login_subject がある）だけで、ほかは 404（別の組織の ID も同じ）。
// 同じロールなら書かずに今の値を返す。memberships は「読んだロールのまま、今の所属」を条件にした UPDATE、
// change_logs（entity_type: membership、action: update、{"role": [前, 後]}）は直前の文が行を変えたときだけ書く。
// 通らなければ読み直して、所属が無ければ 404、そうでなければ 409 の conflict。リーダーが0人になる付け替えも止めない
// （リーダーのいないワークスペースでは、管理者が務めて任命する。docs/requirements.md の「メンバーと権限」）
export const membershipRoleUpdate = defineOperation({
  name: 'membership-role-update',
  description:
    'ワークスペースに今所属している人のロールを付け替え、変更の履歴に残す。同じロールなら何も書かない。読んだ後に変わっていれば 409 の conflict',
  mode: 'write',
  permission: 'leader',
  workspace: true,
  input: z.object({ workspace_id: idSchema, user_id: idSchema, role: z.enum(['leader', 'member']) }),
  output: z.object({ user_id: z.string(), role: z.enum(['leader', 'member']) }),
});
