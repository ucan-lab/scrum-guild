// seed（pnpm db:seed）の SQL を組み立てる。流すのは scripts/db-seed.ts
import { createHash } from 'node:crypto';
import type { SeedSession } from '../seed/sessions.ts';

const SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;

// sessions.token_hash と claim_token_hash の書き方（docs/data-model.md）
export function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

// 消して入れ直す表。マイグレーションの記録と、SQLite と D1 が持つ表は除く
export function seedTables(names: readonly string[]): string[] {
  return names.filter((name) => name !== 'd1_migrations' && !name.startsWith('sqlite_') && !name.startsWith('_cf_'));
}

function quote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

// セッションの期限は流した時刻から数える。固定の日時だと30日後に切れて e2e が落ちるため
export function sessionInserts(sessions: readonly SeedSession[], now: Date): string {
  const at = now.toISOString();
  const expires = new Date(now.getTime() + SESSION_LIFETIME_MS).toISOString();
  const rows = sessions.map(
    (s) => `  (${quote(tokenHash(s.token))}, ${quote(s.accountId)}, ${quote(at)}, ${quote(at)}, ${quote(expires)})`,
  );
  return `INSERT INTO sessions (token_hash, account_id, created_at, last_used_at, expires_at) VALUES\n${rows.join(',\n')};\n`;
}

// 全部の表の行を消してから入れる。手で足した行も消える。消す順は外部キーの検査を先送りして問わない。
// 先送りは消す文の間だけにする。= false は先送りした違反を数えずに通すので、入れる文まで含めると、
// 親の無い行を入れても黙って成功してしまう。表が空になった後なら、入れる文はその場で検査される
export function seedSql(tables: readonly string[], data: string, sessions: readonly SeedSession[], now: Date): string {
  const deletes = seedTables(tables).map((name) => `DELETE FROM "${name.replaceAll('"', '""')}";`);
  return [
    'PRAGMA defer_foreign_keys = true;',
    ...deletes,
    'PRAGMA defer_foreign_keys = false;',
    data.trimEnd(),
    sessionInserts(sessions, now).trimEnd(),
    '',
  ].join('\n');
}
