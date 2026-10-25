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

// D1 の呼び出しに割り込む口。テストが、並行した処理の実行の順を固定したり、書き込みを失敗させたりするのに使う。
// env の取り出しの Proxy で DB を包むので、入口（commonDb、orgDb）はそのまま包まれた D1 に問い合わせる。
//   afterQuery: 問い合わせ（rows、first、run）が答えを返した直後に呼ぶ。その間、問い合わせの結果は呼び出し元に返らない
//   beforeBatch: batch() を送る前に、文の SQL の並びを渡して呼ぶ。投げると、batch() は何も書かずに失敗する
export type D1Hooks = {
  afterQuery?: (sql: string) => Promise<void>;
  beforeBatch?: (sqls: readonly string[]) => void;
};

export function envWithD1Hooks(base: Env, hooks: D1Hooks): Env {
  // batch() には包む前の文を渡す（D1 の本物の文でないと受け取らない）
  const rawOf = new WeakMap<object, D1PreparedStatement>();
  const sqlOf = new WeakMap<object, string>();

  const wrapBound = (bound: D1PreparedStatement, text: string): D1PreparedStatement => {
    const wrapped = new Proxy(bound, {
      get(target, name) {
        if (name === 'all') {
          return async (...args: []) => {
            const result = await target.all(...args);
            await hooks.afterQuery?.(text);
            return result;
          };
        }
        const member = Reflect.get(target, name);
        return typeof member === 'function' ? member.bind(target) : member;
      },
    });
    rawOf.set(wrapped, bound);
    sqlOf.set(wrapped, text);
    return wrapped;
  };

  const wrapStatement = (statement: D1PreparedStatement, text: string) =>
    new Proxy(statement, {
      get(target, name) {
        if (name === 'bind') return (...values: unknown[]) => wrapBound(target.bind(...values), text);
        const member = Reflect.get(target, name);
        return typeof member === 'function' ? member.bind(target) : member;
      },
    });

  const wrapDatabase = (database: D1Database) =>
    new Proxy(database, {
      get(target, name) {
        const member = Reflect.get(target, name);
        if (name === 'prepare') return (text: string) => wrapStatement(target.prepare(text), text);
        if (name === 'batch') {
          return async (statements: D1PreparedStatement[]) => {
            hooks.beforeBatch?.(statements.map((statement) => sqlOf.get(statement) ?? ''));
            return target.batch(statements.map((statement) => rawOf.get(statement) ?? statement));
          };
        }
        return typeof member === 'function' ? member.bind(target) : member;
      },
    });

  return new Proxy(base, {
    get(target, prop) {
      const value = Reflect.get(target, prop);
      return prop === 'DB' ? wrapDatabase(value as D1Database) : value;
    },
  });
}

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
    // ログインできるかの判定が使う形（アカウントに結ばれる前の行も引く。初めてのログインはアカウントが無い）
    usersWithUnlinked: usersStatement(db, account.accountId, account.login, true),
    usersOfNewAccount: usersStatement(db, undefined, account.login, true),
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
