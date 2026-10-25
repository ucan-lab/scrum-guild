// 期限を過ぎた行を消す定期処理（src/server/scheduled/）。scheduled() を直に呼び、基準の時刻は scheduledTime で渡す
import { createScheduledController } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  LOGIN_RATE_LIMIT,
  LOGIN_RATE_LIMIT_IPV6_SITE,
  LOGIN_RATE_LIMIT_POLICIES,
  loginRateLimits,
  longestRateLimitWindowMs,
} from '../src/server/auth/rate-limit.ts';
import { commonDb } from '../src/server/db/index.ts';
import { envWithD1Hooks } from '../src/server/db/testing.ts';
import worker from '../src/server/index.ts';
import { cleanupExpired, CLEANUP_ROW_LIMIT } from '../src/server/scheduled/cleanup-expired.ts';
import { operations } from '../src/shared/operations/index.ts';
import { defineOperation } from '../src/shared/operations/define.ts';
import { z } from 'zod';
import { createAccount, createSession, uuidv7 } from './factories.ts';

const EVERY_MINUTE = '* * * * *';
const NOW = Date.parse('2026-10-25T12:00:00.000Z');
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();
const MINUTE = 60 * 1000;
const LONGEST_WINDOW_MS = longestRateLimitWindowMs();

async function runScheduled(target: Env = env, cron = EVERY_MINUTE, scheduledTime = NOW) {
  await worker.scheduled(createScheduledController({ scheduledTime, cron }), target);
}

async function insertOauthState(expiresAt: string) {
  const state = `state-${uuidv7()}`;
  const db = commonDb(env);
  await db.run(
    db.statement((q) =>
      q
        .insertInto('oauth_states')
        .values({ state, login_provider: 'github', code_verifier: 'verifier', expires_at: expiresAt }),
    ),
  );
  return state;
}

async function insertRateLimit(windowStartAt: string) {
  const key = `login:test-${uuidv7()}`;
  const db = commonDb(env);
  await db.run(
    db.statement((q) => q.insertInto('rate_limits').values({ key, window_start_at: windowStartAt, count: 1 })),
  );
  return key;
}

async function insertSession(expiresAt: string) {
  const account = await createAccount();
  return (await createSession(account.id, { expires_at: expiresAt })).token_hash;
}

// 渡した主キーのうち、表に残っているもの。ほかのテストの行を巻き込まないよう、このテストが作った行だけを見る
async function remaining(table: 'oauth_states' | 'sessions' | 'rate_limits', values: string[]): Promise<string[]> {
  const db = commonDb(env);
  switch (table) {
    case 'oauth_states': {
      const rows = await db.rows(db.statement((q) => q.selectFrom(table).select('state').where('state', 'in', values)));
      return rows.map((row) => row.state).sort();
    }
    case 'sessions': {
      const rows = await db.rows(
        db.statement((q) => q.selectFrom(table).select('token_hash').where('token_hash', 'in', values)),
      );
      return rows.map((row) => row.token_hash).sort();
    }
    case 'rate_limits': {
      const rows = await db.rows(db.statement((q) => q.selectFrom(table).select('key').where('key', 'in', values)));
      return rows.map((row) => row.key).sort();
    }
  }
}

let info: ReturnType<typeof vi.spyOn>;
let warn: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  // 前のテストが残した期限切れの行で、件数やログが変わらないよう、先に片付ける
  await cleanupExpired(env, new Date(NOW));
  info.mockClear();
  warn.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('期限を過ぎた行を消す', () => {
  test('oauth_states は expires_at <= 基準の時刻の行だけが消える', async () => {
    const past = await insertOauthState(iso(-MINUTE));
    const exact = await insertOauthState(iso(0));
    const future = await insertOauthState(iso(MINUTE));

    await runScheduled();

    expect(await remaining('oauth_states', [past, exact, future])).toEqual([future]);
  });

  test('sessions は expires_at <= 基準の時刻の行だけが消える', async () => {
    const past = await insertSession(iso(-MINUTE));
    const exact = await insertSession(iso(0));
    const future = await insertSession(iso(MINUTE));

    await runScheduled();

    expect(await remaining('sessions', [past, exact, future])).toEqual([future]);
  });

  test('rate_limits は window_start_at <= 基準の時刻 - 最長の窓の行だけが消える', async () => {
    const old = await insertRateLimit(iso(-LONGEST_WINDOW_MS - MINUTE));
    const boundary = await insertRateLimit(iso(-LONGEST_WINDOW_MS));
    const inside = await insertRateLimit(iso(-LONGEST_WINDOW_MS + MINUTE));

    await runScheduled();

    expect(await remaining('rate_limits', [old, boundary, inside])).toEqual([inside]);
  });

  test('rate_limits で、最長の窓の内にある行は、短い窓の枠を過ぎていても残る', async () => {
    // 操作の定義が3時間の窓を持つ場合。ログインの10分の枠を過ぎた行も、3時間の窓の内なら残る
    const longOperation = defineOperation({
      name: 'long-window',
      description: 'テスト用',
      mode: 'write',
      permission: 'login',
      rateLimit: { max: 1, windowSeconds: 3 * 60 * 60 },
      input: z.object({}),
      output: z.object({}),
    });
    const longestWindowMs = longestRateLimitWindowMs([...operations, longOperation]);
    expect(longestWindowMs).toBe(3 * 60 * 60 * 1000);

    const pastLoginWindow = await insertRateLimit(iso(-LONGEST_WINDOW_MS - MINUTE));
    const pastLongestWindow = await insertRateLimit(iso(-longestWindowMs - MINUTE));

    await cleanupExpired(env, new Date(NOW), { longestWindowMs });

    expect(await remaining('rate_limits', [pastLoginWindow, pastLongestWindow])).toEqual([pastLoginWindow]);
  });

  test('基準の時刻は scheduledTime。実行した時計ではなく、渡した時刻で決まる', async () => {
    const state = await insertOauthState('2030-01-01T00:00:00.000Z');

    await runScheduled(env, EVERY_MINUTE, Date.parse('2030-01-01T00:00:00.000Z'));

    expect(await remaining('oauth_states', [state])).toEqual([]);
  });
});

