import { sql, type RawBuilder } from 'kysely';

// Google のメールアドレスで待つ承諾待ちの招待の条件。部分索引 invitations_pending_email（migrations/0001_create_initial_tables.sql の
// `WHERE status = 'pending' AND login_subject IS NULL`）の WHERE と同じ式にする。
// 部分索引を使えるのは、問い合わせの条件が索引の条件を含むと SQLite が示せたときだけなので、値は束縛せず文字のまま書く
// （activeSprintRowFilter と同じ。束縛した値でも、値を見て計画し直せるときは使われるが、それに頼らない）。
// alias は問い合わせで invitations に付けた別名（別名が無ければ 'invitations'）
export function pendingEmailInvitationRowFilter(alias: string): RawBuilder<boolean> {
  const column = (name: string) => sql.ref(`${alias}.${name}`);
  return sql<boolean>`(${column('status')} = 'pending' AND ${column('login_subject')} IS NULL)`;
}
