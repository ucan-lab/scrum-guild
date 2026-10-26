// 運用者の操作を、既にある組織の変更の履歴（組織の中の change_logs）に1行足す（組織の停止と再開、停止の理由の切り替え、
// 管理者の指名し直し）。組織の中の入口（OrganizationDb）は渡さず、履歴を1行足すだけの関数にする。
// 組織を確かめた結果（VerifiedOrganization）はこの関数の中で作り、外へ出さない。組織の ID は、呼び出し側が共通の表の organizations から
// 読んだ値を渡す。行が無い ID を渡したら、change_logs.organization_id の外部キーが INSERT を断る（停止中の組織にも書ける）。
// この関数を import できるのは運用者の道具（src/server/operations/operator-tools.ts）だけで、eslint.config.db-entry.js が守る。
// 処理には、道具が運用者のログインの ID を添えて包んだ関数だけを渡す
import { uuidv7 } from '../uuid.ts';
import { orgDb } from './entries.ts';
import { issueVerifiedOrganization } from './verify-organization.ts';

export type OperatorChangeLog = {
  // 運用者のログインの ID（`github:12345` の形）。change_logs.operator に書く
  operator: string;
  // 運用者が履歴に残すのは組織そのものへの操作だけ。管理者の指名し直し（#217）を足すときに、ここへ種類を足す
  entityType: 'organization';
  entityId: string;
  action: 'suspend' | 'resume' | 'update';
  // `{"列名": [前, 後]}`
  changes: Readonly<Record<string, readonly [unknown, unknown]>>;
  at: Date;
};

// workspace_id と actor_user_id は空（組織の変更の履歴）
export async function appendOperatorChangeLog(
  env: Env,
  organizationId: string,
  entry: OperatorChangeLog,
): Promise<void> {
  const db = orgDb(env, issueVerifiedOrganization(organizationId));
  await db.batch([
    db.statement((q) =>
      q.insertInto('change_logs').values({
        id: uuidv7(entry.at.getTime()),
        organization_id: db.organizationId,
        workspace_id: null,
        actor_user_id: null,
        operator: entry.operator,
        entity_type: entry.entityType,
        entity_id: entry.entityId,
        action: entry.action,
        changes_json: JSON.stringify(entry.changes),
        created_at: entry.at.toISOString(),
      }),
    ),
  ]);
}
