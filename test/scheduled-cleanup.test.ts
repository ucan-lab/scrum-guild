// 期限を過ぎた行を消す定期処理（src/server/scheduled/）。scheduled() を直に呼び、基準の時刻は scheduledTime で渡す
import { createScheduledController } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  consumeRateLimit,
  LOGIN_RATE_LIMIT,
  LOGIN_RATE_LIMIT_IPV6_SITE,
  LOGIN_RATE_LIMIT_POLICIES,
  LOGIN_RATE_LIMITS,
  loginRateLimits,
  longestRateLimitWindowMs,
} from '../src/server/auth/rate-limit.ts';
import { commonDb } from '../src/server/db/index.ts';
import { envWithD1Hooks } from '../src/server/db/testing.ts';
import worker from '../src/server/index.ts';
import {
  cleanupExpired,
  CLEANUP_MAX_ROUNDS,
  CLEANUP_ROW_LIMIT,
  CLEANUP_TIME_BUDGET_MS,
  classifyFailure,
} from '../src/server/scheduled/cleanup-expired.ts';
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
  async function insertOauthStates(count: number) {
    const states: string[] = [];
    for (let i = 0; i < count; i++) states.push(await insertOauthState(iso(-3 * MINUTE)));
    return states;
  }

  test('回数の予算が1なら、1回目は上限の行数だけ、2回目で残りが消える', async () => {
    const states = await insertOauthStates(3);

    await cleanupExpired(env, new Date(NOW), { limit: 2, maxRounds: 1 });
    expect(await remaining('oauth_states', states)).toHaveLength(1);

    await cleanupExpired(env, new Date(NOW), { limit: 2, maxRounds: 1 });
    expect(await remaining('oauth_states', states)).toEqual([]);
  });

  test('1回の scheduled() で、上限を超える行が複数回の文で消えきる。warn は出ない', async () => {
    const states = await insertOauthStates(5);

    await cleanupExpired(env, new Date(NOW), { limit: 2 });

    expect(await remaining('oauth_states', states)).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
    expect(JSON.parse(String(info.mock.calls[0]?.[0]))).toMatchObject({
      deleted: { oauth_states: 5, sessions: 0, rate_limits: 0 },
      rounds: { oauth_states: 3, sessions: 1, rate_limits: 1 },
      behind: [],
    });
  });

  test('回数の予算を使い切ると、残りは次の回に残り、warn が出る', async () => {
    const states = await insertOauthStates(7);

    await cleanupExpired(env, new Date(NOW), { limit: 2, maxRounds: 2 });

    expect(await remaining('oauth_states', states)).toHaveLength(3);
    expect(info).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(warn.mock.calls[0]?.[0]))).toMatchObject({
      level: 'warn',
      deleted: { oauth_states: 4 },
      rounds: { oauth_states: 2 },
      behind: ['oauth_states'],
    });

    await cleanupExpired(env, new Date(NOW), { limit: 2, maxRounds: 2 });
    expect(await remaining('oauth_states', states)).toEqual([]);
  });

  test('時間の予算を使い切ると、どの表も最初の1文は送り、繰り返さずに warn が出る', async () => {
    const states = await insertOauthStates(5);
    const sessionHashes = [await insertSession(iso(-MINUTE)), await insertSession(iso(-MINUTE))];

    await cleanupExpired(env, new Date(NOW), { limit: 2, timeBudgetMs: 0 });

    expect(await remaining('oauth_states', states)).toHaveLength(3);
    expect(await remaining('sessions', sessionHashes)).toEqual([]);
    expect(JSON.parse(String(warn.mock.calls[0]?.[0]))).toMatchObject({
      rounds: { oauth_states: 1, sessions: 1, rate_limits: 1 },
      behind: ['oauth_states', 'sessions'],
    });
  });

  test('ちょうど上限の件数の回は、次の文が0件で終わり、warn にならない', async () => {
    const states = await insertOauthStates(2);

    await cleanupExpired(env, new Date(NOW), { limit: 2 });

    expect(await remaining('oauth_states', states)).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
    expect(JSON.parse(String(info.mock.calls[0]?.[0]))).toMatchObject({
      deleted: { oauth_states: 2 },
      rounds: { oauth_states: 2 },
      behind: [],
    });
  });

  test('既定の上限は1万行、1つの表に送る文は20回まで、時間は20秒まで', () => {
    expect(CLEANUP_ROW_LIMIT).toBe(10000);
    expect(CLEANUP_MAX_ROUNDS).toBe(20);
    expect(CLEANUP_TIME_BUDGET_MS).toBe(20_000);
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
    expect(JSON.parse(line)).toMatchObject({
      level: 'error',
      table: 'sessions',
      error: 'Error',
      cause: 'unknown',
      rounds: 0,
      elapsedMs: expect.any(Number),
    });
    expect(line).not.toContain('secret SQL detail');
  });

  test('失敗のログに、message を固定の分類名に直した cause が残り、message は出ない', async () => {
    const failing = envWithD1Hooks(env, {
      beforeBatch: (sqls) => {
        if (sqls.some((sql) => sql.startsWith('delete from "sessions"'))) {
          throw new Error('D1_ERROR: Network connection lost token_hash=secret-hash');
        }
      },
    });

    await expect(runScheduled(failing)).rejects.toThrow('sessions');

    const line = String(error.mock.calls[0]?.[0]);
    expect(JSON.parse(line)).toMatchObject({ table: 'sessions', cause: 'network' });
    expect(line).not.toContain('secret-hash');
  });

  test('message を読むと例外になる Error でも、分類は unknown になり、他の表は消える', async () => {
    const state = await insertOauthState(iso(-MINUTE));
    const broken = new Error('x');
    Object.defineProperty(broken, 'message', {
      get() {
        throw new Error('getter failed');
      },
    });
    const failing = envWithD1Hooks(env, {
      beforeBatch: (sqls) => {
        if (sqls.some((sql) => sql.startsWith('delete from "sessions"'))) throw broken;
      },
    });

    await expect(runScheduled(failing)).rejects.toThrow('sessions');

    expect(await remaining('oauth_states', [state])).toEqual([]);
    expect(JSON.parse(String(error.mock.calls[0]?.[0]))).toMatchObject({ table: 'sessions', cause: 'unknown' });
  });

  test.each([
    [new Error('D1_ERROR: syntax error near "timeout"'), 'syntax'],
    [new Error('D1_ERROR: Network connection lost'), 'network'],
    [new Error('D1 DB reset because its code was updated'), 'reset'],
    [new Error('D1 DB is overloaded. Requests queued for too long'), 'overloaded'],
    [new Error('operation timed out'), 'timeout'],
    [new Error('UNIQUE constraint failed: sessions.token_hash'), 'constraint'],
    [new Error('no such table: sessions'), 'syntax'],
    [new Error('D1 DB storage operation exceeded CPU time limit'), 'timeout'],
    [new Error('Internal error while starting up D1 DB storage caused object to be reset.'), 'reset'],
    [new Error('D1 exceeded timeout which caused object to be reset'), 'reset'],
    [new Error('database is locked: SQLITE_BUSY'), 'busy'],
    [new Error('Exceeded maximum DB size'), 'storage'],
    // 表名や SQL の断片が message に入っても、文の不具合（constraint、syntax）を先に取る
    [new Error('no such table: rate_limits'), 'syntax'],
    [new Error('D1_ERROR: near "timeout": syntax error'), 'syntax'],
    [new Error('UNIQUE constraint failed: sessions.token_hash (database is locked)'), 'constraint'],
    [new Error('UNIQUE constraint failed: rate_limits.key'), 'constraint'],
    [new Error('wrapper', { cause: new Error('Network connection lost') }), 'network'],
    [new Error('something new'), 'unknown'],
    ['not an error', 'unknown'],
  ])('例外 %s の分類は %s', (err, expected) => {
    expect(classifyFailure(err)).toBe(expected);
  });

  test('繰り返しの途中で表が失敗したら、その表はそこで止まり、残りの表は続く', async () => {
    const states = [
      await insertOauthState(iso(-MINUTE)),
      await insertOauthState(iso(-MINUTE)),
      await insertOauthState(iso(-MINUTE)),
    ];
    const rateLimit = await insertRateLimit(iso(-LONGEST_WINDOW_MS - MINUTE));
    let oauthStateBatches = 0;
    const failing = envWithD1Hooks(env, {
      beforeBatch: (sqls) => {
        if (sqls.some((sql) => sql.startsWith('delete from "oauth_states"')) && ++oauthStateBatches === 2) {
          throw new Error('secret SQL detail');
        }
      },
    });

    await expect(cleanupExpired(failing, new Date(NOW), { limit: 1 })).rejects.toThrow('oauth_states');

    expect(oauthStateBatches).toBe(2);
    // rounds は失敗するまでに成功した文の回数
    expect(JSON.parse(String(error.mock.calls[0]?.[0]))).toMatchObject({ table: 'oauth_states', rounds: 1 });
    expect(await remaining('oauth_states', states)).toHaveLength(2);
    expect(await remaining('rate_limits', [rateLimit])).toEqual([]);
  });

  test('rate_limits の境目の計算が例外になっても、他の2表は消える', async () => {
    const state = await insertOauthState(iso(-MINUTE));
    const session = await insertSession(iso(-MINUTE));

    // 窓が大きすぎて Date が不正になる（toISOString が RangeError）
    await expect(cleanupExpired(env, new Date(NOW), { longestWindowMs: Number.MAX_VALUE })).rejects.toThrow(
      'rate_limits',
    );

    expect(await remaining('oauth_states', [state])).toEqual([]);
    expect(await remaining('sessions', [session])).toEqual([]);
    expect(JSON.parse(String(error.mock.calls[0]?.[0]))).toMatchObject({
      table: 'rate_limits',
      error: 'RangeError',
    });
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
      rounds: { oauth_states: 1, sessions: 1, rate_limits: 1 },
      behind: [],
    });
    for (const secret of [state, session, key]) expect(line).not.toContain(secret);
  });

  test('予算を使い切っても上限に届いた表があれば、同じ行を warn に出す', async () => {
    await insertOauthState(iso(-MINUTE));
    await insertOauthState(iso(-MINUTE));
    await insertOauthState(iso(-MINUTE));

    await cleanupExpired(env, new Date(NOW), { limit: 2, maxRounds: 1 });

    expect(info).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(warn.mock.calls[0]?.[0]))).toEqual({
      level: 'warn',
      job: 'cleanup-expired',
      limit: 2,
      deleted: { oauth_states: 2, sessions: 0, rate_limits: 0 },
      rounds: { oauth_states: 1, sessions: 1, rate_limits: 1 },
      behind: ['oauth_states'],
    });
  });
});

