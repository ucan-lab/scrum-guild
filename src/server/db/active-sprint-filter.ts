import { sql, type RawBuilder } from 'kysely';

// 進行中のスプリントの条件。部分索引 sprints_active（migrations/0001_create_initial_tables.sql の
// `WHERE status = 'active' AND deleted_at IS NULL`）の WHERE と同じ式にする。
// SQLite は、問い合わせの条件が索引の条件を含むと示せたときだけ部分索引を使い、束縛の値（?）の入った式からは示せない。
// そのため、値は束縛せず文字のまま書く（Kysely の式で書くと 'active' が ? になり、索引が使われない）。
// alias は問い合わせで sprints に付けた別名
export function activeSprintRowFilter(alias: string): RawBuilder<boolean> {
  const column = (name: string) => sql.ref(`${alias}.${name}`);
  return sql<boolean>`(${column('status')} = 'active' AND ${column('deleted_at')} IS NULL)`;
}
