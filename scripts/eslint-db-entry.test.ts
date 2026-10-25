// 入口を守る ESLint の規則（eslint.config.db-entry.js）のテスト。実際の設定を読み、文字列を lintText に渡して、
// 禁じる形が落ちること、入口のモジュールと例外が通ることを確かめる
import assert from 'node:assert/strict';
import { before, describe, test } from 'node:test';
import { ESLint } from 'eslint';

const RULE = 'db-entry/guard';

let eslint: ESLint;
before(() => {
  eslint = new ESLint({ cwd: import.meta.dirname + '/..' });
});

// 規則の指摘の数。構文エラーなど、規則以外の致命的な指摘が出たら失敗にする
async function violations(filePath: string, code: string): Promise<number> {
  const [result] = await eslint.lintText(code, { filePath });
  assert.ok(result);
  const fatal = result.messages.filter((message) => message.fatal);
  assert.deepEqual(fatal, [], `${filePath} を読めない: ${code}`);
  return result.messages.filter((message) => message.ruleId === RULE).length;
}

// db/ の外のコードが置かれる場所
const outside = [
  'src/server/app.ts',
  'src/server/auth/session.ts',
  'src/lib/api.ts',
  'src/routes/page.ts',
  'src/shared/health.ts',
  'scripts/ci.ts',
  'e2e/shell.test.ts',
  'test/api.test.ts',
  'vitest.config.ts',
];

const forbidden: Record<string, string> = {
  'kysely の import': `import { sql } from 'kysely'; export const a = sql;`,
  'kysely の型の import': `import type { Kysely } from 'kysely'; export type A = Kysely<unknown>;`,
  'kysely の下のパスの import': `import { jsonArrayFrom } from 'kysely/helpers/sqlite'; export const a = jsonArrayFrom;`,
  'kysely の export from': `export { sql } from 'kysely';`,
  'kysely の export all': `export * from 'kysely';`,
  'kysely の動的な import': `export const a = await import('kysely');`,
  'kysely のテンプレートリテラルの動的な import': 'export const a = await import(`kysely`);',
  'kysely の型の import()': `export type A = import('kysely').Kysely<unknown>;`,
  'kysely の require': `declare const require: (name: string) => unknown; export const a = require('kysely');`,
  'kysely の import = require': `import k = require('kysely'); export { k };`,
  'db/ の内部のファイルの import': `import { Statement } from '../server/db/entry.ts'; export const a = Statement;`,
  'db/ の内部のファイルの動的な import': `export const a = await import('./db/tables.ts');`,
  'db/ の内部のファイルの型の import()': `export type A = import('../server/db/send.ts').SendResult;`,
  'db/ の内部のファイルの export from': `export { commonTableColumns } from '../server/db/tables.ts';`,
  '引数が式の import()': `declare const name: string; export const a = await import(name);`,
  '引数がテンプレートの式の import()': 'declare const name: string; export const a = await import(`./${name}.ts`);',
  'createRequire の import': `import { createRequire } from 'node:module'; export const a = createRequire;`,
  'createRequire の名前空間の呼び出し': `import * as m from 'node:module'; export const a = m.createRequire(import.meta.url);`,
  'process.getBuiltinModule': `export const a = process.getBuiltinModule('node:module');`,
  'env.DB': `export const a = (env: Env) => env.DB;`,
  'env?.DB': `export const a = (env?: Env) => env?.DB;`,
  "env['DB']": `export const a = (env: Env) => env['DB'];`,
  'env[`DB`]': 'export const a = (env: Env) => env[`DB`];',
  '{ DB } の取り出し': `export const a = (env: Env) => { const { DB } = env; return DB; };`,
  "{ 'DB': d } の取り出し": `export const a = (env: Env) => { const { 'DB': d } = env; return d; };`,
  "{ ['DB']: d } の取り出し": `export const a = (env: Env) => { const { ['DB']: d } = env; return d; };`,
  '{ [`DB`]: d } の取り出し': 'export const a = (env: Env) => { const { [`DB`]: d } = env; return d; };',
  "Reflect.get(env, 'DB')": `export const a = (env: Env) => Reflect.get(env, 'DB');`,
  "Object.getOwnPropertyDescriptor(env, 'DB')": `export const a = (env: Env) => Object.getOwnPropertyDescriptor(env, 'DB');`,
  "Env['DB'] の型": `export type A = Env['DB'];`,
  'Env[`DB`] の型': 'export type A = Env[`DB`];',
  'D1Database の型': `export type A = D1Database;`,
  'D1Database の引数': `export const a = (db: D1Database) => db;`,
};

