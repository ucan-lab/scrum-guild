// 運用者が、既にある組織の中の表に書くための入口（組織の停止と再開の履歴、管理者の指名し直し）。
// 組織を確かめた結果（VerifiedOrganization）を発行するのは、共通の表の organizations に今ある行の ID に限る。
// 停止中の組織にも発行する（enterOrganization は停止中の組織を入らせないが、運用者は停止と再開の履歴を書く）。
// 呼ぶのは運用者の道具（src/server/operations/operator-tools.ts）だけで、処理には道具が包んだ関数を渡す。
// 確かめた結果を任意の組織の ID から発行する関数は db/ の外へ出さない
import { commonDb, orgDb, type OrganizationDb } from './entries.ts';
import { issueVerifiedOrganization } from './verify-organization.ts';

// organizations に行が無ければ undefined
export async function openOrganizationAsOperator(
  env: Env,
  organizationId: string,
): Promise<OrganizationDb | undefined> {
  const common = commonDb(env);
  const row = await common.first(
    common.statement((q) => q.selectFrom('organizations').select('id').where('id', '=', organizationId)),
  );
  return row === undefined ? undefined : orgDb(env, issueVerifiedOrganization(row.id));
}
