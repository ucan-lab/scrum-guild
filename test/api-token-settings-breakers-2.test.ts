// token-create / token-list / token-revoke を崩す手口の2周目。api-token-settings.test.ts と api-token-settings-breakers.test.ts にない、
// 追加関数の SQL の条件（読みと書きの間に割り込む別の更新）、掃除との相互作用、docs の記述との突き合わせだけを置く
/* eslint-disable db-entry/guard -- api_tokens の行を、入口を通さず D1 に直に読み書きして確かめるため */
import { createScheduledController } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { API_TOKEN_MAX_LIFETIME_DAYS } from '../src/shared/api-token.ts';
import { tokenCreate, tokenList, tokenRevoke } from '../src/shared/operations/session/index.ts';
import { API_TOKEN_NAME_MAX_LENGTH } from '../src/shared/operations/session/token.ts';
import { createApp } from '../src/server/app.ts';
import {
  hashApiToken,
  issueApiTokenWith,
  listApiTokensOf,
  revokeApiTokenOf,
  revokeApiTokensOf,
} from '../src/server/auth/api-token.ts';
import { commonDb, type CommonDb } from '../src/server/db/index.ts';
import worker from '../src/server/index.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import { cleanupApiTokens } from '../src/server/scheduled/cleanup-api-tokens.ts';
import { insertApiToken, tokenRow, tokenRowsOf } from './operations/api-token.ts';
import { errorCodeOf, post } from './operations/harness.ts';
import { provisionalOperations, whoAmI } from './operations/provisional.ts';
import { createLoginPerson, createPerson, testEnv, type Person } from './operations/world.ts';
import { createOrganization } from './factories.ts';

const app = createApp([...implementedOperations, ...provisionalOperations]);
const DAY_MS = 24 * 60 * 60 * 1000;
const future = (days = 30) => new Date(Date.now() + days * DAY_MS).toISOString();
const past = (days = 1) => new Date(Date.now() - days * DAY_MS).toISOString();

afterEach(() => {
  vi.restoreAllMocks();
});

const create = (person: Person, body: unknown) => post(app, tokenCreate, { token: person.token, body });
const list = (person: Person) => post(app, tokenList, { token: person.token });
const revoke = (person: Person, id: string) => post(app, tokenRevoke, { token: person.token, body: { id } });

async function listedIds(person: Person): Promise<string[]> {
  const res = await list(person);
  expect(res.status).toBe(200);
  return ((await res.json()) as { tokens: { id: string }[] }).tokens.map((token) => token.id);
}

// 最初の読み（first）の直後に、別のリクエストが割り込んだ状況を作る入口。書く文（batch）は本物を通す
function interruptedAfterRead(db: CommonDb, interrupt: () => Promise<unknown>): CommonDb {
  return new Proxy(db, {
    get(target, property) {
      const value = Reflect.get(target, property, target) as unknown;
      // 入口は private フィールドを持つので、メソッドは本物に束ねて返す
      if (typeof value !== 'function') return value;
      if (property !== 'first') return (value as (...a: unknown[]) => unknown).bind(target);
      return async (...args: unknown[]) => {
        const row = await (value as (...a: unknown[]) => Promise<unknown>).apply(target, args);
        await interrupt();
        return row;
      };
    },
  });
}

const sql = (statement: string, ...bind: unknown[]) =>
  env.DB.prepare(statement)
    .bind(...bind)
    .run();

