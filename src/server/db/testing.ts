// テストだけが使う口。test/ からだけ import する。src/、scripts/、e2e/ から import すると ESLint が落とす（eslint.config.db-entry.js）。
// Worker は src/server/index.ts から辿るので、ここは束に入らない。
// 組織を確かめた結果を確かめずに作る口と、表の照合に要る値（列の定数と、DB のカタログ）を出す
import { sql } from 'kysely';
import { invitationsStatement, membershipsStatement, usersStatement } from './cross-organization.ts';
import { commonDb, crossOrganizationEntries, entriesOf } from './entries.ts';
import type { LoginId } from './enter-organization.ts';
import { compiledQueryOf, type Scope, type Statement } from './entry.ts';
import { issueVerifiedOrganization, type VerifiedOrganization } from './verify-organization.ts';

export type { ColumnSpec } from './column-spec.ts';
export { commonTableColumns, organizationTableColumns } from './tables.ts';

export function verifiedOrganizationForTest(organizationId: string): VerifiedOrganization {
  return issueVerifiedOrganization(organizationId);
}

// 文が組み立てた SQL と束縛する値
export { compiledQueryOf as compiledQueryForTest };

// 組織の中の DB を複数にした場合の入口（listAccountOrganizations の第3引数）。1つ目は本物の DB で、追加の DB は作り物を渡す
export function organizationEntriesForTest(env: Env, extraDatabases: readonly object[]) {
  return entriesOf([env.DB, ...(extraDatabases as D1Database[])]);
}
export { listAccountOrganizations as listAccountOrganizationsForTest } from './cross-organization.ts';

// 文の実行計画（EXPLAIN QUERY PLAN の detail の列）。索引に乗るかを確かめるのに使う
export async function queryPlanForTest(env: Env, statement: Statement<Scope>): Promise<string[]> {
  const { sql: text, parameters } = compiledQueryOf(statement);
  const result = await env.DB.prepare(`EXPLAIN QUERY PLAN ${text}`)
    .bind(...parameters)
    .all<{ detail: string }>();
  return result.results.map((row) => row.detail);
}

// 組織をまたいで読む関数が組み立てる文。実行計画の確認に使う
export function crossOrganizationStatementsForTest(
  env: Env,
  account: { accountId: string; login: LoginId },
  userIds: readonly string[],
) {
  const [db] = crossOrganizationEntries(env);
  if (db === undefined) throw new Error('組織の中の DB が無い');
  return {
    users: usersStatement(db, account.accountId, account.login),
    memberships: membershipsStatement(db, userIds),
    invitations: invitationsStatement(db, account.login),
  };
}

// PRAGMA table_info の行
export type TableInfoRow = { name: string; type: string; notnull: number; dflt_value: string | null; pk: number };

// マイグレーションが作った表の名前（マイグレーションの記録と、SQLite と D1 が持つ表を除く）
export async function listAppTables(env: Env): Promise<string[]> {
  const db = commonDb(env);
  const rows = await db.rows(
    db.statement((q) =>
      q
        .selectFrom(sql<{ name: string; type: string }>`sqlite_master`.as('m'))
        .select('m.name')
        .where('m.type', '=', 'table'),
    ),
  );
  return rows.map((row) => row.name).filter((name) => !/^(d1_migrations|sqlite_.*|_cf_.*)$/.test(name));
}

export async function tableInfo(env: Env, table: string): Promise<TableInfoRow[]> {
  const db = commonDb(env);
  return db.rows(
    db.statement((q) =>
      q
        .selectFrom(sql<TableInfoRow>`pragma_table_info(${sql.lit(table)})`.as('c'))
        .select(['c.name', 'c.type', 'c.notnull', 'c.dflt_value', 'c.pk']),
    ),
  );
}
