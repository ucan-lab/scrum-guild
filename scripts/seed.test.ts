import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { pbkdf2Sync } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { SEED_PASSWORD_LOGINS } from '../seed/passwords.ts';
import { SEED_OPERATOR_LOGIN_ID, SEED_SESSIONS } from '../seed/sessions.ts';
import { seedSql, seedTables, sessionInserts, tokenHash } from './seed.ts';

// 今の反復回数（src/server/auth/password-hash.ts の PASSWORD_HASH_ITERATIONS）。そのファイルは Workers の型（crypto.subtle.timingSafeEqual）
// を使い、scripts/ の型の検査に入れられないので、値を写す
const PASSWORD_HASH_ITERATIONS = 100_000;

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

// data.sql の password_credentials の行（1行1人）から、ログインの ID とメールアドレスとハッシュを取る
function seedPasswordRows(): { subject: string; email: string; hash: string }[] {
  const data = readFileSync(new URL('../seed/data.sql', import.meta.url), 'utf8');
  const row = /^\s*\('([^']+)', '([^']+)', '(pbkdf2-sha256\$[^']+)'/gm;
  return [...data.matchAll(row)].map(([, subject, email, hash]) => ({ subject: subject!, email: email!, hash: hash! }));
}

describe('seed のパスワード', () => {
  const logins = Object.values(SEED_PASSWORD_LOGINS);

  test('パスワードは12文字以上で、メールアドレスは架空の example.test の、そろえた形', () => {
    for (const login of logins) {
      assert.ok([...login.password].length >= 12, login.email);
      assert.match(login.email, /^[a-z0-9.-]+@example\.test$/);
    }
    assert.equal(new Set(logins.map((login) => login.email)).size, logins.length);
  });

  test('data.sql のハッシュは、今の反復回数で、seed/passwords.ts のパスワードから作った値', () => {
    const rows = seedPasswordRows();
    assert.equal(rows.length, logins.length);
    for (const login of logins) {
      const row = rows.find((candidate) => candidate.subject === login.loginSubject);
      assert.ok(row, `${login.email} の行が無い`);
      assert.equal(row.email, login.email);
      const [scheme, iterations, salt, key] = row.hash.split('$') as [string, string, string, string];
      assert.equal(scheme, 'pbkdf2-sha256');
      assert.equal(Number(iterations), PASSWORD_HASH_ITERATIONS);
      const derived = pbkdf2Sync(
        login.password.normalize('NFC'),
        Buffer.from(salt, 'base64url'),
        Number(iterations),
        32,
        'sha256',
      );
      assert.equal(derived.toString('base64url'), key, `${login.email} のハッシュがパスワードに合わない`);
    }
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
  test('外部キーの検査は消す文の間だけ先送りし、入れる文はその場で検査させる', () => {
    const sql = seedSql(['accounts', 'd1_migrations'], 'INSERT INTO accounts VALUES (1);\n', sessions, new Date());
    const lines = sql.trimEnd().split('\n');
    assert.deepEqual(lines.slice(0, 3), [
      'PRAGMA defer_foreign_keys = true;',
      'DELETE FROM "accounts";',
      'PRAGMA defer_foreign_keys = false;',
    ]);
    assert.ok(!sql.includes('d1_migrations'));
    assert.ok(sql.indexOf('INSERT INTO accounts') < sql.indexOf('INSERT INTO sessions'));
  });
});

// 空の D1 に流して中身を数える。wrangler の手元の D1 を使うので数秒かかる
describe('pnpm db:seed', () => {
  test('2回流しても通り、組織5つ（e2e の組織の設定だけが使うくもラボと、パスワードのログインだけが使うゆず書房とみなも舎を含む）、セッション9つ（同じアカウントの2本目を含む）、組織の無い運用者が入る', () => {
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
          WHERE login_provider || ':' || login_subject = '${SEED_OPERATOR_LOGIN_ID}') AS operator_logins,
        (SELECT count(*) FROM sessions
          WHERE julianday(expires_at) - julianday(last_used_at) = 30) AS sessions_30_days`;
      const result = spawnSync(
        wrangler,
        ['d1', 'execute', 'DB', '--local', '--persist-to', persistTo, '--json', '--command', query],
        { cwd: root, env, encoding: 'utf8' },
      );
      assert.equal(result.status, 0, result.stderr);
      const [row] = (JSON.parse(result.stdout) as { results: Record<string, number>[] }[])[0].results;
      assert.deepEqual(row, {
        organizations: 5,
        sessions: sessions.length,
        operator_users: 0,
        operator_logins: 1,
        sessions_30_days: sessions.length,
      });

      const check = spawnSync(
        wrangler,
        [
          'd1',
          'execute',
          'DB',
          '--local',
          '--persist-to',
          persistTo,
          '--json',
          '--command',
          'PRAGMA foreign_key_check',
        ],
        { cwd: root, env, encoding: 'utf8' },
      );
      assert.equal(check.status, 0, check.stderr);
      assert.deepEqual((JSON.parse(check.stdout) as { results: unknown[] }[])[0].results, [], '親の無い行が無い');
    } finally {
      rmSync(persistTo, { recursive: true, force: true });
    }
  });
});
