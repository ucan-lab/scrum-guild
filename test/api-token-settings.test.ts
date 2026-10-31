// 設定でのトークンの発行・一覧・取消（token-create、token-list、token-revoke）。3操作は Cookie のセッションだけが使える（cookieOnly）。
// 一覧を回す検査は test/operation-registry.test.ts、トークン全般の取り決めは test/api-token-operations.test.ts
import { afterEach, describe, expect, test, vi } from 'vitest';
import { API_TOKEN_PATTERN } from '../src/shared/api-token.ts';
import { tokenCreate, tokenList, tokenRevoke } from '../src/shared/operations/session/index.ts';
import { operations } from '../src/shared/operations/index.ts';
import { createApp } from '../src/server/app.ts';
import { sha256Hex } from '../src/server/auth/tokens.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import { insertApiToken, rawApiToken, tokenRow, tokenRowsOf } from './operations/api-token.ts';
import { errorCodeOf, post } from './operations/harness.ts';
import { provisionalOperations, whoAmI } from './operations/provisional.ts';
import { createLoginPerson } from './operations/world.ts';
import type { Person } from './operations/world.ts';

// whoAmI は、発行したトークンで API を呼べるかを確かめる仮の操作
const app = createApp([...implementedOperations, ...provisionalOperations]);
const DAY_MS = 24 * 60 * 60 * 1000;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const future = (days = 30) => new Date(Date.now() + days * DAY_MS).toISOString();
const past = () => new Date(Date.now() - 1000).toISOString();

afterEach(() => {
  vi.restoreAllMocks();
});

function create(person: Person, body: unknown) {
  return post(app, tokenCreate, { token: person.token, body });
}
function list(person: Person) {
  return post(app, tokenList, { token: person.token });
}
function revoke(person: Person, id: string) {
  return post(app, tokenRevoke, { token: person.token, body: { id } });
}
async function listed(person: Person) {
  const res = await list(person);
  expect(res.status).toBe(200);
  return ((await res.json()) as { tokens: { id: string; name: string }[] }).tokens;
}
async function created(person: Person, body: unknown = { name: '手元の CLI', scope: 'write' }) {
  const res = await create(person, body);
  expect(res.status).toBe(200);
  return (await res.json()) as { id: string; name: string; scope: string; expires_at: string; token: string };
}

describe('操作の定義', () => {
  test('3操作とも、ログインの権限で Cookie だけ、組織の外', () => {
    for (const [definition, mode] of [
      [tokenCreate, 'write'],
      [tokenList, 'read'],
      [tokenRevoke, 'write'],
    ] as const) {
      expect(definition.permission).toBe('login');
      expect(definition.cookieOnly).toBe(true);
      expect(definition.mode).toBe(mode);
      expect(operations).toContain(definition);
    }
  });
});

