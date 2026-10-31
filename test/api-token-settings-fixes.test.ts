// 設定でのトークンの発行の上限（有効な行は1アカウントに20件まで）と、名前の NUL 文字。
// 上限は発行の INSERT 自体の条件（INSERT ... SELECT ... WHERE 件数 < 上限）で守るので、同時に発行しても超えない
import { describe, expect, test } from 'vitest';
import { API_TOKEN_MAX_ACTIVE } from '../src/shared/api-token.ts';
import { tokenCreate, tokenList, tokenRevoke } from '../src/shared/operations/session/index.ts';
import { createApp } from '../src/server/app.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import { insertApiToken, tokenRowsOf } from './operations/api-token.ts';
import { errorCodeOf, post } from './operations/harness.ts';
import { createLoginPerson } from './operations/world.ts';
import type { Person } from './operations/world.ts';

const app = createApp([...implementedOperations]);
const DAY_MS = 24 * 60 * 60 * 1000;
const future = (days = 30) => new Date(Date.now() + days * DAY_MS).toISOString();
const past = () => new Date(Date.now() - 1000).toISOString();

const create = (person: Person, body: unknown = { name: '手元の CLI', scope: 'read' }) =>
  post(app, tokenCreate, { token: person.token, body });
const list = (person: Person) => post(app, tokenList, { token: person.token });
const revoke = (person: Person, id: string) => post(app, tokenRevoke, { token: person.token, body: { id } });

async function fill(person: Person, count: number): Promise<string[]> {
  const hashes: string[] = [];
  for (let index = 0; index < count; index++) {
    hashes.push((await insertApiToken(person.accountId, { name: `既存 ${index}`, expiresAt: future() })).hash);
  }
  return hashes;
}

describe('発行の上限', () => {
  test('上限は20件', () => {
    expect(API_TOKEN_MAX_ACTIVE).toBe(20);
  });

  test('20件まで発行でき、21件目は 409 conflict で、行が増えない', async () => {
    const person = await createLoginPerson();
    for (let index = 0; index < API_TOKEN_MAX_ACTIVE; index++) {
      expect((await create(person)).status, `${index + 1} 件目`).toBe(200);
    }
    const res = await create(person);
    expect(res.status).toBe(409);
    expect(await errorCodeOf(res.clone())).toBe('conflict');
    expect(((await res.json()) as { error: { details?: unknown } }).error.details).toEqual({ reason: 'limit' });
    expect(await tokenRowsOf(person.accountId)).toHaveLength(API_TOKEN_MAX_ACTIVE);
    expect(((await (await list(person)).json()) as { tokens: unknown[] }).tokens).toHaveLength(API_TOKEN_MAX_ACTIVE);
  });

  test('取り消すと再び発行でき、また上限で止まる', async () => {
    const person = await createLoginPerson();
    const [first] = await fill(person, API_TOKEN_MAX_ACTIVE);
    expect((await create(person)).status).toBe(409);
    expect((await revoke(person, first!)).status).toBe(200);
    expect((await create(person)).status).toBe(200);
    expect((await create(person)).status).toBe(409);
  });

  test('期限切れと取消済みの行は数えない', async () => {
    const person = await createLoginPerson();
    await fill(person, 18);
    for (let index = 0; index < 5; index++) {
      await insertApiToken(person.accountId, { name: '期限切れ', expiresAt: past() });
      await insertApiToken(person.accountId, { name: '取消済み', revokedAt: past(), expiresAt: future() });
    }
    expect((await create(person)).status).toBe(200);
    expect((await create(person)).status).toBe(200);
    expect((await create(person)).status).toBe(409);
    expect(await tokenRowsOf(person.accountId)).toHaveLength(18 + 10 + 2);
  });

  test('他人の件数に影響されず、他人の発行も妨げない', async () => {
    const [me, other] = await Promise.all([createLoginPerson(), createLoginPerson()]);
    await fill(other, API_TOKEN_MAX_ACTIVE);
    expect((await create(other)).status).toBe(409);
    expect((await create(me)).status).toBe(200);
    expect(await tokenRowsOf(other.accountId)).toHaveLength(API_TOKEN_MAX_ACTIVE);
  });

  test('20件に近い状態から同時に発行しても、上限を超えない', async () => {
    const person = await createLoginPerson();
    await fill(person, 18);
    const results = await Promise.all(Array.from({ length: 6 }, () => create(person)));
    const statuses = results.map((res) => res.status).sort();
    expect(statuses).toEqual([200, 200, 409, 409, 409, 409]);
    expect(await tokenRowsOf(person.accountId)).toHaveLength(API_TOKEN_MAX_ACTIVE);
  });

  test('一覧は、行が上限を超えていても上限の件数までを返す（保険）', async () => {
    const person = await createLoginPerson();
    await fill(person, API_TOKEN_MAX_ACTIVE + 5);
    const tokens = ((await (await list(person)).json()) as { tokens: unknown[] }).tokens;
    expect(tokens).toHaveLength(API_TOKEN_MAX_ACTIVE);
  });
});

describe('名前の NUL 文字', () => {
  test('NUL を含む名前は 400 invalid_input で、行は増えない', async () => {
    const person = await createLoginPerson();
    for (const name of ['a\u0000b', '\u0000', 'abc\u0000', '\u0000abc']) {
      const res = await create(person, { name, scope: 'read' });
      expect(res.status, JSON.stringify(name)).toBe(400);
      expect(await errorCodeOf(res)).toBe('invalid_input');
    }
    const raw = await post(app, tokenCreate, {
      token: person.token,
      rawBody: '{"name":"x\\u0000y","scope":"read"}',
    });
    expect(raw.status).toBe(400);
    expect(await tokenRowsOf(person.accountId)).toHaveLength(0);
  });

  test('改行・タブ・ゼロ幅の空白を含む名前は、これまでどおり通る', async () => {
    const person = await createLoginPerson();
    for (const name of ['line1\nline2', 'tab\there', 'a​b']) {
      expect((await create(person, { name, scope: 'read' })).status, JSON.stringify(name)).toBe(200);
    }
  });
});
