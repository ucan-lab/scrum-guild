// 解約した組織のデータを消す SQL の書き出し（scripts/purge-organization.ts）の引数と、書き出す行の形の検査。
// SQL を流して消えることは、Workers の実行環境のテスト（test/purge-organization.test.ts）で確かめる
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';
import {
  purgeOrganizationCountSql,
  purgeOrganizationSql,
  purgeOrganizationStatements,
} from './purge-organization-sql.ts';

const SCRIPT = fileURLToPath(new URL('./purge-organization.ts', import.meta.url));
const ID = '019a0000-0000-7000-8000-0000000002f1';

function run(...args: string[]) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
}

describe('purge-organization', () => {
  test('組織の ID を埋めた消す文を、1行に1文で標準出力に書き出す', () => {
    const result = run(ID);
    assert.equal(result.status, 0);
    assert.equal(result.stdout, purgeOrganizationSql(ID));
    assert.equal(result.stdout, `${purgeOrganizationStatements(ID).join('\n')}\n`);
    assert.equal(result.stderr, '');
  });

  test('--count で、残りを数える1行の SELECT を書き出す', () => {
    const result = run('--count', ID);
    assert.equal(result.status, 0);
    assert.equal(result.stdout, purgeOrganizationCountSql(ID));
    assert.match(result.stdout, /^SELECT [^\n]+\n$/);
    assert.equal(result.stderr, '');
  });

  for (const [label, args] of [
    ['引数が無い', []],
    ['引数が2つ', [ID, ID]],
    ['--count だけ', ['--count']],
    ['--count の後に2つ', ['--count', ID, ID]],
    ['UUID でない', ['aoba']],
    ['大文字の UUID', [ID.toUpperCase()]],
    ['引用符を含む', [`${ID}' OR '1'='1`]],
    ['--count で UUID でない', ['--count', 'aoba']],
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
      assert.throws(() => purgeOrganizationStatements(id), /組織の ID は小文字の UUID の形で渡す/);
      assert.throws(() => purgeOrganizationCountSql(id), /組織の ID は小文字の UUID の形で渡す/);
    }
  });

  test('どの DELETE にも消してよい組織かを確かめる条件が付き、organizations の行を最後に消す', () => {
    const statements = purgeOrganizationStatements(ID);
    const guard = `EXISTS (SELECT 1 FROM organizations WHERE id = '${ID}' AND suspended_at IS NOT NULL AND purge_on IS NOT NULL AND purge_on < date('now'))`;
    assert.ok(statements.length > 1);
    for (const statement of statements) {
      assert.match(statement, /^DELETE FROM \w+ WHERE /);
      assert.ok(statement.endsWith(` AND ${guard}`), statement);
    }
    assert.match(statements.at(-1)!, /^DELETE FROM organizations WHERE id = /);
  });

  // 手順書は行を `--command "<文>"` に入れる。人が1行を写して二重引用符で囲んでも、シェルが文を変えない形にする
  test('書き出す行は1行に1文で、コメントの行と、二重引用符の中でシェルが解く文字を含まない', () => {
    const lines = [...purgeOrganizationSql(ID).trimEnd().split('\n'), purgeOrganizationCountSql(ID).trimEnd()];
    for (const line of lines) {
      assert.match(line, /^(DELETE FROM|SELECT) /, line);
      // `!` は対話のシェルの履歴の展開に当たる
      assert.doesNotMatch(line, /["$`\\!\r\n]/, line);
      assert.doesNotMatch(line, /--/, line);
    }
  });
});
