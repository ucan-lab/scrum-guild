// 定期処理の操作を、既にある組織の変更の履歴（組織の中の change_logs）に1行足す（お試しの期限切れによる組織の停止）。
// operator-change-log.ts と同じ作りで、operator も actor_user_id も空に書く（変更の履歴の画面は、どちらも空の行を「システム」の操作として出す）。
// 組織の中の入口（OrganizationDb）は渡さず、履歴を1行足すだけの関数にする。組織を確かめた結果（VerifiedOrganization）はこの関数の中で作り、
// 外へ出さない。組織の ID は、呼び出し側が共通の表の organizations から読んだ（UPDATE ... RETURNING で得た）値を渡す。
// 行が無い ID を渡したら、change_logs.organization_id の外部キーが INSERT を断る（停止中の組織にも書ける）。
// この関数を import できるのは定期処理（src/server/scheduled/）だけで、eslint.config.db-entry.js が守る
import { uuidv7 } from '../uuid.ts';
import { orgDb } from './entries.ts';
import { issueVerifiedOrganization } from './verify-organization.ts';

export type ScheduledChangeLog = {
  entityId: string;
  action: 'suspend';
  // `{"列名": [前, 後]}`
  changes: Readonly<Record<string, readonly [unknown, unknown]>>;
  at: Date;
};

// entity_type は 'organization'、workspace_id と actor_user_id と operator は空（組織の変更の履歴）
export async function appendScheduledChangeLog(
  env: Env,
  organizationId: string,
  entry: ScheduledChangeLog,
): Promise<void> {
  const db = orgDb(env, issueVerifiedOrganization(organizationId));
  await db.batch([
    db.statement((q) =>
      q.insertInto('change_logs').values({
        id: uuidv7(entry.at.getTime()),
        organization_id: db.organizationId,
        workspace_id: null,
        actor_user_id: null,
        operator: null,
        entity_type: 'organization',
        entity_id: entry.entityId,
        action: entry.action,
        changes_json: JSON.stringify(entry.changes),
        created_at: entry.at.toISOString(),
      }),
    ),
  ]);
}
