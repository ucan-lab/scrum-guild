// パスワードでのログインのレート制限（src/server/auth/rate-limit.ts の consumePasswordLoginRateLimits、Issue #256）。
// キーは `password:<IPv4 か /64>`、`password48:<…/48>`、`password-email:<メールアドレスのハッシュ>`。OAuth のログインの枠と分ける。
// 先に全部を覗き、上限に届いた枠があれば行を書かずに false。成功も含めて試みを数える
import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import {
  consumePasswordLoginRateLimits,
  LOGIN_RATE_LIMITS,
  longestRateLimitWindowMs,
  PASSWORD_LOGIN_RATE_LIMITS,
} from '../src/server/auth/rate-limit.ts';
import { commonDb } from '../src/server/db/index.ts';
import { hash64 } from './factories.ts';

// このファイルの中で IP が重ならないよう、198.18.0.0/15（ベンチマーク用）から順に配る
let ipCount = 0;
const nextIp = () => `198.18.${Math.floor(++ipCount / 250)}.${(ipCount % 250) + 1}`;
// ほかのテストと枠が重ならないよう、テストごとに /48 を変える。3つ目の組は 0 で始まらない（キーは前の 0 を落とした形）
const randomSite = () => `2001:db8:${(0x1000 + Math.floor(Math.random() * 0xefff)).toString(16)}`;

async function rowOf(key: string) {
  const db = commonDb(env);
  return db.first(db.statement((q) => q.selectFrom('rate_limits').selectAll().where('key', '=', key)));
}

async function setRow(key: string, count: number, windowStartAt: Date) {
  const db = commonDb(env);
  await db.batch([
    db.statement((q) =>
      q
        .insertInto('rate_limits')
        .values({ key, window_start_at: windowStartAt.toISOString(), count })
        .onConflict((conflict) =>
          conflict.column('key').doUpdateSet({ window_start_at: windowStartAt.toISOString(), count }),
        ),
    ),
  ]);
}

async function keysLike(pattern: string): Promise<string[]> {
  const db = commonDb(env);
  const rows = await db.rows(
    db.statement((q) => q.selectFrom('rate_limits').select('key').where('key', 'like', pattern)),
  );
  return rows.map((row) => row.key).sort();
}

describe('枠の値', () => {
  test('IP は10分に30回、/48 は60回、メールアドレスは10分に10回', () => {
    expect(PASSWORD_LOGIN_RATE_LIMITS).toEqual({
      network: { max: 30, windowMs: 600_000 },
      ipv6Site: { max: 60, windowMs: 600_000 },
      email: { max: 10, windowMs: 600_000 },
    });
  });

  test('掃除の境目の最長の窓は、パスワードの枠の窓を含む', () => {
    const longest = longestRateLimitWindowMs([]);
    for (const policy of Object.values(PASSWORD_LOGIN_RATE_LIMITS)) {
      expect(longest).toBeGreaterThanOrEqual(policy.windowMs);
    }
  });
});

describe('キー', () => {
  const now = new Date();

  test('IPv4 は password:<IP> と password-email:<ハッシュ> を1回ずつ数える', async () => {
    const ip = nextIp();
    const emailHash = hash64();
    expect(await consumePasswordLoginRateLimits(env, ip, emailHash, now)).toBe(true);
    expect((await rowOf(`password:${ip}`))?.count).toBe(1);
    expect((await rowOf(`password-email:${emailHash}`))?.count).toBe(1);
  });

  test('IPv6 は password48:<…/48> と password:<…/64> を数える', async () => {
    const site = randomSite();
    const emailHash = hash64();
    expect(await consumePasswordLoginRateLimits(env, `${site}:5::1`, emailHash, now)).toBe(true);
    expect((await rowOf(`password48:${site}::/48`))?.count).toBe(1);
    expect((await rowOf(`password:${site}:5::/64`))?.count).toBe(1);
    expect((await rowOf(`password-email:${emailHash}`))?.count).toBe(1);
  });

  test('IP の無いリクエストは password:unknown にまとめる', async () => {
    const before = (await rowOf('password:unknown'))?.count ?? 0;
    expect(await consumePasswordLoginRateLimits(env, undefined, hash64(), now)).toBe(true);
    expect((await rowOf('password:unknown'))?.count).toBe(before + 1);
  });

  test('メールアドレスのハッシュが無ければ、IP の枠だけを数える', async () => {
    const ip = nextIp();
    const before = await keysLike('password-email:%');
    expect(await consumePasswordLoginRateLimits(env, ip, undefined, now)).toBe(true);
    expect((await rowOf(`password:${ip}`))?.count).toBe(1);
    expect(await keysLike('password-email:%')).toEqual(before);
  });

  test('OAuth のログインの枠（login:、login48:）は数えない', async () => {
    const ip = nextIp();
    const site = randomSite();
    await consumePasswordLoginRateLimits(env, ip, hash64(), now);
    await consumePasswordLoginRateLimits(env, `${site}:1::1`, hash64(), now);
    expect(await rowOf(`login:${ip}`)).toBeUndefined();
    expect(await rowOf(`login48:${site}::/48`)).toBeUndefined();
    expect(await rowOf(`login:${site}:1::/64`)).toBeUndefined();
  });

  test('OAuth のログインの枠が上限でも、パスワードの枠は別に数える', async () => {
    const ip = nextIp();
    await setRow(`login:${ip}`, LOGIN_RATE_LIMITS.network.max, now);
    expect(await consumePasswordLoginRateLimits(env, ip, hash64(), now)).toBe(true);
  });
});

