import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { SEED_OPERATOR_LOGIN_ID, SEED_SESSIONS } from '../seed/sessions.ts';
import { seedSql, seedTables, sessionInserts, tokenHash } from './seed.ts';

const sessions = Object.values(SEED_SESSIONS);

describe('seed のトークン', () => {
  test('ログインが作るトークンと同じ base64url の43文字で、重ならない', () => {
    for (const s of sessions) assert.match(s.token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(new Set(sessions.map((s) => s.token)).size, sessions.length);
  });

  test('ハッシュは SHA-256 の小文字の16進', () => {
    assert.equal(tokenHash('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  test('運用者の ID は .dev.vars.example の OPERATOR_LOGIN_IDS と同じ', () => {
    const example = readFileSync(new URL('../.dev.vars.example', import.meta.url), 'utf8');
    assert.match(example, new RegExp(`^OPERATOR_LOGIN_IDS=${SEED_OPERATOR_LOGIN_ID}$`, 'm'));
  });
});

describe('seedTables', () => {
  test('マイグレーションの記録と SQLite と D1 の表は消さない', () => {
    assert.deepEqual(seedTables(['_cf_METADATA', 'accounts', 'd1_migrations', 'sqlite_sequence', 'users']), [
      'accounts',
      'users',
    ]);
  });
});

describe('sessionInserts', () => {
  test('期限は流した時刻の30日後', () => {
    const sql = sessionInserts([SEED_SESSIONS.admin], new Date('2026-10-20T00:00:00.000Z'));
    assert.ok(sql.includes(`'${tokenHash(SEED_SESSIONS.admin.token)}'`));
    assert.ok(sql.includes("'2026-10-20T00:00:00.000Z', '2026-10-20T00:00:00.000Z', '2026-11-19T00:00:00.000Z'"));
    assert.ok(!sql.includes(SEED_SESSIONS.admin.token), 'トークンそのものは DB に入れない');
  });
});

describe('seedSql', () => {
  test('外部キーの検査を先送りして全部の表を消してから入れる', () => {
    const sql = seedSql(['accounts', 'd1_migrations'], 'INSERT INTO accounts VALUES (1);\n', sessions, new Date());
    const lines = sql.trimEnd().split('\n');
    assert.equal(lines[0], 'PRAGMA defer_foreign_keys = true;');
    assert.equal(lines[1], 'DELETE FROM "accounts";');
    assert.ok(!sql.includes('d1_migrations'));
    assert.ok(sql.indexOf('INSERT INTO accounts') < sql.indexOf('INSERT INTO sessions'));
    assert.equal(lines.at(-1), 'PRAGMA defer_foreign_keys = false;');
  });
});

// 空の D1 に流して中身を数える。wrangler の手元の D1 を使うので数秒かかる
describe('pnpm db:seed', () => {
  test('2回流しても通り、組織2つ、セッション4つ、組織の無い運用者が入る', () => {
    const persistTo = mkdtempSync(path.join(tmpdir(), 'scrum-guild-seed-test-'));
    const root = fileURLToPath(new URL('..', import.meta.url));
    const wrangler = path.join(root, 'node_modules', '.bin', 'wrangler');
    const env = { ...process.env, PATH: `${path.dirname(wrangler)}${path.delimiter}${process.env.PATH}` };
    try {
      for (const round of [1, 2]) {
        const result = spawnSync(process.execPath, ['scripts/db-seed.ts', '--persist-to', persistTo], {
          cwd: root,
          env,
          encoding: 'utf8',
        });
        assert.equal(result.status, 0, `${round}回目: ${result.stderr}`);
      }
      const query = `SELECT
        (SELECT count(*) FROM organizations) AS organizations,
        (SELECT count(*) FROM sessions) AS sessions,
        (SELECT count(*) FROM users u JOIN account_logins l ON l.account_id = u.account_id
          WHERE l.login_provider || ':' || l.login_subject = '${SEED_OPERATOR_LOGIN_ID}') AS operator_users,
        (SELECT count(*) FROM account_logins
          WHERE login_provider || ':' || login_subject = '${SEED_OPERATOR_LOGIN_ID}') AS operator_logins`;
      const result = spawnSync(
        wrangler,
        ['d1', 'execute', 'DB', '--local', '--persist-to', persistTo, '--json', '--command', query],
        { cwd: root, env, encoding: 'utf8' },
      );
      assert.equal(result.status, 0, result.stderr);
      const [row] = (JSON.parse(result.stdout) as { results: Record<string, number>[] }[])[0].results;
      assert.deepEqual(row, { organizations: 2, sessions: 4, operator_users: 0, operator_logins: 1 });
    } finally {
      rmSync(persistTo, { recursive: true, force: true });
    }
  });
});