describe('完了条件: 発行', () => {
  test('応答は { id, name, scope, expires_at, token }。生の値は sgp_ + 43文字、id は小文字16進64文字', async () => {
    const person = await createLoginPerson();
    const body = await created(person, { name: '手元の CLI', scope: 'read', lifetime_days: 7 });
    expect(Object.keys(body).sort()).toEqual(['expires_at', 'id', 'name', 'scope', 'token']);
    expect(body.token).toMatch(API_TOKEN_PATTERN);
    expect(body.id).toMatch(HASH_PATTERN);
    expect(body.name).toBe('手元の CLI');
    expect(body.scope).toBe('read');
  });

  test('DB の行は1件で、ハッシュは生の値の SHA-256、生の値は行のどこにも無い', async () => {
    const person = await createLoginPerson();
    const body = await created(person, { name: 'ci', scope: 'write', lifetime_days: 10 });
    const rows = await tokenRowsOf(person.accountId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.token_hash).toBe(await sha256Hex(body.token));
    expect(rows[0]!.token_hash).toBe(body.id);
    expect(rows[0]).toMatchObject({ account_id: person.accountId, name: 'ci', scope: 'write', revoked_at: null });
    expect(rows[0]!.last_used_at).toBeNull();
    expect(JSON.stringify(rows[0])).not.toContain(body.token.slice(4));
  });

  test('expires_at は now から lifetime_days 日後。応答と行が同じ', async () => {
    const person = await createLoginPerson();
    const before = Date.now();
    const body = await created(person, { name: 'a', scope: 'read', lifetime_days: 7 });
    const after = Date.now();
    const expires = Date.parse(body.expires_at);
    expect(expires).toBeGreaterThanOrEqual(before + 7 * DAY_MS);
    expect(expires).toBeLessThanOrEqual(after + 7 * DAY_MS);
    expect((await tokenRow(body.id))!.expires_at).toBe(body.expires_at);
  });

  test('lifetime_days を省くと90日', async () => {
    const person = await createLoginPerson();
    const before = Date.now();
    const body = await created(person, { name: 'a', scope: 'write' });
    const after = Date.now();
    const expires = Date.parse(body.expires_at);
    expect(expires).toBeGreaterThanOrEqual(before + 90 * DAY_MS);
    expect(expires).toBeLessThanOrEqual(after + 90 * DAY_MS);
  });

  test('発行したトークンで API を呼べる（read は読む操作だけ）', async () => {
    const person = await createLoginPerson();
    const write = await created(person, { name: 'w', scope: 'write' });
    const read = await created(person, { name: 'r', scope: 'read' });
    expect((await post(app, whoAmI, { bearer: write.token, origin: null })).status).toBe(200);
    expect((await post(app, whoAmI, { bearer: read.token, origin: null })).status).toBe(200);
  });

  test('同じ入力でも毎回別の生の値と id', async () => {
    const person = await createLoginPerson();
    const first = await created(person);
    const second = await created(person);
    expect(second.token).not.toBe(first.token);
    expect(second.id).not.toBe(first.id);
    expect(await tokenRowsOf(person.accountId)).toHaveLength(2);
  });

  test('name の前後の空白は除いて保存する', async () => {
    const person = await createLoginPerson();
    const body = await created(person, { name: '  \t手元 の CLI \n', scope: 'read' });
    expect(body.name).toBe('手元 の CLI');
    expect((await tokenRow(body.id))!.name).toBe('手元 の CLI');
  });

  test('余計なキー（expires_at、account_id）は効かない', async () => {
    const person = await createLoginPerson();
    const other = await createLoginPerson();
    const body = await created(person, {
      name: 'a',
      scope: 'read',
      lifetime_days: 1,
      expires_at: future(365),
      account_id: other.accountId,
      revoked_at: past(),
    });
    const row = (await tokenRow(body.id))!;
    expect(row.account_id).toBe(person.accountId);
    expect(row.revoked_at).toBeNull();
    expect(Date.parse(row.expires_at)).toBeLessThan(Date.now() + 2 * DAY_MS);
    expect(await tokenRowsOf(other.accountId)).toHaveLength(0);
  });
});

