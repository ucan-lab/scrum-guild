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

describe('同意の操作', () => {
  test('consent-status は現在の版と、同意が無い状態を返す', async () => {
    const person = await createLoginPerson();
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
    const person = await createLoginPerson();
    const input = { terms_version: TERMS_VERSION, privacy_version: PRIVACY_VERSION };
    expect((await post(app, consentRecord, { token: person.token, body: input })).status).toBe(200);
    expect((await post(app, consentRecord, { token: person.token, body: input })).status).toBe(200);
    expect(await rowsFor(person.accountId)).toHaveLength(1);
    const status = await post(app, consentStatus, { token: person.token });
    expect((await status.json()) as { current: boolean }).toMatchObject({ current: true });
  });

  test('画面の版が古いと 409 conflict で、行を増やさない', async () => {
    const person = await createLoginPerson();
    const response = await post(app, consentRecord, {
      token: person.token,
      body: { terms_version: '2026-01-01', privacy_version: PRIVACY_VERSION },
    });
    expect(response.status).toBe(409);
    expect(await errorCodeOf(response)).toBe('conflict');
    expect(await rowsFor(person.accountId)).toHaveLength(0);
  });

  test('API トークンでは record が 403', async () => {
    const person = await createLoginPerson();
    const created = await post(app, tokenCreate, {
      token: person.token,
      body: { name: 'consent test', scope: 'write' },
    });
    const { token } = (await created.json()) as { token: string };
    expect((await post(app, consentStatus, { bearer: token, origin: null })).status).toBe(200);
    expect((await post(app, consentRecord, { bearer: token, origin: null, body: {} })).status).toBe(403);
  });
});
