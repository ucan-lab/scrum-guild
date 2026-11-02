// API トークンの発行の再認証（token-create は、ログイン（sessions.created_at）から API_TOKEN_REAUTH_MINUTES 分以内のセッションだけ）。
// token-list と token-revoke は求めない。基本の取り決めは test/api-token-settings.test.ts
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createSessionWithToken } from './factories.ts';
import { API_TOKEN_REAUTH_MINUTES } from '../src/shared/api-token.ts';
import { errorCodes, isErrorBody } from '../src/shared/errors.ts';
import { tokenCreate, tokenList, tokenRevoke } from '../src/shared/operations/session/index.ts';
import { createApp } from '../src/server/app.ts';
import { hashSessionToken } from '../src/server/auth/session.ts';
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
let now = 0;

beforeEach(() => {
  now = Date.now();
  // 境目（ちょうど10分）を決まった値で確かめるため、Date だけ止める
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(now));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const iso = (ms: number) => new Date(ms).toISOString();

// ログインから ageMs たったセッションを持つ人。lastUsedAgoMs は最後に使ってからの時間（1時間以上で readSession が書き直す）
function personLoggedInAgo(ageMs: number, lastUsedAgoMs = Math.min(ageMs, 1000)) {
  return createLoginPerson({
    sessionOverrides: { created_at: iso(now - ageMs), last_used_at: iso(now - lastUsedAgoMs) },
  });
}
const create = (person: Person) => post(app, tokenCreate, { token: person.token, body: BODY });
const list = (person: Person) => post(app, tokenList, { token: person.token });

async function sessionRow(person: Person) {
  const hash = await hashSessionToken(person.token);
  const db = commonDb(env);
  return db.first(db.statement((q) => q.selectFrom('sessions').selectAll().where('token_hash', '=', hash)));
}

async function canCreate(person: Person) {
  const res = await list(person);
  expect(res.status).toBe(200);
  return ((await res.json()) as { can_create?: unknown }).can_create;
}

describe('errorCodes', () => {
  test('reauth_required がある', () => {
    expect(errorCodes).toContain('reauth_required');
  });
});

describe('token-create: ログインからの時間', () => {
  test('作ったばかりのセッションは発行できる', async () => {
    const person = await personLoggedInAgo(0);
    const res = await create(person);
    expect(res.status).toBe(200);
    expect(await tokenRowsOf(person.accountId)).toHaveLength(1);
  });

  test('10分以内（9分59秒）は発行できる', async () => {
    const person = await personLoggedInAgo(GRACE_MS - 1000);
    expect((await create(person)).status).toBe(200);
  });

  test('ちょうど10分は通す', async () => {
    const person = await personLoggedInAgo(GRACE_MS);
    expect((await create(person)).status).toBe(200);
    expect(await tokenRowsOf(person.accountId)).toHaveLength(1);
  });

  test('10分を1ミリ秒超えたら 403 の reauth_required で、トークンの行は作られない', async () => {
    const person = await personLoggedInAgo(GRACE_MS + 1);
    const res = await create(person);
    expect(res.status).toBe(403);
    expect(await errorCodeOf(res)).toBe('reauth_required');
    expect(await tokenRowsOf(person.accountId)).toHaveLength(0);
  });

  test('ログインから何日もたったセッションも断る。401 ではない', async () => {
    const person = await personLoggedInAgo(20 * 24 * HOUR_MS, 1000);
    const res = await create(person);
    expect(res.status).toBe(403);
    expect(await errorCodeOf(res)).toBe('reauth_required');
  });

  test('応答の本文は決まったエラーの形（error.code、message）', async () => {
    const person = await personLoggedInAgo(GRACE_MS + 1);
    const body: unknown = await (await create(person)).json();
    expect(isErrorBody(body)).toBe(true);
    expect(body).toMatchObject({ error: { code: 'reauth_required', message: expect.any(String) } });
  });

  test('断った後に10分以内のセッションで発行すると、行は1件だけ', async () => {
    const stale = await personLoggedInAgo(GRACE_MS + 1);
    expect((await create(stale)).status).toBe(403);
    expect((await create(stale)).status).toBe(403);
    expect(await tokenRowsOf(stale.accountId)).toHaveLength(0);
  });
});

describe('延長しても created_at で判定する', () => {
  test('last_used_at が1時間以上前で readSession が書き直しても、新しいセッションは発行できる', async () => {
    const person = await personLoggedInAgo(5 * MINUTE_MS, 2 * HOUR_MS);
    const before = await sessionRow(person);
    expect((await create(person)).status).toBe(200);
    const after = await sessionRow(person);
    expect(after!.last_used_at).toBe(iso(now));
    expect(after!.created_at).toBe(before!.created_at);
  });

  test('前の created_at が10分超のセッションは、延長されても断られ、created_at は変わらない', async () => {
    const person = await personLoggedInAgo(GRACE_MS + 1, 2 * HOUR_MS);
    const res = await create(person);
    expect(res.status).toBe(403);
    expect(await errorCodeOf(res)).toBe('reauth_required');
    const row = await sessionRow(person);
    // 延長（last_used_at の書き直し）は起きている
    expect(row!.last_used_at).toBe(iso(now));
    expect(row!.created_at).toBe(iso(now - GRACE_MS - 1));
  });

  test('使い続けた（last_used_at が今）セッションも、created_at が10分超なら断る', async () => {
    const person = await personLoggedInAgo(HOUR_MS, 0);
    expect(await errorCodeOf(await create(person))).toBe('reauth_required');
  });
});

describe('token-list と token-revoke は再認証を求めない', () => {
  test('10分を超えたセッションでも token-list は成功し、既存のトークンを返す', async () => {
    const person = await personLoggedInAgo(GRACE_MS + 1);
    const { hash } = await insertApiToken(person.accountId, {
      scope: 'read',
      expiresAt: iso(now + 30 * 24 * HOUR_MS),
    });
    const res = await list(person);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tokens: { id: string }[] };
    expect(body.tokens.map((token) => token.id)).toEqual([hash]);
  });

  test('10分を超えたセッションでも token-revoke は成功し、トークンが取り消される', async () => {
    const person = await personLoggedInAgo(2 * HOUR_MS, 2 * HOUR_MS);
    const { hash } = await insertApiToken(person.accountId, {
      scope: 'write',
      expiresAt: iso(now + 30 * 24 * HOUR_MS),
    });
    const res = await post(app, tokenRevoke, { token: person.token, body: { id: hash } });
    expect(res.status).toBe(200);
    const rows = await tokenRowsOf(person.accountId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.revoked_at).not.toBeNull();
  });
});