describe('完了条件: 一覧', () => {
  test('自分の有効な行だけ。他人、取り消し済み、期限切れは出ない', async () => {
    const [me, other] = await Promise.all([createLoginPerson(), createLoginPerson()]);
    const mine = await insertApiToken(me.accountId, { name: '自分の', expiresAt: future() });
    await insertApiToken(me.accountId, { name: '取消済み', revokedAt: past() });
    await insertApiToken(me.accountId, { name: '期限切れ', expiresAt: past() });
    await insertApiToken(other.accountId, { name: '他人の', expiresAt: future() });
    const tokens = await listed(me);
    expect(tokens.map((token) => token.id)).toEqual([mine.hash]);
    expect(JSON.stringify(tokens)).not.toContain('他人の');
  });

  test('各行は { id, name, scope, created_at, last_used_at, expires_at } だけ', async () => {
    const person = await createLoginPerson();
    const expiresAt = future(20);
    const { hash } = await insertApiToken(person.accountId, {
      name: 'm',
      scope: 'read',
      createdAt: '2026-10-01T00:00:00.000Z',
      lastUsedAt: '2026-10-02T03:04:05.000Z',
      expiresAt,
    });
    const res = await list(person);
    expect(await res.json()).toEqual({
      tokens: [
        {
          id: hash,
          name: 'm',
          scope: 'read',
          created_at: '2026-10-01T00:00:00.000Z',
          last_used_at: '2026-10-02T03:04:05.000Z',
          expires_at: expiresAt,
        },
      ],
    });
  });

  test('一度も使っていない行の last_used_at は null', async () => {
    const person = await createLoginPerson();
    await insertApiToken(person.accountId, { lastUsedAt: null });
    expect((await listed(person))[0]).toMatchObject({ last_used_at: null });
  });

  test('作成日時の新しい順', async () => {
    const person = await createLoginPerson();
    const middle = await insertApiToken(person.accountId, { name: 'b', createdAt: '2026-10-02T00:00:00.000Z' });
    const oldest = await insertApiToken(person.accountId, { name: 'a', createdAt: '2026-10-01T00:00:00.000Z' });
    const newest = await insertApiToken(person.accountId, { name: 'c', createdAt: '2026-10-03T00:00:00.000Z' });
    expect((await listed(person)).map((token) => token.id)).toEqual([newest.hash, middle.hash, oldest.hash]);
  });

  test('応答のどこにも生の値とハッシュ由来でない秘密（token キー、token_hash キー、生の値）が無い', async () => {
    const person = await createLoginPerson();
    const { raw } = await insertApiToken(person.accountId);
    const text = await (await list(person)).text();
    expect(text).not.toContain(raw);
    expect(text).not.toContain(raw.slice(4));
    expect(text).not.toContain('token_hash');
    expect(text).not.toContain('"token"');
    expect(text).not.toContain('revoked_at');
  });

  test('発行した直後に一覧へ出る。生の値は出ない', async () => {
    const person = await createLoginPerson();
    const body = await created(person);
    const res = await list(person);
    const text = await res.text();
    expect(JSON.parse(text).tokens.map((token: { id: string }) => token.id)).toEqual([body.id]);
    expect(text).not.toContain(body.token);
  });

  test('1件も無ければ空の配列', async () => {
    const person = await createLoginPerson();
    expect(await (await list(person)).json()).toEqual({ tokens: [] });
  });

  test('一覧を見ても last_used_at を書き換えない', async () => {
    const person = await createLoginPerson();
    const { hash } = await insertApiToken(person.accountId, { lastUsedAt: '2026-10-02T00:00:00.000Z' });
    await list(person);
    expect((await tokenRow(hash))!.last_used_at).toBe('2026-10-02T00:00:00.000Z');
  });
});

