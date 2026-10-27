// 運用者による管理者の指名し直し（Issue #217）の、既にある組織の中の users と change_logs への書き込み。
// 組織の中の入口（OrganizationDb）は渡さず、指名し直すだけの関数にする。組織の ID は、呼び出し側が共通の表の organizations から
// 読んだ値を渡す。この関数を import できるのは運用者の道具（src/server/operations/operator-tools.ts）だけで、
// eslint.config.db-entry.js が守る（appendOperatorChangeLog と同じ守り方）
import type { AdminNominee } from '../organizations/designate-admin.ts';

export type AdminReassignment = {
  // 運用者のログインの ID（`github:12345` の形）。change_logs.operator に書く
  operator: string;
  nominee: AdminNominee;
  now: Date;
};

export type AdminReassignmentResult = {
  userId: string;
  // created: 新しい行を入れた。updated: 既にいる人を管理者にした（か、有効に戻した）。unchanged: 既に有効な管理者だった
  outcome: 'created' | 'updated' | 'unchanged';
  // 消した前の指名の数
  removed: number;
};

// 前の指名（その組織の account_id が空の users の行。指名する人自身の行は除く）を消し、続けて指名する。1回の batch() で書く。
// 既にいる人の UPDATE が条件に外れたときと、新しい行が一意に当たったときは 'conflict'
export async function reassignOrganizationAdmin(
  env: Env,
  organizationId: string,
  input: AdminReassignment,
): Promise<AdminReassignmentResult | 'conflict'> {
  void [env, organizationId, input];
  throw new Error('未実装');
}
