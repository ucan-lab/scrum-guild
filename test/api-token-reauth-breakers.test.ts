// API トークンの発行の再認証（#714）を崩す側のテスト。test/api-token-reauth.test.ts（境目の10分、延長、can_create の基本）と
// 重ならない手口だけを置く: created_at の形（読めない値、桁と時差の違う表記）、同時の発行、ログインし直し、
// API トークンの呼び出しで createdAt を読んで落ちないこと、断るときの順序とログ
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createSessionWithToken } from './factories.ts';
import { API_TOKEN_MAX_ACTIVE, API_TOKEN_REAUTH_MINUTES } from '../src/shared/api-token.ts';
import { logout, me, tokenCreate, tokenList, tokenRevoke } from '../src/shared/operations/session/index.ts';
import { createApp } from '../src/server/app.ts';
import { createSession, hashSessionToken } from '../src/server/auth/session.ts';
import { commonDb } from '../src/server/db/index.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import { insertApiToken, tokenRowsOf } from './operations/api-token.ts';
import { errorCodeOf, post } from './operations/harness.ts';
import { createLoginPerson } from './operations/world.ts';
import type { Person } from './operations/world.ts';

const app = createApp([...implementedOperations]);
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const GRACE_MS = API_TOKEN_REAUTH_MINUTES * MINUTE_MS;
const BODY = { name: '手元の CLI', scope: 'write' };
// 秒までで切った時刻。ミリ秒の無い表記（`...:00Z`）でも、ちょうど10分前を表せる
let now = 0;