describe('追加関数の SQL: 取消の読みと書きの間に割り込みが入る', () => {
  test('読んだ後に別の取消が先に書かれても、最初の revoked_at が残り、成功を返す', async () => {
    const person = await createLoginPerson();
    const { hash } = await insertApiToken(person.accountId);
    const first = '2026-10-21T01:02:03.004Z';
    const db = interruptedAfterRead(commonDb(testEnv), () =>
      sql('update api_tokens set revoked_at = ? where token_hash = ?', first, hash),
    );
    expect(await revokeApiTokenOf(db, person.accountId, hash, new Date())).toBe(true);
    expect((await tokenRow(hash))!.revoked_at).toBe(first);
  });

  test('読んだ後に行の持ち主が替わっても、書く文の account_id の条件で、新しい持ち主の行を取り消さない', async () => {
    const person = await createLoginPerson();
    const other = await createLoginPerson();
    const { hash } = await insertApiToken(person.accountId);
    const db = interruptedAfterRead(commonDb(testEnv), () =>
      sql('update api_tokens set account_id = ? where token_hash = ?', other.accountId, hash),
    );
    await revokeApiTokenOf(db, person.accountId, hash, new Date());
    const row = (await tokenRow(hash))!;
    expect(row.account_id).toBe(other.accountId);
    expect(row.revoked_at).toBeNull();
    expect(await listedIds(other)).toEqual([hash]);
  });

  test('読んだ後に行が掃除で消えても、例外にならず、行を作り直さない', async () => {
    const person = await createLoginPerson();
    const { hash } = await insertApiToken(person.accountId, { expiresAt: past() });
    const db = interruptedAfterRead(commonDb(testEnv), () => sql('delete from api_tokens where token_hash = ?', hash));
    await expect(revokeApiTokenOf(db, person.accountId, hash, new Date())).resolves.toBeTypeOf('boolean');
    expect(await tokenRow(hash)).toBeUndefined();
  });

  test('読んだ後に期限が切れても取消は書かれ、revoked_at は渡した now になる', async () => {
    const person = await createLoginPerson();
    const { hash } = await insertApiToken(person.accountId, { expiresAt: future(1) });
    const now = new Date('2026-10-22T05:06:07.089Z');
    const db = interruptedAfterRead(commonDb(testEnv), () =>
      sql('update api_tokens set expires_at = ? where token_hash = ?', past(), hash),
    );
    expect(await revokeApiTokenOf(db, person.accountId, hash, now)).toBe(true);
    expect((await tokenRow(hash))!.revoked_at).toBe(now.toISOString());
  });

  test('取消が書き換えるのは revoked_at の1列だけで、ほかの列は変わらない', async () => {
    const person = await createLoginPerson();
    const { hash } = await insertApiToken(person.accountId, {
      name: '元の名前',
      scope: 'read',
      createdAt: '2026-10-10T00:00:00.000Z',
      lastUsedAt: '2026-10-11T00:00:00.000Z',
    });
    const before = (await tokenRow(hash))!;
    expect(await revokeApiTokenOf(commonDb(testEnv), person.accountId, hash, new Date())).toBe(true);
    const after = (await tokenRow(hash))!;
    expect({ ...after, revoked_at: null }).toEqual(before);
    expect(after.revoked_at).not.toBeNull();
  });

  test('ログインできる条件を失った判定で取り消された行は、画面の取消でも成功し、revoked_at は書き直さない', async () => {
    const person = await createLoginPerson();
    const { hash } = await insertApiToken(person.accountId);
    await revokeApiTokensOf(commonDb(testEnv), person.accountId, new Date(Date.now() + 60_000));
    const lostAt = (await tokenRow(hash))!.revoked_at;
    expect(lostAt).not.toBeNull();
    expect((await revoke(person, hash)).status).toBe(200);
    expect((await tokenRow(hash))!.revoked_at).toBe(lostAt);
  });

  test('ログインできる条件を失った判定の後に発行した行は取り消されず、一覧に残る', async () => {
    const person = await createLoginPerson();
    const checkedAt = new Date(Date.now() - 1000);
    const created = await create(person, { name: '判定の後', scope: 'read' });
    const { id } = (await created.json()) as { id: string };
    await revokeApiTokensOf(commonDb(testEnv), person.accountId, checkedAt);
    expect((await tokenRow(id))!.revoked_at).toBeNull();
    expect(await listedIds(person)).toEqual([id]);
  });
});