describe('1回で消す行数の上限', () => {
  test('上限を超える行があるとき、1回目は上限の行数だけ、2回目で残りが消える', async () => {
    const states = [
      await insertOauthState(iso(-3 * MINUTE)),
      await insertOauthState(iso(-3 * MINUTE)),
      await insertOauthState(iso(-3 * MINUTE)),
    ];

    await cleanupExpired(env, new Date(NOW), { limit: 2 });
    expect(await remaining('oauth_states', states)).toHaveLength(1);

    await cleanupExpired(env, new Date(NOW), { limit: 2 });
    expect(await remaining('oauth_states', states)).toEqual([]);
  });

  test('既定の上限は1万行', () => {
    expect(CLEANUP_ROW_LIMIT).toBe(10000);
  });
});

describe('失敗の切り分け', () => {
  test('1つの表の文が失敗しても、他の表は消え、scheduled() は例外で終わる', async () => {
    const state = await insertOauthState(iso(-MINUTE));
    const session = await insertSession(iso(-MINUTE));
    const rateLimit = await insertRateLimit(iso(-LONGEST_WINDOW_MS - MINUTE));
    const failing = envWithD1Hooks(env, {
      beforeBatch: (sqls) => {
        if (sqls.some((sql) => sql.startsWith('delete from "sessions"'))) throw new Error('secret SQL detail');
      },
    });

    await expect(runScheduled(failing)).rejects.toThrow('sessions');

    expect(await remaining('oauth_states', [state])).toEqual([]);
    expect(await remaining('rate_limits', [rateLimit])).toEqual([]);
    expect(await remaining('sessions', [session])).toEqual([session]);

    // 失敗した表の名前と例外の名前だけが残る。message の中身は出さない
    expect(error).toHaveBeenCalledTimes(1);
    const line = String(error.mock.calls[0]?.[0]);
    expect(JSON.parse(line)).toMatchObject({ level: 'error', table: 'sessions', error: 'Error' });
    expect(line).not.toContain('secret SQL detail');
  });
});

describe('cron の式', () => {
  test('表に無い式で起きたら例外になる', async () => {
    await expect(runScheduled(env, '*/5 * * * *')).rejects.toThrow('*/5 * * * *');
  });
});

describe('ログ', () => {
  test('消した行が無い回は何も出さない', async () => {
    await cleanupExpired(env, new Date(NOW));
    await cleanupExpired(env, new Date(NOW));
    info.mockClear();
    warn.mockClear();

    await runScheduled();

    expect(info).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  test('1行以上消した回は、件数だけの JSON を info に1行出す。行の中身は出さない', async () => {
    await cleanupExpired(env, new Date(NOW));
    info.mockClear();
    const state = await insertOauthState(iso(-MINUTE));
    const session = await insertSession(iso(-MINUTE));
    const key = await insertRateLimit(iso(-LONGEST_WINDOW_MS - MINUTE));

    await runScheduled();

    expect(warn).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledTimes(1);
    const line = String(info.mock.calls[0]?.[0]);
    expect(JSON.parse(line)).toEqual({
      level: 'info',
      job: 'cleanup-expired',
      limit: CLEANUP_ROW_LIMIT,
      deleted: { oauth_states: 1, sessions: 1, rate_limits: 1 },
    });
    for (const secret of [state, session, key]) expect(line).not.toContain(secret);
  });

  test('上限に届いた表があれば、同じ行を warn に出す', async () => {
    await cleanupExpired(env, new Date(NOW));
    info.mockClear();
    await insertOauthState(iso(-MINUTE));
    await insertOauthState(iso(-MINUTE));
    await insertOauthState(iso(-MINUTE));

    await cleanupExpired(env, new Date(NOW), { limit: 2 });

    expect(info).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(warn.mock.calls[0]?.[0]))).toEqual({
      level: 'warn',
      job: 'cleanup-expired',
      limit: 2,
      deleted: { oauth_states: 2, sessions: 0, rate_limits: 0 },
    });
  });
});

describe('最長の窓', () => {
  test('ログインの枠は、最長の窓以下', () => {
    for (const policy of LOGIN_RATE_LIMIT_POLICIES) expect(policy.windowMs).toBeLessThanOrEqual(LONGEST_WINDOW_MS);
    // loginRateLimits() が返す枠は、一覧の値だけ
    for (const ip of ['203.0.113.7', '2001:db8:1:2::1', undefined, 'not-an-ip']) {
      for (const { policy } of loginRateLimits(ip)) expect(LOGIN_RATE_LIMIT_POLICIES).toContain(policy);
    }
    expect(LOGIN_RATE_LIMIT_POLICIES).toEqual([LOGIN_RATE_LIMIT, LOGIN_RATE_LIMIT_IPV6_SITE]);
  });

  test('操作の定義（operations、sessionOperations を含む）の rateLimit の窓は、最長の窓以下', () => {
    for (const definition of operations) {
      if (definition.rateLimit === undefined) continue;
      expect(definition.rateLimit.windowSeconds * 1000, definition.name).toBeLessThanOrEqual(LONGEST_WINDOW_MS);
    }
  });
});
