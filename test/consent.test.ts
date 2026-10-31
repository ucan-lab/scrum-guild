import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import { PRIVACY_VERSION, TERMS_VERSION } from '../src/lib/legal/versions.ts';
import { consentRecord, consentStatus } from '../src/shared/operations/session/consent.ts';
import { tokenCreate } from '../src/shared/operations/session/index.ts';
import { commonDb } from '../src/server/db/index.ts';
import { createApp } from '../src/server/app.ts';
import { errorCodeOf, post } from './operations/harness.ts';
import { createLoginPerson } from './operations/world.ts';

const app = createApp();

async function rowsFor(accountId: string) {
  const db = commonDb(env);
  return db.rows(
    db.statement((q) =>
      q.selectFrom('account_consents').selectAll().where('account_id', '=', accountId).orderBy('consented_at'),
    ),
  );
}

async function seedConsent(accountId: string, terms: string, privacy: string, consentedAt: string) {
  const db = commonDb(env);
  await db.batch([
    db.statement((q) =>
      q.insertInto('account_consents').values({
        account_id: accountId,
        terms_version: terms,
        privacy_version: privacy,
        consented_at: consentedAt,
      }),
    ),
  ]);
}

const OLD = '2026-01-01';
const CURRENT_INPUT = { terms_version: TERMS_VERSION, privacy_version: PRIVACY_VERSION };