describe('完了条件: 取消', () => {
  test('自分の行を取り消すと revoked_at が入り、{} を返し、一覧から消える', async () => {
    const person = await createLoginPerson();
    const { hash } = await insertApiToken(person.accountId);
    const startedAt = Date.now();
    const res = await revoke(person, hash);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
    const row = (await tokenRow(hash))!;
    expect(Date.parse(row.revoked_at!)).toBeGreaterThanOrEqual(startedAt - 1000);
    expect(await listed(person)).toEqual([]);
  });

  test('取り消したトークンで API を呼ぶと 401 unauthenticated', async () => {
    const person = await createLoginPerson();
    const body = await created(person);
    expect((await post(app, whoAmI, { bearer: body.token })).status).toBe(200);
    expect((await revoke(person, body.id)).status).toBe(200);
    const res = await post(app, whoAmI, { bearer: body.token });
    expect(res.status).toBe(401);
    expect(await errorCodeOf(res)).toBe('unauthenticated');
  });

  test('取り消しても、同じ人の他のトークンは使える', async () => {
    const person = await createLoginPerson();
    const [first, second] = [await created(person), await created(person)];
    await revoke(person, first.id);
    expect((await post(app, whoAmI, { bearer: second.token })).status).toBe(200);
    expect((await tokenRow(second.id))!.revoked_at).toBeNull();
  });

  test('他人の ID は 404 not_found で、他人の行は取り消されない', async () => {
    const [me, other] = await Promise.all([createLoginPerson(), createLoginPerson()]);
    const theirs = await insertApiToken(other.accountId);
    const res = await revoke(me, theirs.hash);
    expect(res.status).toBe(404);
    expect(await errorCodeOf(res)).toBe('not_found');
    expect((await tokenRow(theirs.hash))!.revoked_at).toBeNull();
    expect((await post(app, whoAmI, { bearer: theirs.raw })).status).toBe(200);
  });

  test('存在しない ID も同じ 404 not_found（応答の本文も他人の ID と同じ）', async () => {
    const [me, other] = await Promise.all([createLoginPerson(), createLoginPerson()]);
    const theirs = await insertApiToken(other.accountId);
    const missing = await revoke(me, await sha256Hex(rawApiToken()));
    const foreign = await revoke(me, theirs.hash);
    const [missingText, foreignText] = [await missing.clone().text(), await foreign.clone().text()];
    expect(missing.status).toBe(404);
    expect(await errorCodeOf(missing)).toBe('not_found');
    expect(missingText).toBe(foreignText);
  });

  test('すでに取り消した自分の行をもう一度取り消しても成功し、revoked_at は変わらない', async () => {
    const person = await createLoginPerson();
    const revokedAt = '2026-10-05T00:00:00.000Z';
    const { hash } = await insertApiToken(person.accountId, { revokedAt });
    const res = await revoke(person, hash);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
    expect((await tokenRow(hash))!.revoked_at).toBe(revokedAt);
  });

  test('操作を2回続けても revoked_at は最初の値のまま', async () => {
    const person = await createLoginPerson();
    const { hash } = await insertApiToken(person.accountId);
    expect((await revoke(person, hash)).status).toBe(200);
    const first = (await tokenRow(hash))!.revoked_at;
    expect(first).not.toBeNull();
    expect((await revoke(person, hash)).status).toBe(200);
    expect((await tokenRow(hash))!.revoked_at).toBe(first);
  });

  test('期限切れの自分の行にも成功する', async () => {
    const person = await createLoginPerson();
    const { hash } = await insertApiToken(person.accountId, { expiresAt: past() });
    expect((await revoke(person, hash)).status).toBe(200);
    expect((await tokenRow(hash))!.revoked_at).not.toBeNull();
  });

  test('別のアカウントの Cookie では他人の ID を取り消せない（Cookie 側の人を取り違えない）', async () => {
    const [a, b] = await Promise.all([createLoginPerson(), createLoginPerson()]);
    const ta = await insertApiToken(a.accountId);
    const tb = await insertApiToken(b.accountId);
    expect((await revoke(b, ta.hash)).status).toBe(404);
    expect((await revoke(a, tb.hash)).status).toBe(404);
    expect((await tokenRow(ta.hash))!.revoked_at).toBeNull();
    expect((await tokenRow(tb.hash))!.revoked_at).toBeNull();
    expect((await revoke(a, ta.hash)).status).toBe(200);
    expect((await tokenRow(tb.hash))!.revoked_at).toBeNull();
  });
});