beforeEach(() => {
  now = Math.floor(Date.now() / 1000) * 1000;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(now));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const iso = (ms: number) => new Date(ms).toISOString();
const create = (person: Person) => post(app, tokenCreate, { token: person.token, body: BODY });
const list = (person: Person) => post(app, tokenList, { token: person.token });
const personWith = (createdAt: string, lastUsedAt = iso(now)) =>
  createLoginPerson({ sessionOverrides: { created_at: createdAt, last_used_at: lastUsedAt } });

async function canCreate(person: Person): Promise<unknown> {
  const res = await list(person);
  expect(res.status).toBe(200);
  return ((await res.json()) as { can_create?: unknown }).can_create;
}

// 同じ行について、can_create と token-create が割れないことを返す。許したか
async function agreed(person: Person): Promise<boolean> {
  const allowed = await canCreate(person);
  const res = await create(person);
  expect(typeof allowed).toBe('boolean');
  expect(res.status, `can_create=${String(allowed)}`).toBe(allowed === true ? 200 : 403);
  if (res.status === 403) expect(await errorCodeOf(res)).toBe('reauth_required');
  return allowed === true;
}

// 同じ瞬間を表す、形の違う created_at。ちょうど10分前と、1秒超えた時刻
function spellings(ms: number): Record<string, string> {
  const d = new Date(ms);
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  const jst = new Date(ms + 9 * HOUR_MS);
  const jstText =
    `${jst.getUTCFullYear()}-${pad(jst.getUTCMonth() + 1)}-${pad(jst.getUTCDate())}` +
    `T${pad(jst.getUTCHours())}:${pad(jst.getUTCMinutes())}:${pad(jst.getUTCSeconds())}`;
  return {
    'ミリ秒つきの Z': d.toISOString(),
    'ミリ秒なしの Z': d.toISOString().replace('.000Z', 'Z'),
    '+00:00': d.toISOString().replace('Z', '+00:00'),
    '+09:00（時差つき）': `${jstText}.000+09:00`,
  };
}

describe('created_at の表記が違っても、境目で can_create と token-create は同じ結果になる', () => {
  // now は beforeEach で決まるので、表記の組はテストの中で作る
  const labels = Object.keys(spellings(0));
  for (const label of labels) {
    test(`${label}: ちょうど10分は両方通す`, async () => {
      expect(await agreed(await personWith(spellings(now - GRACE_MS)[label]!))).toBe(true);
    });
  }
  for (const label of labels) {
    test(`${label}: 10分を1秒超えたら両方断る`, async () => {
      const person = await personWith(spellings(now - GRACE_MS - 1000)[label]!);
      expect(await agreed(person)).toBe(false);
      expect(await tokenRowsOf(person.accountId)).toHaveLength(0);
    });
  }
});

describe('読めない created_at は、通さない（500 にも 200 にもならない）', () => {
  for (const bad of ['', 'garbage', '0', 'Invalid Date', '2026-13-45T99:99:99.000Z']) {
    test(`created_at が ${JSON.stringify(bad)}`, async () => {
      const person = await personWith(bad);
      // token-list は読み取りなので成功し、can_create は false
      expect(await canCreate(person)).toBe(false);
      const res = await create(person);
      expect(res.status).toBe(403);
      expect(await errorCodeOf(res)).toBe('reauth_required');
      expect(await tokenRowsOf(person.accountId)).toHaveLength(0);
    });
  }
});

describe('時刻の前後関係がおかしい行', () => {
  test('created_at が last_used_at より後でも、created_at だけで判定する（新しければ通す）', async () => {
    const person = await personWith(iso(now - MINUTE_MS), iso(now - 3 * HOUR_MS));
    expect(await agreed(person)).toBe(true);
  });

  test('last_used_at が読めなくても（書き直される）、created_at が新しければ発行できる', async () => {
    const person = await personWith(iso(now - MINUTE_MS), 'garbage');
    expect(await agreed(person)).toBe(true);
  });

  test('last_used_at が最近でも created_at が10分超なら断る（last_used_at を見ていない）', async () => {
    const person = await personWith(iso(now - GRACE_MS - 1), iso(now));
    expect(await agreed(person)).toBe(false);
  });

  test('未来の created_at（時計のずれ）でも、can_create と token-create は割れない', async () => {
    for (const ahead of [1, MINUTE_MS, HOUR_MS]) await agreed(await personWith(iso(now + ahead)));
  });
});

describe('時間がたつと同じセッションの結果が変わる（判定が毎回の時刻で行われる）', () => {
  test('ちょうど10分は通り、1ミリ秒進むと同じ Cookie で断られ、can_create も false に変わる', async () => {
    const person = await personWith(iso(now));
    vi.setSystemTime(new Date(now + GRACE_MS));
    expect(await canCreate(person)).toBe(true);
    vi.setSystemTime(new Date(now + GRACE_MS + 1));
    expect(await canCreate(person)).toBe(false);
    const res = await create(person);
    expect(res.status).toBe(403);
    expect(await errorCodeOf(res)).toBe('reauth_required');
  });

  test('1回発行できたセッションも、10分を過ぎたら次の発行は断られ、先に作ったトークンの行は残る', async () => {
    const person = await personWith(iso(now));
    expect((await create(person)).status).toBe(200);
    vi.setSystemTime(new Date(now + GRACE_MS + 1));
    expect(await errorCodeOf(await create(person))).toBe('reauth_required');
    expect(await tokenRowsOf(person.accountId)).toHaveLength(1);
  });
});

describe('同時の発行', () => {
  test('新しいセッションの同時2回は、どちらも通って2行になる', async () => {
    const person = await personWith(iso(now));
    const results = await Promise.all([create(person), create(person)]);
    expect(results.map((res) => res.status)).toEqual([200, 200]);
    expect(await tokenRowsOf(person.accountId)).toHaveLength(2);
  });

  test('古いセッションの同時2回と、断られた直後の再送は、すべて 403 の reauth_required で行は0', async () => {
    const person = await personWith(iso(now - GRACE_MS - 1));
    const results = await Promise.all([create(person), create(person)]);
    expect(results.map((res) => res.status)).toEqual([403, 403]);
    expect(await Promise.all(results.map(errorCodeOf))).toEqual(['reauth_required', 'reauth_required']);
    const resend = await create(person);
    expect(resend.status).toBe(403);
    expect(await tokenRowsOf(person.accountId)).toHaveLength(0);
  });

  test('ちょうど10分のセッションの同時の発行と一覧は、同じ時刻で判定し、すべて通る', async () => {
    const person = await personWith(iso(now - GRACE_MS));
    const [a, b, c] = await Promise.all([create(person), list(person), create(person)]);
    expect([a.status, b.status, c.status]).toEqual([200, 200, 200]);
    expect(((await b.json()) as { can_create: boolean }).can_create).toBe(true);
  });
});

describe('ログインし直し（createSession の replacedToken）', () => {
  test('古いセッションで断られた人は、ログインし直した新しいセッションで発行でき、古い Cookie は 401', async () => {
    const stale = await personWith(iso(now - 2 * HOUR_MS));
    expect(await errorCodeOf(await create(stale))).toBe('reauth_required');

    const newToken = await createSession(env, stale.accountId, new Date(), stale.token);
    const fresh = { ...stale, token: newToken };
    expect(await canCreate(fresh)).toBe(true);
    expect((await create(fresh)).status).toBe(200);
    expect(await tokenRowsOf(stale.accountId)).toHaveLength(1);
    // 置き換えられた古いセッションの行は消えている
    expect((await list(stale)).status).toBe(401);
  });

  test('replacedToken なしでログインし直しても、前の古いセッションは古いまま断られ、新しい方だけが通る', async () => {
    const stale = await personWith(iso(now - 2 * HOUR_MS));
    const newToken = await createSession(env, stale.accountId, new Date(), undefined);
    expect((await create({ ...stale, token: newToken })).status).toBe(200);
    expect(await errorCodeOf(await create(stale))).toBe('reauth_required');
  });

  test('ログインし直した新しいセッションの created_at は今で、延長しても動かない', async () => {
    const stale = await personWith(iso(now - 2 * HOUR_MS));
    const newToken = await createSession(env, stale.accountId, new Date(), stale.token);
    vi.setSystemTime(new Date(now + 2 * HOUR_MS));
    const db = commonDb(env);
    const hash = await hashSessionToken(newToken);
    // 2時間後の最初の呼び出しは、last_used_at の書き直しを伴う（そして10分を超えているので断られる）
    expect(await errorCodeOf(await create({ ...stale, token: newToken }))).toBe('reauth_required');
    const row = await db.first(
      db.statement((q) => q.selectFrom('sessions').selectAll().where('token_hash', '=', hash)),
    );
    expect(row!.created_at).toBe(iso(now));
    expect(row!.last_used_at).toBe(iso(now + 2 * HOUR_MS));
  });
});

describe('API トークンの呼び出しは session.createdAt を読まない', () => {
  test('token-list と token-revoke と token-create は、どの範囲のトークンでも 403 の forbidden で、500 にならない', async () => {
    const person = await personWith(iso(now));
    for (const scope of ['read', 'write'] as const) {
      const { raw, hash } = await insertApiToken(person.accountId, { scope, expiresAt: iso(now + 30 * 24 * HOUR_MS) });
      const calls = [
        post(app, tokenList, { bearer: raw, origin: null }),
        post(app, tokenRevoke, { bearer: raw, origin: null, body: { id: hash } }),
        post(app, tokenCreate, { bearer: raw, origin: null, body: BODY }),
        post(app, logout, { bearer: raw, origin: null }),
      ];
      for (const res of await Promise.all(calls)) {
        expect(res.status, scope).toBe(403);
        expect(await errorCodeOf(res), scope).toBe('forbidden');
      }
    }
  });

  test('Cookie と Bearer を両方付けたら Bearer で認証し、token-list は 403 の forbidden（Cookie の created_at に落ちない）', async () => {
    const person = await personWith(iso(now));
    const { raw } = await insertApiToken(person.accountId, { scope: 'write', expiresAt: iso(now + 30 * 24 * HOUR_MS) });
    const res = await post(app, tokenList, { token: person.token, bearer: raw });
    expect(res.status).toBe(403);
    expect(await errorCodeOf(res)).toBe('forbidden');
  });
});

describe('再認証が要るのは token-create だけ', () => {
  test('古いセッションでも、createdAt を使わないほかの操作（me、token-list、token-revoke）は通る', async () => {
    const person = await personWith(iso(now - 5 * 24 * HOUR_MS), iso(now - 5 * 24 * HOUR_MS));
    expect((await post(app, me, { token: person.token })).status).toBe(200);
    expect((await list(person)).status).toBe(200);
    const { hash } = await insertApiToken(person.accountId, { scope: 'read', expiresAt: iso(now + 30 * 24 * HOUR_MS) });
    expect((await post(app, tokenRevoke, { token: person.token, body: { id: hash } })).status).toBe(200);
  });

  test('上限（20件）に達した古いセッションの発行は、409 でなく 403 の reauth_required（再認証が先）', async () => {
    const person = await personWith(iso(now - GRACE_MS - 1));
    for (let i = 0; i < API_TOKEN_MAX_ACTIVE; i++) {
      await insertApiToken(person.accountId, { scope: 'read', expiresAt: iso(now + 30 * 24 * HOUR_MS) });
    }
    const res = await create(person);
    expect(res.status).toBe(403);
    expect(await errorCodeOf(res)).toBe('reauth_required');
    expect(await tokenRowsOf(person.accountId)).toHaveLength(API_TOKEN_MAX_ACTIVE);
  });

  test('上限に達した新しいセッションの発行は、これまでどおり 409 の conflict', async () => {
    const person = await personWith(iso(now));
    for (let i = 0; i < API_TOKEN_MAX_ACTIVE; i++) {
      await insertApiToken(person.accountId, { scope: 'read', expiresAt: iso(now + 30 * 24 * HOUR_MS) });
    }
    const res = await create(person);
    expect(res.status).toBe(409);
    expect(await errorCodeOf(res)).toBe('conflict');
  });
});

describe('断るときの応答とログ', () => {
  test('403 の本文とログに、セッションの値、ハッシュ、created_at の値を出さない', async () => {
    const createdAt = iso(now - 3 * HOUR_MS);
    const person = await personWith(createdAt);
    const lines: string[] = [];
    for (const method of ['log', 'info', 'warn', 'error'] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        lines.push(args.map(String).join(' '));
      });
    }
    const res = await create(person);
    const text = await res.text();
    expect(res.status).toBe(403);
    const hash = await hashSessionToken(person.token);
    for (const secret of [person.token, hash, createdAt]) {
      expect(text).not.toContain(secret);
      for (const line of lines) expect(line).not.toContain(secret);
    }
    // 操作ごとのログは1行で、失敗の code を残す
    expect(lines.some((line) => line.includes('reauth_required'))).toBe(true);
  });

  test('Origin が違う発行は、古いセッションでも 403 の reauth_required ではなく Origin の検査が先に断る', async () => {
    const person = await personWith(iso(now - GRACE_MS - 1));
    const res = await post(app, tokenCreate, { token: person.token, origin: 'https://evil.example', body: BODY });
    expect(res.status).toBe(403);
    expect(await errorCodeOf(res)).not.toBe('reauth_required');
  });

  test('createSessionWithToken の別セッションを足しても、古いセッションの判定は変わらない（同じアカウント内の取り違えが無い）', async () => {
    const stale = await personWith(iso(now - GRACE_MS - 1));
    await createSessionWithToken(stale.accountId, { created_at: iso(now) });
    await createSessionWithToken(stale.accountId, { created_at: iso(now) });
    expect(await agreed(stale)).toBe(false);
  });
});
