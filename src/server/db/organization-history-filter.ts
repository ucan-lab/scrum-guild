import { sql, type RawBuilder } from 'kysely';

// 組織の変更の履歴（organization-history）に出す change_logs の行の条件。部分索引 change_logs_organization_history
// （migrations/0005_add_change_logs_organization_history_index.sql）の WHERE と同じ式にする。
// SQLite は、問い合わせの条件が索引の条件を含むと示せたときだけ部分索引を使い、束縛の値（?）の入った式からは示せない。
// そのため、値は束縛せず文字のまま書く（Kysely の式で書くと 'workspace' などが ? になり、索引が使われない）。
// alias は問い合わせで change_logs に付けた別名
export function organizationHistoryRowFilter(alias: string): RawBuilder<boolean> {
  const column = (name: string) => sql.ref(`${alias}.${name}`);
  return sql<boolean>`(${column('workspace_id')} IS NULL OR (${column('entity_type')} = 'workspace' AND ${column('action')} IN ('create', 'close', 'reopen')))`;
}