describe('断る場合: 発行の入力の検証（行は増えない）', () => {
  async function expectInvalid(body: unknown) {
    const person = await createLoginPerson();
    const res = await create(person, body);
    expect(res.status, JSON.stringify(body)).toBe(400);
    expect(await errorCodeOf(res)).toBe('invalid_input');
    expect(await tokenRowsOf(person.accountId)).toHaveLength(0);
  }
  async function expectAccepted(body: unknown) {
    const person = await createLoginPerson();
    const res = await create(person, body);
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(await tokenRowsOf(person.accountId)).toHaveLength(1);
  }

  test('name が空、空白だけ、無い、文字列でない', async () => {
    for (const name of ['', '   ', '\t\n', undefined, null, 1]) await expectInvalid({ name, scope: 'read' });
  });

  test('name は前後の空白を除いて100文字までが通り、101文字は拒む', async () => {
    await expectAccepted({ name: 'あ'.repeat(100), scope: 'read' });
    await expectAccepted({ name: ` ${'a'.repeat(100)} `, scope: 'read' });
    await expectAccepted({ name: 'a', scope: 'read' });
    await expectInvalid({ name: 'あ'.repeat(101), scope: 'read' });
    await expectInvalid({ name: ` ${'a'.repeat(101)} `, scope: 'read' });
  });

  test('scope は read か write だけ', async () => {
    for (const scope of ['admin', 'READ', '', 'read,write', undefined, null, 1, ['read']]) {
      await expectInvalid({ name: 'a', scope });
    }
    await expectAccepted({ name: 'a', scope: 'read' });
    await expectAccepted({ name: 'a', scope: 'write' });
  });

  test('lifetime_days は1〜90の整数。0、負数、91、小数、文字列、null は拒む', async () => {
    for (const lifetime_days of [0, -1, 91, 365, 1.5, 89.9, '30', '', null, Number.NaN, [30]]) {
      await expectInvalid({ name: 'a', scope: 'read', lifetime_days });
    }
    for (const lifetime_days of [1, 2, 89, 90]) await expectAccepted({ name: 'a', scope: 'read', lifetime_days });
  });

  test('境界の期限: 1日は約1日後、90日は約90日後', async () => {
    const person = await createLoginPerson();
    const one = await created(person, { name: 'a', scope: 'read', lifetime_days: 1 });
    const ninety = await created(person, { name: 'a', scope: 'read', lifetime_days: 90 });
    expect(Date.parse(one.expires_at) - Date.now()).toBeLessThanOrEqual(DAY_MS);
    expect(Date.parse(one.expires_at) - Date.now()).toBeGreaterThan(DAY_MS - 60_000);
    expect(Date.parse(ninety.expires_at) - Date.now()).toBeLessThanOrEqual(90 * DAY_MS);
    expect(Date.parse(ninety.expires_at) - Date.now()).toBeGreaterThan(90 * DAY_MS - 60_000);
  });

  test('必須の欠落（name だけ、scope だけ、空のオブジェクト）、本文が壊れている、JSON でない', async () => {
    await expectInvalid({});
    await expectInvalid({ name: 'a' });
    await expectInvalid({ scope: 'read' });
    const person = await createLoginPerson();
    const res = await post(app, tokenCreate, { token: person.token, rawBody: '{broken' });
    expect(res.status).toBe(400);
    expect(await tokenRowsOf(person.accountId)).toHaveLength(0);
  });
});

describe('断る場合: 取消の入力の検証', () => {
  test('id が64桁の小文字16進でないと、行があっても 400 invalid_input', async () => {
    const person = await createLoginPerson();
    const { hash } = await insertApiToken(person.accountId);
    const bad = [
      '',
      hash.slice(1),
      `${hash}0`,
      hash.toUpperCase(),
      `${hash.slice(0, 63)}g`,
      ` ${hash.slice(1)}`,
      'sgp_' + 'a'.repeat(43),
      1,
      null,
      undefined,
    ];
    for (const id of bad) {
      const res = await post(app, tokenRevoke, { token: person.token, body: { id } });
      expect(res.status, String(id)).toBe(400);
      expect(await errorCodeOf(res)).toBe('invalid_input');
    }
    expect((await tokenRow(hash))!.revoked_at).toBeNull();
  });

  test('id が無い、余計なキーだけ', async () => {
    const person = await createLoginPerson();
    for (const body of [{}, { token_hash: 'a'.repeat(64) }]) {
      const res = await post(app, tokenRevoke, { token: person.token, body });
      expect(res.status).toBe(400);
    }
  });

  test('一覧の入力は {} だけでよく、余計なキーは結果を変えない', async () => {
    const person = await createLoginPerson();
    await insertApiToken(person.accountId);
    const res = await post(app, tokenList, { token: person.token, body: { account_id: 'someone-else' } });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { tokens: unknown[] }).tokens).toHaveLength(1);
  });
});