describe('同意の操作', () => {
  test('consent-status は現在の版と、同意が無い状態を返す', async () => {
    const person = await createLoginPerson({ consented: false });
    const response = await post(app, consentStatus, { token: person.token });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      terms_version: TERMS_VERSION,
      privacy_version: PRIVACY_VERSION,
      latest: null,
      current: false,
    });
  });

  test('現在の版を同意すると行が書かれ、同じ版への二度目は行が増えない', async () => {
    const person = await createLoginPerson({ consented: false });
    const input = { terms_version: TERMS_VERSION, privacy_version: PRIVACY_VERSION };
    expect((await post(app, consentRecord, { token: person.token, body: input })).status).toBe(200);
    expect((await post(app, consentRecord, { token: person.token, body: input })).status).toBe(200);
    expect(await rowsFor(person.accountId)).toHaveLength(1);
    const status = await post(app, consentStatus, { token: person.token });
    expect((await status.json()) as { current: boolean }).toMatchObject({ current: true });
  });

  test('画面の版が古いと 409 conflict で、行を増やさない', async () => {
    const person = await createLoginPerson({ consented: false });
    const response = await post(app, consentRecord, {
      token: person.token,
      body: { terms_version: '2026-01-01', privacy_version: PRIVACY_VERSION },
    });
    expect(response.status).toBe(409);
    expect(await errorCodeOf(response)).toBe('conflict');
    expect(await rowsFor(person.accountId)).toHaveLength(0);
  });

  test('プライバシーポリシーの版だけが古い画面の同意は 409 で、行を増やさない', async () => {
    const person = await createLoginPerson({ consented: false });
    const response = await post(app, consentRecord, {
      token: person.token,
      body: { terms_version: TERMS_VERSION, privacy_version: OLD },
    });
    expect(response.status).toBe(409);
    expect(await rowsFor(person.accountId)).toHaveLength(0);
  });

  test('旧版の行と現在版の行があれば最新は現在版で、record を重ねても行は増えない', async () => {
    const person = await createLoginPerson({ consented: false });
    await seedConsent(person.accountId, OLD, OLD, '2026-01-01T00:00:00.000Z');
    await seedConsent(person.accountId, TERMS_VERSION, PRIVACY_VERSION, '2026-10-31T00:00:00.000Z');
    const status = await post(app, consentStatus, { token: person.token });
    expect(await status.json()).toEqual({
      terms_version: TERMS_VERSION,
      privacy_version: PRIVACY_VERSION,
      latest: {
        terms_version: TERMS_VERSION,
        privacy_version: PRIVACY_VERSION,
        consented_at: '2026-10-31T00:00:00.000Z',
      },
      current: true,
    });
    expect((await post(app, consentRecord, { token: person.token, body: CURRENT_INPUT })).status).toBe(200);
    expect(await rowsFor(person.accountId)).toHaveLength(2);
  });

  test.each([
    ['両方が旧版', OLD, OLD],
    ['規約だけが旧版', OLD, PRIVACY_VERSION],
    ['プライバシーポリシーだけが旧版', TERMS_VERSION, OLD],
  ])('最新の同意が%sなら current は false で、record すると新しい行が足される', async (_name, terms, privacy) => {
    const person = await createLoginPerson({ consented: false });
    await seedConsent(person.accountId, terms, privacy, '2026-01-01T00:00:00.000Z');
    const before = await post(app, consentStatus, { token: person.token });
    expect(await before.json()).toMatchObject({
      latest: { terms_version: terms, privacy_version: privacy, consented_at: '2026-01-01T00:00:00.000Z' },
      current: false,
    });
    expect((await post(app, consentRecord, { token: person.token, body: CURRENT_INPUT })).status).toBe(200);
    expect(await rowsFor(person.accountId)).toHaveLength(2);
    const after = await post(app, consentStatus, { token: person.token });
    expect(await after.json()).toMatchObject({ current: true });
  });

  test('現在版の行より新しい旧版の行があれば current は false で、record すると新しい行が足されて current になる', async () => {
    const person = await createLoginPerson({ consented: false });
    await seedConsent(person.accountId, TERMS_VERSION, PRIVACY_VERSION, '2026-10-30T00:00:00.000Z');
    // 実行時刻より過去にする（record が足す行は今の時刻で、これより新しくなければならない）
    await seedConsent(person.accountId, OLD, OLD, '2026-10-31T00:00:00.000Z');
    const before = await post(app, consentStatus, { token: person.token });
    expect(await before.json()).toMatchObject({ latest: { terms_version: OLD }, current: false });
    expect((await post(app, consentRecord, { token: person.token, body: CURRENT_INPUT })).status).toBe(200);
    expect(await rowsFor(person.accountId)).toHaveLength(3);
    const after = await post(app, consentStatus, { token: person.token });
    expect(await after.json()).toMatchObject({ latest: { terms_version: TERMS_VERSION }, current: true });
  });

  // 索引を逆向きに走ると rowid の大きい行が先に出るので、どちらの順に入れても版で決まることを確かめる
  test.each([
    ['旧版を先に入れた', true],
    ['現在版を先に入れた', false],
  ])('同じ時刻の行は、%sときも版が新しいほうを最新にする', async (_name, oldFirst) => {
    const person = await createLoginPerson({ consented: false });
    const at = '2026-10-31T00:00:00.000Z';
    if (oldFirst) await seedConsent(person.accountId, OLD, OLD, at);
    await seedConsent(person.accountId, TERMS_VERSION, PRIVACY_VERSION, at);
    if (!oldFirst) await seedConsent(person.accountId, OLD, OLD, at);
    const status = await post(app, consentStatus, { token: person.token });
    expect(await status.json()).toMatchObject({ latest: { terms_version: TERMS_VERSION }, current: true });
  });

  test('同じ同意を同時に送っても、すべて 200 で行は 1 つ', async () => {
    const person = await createLoginPerson({ consented: false });
    const responses = await Promise.all(
      Array.from({ length: 5 }, () => post(app, consentRecord, { token: person.token, body: CURRENT_INPUT })),
    );
    expect(responses.map((response) => response.status)).toEqual([200, 200, 200, 200, 200]);
    expect(await rowsFor(person.accountId)).toHaveLength(1);
  });

  test('API トークンでは record が 403', async () => {
    const person = await createLoginPerson({ consented: false });
    // token-create は同意の門を通る（未同意だと 403 の terms_required）ので、先に同意してからトークンを作る
    expect((await post(app, consentRecord, { token: person.token, body: CURRENT_INPUT })).status).toBe(200);
    const created = await post(app, tokenCreate, {
      token: person.token,
      body: { name: 'consent test', scope: 'write' },
    });
    const { token } = (await created.json()) as { token: string };
    expect((await post(app, consentStatus, { bearer: token, origin: null })).status).toBe(200);
    expect((await post(app, consentRecord, { bearer: token, origin: null, body: {} })).status).toBe(403);
  });
});