describe('上限', () => {
  const now = new Date();

  test('IP の枠は30回まで通り、31回目を断る', async () => {
    const ip = nextIp();
    await setRow(`password:${ip}`, PASSWORD_LOGIN_RATE_LIMITS.network.max - 1, now);
    expect(await consumePasswordLoginRateLimits(env, ip, hash64(), now)).toBe(true);
    expect(await consumePasswordLoginRateLimits(env, ip, hash64(), now)).toBe(false);
  });

  test('/48 の枠は60回まで通り、/64 が空でも61回目を断る', async () => {
    const site = randomSite();
    await setRow(`password48:${site}::/48`, PASSWORD_LOGIN_RATE_LIMITS.ipv6Site.max - 1, now);
    expect(await consumePasswordLoginRateLimits(env, `${site}:1::1`, hash64(), now)).toBe(true);
    expect(await consumePasswordLoginRateLimits(env, `${site}:2::1`, hash64(), now)).toBe(false);
  });

  test('メールアドレスの枠は、別の IP からでも10回まで通り、11回目を断る', async () => {
    const emailHash = hash64();
    for (let i = 0; i < PASSWORD_LOGIN_RATE_LIMITS.email.max; i++) {
      expect(await consumePasswordLoginRateLimits(env, nextIp(), emailHash, now)).toBe(true);
    }
    expect(await consumePasswordLoginRateLimits(env, nextIp(), emailHash, now)).toBe(false);
    // 別のメールアドレスは同じ IP からでも通る
    expect(await consumePasswordLoginRateLimits(env, nextIp(), hash64(), now)).toBe(true);
  });

  test('窓を過ぎれば、上限に届いた枠も数え直して通る（アカウントを締め出さない）', async () => {
    const ip = nextIp();
    const emailHash = hash64();
    const past = new Date(now.getTime() - PASSWORD_LOGIN_RATE_LIMITS.email.windowMs);
    await setRow(`password:${ip}`, PASSWORD_LOGIN_RATE_LIMITS.network.max, past);
    await setRow(`password-email:${emailHash}`, PASSWORD_LOGIN_RATE_LIMITS.email.max, past);
    expect(await consumePasswordLoginRateLimits(env, ip, emailHash, now)).toBe(true);
    expect((await rowOf(`password:${ip}`))?.count).toBe(1);
    expect((await rowOf(`password-email:${emailHash}`))?.count).toBe(1);
  });

  test('窓の中で時刻を進めても、窓を過ぎるまでは断る', async () => {
    const emailHash = hash64();
    await setRow(`password-email:${emailHash}`, PASSWORD_LOGIN_RATE_LIMITS.email.max, now);
    const almost = new Date(now.getTime() + PASSWORD_LOGIN_RATE_LIMITS.email.windowMs - 1);
    expect(await consumePasswordLoginRateLimits(env, nextIp(), emailHash, almost)).toBe(false);
    const after = new Date(now.getTime() + PASSWORD_LOGIN_RATE_LIMITS.email.windowMs);
    expect(await consumePasswordLoginRateLimits(env, nextIp(), emailHash, after)).toBe(true);
  });
});

describe('先に覗く（断ったときに行を書かない）', () => {
  const now = new Date();

  test('メールアドレスの枠が上限なら、IP の行を作らず、メールアドレスの行も数えない', async () => {
    const ip = nextIp();
    const emailHash = hash64();
    await setRow(`password-email:${emailHash}`, PASSWORD_LOGIN_RATE_LIMITS.email.max, now);
    expect(await consumePasswordLoginRateLimits(env, ip, emailHash, now)).toBe(false);
    expect(await rowOf(`password:${ip}`)).toBeUndefined();
    expect((await rowOf(`password-email:${emailHash}`))?.count).toBe(PASSWORD_LOGIN_RATE_LIMITS.email.max);
  });

  test('IP の枠が上限なら、メールアドレスの行を作らず、IP の行も数えない', async () => {
    const ip = nextIp();
    const emailHash = hash64();
    await setRow(`password:${ip}`, PASSWORD_LOGIN_RATE_LIMITS.network.max, now);
    expect(await consumePasswordLoginRateLimits(env, ip, emailHash, now)).toBe(false);
    expect(await rowOf(`password-email:${emailHash}`)).toBeUndefined();
    expect((await rowOf(`password:${ip}`))?.count).toBe(PASSWORD_LOGIN_RATE_LIMITS.network.max);
  });

  test('/48 の枠が上限なら、/64 の行もメールアドレスの行も作らない', async () => {
    const site = randomSite();
    const emailHash = hash64();
    await setRow(`password48:${site}::/48`, PASSWORD_LOGIN_RATE_LIMITS.ipv6Site.max, now);
    expect(await consumePasswordLoginRateLimits(env, `${site}:3::1`, emailHash, now)).toBe(false);
    expect(await rowOf(`password:${site}:3::/64`)).toBeUndefined();
    expect(await rowOf(`password-email:${emailHash}`)).toBeUndefined();
  });

  test('並行した N 回は、メールアドレスの枠の上限までしか通らない', async () => {
    const emailHash = hash64();
    const results = await Promise.all(
      Array.from({ length: 20 }, () => consumePasswordLoginRateLimits(env, nextIp(), emailHash, now)),
    );
    expect(results.filter(Boolean)).toHaveLength(PASSWORD_LOGIN_RATE_LIMITS.email.max);
  });
});