describe('すり抜け: トークンでは3操作とも 403', () => {
  const calls = [
    ['token-create', tokenCreate, { name: 'a', scope: 'read' }],
    ['token-list', tokenList, {}],
    ['token-revoke', tokenRevoke, undefined],
  ] as const;

  for (const scope of ['read', 'write'] as const) {
    test(`${scope} のトークンは 403 forbidden で、行は増えも変わりもしない`, async () => {
      const person = await createLoginPerson();
      const bearer = await insertApiToken(person.accountId, { scope, expiresAt: future() });
      const target = await insertApiToken(person.accountId, { name: '取り消されるはずの無い' });
      // 認証が書く last_used_at は除く（トークンを読むたびに更新される）
      const snapshot = async () =>
        JSON.stringify(
          (await tokenRowsOf(person.accountId))
            .map((row) => [row.token_hash, row.name, row.scope, row.expires_at, row.revoked_at])
            .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
        );
      const before = await snapshot();
      for (const [name, definition, body] of calls) {
        for (const origin of [null, undefined]) {
          const res = await post(app, definition, {
            bearer: bearer.raw,
            origin,
            body: name === 'token-revoke' ? { id: target.hash } : body,
          });
          expect(res.status, `${name} ${String(origin)}`).toBe(403);
          expect(await errorCodeOf(res)).toBe('forbidden');
        }
      }
      expect(await snapshot()).toBe(before);
    });
  }

  test('トークンでトークンを増やせない（token-create は 403 で数が変わらない。自分自身も取り消せない）', async () => {
    const person = await createLoginPerson();
    const bearer = await insertApiToken(person.accountId, { scope: 'write', expiresAt: future() });
    const res = await post(app, tokenCreate, {
      bearer: bearer.raw,
      origin: null,
      body: { name: '増やす', scope: 'write', lifetime_days: 90 },
    });
    expect(res.status).toBe(403);
    expect(await tokenRowsOf(person.accountId)).toHaveLength(1);
    const self = await post(app, tokenRevoke, { bearer: bearer.raw, origin: null, body: { id: bearer.hash } });
    expect(self.status).toBe(403);
    expect((await tokenRow(bearer.hash))!.revoked_at).toBeNull();
  });

  test('read のトークンの書き込み操作も、本文が壊れていても 400 でなく 403', async () => {
    const person = await createLoginPerson();
    const bearer = await insertApiToken(person.accountId, { scope: 'read', expiresAt: future() });
    for (const definition of [tokenCreate, tokenRevoke]) {
      const res = await post(app, definition, { bearer: bearer.raw, rawBody: '{broken' });
      expect(res.status).toBe(403);
    }
  });

  test('Bearer と有効な Cookie を同時に付けても Bearer が優先されて 403', async () => {
    const person = await createLoginPerson();
    const bearer = await insertApiToken(person.accountId, { scope: 'write', expiresAt: future() });
    const target = await insertApiToken(person.accountId);
    const attempts = [
      post(app, tokenCreate, { token: person.token, bearer: bearer.raw, body: { name: 'a', scope: 'read' } }),
      post(app, tokenList, { token: person.token, bearer: bearer.raw }),
      post(app, tokenRevoke, { token: person.token, bearer: bearer.raw, body: { id: target.hash } }),
    ];
    for (const res of await Promise.all(attempts)) {
      expect(res.status).toBe(403);
      expect(await errorCodeOf(res)).toBe('forbidden');
    }
    expect(await tokenRowsOf(person.accountId)).toHaveLength(2);
    expect((await tokenRow(target.hash))!.revoked_at).toBeNull();
  });

  test('無効なトークン（取消済み、期限切れ、DB に無い）は 401（有効な Cookie があっても）', async () => {
    const person = await createLoginPerson();
    const revoked = await insertApiToken(person.accountId, { revokedAt: past() });
    const expired = await insertApiToken(person.accountId, { expiresAt: past() });
    for (const bearer of [revoked.raw, expired.raw, rawApiToken()]) {
      for (const [name, definition, body] of calls) {
        for (const token of [undefined, person.token]) {
          const res = await post(app, definition, {
            bearer,
            ...(token === undefined ? {} : { token }),
            body: name === 'token-revoke' ? { id: 'a'.repeat(64) } : body,
          });
          expect(res.status, name).toBe(401);
          expect(await errorCodeOf(res)).toBe('unauthenticated');
        }
      }
    }
    expect(await tokenRowsOf(person.accountId)).toHaveLength(2);
  });
});