describe('追加関数の SQL: 発行・一覧に直接渡す値', () => {
  test('now が不正な日時なら発行は例外で、行を作らない', async () => {
    const person = await createLoginPerson();
    await expect(
      issueApiTokenWith(commonDb(testEnv), {
        accountId: person.accountId,
        name: 'x',
        scope: 'read',
        now: new Date(Number.NaN),
      }),
    ).rejects.toThrow();
    // 90日後が Date の上限を超える now も同じ
    await expect(
      issueApiTokenWith(commonDb(testEnv), {
        accountId: person.accountId,
        name: 'x',
        scope: 'read',
        now: new Date(8.64e15),
      }),
    ).rejects.toThrow();
    expect(await tokenRowsOf(person.accountId)).toHaveLength(0);
  });

  test('DB の CHECK に反する name と scope は、操作の検証を通らない直の呼び出しでも行を作らない', async () => {
    const person = await createLoginPerson();
    const db = commonDb(testEnv);
    const base = { accountId: person.accountId, now: new Date() };
    await expect(issueApiTokenWith(db, { ...base, name: '', scope: 'read' })).rejects.toThrow();
    await expect(
      issueApiTokenWith(db, { ...base, name: 'a'.repeat(API_TOKEN_NAME_MAX_LENGTH + 1), scope: 'read' }),
    ).rejects.toThrow();
    await expect(issueApiTokenWith(db, { ...base, name: 'x', scope: 'admin' as unknown as 'read' })).rejects.toThrow();
    expect(await tokenRowsOf(person.accountId)).toHaveLength(0);
  });

  test('返す expiresAt と tokenHash は、保存した行と一致し、tokenHash は生の値の SHA-256', async () => {
    const person = await createLoginPerson();
    const now = new Date('2026-10-23T00:00:00.123Z');
    const issued = await issueApiTokenWith(commonDb(testEnv), {
      accountId: person.accountId,
      name: 'x',
      scope: 'write',
      now,
      lifetimeDays: 1,
    });
    expect(issued.tokenHash).toBe(await hashApiToken(issued.raw));
    const row = (await tokenRow(issued.tokenHash))!;
    expect(row.expires_at).toBe(issued.expiresAt);
    expect(row.expires_at).toBe('2026-10-24T00:00:00.123Z');
    expect(row.created_at).toBe(now.toISOString());
    expect(row.last_used_at).toBeNull();
    expect(row.revoked_at).toBeNull();
  });

  test('一覧は渡した now で期限を判定し、実際の時刻には依らない（now の1ms前は有効、ちょうどは無効）', async () => {
    const person = await createLoginPerson();
    const expiresAt = '2030-01-01T00:00:00.000Z';
    const { hash } = await insertApiToken(person.accountId, { expiresAt });
    const db = commonDb(testEnv);
    const at = (ms: number) => listApiTokensOf(db, person.accountId, new Date(Date.parse(expiresAt) + ms));
    expect((await at(-1)).map((token) => token.id)).toEqual([hash]);
    expect(await at(0)).toEqual([]);
    expect(await at(1)).toEqual([]);
    // 実際の時刻より前の now なら、すでに切れている行も見える
    const expired = await insertApiToken(person.accountId, { expiresAt: '2020-01-01T00:00:00.000Z' });
    expect(
      (await listApiTokensOf(db, person.accountId, new Date('2019-12-31T00:00:00.000Z'))).map((t) => t.id),
    ).toContain(expired.hash);
  });

  test('revoked_at が未来の日時でも、非 NULL なら取消済みとして一覧に出ない', async () => {
    const person = await createLoginPerson();
    const live = await insertApiToken(person.accountId);
    await insertApiToken(person.accountId, { revokedAt: '9999-12-31T23:59:59.999Z' });
    expect(await listedIds(person)).toEqual([live.hash]);
  });

  test('created_at が同じ行は、token_hash の昇順で並ぶ', async () => {
    const person = await createLoginPerson();
    const createdAt = '2026-10-20T00:00:00.000Z';
    const rows = await Promise.all([1, 2, 3, 4, 5].map(() => insertApiToken(person.accountId, { createdAt })));
    expect(await listedIds(person)).toEqual(rows.map((row) => row.hash).sort());
  });

  test('seed と同じ書き方の期限（SQL の strftime）の行も、一覧に出て取り消せる', async () => {
    const person = await createLoginPerson();
    const seeded = await env.DB.prepare("select strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+90 days') as at").first<{
      at: string;
    }>();
    expect(seeded!.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    const { hash } = await insertApiToken(person.accountId, {
      expiresAt: seeded!.at,
      createdAt: '2026-10-20T00:00:00.000Z',
      lastUsedAt: null,
    });
    const res = await list(person);
    const [token] = (
      (await res.json()) as { tokens: { id: string; last_used_at: string | null; expires_at: string }[] }
    ).tokens;
    expect(token).toMatchObject({ id: hash, last_used_at: null, expires_at: seeded!.at });
    expect((await revoke(person, hash)).status).toBe(200);
    expect(await listedIds(person)).toEqual([]);
  });
});

describe('掃除との相互作用', () => {
  async function issue(person: Person, lifetimeDays: number) {
    const res = await create(person, { name: `期限${lifetimeDays}日`, scope: 'read', lifetime_days: lifetimeDays });
    expect(res.status).toBe(200);
    return (await res.json()) as { id: string; token: string; expires_at: string };
  }

  test('期限の1ms前の掃除では行が残り、取消は成功し、期限ちょうどの掃除で消えた後の取消は 404、Bearer は 401', async () => {
    const person = await createLoginPerson();
    const keep = await issue(person, 1);
    const gone = await issue(person, 1);
    const expiresAt = Date.parse(keep.expires_at);

    await cleanupApiTokens(testEnv, new Date(expiresAt - 1 - 5000));
    expect(await tokenRow(keep.id)).toBeDefined();
    expect((await revoke(person, keep.id)).status).toBe(200);

    await cleanupApiTokens(testEnv, new Date(Date.parse(gone.expires_at)));
    expect(await tokenRow(gone.id)).toBeUndefined();
    const res = await revoke(person, gone.id);
    expect(res.status).toBe(404);
    expect(await errorCodeOf(res)).toBe('not_found');
    expect((await post(app, whoAmI, { bearer: gone.token, origin: null })).status).toBe(401);
  });

  test('取消済みで期限内の行は掃除で残り、再取消は成功し revoked_at は不変。期限が来た取消済みの行は消え、再取消は 404', async () => {
    const person = await createLoginPerson();
    const kept = await insertApiToken(person.accountId, { revokedAt: '2026-10-21T00:00:00.000Z' });
    const dropped = await insertApiToken(person.accountId, {
      revokedAt: '2026-10-21T00:00:00.000Z',
      expiresAt: past(),
    });
    await cleanupApiTokens(testEnv, new Date());
    expect((await tokenRow(kept.hash))!.revoked_at).toBe('2026-10-21T00:00:00.000Z');
    expect(await tokenRow(dropped.hash)).toBeUndefined();
    expect((await revoke(person, kept.hash)).status).toBe(200);
    expect((await tokenRow(kept.hash))!.revoked_at).toBe('2026-10-21T00:00:00.000Z');
    expect((await revoke(person, dropped.hash)).status).toBe(404);
  });

  test('掃除は期限内の行（自分・他人・使用中）を消さず、一覧は掃除の前後で変わらない', async () => {
    const person = await createLoginPerson();
    const other = await createLoginPerson();
    const mine = await insertApiToken(person.accountId, { name: '自分', lastUsedAt: new Date().toISOString() });
    const theirs = await insertApiToken(other.accountId, { name: '他人' });
    await insertApiToken(person.accountId, { name: '切れた', expiresAt: past() });
    const before = await (await list(person)).json();
    await cleanupApiTokens(testEnv, new Date());
    expect(await (await list(person)).json()).toEqual(before);
    expect(await listedIds(person)).toEqual([mine.hash]);
    expect(await listedIds(other)).toEqual([theirs.hash]);
  });

  test('cron の入口（scheduled）から回しても、発行した行は期限ちょうどで消え、ログにハッシュも生の値も出ない', async () => {
    const person = await createLoginPerson();
    const issued = await issue(person, 1);
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    await worker.scheduled(
      createScheduledController({ scheduledTime: Date.parse(issued.expires_at), cron: '* * * * *' }),
      testEnv,
    );
    expect(await tokenRow(issued.id)).toBeUndefined();
    const logged = [...info.mock.calls, ...errors.mock.calls].map((call) => call.join(' ')).join('\n');
    expect(logged).toContain('api_tokens');
    expect(logged).not.toContain(issued.id);
    expect(logged).not.toContain(issued.token);
    expect(logged).not.toContain(person.accountId);
  });

  test('掃除で行が消えても、同じ人が続けて発行・一覧できる（掃除が他の行や人に触れない）', async () => {
    const person = await createLoginPerson();
    await insertApiToken(person.accountId, { expiresAt: past() });
    await cleanupApiTokens(testEnv, new Date());
    const issued = await issue(person, 90);
    expect(await listedIds(person)).toEqual([issued.id]);
    expect(await tokenRowsOf(person.accountId)).toHaveLength(1);
  });
});

describe('docs との突き合わせ', () => {
  test('requirements: 組織の管理者でも、同じ組織の一般のメンバーのトークンは一覧に出ず、取り消せない', async () => {
    const organization = await createOrganization();
    const admin = await createPerson({ organization, admin: true });
    const member = await createPerson({ organization });
    const theirs = await insertApiToken(member.accountId);
    expect(await listedIds(admin)).toEqual([]);
    const res = await revoke(admin, theirs.hash);
    expect(res.status).toBe(404);
    expect((await tokenRow(theirs.hash))!.revoked_at).toBeNull();
  });

  test('requirements: 管理者の write トークンでも、他人のトークンを一覧・取消できる口は無い（3操作とも 403）', async () => {
    const organization = await createOrganization();
    const admin = await createPerson({ organization, admin: true });
    const member = await createPerson({ organization });
    const theirs = await insertApiToken(member.accountId);
    const mine = await insertApiToken(admin.accountId, { scope: 'write' });
    for (const [definition, body] of [
      [tokenList, {}],
      [tokenRevoke, { id: theirs.hash }],
      [tokenCreate, { name: 'x', scope: 'read' }],
    ] as const) {
      const res = await post(app, definition, { bearer: mine.raw, origin: null, body });
      expect(res.status, definition.name).toBe(403);
    }
    expect((await tokenRow(theirs.hash))!.revoked_at).toBeNull();
  });

  test('data-model: api_tokens の列、制約、account_id の索引が docs の表のとおり', async () => {
    const columns = await env.DB.prepare('select name, type, "notnull" as nn, pk from pragma_table_info(?)')
      .bind('api_tokens')
      .all<{ name: string; type: string; nn: number; pk: number }>();
    expect(columns.results.map((c) => [c.name, c.nn, c.pk])).toEqual([
      ['token_hash', 1, 1],
      ['account_id', 1, 0],
      ['name', 1, 0],
      ['scope', 1, 0],
      ['created_at', 1, 0],
      ['last_used_at', 0, 0],
      ['expires_at', 1, 0],
      ['revoked_at', 0, 0],
    ]);
    const indexes = await env.DB.prepare(
      "select il.name as name from pragma_index_list('api_tokens') il join pragma_index_info(il.name) ii where il.origin = 'c' and ii.name = 'account_id'",
    ).all<{ name: string }>();
    expect(indexes.results).toHaveLength(1);
  });

  test('data-model: 発行で作る行の token_hash は小文字16進64文字、名前は100文字ちょうどまで入る', async () => {
    const person = await createLoginPerson();
    const res = await create(person, { name: 'あ'.repeat(API_TOKEN_NAME_MAX_LENGTH), scope: 'read' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string };
    expect(body.id).toMatch(/^[0-9a-f]{64}$/);
    expect([...(await tokenRow(body.id))!.name]).toHaveLength(API_TOKEN_NAME_MAX_LENGTH);
  });

  test('操作の description の数字が、実際に受け付ける上限と同じ', () => {
    expect(tokenCreate.description).toContain(`1〜${API_TOKEN_NAME_MAX_LENGTH}文字`);
    expect(tokenCreate.description).toContain(`1〜${API_TOKEN_MAX_LIFETIME_DAYS}の整数`);
    expect(tokenCreate.description).toContain(`省略は${API_TOKEN_MAX_LIFETIME_DAYS}日`);
  });
});
