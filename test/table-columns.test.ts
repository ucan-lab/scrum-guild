// src/server/db/tables.ts の定数と、全マイグレーションを当てた D1 の表と列を突き合わせる。
// 定数から Kysely の型を作っているので、ずれたまま通ると、型の上では在る列が DB に無い（または逆の）問い合わせが書ける
import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import {
  commonTableColumns,
  listAppTables,
  organizationTableColumns,
  tableInfo,
  type ColumnSpec,
  type TableInfoRow as ActualColumn,
} from '../src/server/db/testing.ts';

const actualTables = () => listAppTables(env);
const actualColumns = (table: string) => tableInfo(env, table);

// 定数と DB のずれを文にして返す。ずれが無ければ空
function columnProblems(table: string, spec: Readonly<Record<string, ColumnSpec>>, actual: ActualColumn[]): string[] {
  const problems: string[] = [];
  const actualByName = new Map(actual.map((column) => [column.name, column]));
  for (const [name, column] of Object.entries(spec)) {
    const found = actualByName.get(name);
    if (!found) {
      problems.push(`${table}.${name}: 定数にあるが DB に無い`);
      continue;
    }
    if (found.type !== column.type.toUpperCase()) problems.push(`${table}.${name}: 型が ${found.type}`);
    if (found.notnull !== (column.nullable ? 0 : 1)) problems.push(`${table}.${name}: NOT NULL が ${found.notnull}`);
    if ((found.dflt_value !== null) !== column.hasDefault)
      problems.push(`${table}.${name}: DEFAULT が ${found.dflt_value}`);
  }
  for (const name of actualByName.keys()) {
    if (!(name in spec)) problems.push(`${table}.${name}: DB にあるが定数に無い`);
  }
  return problems;
}

const allTables = { ...commonTableColumns, ...organizationTableColumns };

describe('表の一覧', () => {
  test('共通の表は docs/data-model.md の7表', () => {
    expect(Object.keys(commonTableColumns).sort()).toEqual(
      [
        'account_logins',
        'accounts',
        'oauth_states',
        'organizations',
        'password_credentials',
        'rate_limits',
        'sessions',
      ].sort(),
    );
  });

  test('共通の表と組織の中の表に重なりが無い', () => {
    expect(Object.keys(allTables)).toHaveLength(
      Object.keys(commonTableColumns).length + Object.keys(organizationTableColumns).length,
    );
  });

  test('定数の表と、マイグレーションが作った表が一致する', async () => {
    expect((await actualTables()).sort()).toEqual(Object.keys(allTables).sort());
  });
});

describe.each(Object.entries(allTables))('%s の列', (table, spec) => {
  test('定数の列名、型、NULL を許すか、DEFAULT の有無が DB と一致する', async () => {
    expect(columnProblems(table, spec, await actualColumns(table))).toEqual([]);
  });

  // SQLite の通常の表では PRIMARY KEY が NULL を拒まないので、マイグレーションは NOT NULL も書いている
  test('主キーの列は NOT NULL', async () => {
    const primaryKey = (await actualColumns(table)).filter((column) => column.pk > 0);
    expect(primaryKey.length).toBeGreaterThan(0);
    expect(primaryKey.filter((column) => column.notnull !== 1).map((column) => column.name)).toEqual([]);
  });
});

describe('照合がずれを見つける', () => {
  const notNull: ColumnSpec = { type: 'text', nullable: false, hasDefault: false };
  const nullable: ColumnSpec = { ...notNull, nullable: true };
  const spec = { id: notNull, last_login_at: nullable, created_at: notNull, updated_at: notNull };
  const actual: ActualColumn[] = [
    { name: 'id', type: 'TEXT', notnull: 1, dflt_value: null, pk: 1 },
    { name: 'last_login_at', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
    { name: 'created_at', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
    { name: 'updated_at', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
  ];

  test('ずれが無ければ空', () => {
    expect(columnProblems('accounts', spec, actual)).toEqual([]);
  });

  test.each([
    ['DB に無い列を定数が持つ', { ...spec, extra: spec.id }, actual],
    ['DB にある列を定数が持たない', spec, [...actual, { ...actual[0]!, name: 'extra' }]],
    ['NOT NULL がずれる', spec, actual.map((c) => (c.name === 'id' ? { ...c, notnull: 0 } : c))],
    ['NULL を許す列が NOT NULL', { ...spec, created_at: nullable }, actual],
    ['型がずれる', spec, actual.map((c) => (c.name === 'id' ? { ...c, type: 'INTEGER' } : c))],
    ['DEFAULT がずれる', spec, actual.map((c) => (c.name === 'id' ? { ...c, dflt_value: "'x'" } : c))],
  ])('%s', (_, specUnderTest, actualUnderTest) => {
    expect(columnProblems('accounts', specUnderTest, actualUnderTest)).not.toEqual([]);
  });
});