describe('Cookie の呼び出しの決まり', () => {
  const calls = [
    ['token-create', tokenCreate, { name: 'a', scope: 'read' }],
    ['token-list', tokenList, {}],
    ['token-revoke', tokenRevoke, { id: 'a'.repeat(64) }],
  ] as const;

  test('Cookie なら 200（取消は自分の行）', async () => {
    const person = await createLoginPerson();
    expect((await create(person, { name: 'a', scope: 'read' })).status).toBe(200);
    expect((await list(person)).status).toBe(200);
    const { hash } = await insertApiToken(person.accountId);
    expect((await revoke(person, hash)).status).toBe(200);
  });

  test('Origin が無い、違う Cookie 呼び出しは 403 forbidden で、行は変わらない', async () => {
    const person = await createLoginPerson();
    const { hash } = await insertApiToken(person.accountId);
    for (const origin of [null, 'https://evil.example']) {
      for (const [name, definition, body] of calls) {
        const res = await post(app, definition, {
          token: person.token,
          origin,
          body: name === 'token-revoke' ? { id: hash } : body,
        });
        expect(res.status, `${name} ${String(origin)}`).toBe(403);
        expect(await errorCodeOf(res)).toBe('forbidden');
      }
    }
    expect(await tokenRowsOf(person.accountId)).toHaveLength(1);
    expect((await tokenRow(hash))!.revoked_at).toBeNull();
  });

  test('未ログインは 401 unauthenticated', async () => {
    for (const [, definition, body] of calls) {
      const res = await post(app, definition, { body });
      expect(res.status).toBe(401);
      expect(await errorCodeOf(res)).toBe('unauthenticated');
    }
  });

  test('壊れた Cookie は 401', async () => {
    for (const [, definition, body] of calls) {
      const res = await post(app, definition, { token: 'broken', body });
      expect(res.status).toBe(401);
    }
  });
});

describe('ランタイム: ログ', () => {
  test('token-create の応答の後、ログに生の値もハッシュも出ない', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const person = await createLoginPerson();
    const body = await created(person);
    await list(person);
    await revoke(person, body.id);
    const output = [...log.mock.calls, ...error.mock.calls, ...warn.mock.calls].flat().map(String).join('\n');
    expect(output).toContain('token-create');
    expect(output).not.toContain(body.token);
    expect(output).not.toContain(body.token.slice(4));
    expect(output).not.toContain(body.id);
  });

  test('操作のログには credential: cookie が付く', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const person = await createLoginPerson();
    await created(person);
    const last = JSON.parse(String(log.mock.calls.at(-1)![0]));
    expect(last).toMatchObject({ operation: 'token-create', status: 200, credential: 'cookie' });
  });
});
