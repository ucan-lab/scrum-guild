// レート制限の数え方（src/server/auth/rate-limit.ts、client-ip.ts）。IP を数える単位と、並行した呼び出しの数え方
import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import { clientIpUnits } from '../src/server/auth/client-ip.ts';
import {
  consumeLoginRateLimits,
  consumeRateLimit,
  isRateLimitExceeded,
  LOGIN_RATE_LIMIT,
  LOGIN_RATE_LIMIT_GLOBAL,
  LOGIN_RATE_LIMIT_IPV6_SITE,
  LOGIN_RATE_LIMIT_POLICIES,
  loginRateLimits,
  longestRateLimitWindowMs,
} from '../src/server/auth/rate-limit.ts';
import { commonDb } from '../src/server/db/index.ts';

const v4 = (address: string) => ({ kind: 'v4', address });
const v6 = (network64: string, network48: string) => ({ kind: 'v6', network64, network48 });
const unknown = { kind: 'unknown' };

describe('IP を数える単位', () => {
  test('IPv4 はそのまま。前後の空白と、0 を前に付けた書き方は直す', () => {
    expect(clientIpUnits('203.0.113.7')).toEqual(v4('203.0.113.7'));
    expect(clientIpUnits(' 203.0.113.7 ')).toEqual(v4('203.0.113.7'));
    expect(clientIpUnits('203.000.113.007')).toEqual(v4('203.0.113.7'));
  });

  test.each([
    '256.0.0.1',
    '1.2.3',
    '1.2.3.4.5',
    '1.2.3.1000',
    '999.999.999.999',
    '-1.2.3.4',
    'a.b.c.d',
    '203.0.113.7:80',
  ])('IPv4 の形でも IPv6 の形でもない %s は unknown', (value) => {
    expect(clientIpUnits(value)).toEqual(unknown);
  });

  test.each([
    ['::ffff:203.0.113.7', '203.0.113.7'],
    ['::FFFF:203.0.113.7', '203.0.113.7'],
    // 16進で書いた IPv4 射影
    ['::ffff:0102:0304', '1.2.3.4'],
    ['::ffff:cb00:7107', '203.0.113.7'],
    ['::ffff:102:304', '1.2.3.4'],
    // 全部を書いた形
    ['0:0:0:0:0:ffff:0102:0304', '1.2.3.4'],
    ['0000:0000:0000:0000:0000:ffff:0102:0304', '1.2.3.4'],
    ['0:0:0:0:0:ffff:1.2.3.4', '1.2.3.4'],
    ['0000:0000:0000:0000:0000:FFFF:cb00:7107', '203.0.113.7'],
    // 途中を `::` で縮めた形
    ['0:0::ffff:0102:0304', '1.2.3.4'],
    ['::0:ffff:0102:0304', '1.2.3.4'],
  ])('IPv4 射影 %s は IPv4 %s に直す', (value, address) => {
    expect(clientIpUnits(value)).toEqual(v4(address));
  });

  test.each([
    // オクテットが 0 から 255 の外
    '::ffff:256.0.0.1',
    '::ffff:1.2.3.999',
    '::ffff:1.2.3',
    '::ffff:1.2.3.4.5',
    '::1.2.3.256',
    // IPv4 の書き方が末尾でない
    '::1.2.3.4:ffff',
  ])('IPv4 の部分の形が合わない %s は unknown', (value) => {
    expect(clientIpUnits(value)).toEqual(unknown);
  });

  test('IPv4 射影でない IPv6 は、IPv4 に直さない', () => {
    // ::ffff:0:0/96 の外（上位が 0 でない、5つ目が ffff でない）
    expect(clientIpUnits('1::ffff:0102:0304').kind).toBe('v6');
    expect(clientIpUnits('::fffe:0102:0304').kind).toBe('v6');
    expect(clientIpUnits('::1:ffff:0102:0304').kind).toBe('v6');
    expect(clientIpUnits('64:ff9b::192.0.2.33')).toEqual(v6('64:ff9b:0:0::/64', '64:ff9b:0::/48'));
  });

  test.each([
    ['2001:db8:1:2:3:4:5:6', '2001:db8:1:2::/64', '2001:db8:1::/48'],
    ['2001:0DB8:0001:0002:ffff:ffff:ffff:ffff', '2001:db8:1:2::/64', '2001:db8:1::/48'],
    ['2001:db8:1:2::1', '2001:db8:1:2::/64', '2001:db8:1::/48'],
    ['2001:db8:1:2:abcd::', '2001:db8:1:2::/64', '2001:db8:1::/48'],
    ['2001:db8::1', '2001:db8:0:0::/64', '2001:db8:0::/48'],
    ['2001:db8:0:0:1::2', '2001:db8:0:0::/64', '2001:db8:0::/48'],
    ['::1', '0:0:0:0::/64', '0:0:0::/48'],
    ['::', '0:0:0:0::/64', '0:0:0::/48'],
    ['fe80::1%eth0', 'fe80:0:0:0::/64', 'fe80:0:0::/48'],
  ])('IPv6 %s は上位 64 ビットと 48 ビットに丸める', (value, network64, network48) => {
    expect(clientIpUnits(value)).toEqual(v6(network64, network48));
  });

  test('同じ /64 は同じ枠、同じ /48 の別の /64 は /64 が別で /48 は同じ、別の /48 はどちらも別。/48 を先に数える', () => {
    const keys = (ip: string) => loginRateLimits(ip).map((limit) => limit.key);
    expect(keys('2001:db8:1:2::1')).toEqual(['login48:2001:db8:1::/48', 'login:2001:db8:1:2::/64']);
    expect(keys('2001:db8:1:2:ffff:eeee:dddd:cccc')).toEqual(keys('2001:db8:1:2::1'));
    const sibling = keys('2001:db8:1:3::1');
    expect(sibling[0]).toBe(keys('2001:db8:1:2::1')[0]);
    expect(sibling[1]).not.toBe(keys('2001:db8:1:2::1')[1]);
    const other = keys('2001:db8:2:2::1');
    expect(other[0]).not.toBe(keys('2001:db8:1:2::1')[0]);
    expect(other[1]).not.toBe(keys('2001:db8:1:2::1')[1]);
  });

  test('IPv4 は1つの枠、/48 の枠は /64 より緩い上限', () => {
    expect(loginRateLimits('203.0.113.7')).toEqual([{ key: 'login:203.0.113.7', policy: LOGIN_RATE_LIMIT }]);
    expect(loginRateLimits('::ffff:0102:0304')).toEqual([{ key: 'login:1.2.3.4', policy: LOGIN_RATE_LIMIT }]);
    const [wide, narrow] = loginRateLimits('2001:db8:1:2::1');
    expect(narrow!.policy).toBe(LOGIN_RATE_LIMIT);
    expect(wide!.policy).toBe(LOGIN_RATE_LIMIT_IPV6_SITE);
    expect(wide!.policy.max).toBeGreaterThan(narrow!.policy.max);
    expect(wide!.policy.windowMs).toBeGreaterThanOrEqual(narrow!.policy.windowMs);
  });

  test.each([undefined, '', '  ', 'zz::1', '1:2:3::4::5', 'not an ip', `1:${'2'.repeat(100)}`, '::ffff:'])(
    '解釈できない値（%j）と IP の無いリクエストは、login:unknown の1つの枠にまとめる',
    (value) => {
      expect(loginRateLimits(value)).toEqual([{ key: 'login:unknown', policy: LOGIN_RATE_LIMIT }]);
    },
  );
});

