// 解約した組織のデータを消す SQL の書き出し（scripts/purge-organization.ts）の引数の検査。
// SQL を流して消えることは、Workers の実行環境のテスト（test/purge-organization.test.ts）で確かめる
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';
import { purgeOrganizationSql } from './purge-organization-sql.ts';

const SCRIPT = fileURLToPath(new URL('./purge-organization.ts', import.meta.url));
const ID = '019a0000-0000-7000-8000-0000000002f1';

function run(...args: string[]) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
}

describe('purge-organization', () => {
  test('組織の ID を埋めた SQL を標準出力に書き出す', () => {
    const result = run(ID);
    assert.equal(result.status, 0);
    assert.equal(result.stdout, purgeOrganizationSql(ID));
    assert.equal(result.stderr, '');
  });

  for (const [label, args] of [
    ['引数が無い', []],
    ['引数が2つ', [ID, ID]],
    ['UUID でない', ['aoba']],
    ['大文字の UUID', [ID.toUpperCase()]],
    ['引用符を含む', [`${ID}' OR '1'='1`]],
  ] as const) {
    test(`${label}なら使い方を出して 1 で終える`, () => {
      const result = run(...args);
      assert.equal(result.status, 1);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, /使い方: node scripts\/purge-organization\.ts <組織の ID>/);
    });
  }

  test('SQL を組む関数は UUID の形でない ID を投げる', () => {
    for (const id of ['', 'aoba', `${ID}\n`, ` ${ID}`, ID.replaceAll('-', '')]) {
      assert.throws(() => purgeOrganizationSql(id), /組織の ID は小文字の UUID の形で渡す/);
    }
  });

  test('どの DELETE にも消してよい組織かを確かめる条件が付き、organizations の行を最後に消す', () => {
    const statements = purgeOrganizationSql(ID)
      .split('\n')
      .filter((line) => line.startsWith('DELETE'));
    const guard = `EXISTS (SELECT 1 FROM organizations WHERE id = '${ID}' AND suspended_at IS NOT NULL AND purge_on IS NOT NULL AND purge_on < date('now'))`;
    assert.ok(statements.length > 1);
    for (const statement of statements) assert.ok(statement.endsWith(` AND ${guard};`), statement);
    assert.match(statements.at(-1)!, /^DELETE FROM organizations WHERE id = /);
  });
});