describe('token-list の can_create', () => {
  test('作ったばかり、10分以内は true', async () => {
    expect(await canCreate(await personLoggedInAgo(0))).toBe(true);
    expect(await canCreate(await personLoggedInAgo(GRACE_MS - 1000))).toBe(true);
  });

  test('ちょうど10分は true', async () => {
    expect(await canCreate(await personLoggedInAgo(GRACE_MS))).toBe(true);
  });

  test('10分を1ミリ秒超えたら false', async () => {
    expect(await canCreate(await personLoggedInAgo(GRACE_MS + 1))).toBe(false);
  });

  test('ログインから日がたっても、最近使っていても false', async () => {
    expect(await canCreate(await personLoggedInAgo(3 * 24 * HOUR_MS, 0))).toBe(false);
  });

  test('can_create と token-create の結果が一致する（境目の前後）', async () => {
    for (const age of [GRACE_MS, GRACE_MS + 1]) {
      const person = await personLoggedInAgo(age);
      const allowed = await canCreate(person);
      const res = await create(person);
      expect(res.status).toBe(allowed === true ? 200 : 403);
    }
  });

  test('延長（last_used_at の書き直し）で、can_create は変わらない', async () => {
    const stale = await personLoggedInAgo(GRACE_MS + 1, 2 * HOUR_MS);
    expect(await canCreate(stale)).toBe(false);
    expect(await canCreate(stale)).toBe(false);
    const fresh = await personLoggedInAgo(MINUTE_MS, 2 * HOUR_MS);
    expect(await canCreate(fresh)).toBe(true);
  });
});

describe('API トークンからの token-create', () => {
  test('作ったばかりのセッションの人でも、トークンからは 403 の forbidden（reauth_required ではない）', async () => {
    const person = await personLoggedInAgo(0);
    const { raw } = await insertApiToken(person.accountId, {
      scope: 'write',
      expiresAt: iso(now + 30 * 24 * HOUR_MS),
    });
    const res = await post(app, tokenCreate, { bearer: raw, origin: null, body: BODY });
    expect(res.status).toBe(403);
    expect(await errorCodeOf(res)).toBe('forbidden');
    expect(await tokenRowsOf(person.accountId)).toHaveLength(1);
  });

  test('10分を超えたセッションの人でも、トークンからは forbidden', async () => {
    const person = await personLoggedInAgo(GRACE_MS + 1);
    const { raw } = await insertApiToken(person.accountId, {
      scope: 'write',
      expiresAt: iso(now + 30 * 24 * HOUR_MS),
    });
    const res = await post(app, tokenCreate, { bearer: raw, origin: null, body: BODY });
    expect(res.status).toBe(403);
    expect(await errorCodeOf(res)).toBe('forbidden');
  });
});

describe('別のアカウントのセッションは影響しない', () => {
  test('古いセッションの人が断られても、新しいセッションの別の人は発行できる（逆も）', async () => {
    const stale = await personLoggedInAgo(GRACE_MS + 1);
    const fresh = await personLoggedInAgo(0);
    expect(await errorCodeOf(await create(stale))).toBe('reauth_required');
    expect((await create(fresh)).status).toBe(200);
    expect(await tokenRowsOf(stale.accountId)).toHaveLength(0);
    expect(await tokenRowsOf(fresh.accountId)).toHaveLength(1);
  });

  test('同じアカウントの別のセッションは、使った Cookie の created_at で決まる', async () => {
    const stale = await personLoggedInAgo(GRACE_MS + 1);
    // 同じアカウントの新しいセッション
    const { token } = await createSessionWithToken(stale.accountId);
    const fresh = { ...stale, token };
    expect((await create(fresh)).status).toBe(200);
    expect(await errorCodeOf(await create(stale))).toBe('reauth_required');
    expect(await canCreate(fresh)).toBe(true);
    expect(await canCreate(stale)).toBe(false);
  });
});