// ほかのテストと枠が重ならないよう、テストごとに /48 を変える。3つ目の組は 0 で始まらない（キーは前の 0 を落とした形）
const randomSite = () => `2001:db8:${(0x1000 + Math.floor(Math.random() * 0xefff)).toString(16)}`;

describe('IPv6 の2つの枠', () => {
  const rowOf = async (key: string) => {
    const db = commonDb(env);
    return db.first(db.statement((q) => q.selectFrom('rate_limits').selectAll().where('key', '=', key)));
  };
  const setCount = async (key: string, count: number) => {
    const db = commonDb(env);
    await db.batch([db.statement((q) => q.updateTable('rate_limits').set({ count }).where('key', '=', key))]);
  };
  const now = new Date();

  test('/64 の上限を超えたら断り、同じ /48 の別の /64 は通る。両方の枠を数える', async () => {
    const site = randomSite();
    const address = (n64: number) => `${site}:${n64}::1`;
    expect(await consumeLoginRateLimits(env, address(1), now)).toBe(true);
    expect((await rowOf(`login:${site}:1::/64`))?.count).toBe(1);
    await setCount(`login:${site}:1::/64`, LOGIN_RATE_LIMIT.max);
    expect(await consumeLoginRateLimits(env, address(1), now)).toBe(false);
    // 同じ /48 の別の /64 は、自分の枠が空なので通る
    expect(await consumeLoginRateLimits(env, address(2), now)).toBe(true);
    // /48 の枠は、どの /64 からも数えている。/64 の枠に断られた呼び出しは、覗いただけで /48 も数えない
    expect((await rowOf(`login48:${site}::/48`))?.count).toBe(2);
  });

  test('/48 の上限を超えたら、/64 の枠が空でも断る', async () => {
    const site = randomSite();
    const address = (n64: number) => `${site}:${n64}::1`;
    expect(await consumeLoginRateLimits(env, address(1), now)).toBe(true);
    await setCount(`login48:${site}::/48`, LOGIN_RATE_LIMIT_IPV6_SITE.max);
    expect(await consumeLoginRateLimits(env, address(7), now)).toBe(false);
    // /48 で断った呼び出しは、/64 の行を作らない
    expect(await rowOf(`login:${site}:7::/64`)).toBeUndefined();
    // 別の /48 は数えていない
    const other = randomSite();
    expect(await consumeLoginRateLimits(env, `${other}:1::1`, now)).toBe(true);
  });

  test('上限ちょうどまでは通り、1つ超えたら断る（/64 と /48 のそれぞれ）', async () => {
    const site = randomSite();
    const address = `${site}:9::1`;
    expect(await consumeLoginRateLimits(env, address, now)).toBe(true);
    await setCount(`login:${site}:9::/64`, LOGIN_RATE_LIMIT.max - 1);
    expect(await consumeLoginRateLimits(env, address, now)).toBe(true);
    expect(await consumeLoginRateLimits(env, address, now)).toBe(false);

    const wideSite = randomSite();
    const wideAddress = `${wideSite}:9::1`;
    expect(await consumeLoginRateLimits(env, wideAddress, now)).toBe(true);
    await setCount(`login48:${wideSite}::/48`, LOGIN_RATE_LIMIT_IPV6_SITE.max - 1);
    expect(await consumeLoginRateLimits(env, wideAddress, now)).toBe(true);
    expect(await consumeLoginRateLimits(env, wideAddress, now)).toBe(false);
  });
});

