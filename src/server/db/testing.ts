// テストだけが使う口。test/ からだけ import する。src/、scripts/、e2e/ から import すると ESLint が落とす（eslint.config.db-entry.js）。
// Worker は src/server/index.ts から辿るので、ここは束に入らない。
// 組織を確かめた結果を確かめずに作る口と、表の照合に要る値（列の定数と、DB のカタログ）を出す
import { sql } from 'kysely';
import {
  invitationsStatement,
  listAccountOrganizationsIn,
  membershipsStatement,
  usersStatement,
} from './cross-organization.ts';
import { commonDb, crossOrganizationEntries, entriesOf } from './entries.ts';
import type { LoginId } from './enter-organization.ts';
import { compiledQueryOf, type Scope, type Statement } from './entry.ts';
import { explainQueryPlan } from './send.ts';
import { allOrganizationDatabases, commonDatabase } from './select-database.ts';
import { issueVerifiedOrganization, type VerifiedOrganization } from './verify-organization.ts';

export type { ColumnSpec } from './column-spec.ts';
export { commonTableColumns, organizationTableColumns } from './tables.ts';

export function verifiedOrganizationForTest(organizationId: string): VerifiedOrganization {
  return issueVerifiedOrganization(organizationId);
}

// 文が組み立てた SQL と束縛する値
export { compiledQueryOf as compiledQueryForTest };

// D1 の形のうち、組織をまたいで読む関数が使う部分（prepare、bind、all）。組織の中の DB を複数にした場合のテストが、作り物を渡す
export type FakeDatabase = {
  prepare(text: string): {
    bind(...values: unknown[]): { all(): Promise<{ results: unknown[]; meta: { changes: number } }> };
  };
};

// 組織の中の DB を、本物の1つと作り物の追加分にして、組織をまたいで読む関数を呼ぶ。本番の関数の署名は広げない
export function listAccountOrganizationsForTest(
  env: Env,
  account: { accountId: string; logins: readonly LoginId[] },
  extraDatabases: readonly FakeDatabase[],
) {
  // 型の穴はここだけ。作り物は、送る側（send.ts）が呼ぶ prepare、bind、all しか持たない
  const extras = extraDatabases as unknown as D1Database[];
  return listAccountOrganizationsIn(env, account, entriesOf([...allOrganizationDatabases(env), ...extras]));
}

// 文の実行計画（EXPLAIN QUERY PLAN の detail の列）。索引に乗るかを確かめるのに使う
export function queryPlanForTest(env: Env, statement: Statement<Scope>): Promise<string[]> {
  return explainQueryPlan(commonDatabase(env), compiledQueryOf(statement));
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