describe('最長の窓', () => {
  test('最長の窓に入らない窓の枠は、consumeRateLimit が例外にする', async () => {
    const tooLong = { max: 1, windowMs: LONGEST_WINDOW_MS + 1 };
    await expect(consumeRateLimit(env, 'login:too-long', tooLong, new Date(NOW))).rejects.toThrow('最長の窓');
    const db = commonDb(env);
    expect(
      await db.first(db.statement((q) => q.selectFrom('rate_limits').selectAll().where('key', '=', 'login:too-long'))),
    ).toBeUndefined();

    const atLongest = { max: 1, windowMs: LONGEST_WINDOW_MS };
    expect(await consumeRateLimit(env, 'login:at-longest', atLongest, new Date(NOW))).toBe(true);
  });

  test('ログインの枠は、最長の窓以下', () => {
    for (const policy of LOGIN_RATE_LIMIT_POLICIES) expect(policy.windowMs).toBeLessThanOrEqual(LONGEST_WINDOW_MS);
    // loginRateLimits() が返す枠は、一覧の値だけ
    for (const ip of ['203.0.113.7', '2001:db8:1:2::1', undefined, 'not-an-ip']) {
      for (const { policy } of loginRateLimits(ip)) expect(LOGIN_RATE_LIMIT_POLICIES).toContain(policy);
    }
    expect(LOGIN_RATE_LIMIT_POLICIES).toEqual(Object.values(LOGIN_RATE_LIMITS));
    expect(LOGIN_RATE_LIMIT).toBe(LOGIN_RATE_LIMITS.network);
    expect(LOGIN_RATE_LIMIT_IPV6_SITE).toBe(LOGIN_RATE_LIMITS.ipv6Site);
  });

  test('操作の定義（operations、sessionOperations を含む）の rateLimit の窓は、最長の窓以下', () => {
    for (const definition of operations) {
      if (definition.rateLimit === undefined) continue;
      expect(definition.rateLimit.windowSeconds * 1000, definition.name).toBeLessThanOrEqual(LONGEST_WINDOW_MS);
    }
  });
});