describe('数えずに覗く', () => {
  const policy = { max: 3, windowMs: 60_000 };
  const now = new Date();
  const setRow = async (key: string, count: number, windowStartAt: Date) => {
    const db = commonDb(env);
    await db.batch([
      db.statement((q) =>
        q.insertInto('rate_limits').values({ key, window_start_at: windowStartAt.toISOString(), count }),
      ),
    ]);
  };

  test('行が無い枠は超えておらず、覗いても行を作らない', async () => {
    const key = `test:${crypto.randomUUID()}`;
    expect(await isRateLimitExceeded(env, key, policy, now)).toBe(false);
    const db = commonDb(env);
    expect(
      await db.first(db.statement((q) => q.selectFrom('rate_limits').selectAll().where('key', '=', key))),
    ).toBeUndefined();
  });

  test('窓の内は、count が上限に届いたら超えている（次の呼び出しが断られる）', async () => {
    const below = `test:${crypto.randomUUID()}`;
    await setRow(below, policy.max - 1, now);
    expect(await isRateLimitExceeded(env, below, policy, now)).toBe(false);
    const reached = `test:${crypto.randomUUID()}`;
    await setRow(reached, policy.max, now);
    expect(await isRateLimitExceeded(env, reached, policy, now)).toBe(true);
    // 覗いた判定と、数えたときの判定が合う
    expect(await consumeRateLimit(env, reached, policy, now)).toBe(false);
  });

  test('窓を過ぎた行は、上限を超えた count でも超えていない（consumeRateLimit と同じ境目）', async () => {
    const boundary = `test:${crypto.randomUUID()}`;
    await setRow(boundary, policy.max + 10, new Date(now.getTime() - policy.windowMs));
    expect(await isRateLimitExceeded(env, boundary, policy, now)).toBe(false);
    expect(await consumeRateLimit(env, boundary, policy, now)).toBe(true);

    const inside = `test:${crypto.randomUUID()}`;
    await setRow(inside, policy.max, new Date(now.getTime() - policy.windowMs + 1));
    expect(await isRateLimitExceeded(env, inside, policy, now)).toBe(true);
  });

  test('全体の枠は、掃除の境目の最長の窓を求める枠の一覧に入る', () => {
    expect(LOGIN_RATE_LIMIT_POLICIES).toContain(LOGIN_RATE_LIMIT_GLOBAL);
    expect(longestRateLimitWindowMs([])).toBeGreaterThanOrEqual(LOGIN_RATE_LIMIT_GLOBAL.windowMs);
  });
});

describe('並行した数え方', () => {
  test('N 回を並行して流すと、count は N になり、上限までが通る', async () => {
    const key = `test:${crypto.randomUUID()}`;
    const policy = { max: 7, windowMs: 60_000 };
    const now = new Date();
    const count = 20;
    const results = await Promise.all(Array.from({ length: count }, () => consumeRateLimit(env, key, policy, now)));
    expect(results.filter(Boolean)).toHaveLength(policy.max);

    const db = commonDb(env);
    const row = await db.first(db.statement((q) => q.selectFrom('rate_limits').selectAll().where('key', '=', key)));
    expect(row?.count).toBe(count);
  });
});
