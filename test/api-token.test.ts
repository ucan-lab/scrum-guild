// API トークンの発行、読み取り、取り消し、期限切れの掃除（src/server/auth/api-token.ts。docs/data-model.md の `api_tokens`）
import { createScheduledController } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { API_TOKEN_MAX_LIFETIME_DAYS, API_TOKEN_PATTERN } from '../src/shared/api-token.ts';
import {
  deleteExpiredApiTokens,
  hashApiToken,
  issueApiToken,
  readApiToken,
  revokeApiTokensOf,
} from '../src/server/auth/api-token.ts';
import { commonDb } from '../src/server/db/index.ts';
import worker from '../src/server/index.ts';
import { createAccount } from './factories.ts';
import { countTokensIn, insertApiToken, tokenRow, tokenRowsOf } from './operations/api-token.ts';

const NOW = new Date('2026-10-25T12:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;
const at = (offsetMs: number) => new Date(NOW.getTime() + offsetMs).toISOString();
const SHA256_OF_ABC = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('形と上限の定数', () => {
  test('API_TOKEN_PATTERN は sgp_ + base64url の43文字だけを通す', () => {
    const body = 'A1_-'.repeat(10) + 'abc';
    expect(body).toHaveLength(43);
    expect(API_TOKEN_PATTERN.test(`sgp_${body}`)).toBe(true);
    for (const bad of [
      body,
      `sgp_${body.slice(1)}`,
      `sgp_${body}A`,
      `SGP_${body}`,
      `sgp_${body.slice(1)}+`,
      `sgp_${body.slice(1)}=`,
      `sgp_${body.slice(1)} `,
      `xsgp_${body}`,
      '',
    ]) {
      expect(API_TOKEN_PATTERN.test(bad), bad).toBe(false);
    }
  });

  test('上限は90日', () => {
    expect(API_TOKEN_MAX_LIFETIME_DAYS).toBe(90);
  });
});

describe('hashApiToken', () => {
  test('SHA-256 の小文字の16進64文字', async () => {
    expect(await hashApiToken('abc')).toBe(SHA256_OF_ABC);
  });
});

describe('issueApiToken', () => {
  test('sgp_ + 43文字の生の値を返し、毎回違う', async () => {
    const account = await createAccount();
    const input = { accountId: account.id, name: '手元の CLI', scope: 'read', now: NOW } as const;
    const first = await issueApiToken(env, input);
    const second = await issueApiToken(env, input);
    expect(first).toMatch(API_TOKEN_PATTERN);
    expect(second).toMatch(API_TOKEN_PATTERN);
    expect(first).not.toBe(second);
  });

  test('DB にはハッシュだけを入れ、生の値は行のどこにも無い', async () => {
    const account = await createAccount();
    const raw = await issueApiToken(env, { accountId: account.id, name: '手元の CLI', scope: 'write', now: NOW });
    const rows = await tokenRowsOf(account.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.token_hash).toBe(await hashApiToken(raw));
    expect(rows[0]).toMatchObject({ account_id: account.id, name: '手元の CLI', scope: 'write', revoked_at: null });
    expect(JSON.stringify(rows[0])).not.toContain(raw);
    expect(JSON.stringify(rows[0])).not.toContain(raw.slice(4));
  });

  test('期限は now + 90日（省略時）で、lifetimeDays を渡すとその日数', async () => {
    const account = await createAccount();
    const byDefault = await issueApiToken(env, { accountId: account.id, name: 'a', scope: 'read', now: NOW });
    const thirty = await issueApiToken(env, {
      accountId: account.id,
      name: 'b',
      scope: 'read',
      now: NOW,
      lifetimeDays: 30,
    });
    const max = await issueApiToken(env, {
      accountId: account.id,
      name: 'c',
      scope: 'read',
      now: NOW,
      lifetimeDays: API_TOKEN_MAX_LIFETIME_DAYS,
    });
    expect((await tokenRow(await hashApiToken(byDefault)))!.expires_at).toBe(at(90 * DAY_MS));
    expect((await tokenRow(await hashApiToken(thirty)))!.expires_at).toBe(at(30 * DAY_MS));
    expect((await tokenRow(await hashApiToken(max)))!.expires_at).toBe(at(90 * DAY_MS));
  });

  test('91日と、1日未満は例外で、行を作らない', async () => {
    const account = await createAccount();
    for (const lifetimeDays of [91, 0, -1]) {
      await expect(
        issueApiToken(env, { accountId: account.id, name: 'x', scope: 'read', now: NOW, lifetimeDays }),
        String(lifetimeDays),
      ).rejects.toThrow();
    }
    expect(await tokenRowsOf(account.id)).toHaveLength(0);
  });

  test('発行した値は readApiToken で読める', async () => {
    const account = await createAccount();
    const raw = await issueApiToken(env, { accountId: account.id, name: 'x', scope: 'read', now: new Date() });
    expect(await readApiToken(env, raw, new Date())).toEqual({
      accountId: account.id,
      tokenHash: await hashApiToken(raw),
      scope: 'read',
    });
  });
});

describe('readApiToken', () => {
  test('有効なトークンは、アカウントと範囲とハッシュを返す', async () => {
    const account = await createAccount();
    const { raw, hash } = await insertApiToken(account.id, { scope: 'read', expiresAt: at(DAY_MS) });
    expect(await readApiToken(env, raw, NOW)).toEqual({ accountId: account.id, tokenHash: hash, scope: 'read' });
  });

  test('無い、空、行の無い値は undefined', async () => {
    expect(await readApiToken(env, undefined, NOW)).toBeUndefined();
    expect(await readApiToken(env, '', NOW)).toBeUndefined();
    expect(await readApiToken(env, `sgp_${'B'.repeat(43)}`, NOW)).toBeUndefined();
  });

  test('形の違う値は、同じ値の行があっても undefined', async () => {
    const account = await createAccount();
    const body = 'k'.repeat(43);
    for (const raw of [body, `sgp_${body.slice(1)}`, `sgp_${body}k`, `SGP_${body}`, `sgp_${body.slice(1)}+`]) {
      await insertApiToken(account.id, { raw, expiresAt: at(DAY_MS) });
      expect(await readApiToken(env, raw, NOW), raw).toBeUndefined();
    }
  });

  test('期限は expires_at <= now で切れる', async () => {
    const account = await createAccount();
    const past = await insertApiToken(account.id, { expiresAt: at(-1000) });
    const exact = await insertApiToken(account.id, { expiresAt: at(0) });
    const future = await insertApiToken(account.id, { expiresAt: at(1) });
    expect(await readApiToken(env, past.raw, NOW)).toBeUndefined();
    expect(await readApiToken(env, exact.raw, NOW)).toBeUndefined();
    expect(await readApiToken(env, future.raw, NOW)).toMatchObject({ accountId: account.id });
  });

  test('取消済みは undefined', async () => {
    const account = await createAccount();
    const { raw } = await insertApiToken(account.id, { expiresAt: at(DAY_MS), revokedAt: at(-1000) });
    expect(await readApiToken(env, raw, NOW)).toBeUndefined();
  });

  test('読めたとき last_used_at を now に書き、expires_at は延ばさない', async () => {
    const account = await createAccount();
    const { raw, hash } = await insertApiToken(account.id, {
      createdAt: '2026-10-01T00:00:00.000Z',
      lastUsedAt: '2026-10-02T00:00:00.000Z',
      expiresAt: at(DAY_MS),
    });
    expect(await readApiToken(env, raw, NOW)).toBeDefined();
    const row = await tokenRow(hash);
    expect(row!.last_used_at).toBe(NOW.toISOString());
    expect(row!.expires_at).toBe(at(DAY_MS));
  });

  test('何度使っても expires_at は変わらない', async () => {
    const account = await createAccount();
    const { raw, hash } = await insertApiToken(account.id, { expiresAt: at(DAY_MS) });
    for (let i = 1; i <= 3; i++) await readApiToken(env, raw, new Date(NOW.getTime() + i * 60 * 60 * 1000));
    expect((await tokenRow(hash))!.expires_at).toBe(at(DAY_MS));
  });

  test('読めなかったとき last_used_at は書き換えない', async () => {
    const account = await createAccount();
    const expired = await insertApiToken(account.id, { expiresAt: at(-1000), lastUsedAt: '2026-10-02T00:00:00.000Z' });
    const revoked = await insertApiToken(account.id, {
      expiresAt: at(DAY_MS),
      revokedAt: at(-1000),
      lastUsedAt: '2026-10-02T00:00:00.000Z',
    });
    await readApiToken(env, expired.raw, NOW);
    await readApiToken(env, revoked.raw, NOW);
    expect((await tokenRow(expired.hash))!.last_used_at).toBe('2026-10-02T00:00:00.000Z');
    expect((await tokenRow(revoked.hash))!.last_used_at).toBe('2026-10-02T00:00:00.000Z');
  });
});

describe('revokeApiTokensOf', () => {
  test('判定の時刻までに作られた、その人のトークンだけに revoked_at を書く', async () => {
    const [account, other] = await Promise.all([createAccount(), createAccount()]);
    const before = await insertApiToken(account.id, { createdAt: at(-1000), expiresAt: at(DAY_MS) });
    const exact = await insertApiToken(account.id, { createdAt: at(0), expiresAt: at(DAY_MS) });
    const after = await insertApiToken(account.id, { createdAt: at(1000), expiresAt: at(DAY_MS) });
    const others = await insertApiToken(other.id, { createdAt: at(-1000), expiresAt: at(DAY_MS) });

    await revokeApiTokensOf(commonDb(env), account.id, NOW);

    expect((await tokenRow(before.hash))!.revoked_at).not.toBeNull();
    expect((await tokenRow(exact.hash))!.revoked_at).not.toBeNull();
    expect((await tokenRow(after.hash))!.revoked_at).toBeNull();
    expect((await tokenRow(others.hash))!.revoked_at).toBeNull();
  });

  test('取り消したトークンは読めなくなる', async () => {
    const account = await createAccount();
    const { raw } = await insertApiToken(account.id, { createdAt: at(-1000), expiresAt: at(DAY_MS) });
    expect(await readApiToken(env, raw, NOW)).toBeDefined();
    await revokeApiTokensOf(commonDb(env), account.id, NOW);
    expect(await readApiToken(env, raw, NOW)).toBeUndefined();
  });
});

describe('期限切れの掃除', () => {
  beforeEach(async () => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    // 前のテストが残した期限切れの行で件数が変わらないよう、先に片付ける
    await deleteExpiredApiTokens(env, NOW);
  });

  test('deleteExpiredApiTokens は expires_at <= now の行だけを消し、消した件数を返す', async () => {
    const account = await createAccount();
    const past = await insertApiToken(account.id, { expiresAt: at(-1000) });
    const exact = await insertApiToken(account.id, { expiresAt: at(0) });
    const future = await insertApiToken(account.id, { expiresAt: at(1000) });
    // 取り消し済みでも、期限が来るまでは残す
    const revoked = await insertApiToken(account.id, { expiresAt: at(1000), revokedAt: at(-1000) });

    expect(await deleteExpiredApiTokens(env, NOW)).toBe(2);

    expect(await countTokensIn([past.hash, exact.hash, future.hash, revoked.hash])).toEqual(
      [future.hash, revoked.hash].sort(),
    );
  });

  test('毎分の掃除（scheduled）が期限切れのトークンを消す', async () => {
    const account = await createAccount();
    const past = await insertApiToken(account.id, { expiresAt: at(-1000) });
    const future = await insertApiToken(account.id, { expiresAt: at(1000) });

    await worker.scheduled(createScheduledController({ scheduledTime: NOW.getTime(), cron: '* * * * *' }), env);

    expect(await countTokensIn([past.hash, future.hash])).toEqual([future.hash]);
  });
});