const allowedEverywhere: Record<string, string> = {
  '入口のモジュールの import': `import { commonDb } from '../server/db/index.ts'; export const a = commonDb;`,
  '拡張子の無い入口のモジュールの import': `import { commonDb } from './db'; export const a = commonDb;`,
  '入口のモジュールの動的な import': `export const a = await import('./db/index.ts');`,
  '文字列のリテラルの動的な import': `export const a = await import('./other.ts');`,
  '入口のモジュールの型の import()': `export type A = import('../server/db/index.ts').CommonDb;`,
  'DB を含む別のプロパティ': `export const a = (env: Env) => [env.DBS, env.db, env['DB_0']];`,
  オブジェクトのリテラルのキー: `export const a = { DB: 1 };`,
  'DB の無い取り出し': `export const a = (env: Env) => { const { ASSETS } = env; return ASSETS; };`,
  'DB 以外を引く Reflect.get': `export const a = (env: Env) => Reflect.get(env, 'ASSETS');`,
  'kysely に似た名前のパッケージ': `import x from 'kysely-d1'; export const a = x;`,
};

describe('db/ の外で禁じる形', () => {
  for (const file of outside) {
    for (const [name, code] of Object.entries(forbidden)) {
      test(`${file}: ${name}`, async () => {
        assert.ok((await violations(file, code)) >= 1, `落ちなかった: ${code}`);
      });
    }
  }
});

describe('db/ の外でも通る形', () => {
  for (const file of outside) {
    for (const [name, code] of Object.entries(allowedEverywhere)) {
      test(`${file}: ${name}`, async () => {
        assert.equal(await violations(file, code), 0, code);
      });
    }
  }
});

describe('db/testing.ts', () => {
  const importTesting = `import { verifiedOrganizationForTest } from '../src/server/db/testing.ts'; export const a = verifiedOrganizationForTest;`;
  const dynamicTesting = `export const a = await import('../src/server/db/testing.ts');`;
  const typeTesting = `export type A = import('../src/server/db/testing.ts').TableInfoRow;`;

  for (const file of outside.filter((file) => !file.startsWith('test/'))) {
    test(`${file}: 落ちる`, async () => {
      for (const code of [importTesting, dynamicTesting, typeTesting]) {
        assert.ok((await violations(file, code)) >= 1, code);
      }
    });
  }

  test('test/ からは import できる', async () => {
    for (const code of [importTesting, dynamicTesting, typeTesting]) {
      assert.equal(await violations('test/db.test.ts', code), 0, code);
    }
  });
});

describe('src/server/db/ の中と例外のファイル', () => {
  const inside = ['src/server/db/entry.ts', 'src/server/db/send.ts', 'src/server/db/ping.ts'];
  const exceptions = ['test/apply-migrations.ts', 'test/schema.test.ts'];

  for (const file of [...inside, ...exceptions]) {
    test(`${file}: 禁じる形がすべて通る`, async () => {
      for (const [name, code] of Object.entries(forbidden)) {
        assert.equal(await violations(file, code), 0, `${name}: ${code}`);
      }
    });
  }

  test('例外はこの 2 ファイルだけ（隣のファイルは落ちる）', async () => {
    for (const file of ['test/schema.test.ts.bak.ts', 'test/other.test.ts', 'test/apply-migrations.test.ts']) {
      assert.ok((await violations(file, `export const a = (env: Env) => env.DB;`)) >= 1, file);
    }
  });
});

test('.svelte の script も同じ規則で落ちる', async () => {
  const code = `<script lang="ts">\n  import { sql } from 'kysely';\n  const a = (env: Env) => env.DB;\n  console.log(sql, a);\n</script>\n`;
  assert.equal(await violations('src/routes/+page.svelte', code), 2);
});
