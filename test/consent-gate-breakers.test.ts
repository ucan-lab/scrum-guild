// 同意の門（#648）を崩すテスト。consent-gate.test.ts が見ない手口だけを持つ:
// 全操作を回す走査、門の位置（回数の上限、運用者の判定、停止した組織、招待）、期限切れ・失効の認証が先、ログ、
// consent-status の current との一致、同時の呼び出し
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { z } from 'zod';
import { PRIVACY_VERSION, TERMS_VERSION } from '../src/lib/legal/versions.ts';
import { createApp } from '../src/server/app.ts';
import { commonDb } from '../src/server/db/index.ts';
import {
  assertOperationDefinition,
  isOutsideOperation,
  type AnyOperationDefinition,
} from '../src/shared/operations/define.ts';
import { operations } from '../src/shared/operations/index.ts';
import { listOrganizations } from '../src/shared/operations/operator/list-organizations.ts';
import { myOrganizations } from '../src/shared/operations/organization/my-organizations.ts';
import { consentRecord, consentStatus } from '../src/shared/operations/session/consent.ts';
import { me, tokenCreate } from '../src/shared/operations/session/index.ts';
import { invitationList } from '../src/shared/operations/workspace/index.ts';
import { workspaceList } from '../src/shared/operations/workspace/workspace-list.ts';
import { createOrganization, createInvitation, createWorkspace } from './factories.ts';
import { bearerFor, insertApiToken } from './operations/api-token.ts';
import { errorCodeOf, post } from './operations/harness.ts';
import { createLoginPerson, createPerson, createTarget } from './operations/world.ts';

const app = createApp();
const OLD = '2026-01-01';
const CURRENT_INPUT = { terms_version: TERMS_VERSION, privacy_version: PRIVACY_VERSION };
const SKIPPING = ['consent-record', 'consent-status', 'logout', 'me'];

afterEach(() => vi.restoreAllMocks());

async function addConsent(accountId: string, terms: string, privacy: string, consentedAt: string) {
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

async function expectTermsRequired(response: Response) {
  expect(response.status).toBe(403);
  expect(await errorCodeOf(response)).toBe('terms_required');
}

describe('全操作の走査', () => {
  // 入力も権限も合わない呼び出しでも、門が先に断る。skipsConsent の 4 つ以外は、1 つでも通り抜けたら落ちる
  const gated = operations.filter((d) => !SKIPPING.includes(d.name));

  test('登録された操作のうち、門の対象は 4 つ以外の全部（走査の母数が空でない）', () => {
    expect(gated.length).toBeGreaterThan(20);
    expect(gated.length + SKIPPING.length).toBe(operations.length);
  });

  test('未同意の Cookie は、skipsConsent 以外のすべての操作で 403 の terms_required', async () => {
    const target = await createTarget();
    const person = await createPerson({ organization: target.organization, admin: true, consented: false });
    const failures: string[] = [];
    for (const definition of gated) {
      const response = await post(app, definition, { slug: target.slug, token: person.token });
      const code = response.status === 403 ? await errorCodeOf(response) : undefined;
      if (code !== 'terms_required') failures.push(`${definition.name}: ${response.status} ${code}`);
    }
    expect(failures).toEqual([]);
  });

  test('未同意の write の API トークンは、cookieOnly と運用者の操作も含め 403 の terms_required（範囲の検査より前）', async () => {
    const target = await createTarget();
    const person = await createPerson({ organization: target.organization, admin: true, consented: false });
    const bearer = await bearerFor(person, 'write');
    const failures: string[] = [];
    for (const definition of gated) {
      const response = await post(app, definition, { slug: target.slug, bearer, origin: null });
      const code = response.status === 403 ? await errorCodeOf(response) : undefined;
      if (code !== 'terms_required') failures.push(`${definition.name}: ${response.status} ${code}`);
    }
    expect(failures).toEqual([]);
  });
});

describe('門の位置', () => {
  test('未同意の呼び出しは回数の上限を消費しない（同意した直後の最初の呼び出しが 429 にならない）', async () => {
    const person = await createLoginPerson({ consented: false });
    const limit = tokenCreate.rateLimit!.max;
    for (let i = 0; i < limit + 3; i++) {
      await expectTermsRequired(
        await post(app, tokenCreate, { token: person.token, body: { name: 'n', scope: 'read' } }),
      );
    }
    expect((await post(app, consentRecord, { token: person.token, body: CURRENT_INPUT })).status).toBe(200);
    const created = await post(app, tokenCreate, { token: person.token, body: { name: 'n', scope: 'read' } });
    expect(created.status).toBe(200);
  });

  test('運用者でない未同意の人が運用者の操作を呼んでも、403 の forbidden でなく terms_required', async () => {
    const person = await createLoginPerson({ consented: false });
    await expectTermsRequired(await post(app, listOrganizations, { token: person.token }));
    expect((await post(app, consentRecord, { token: person.token, body: CURRENT_INPUT })).status).toBe(200);
    const after = await post(app, listOrganizations, { token: person.token });
    expect(after.status).toBe(403);
    expect(await errorCodeOf(after)).toBe('forbidden');
  });

  test('停止した組織の管理者が未同意なら terms_required。同意した後に organization_suspended', async () => {
    const organization = await createOrganization({ suspended_at: '2026-10-20T00:00:00.000Z' });
    const admin = await createPerson({ organization, admin: true, consented: false });
    await expectTermsRequired(await post(app, workspaceList, { slug: organization.slug, token: admin.token }));
    expect((await post(app, consentRecord, { token: admin.token, body: CURRENT_INPUT })).status).toBe(200);
    const after = await post(app, workspaceList, { slug: organization.slug, token: admin.token });
    expect(after.status).toBe(403);
    expect(await errorCodeOf(after)).toBe('organization_suspended');
  });

  test('承諾待ちの招待だけの未同意の人は、招待の一覧も terms_required。同意すれば招待が読める', async () => {
    const organization = await createOrganization();
    const admin = await createPerson({ organization, admin: true });
    const workspace = await createWorkspace(organization, admin.userId!);
    const invitee = await createPerson({ consented: false });
    await createInvitation(organization, workspace.id, admin.userId!, invitee.login);
    await expectTermsRequired(await post(app, invitationList, { slug: organization.slug, token: invitee.token }));
    await expectTermsRequired(await post(app, myOrganizations, { token: invitee.token }));
    expect((await post(app, consentRecord, { token: invitee.token, body: CURRENT_INPUT })).status).toBe(200);
    expect((await post(app, invitationList, { slug: organization.slug, token: invitee.token })).status).toBe(200);
  });

  test('組織が無い未同意の人も terms_required で、無効にされた人も同じ', async () => {
    const lone = await createPerson({ consented: false });
    await expectTermsRequired(await post(app, myOrganizations, { token: lone.token }));
    const organization = await createOrganization();
    const disabled = await createPerson({ organization, disabled: true, consented: false });
    await expectTermsRequired(await post(app, workspaceList, { slug: organization.slug, token: disabled.token }));
  });

  test('同意はアカウントごと。同じ組織の別の人の同意は引き継がれない', async () => {
    const target = await createTarget();
    const unconsented = await createPerson({ organization: target.organization, consented: false });
    expect((await post(app, workspaceList, { slug: target.slug, token: target.admin.token })).status).toBe(200);
    await expectTermsRequired(await post(app, workspaceList, { slug: target.slug, token: unconsented.token }));
    expect((await post(app, consentRecord, { token: target.admin.token, body: CURRENT_INPUT })).status).toBe(200);
    await expectTermsRequired(await post(app, workspaceList, { slug: target.slug, token: unconsented.token }));
  });
});

describe('認証が先', () => {
  test('未同意でも、期限切れのセッションは 401 の unauthenticated', async () => {
    const person = await createPerson({
      consented: false,
      sessionOverrides: { expires_at: '2026-01-01T00:00:00.000Z' },
    });
    const response = await post(app, myOrganizations, { token: person.token });
    expect(response.status).toBe(401);
    expect(await errorCodeOf(response)).toBe('unauthenticated');
  });

  test.each([
    ['期限切れ', { expiresAt: '2026-01-01T00:00:00.000Z' }],
    ['取り消し済み', { revokedAt: '2026-10-21T00:00:00.000Z' }],
  ])('未同意でも、%sの API トークンは 401 の unauthenticated', async (_name, options) => {
    const person = await createLoginPerson({ consented: false });
    const { raw } = await insertApiToken(person.accountId, options);
    const response = await post(app, myOrganizations, { bearer: raw, origin: null });
    expect(response.status).toBe(401);
    expect(await errorCodeOf(response)).toBe('unauthenticated');
  });
});

describe('operation ログ', () => {
  async function loggedLine(run: () => Promise<Response>): Promise<Record<string, unknown>> {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    // 同じ console.log のスパイが前の呼び出しの行を持ち越すので、数え直す
    log.mockClear();
    await run();
    const lines = log.mock.calls
      .map(([line]) => (typeof line === 'string' ? line : ''))
      .filter((line) => line.startsWith('{') && line.includes('"operation"'));
    expect(lines).toHaveLength(1);
    return JSON.parse(lines[0]!) as Record<string, unknown>;
  }

  test('terms_required と 403 と accountId が残り、トークンの値と Cookie は出ない', async () => {
    const person = await createLoginPerson({ consented: false });
    const bearer = await bearerFor(person, 'read');
    const cookieLine = await loggedLine(() => post(app, myOrganizations, { token: person.token }));
    expect(cookieLine).toMatchObject({
      operation: 'my-organizations',
      code: 'terms_required',
      status: 403,
      accountId: person.accountId,
      credential: 'cookie',
    });
    const tokenLine = await loggedLine(() => post(app, myOrganizations, { bearer, origin: null }));
    expect(tokenLine).toMatchObject({ code: 'terms_required', status: 403, credential: 'token' });
    for (const line of [cookieLine, tokenLine]) {
      expect(JSON.stringify(line)).not.toContain(person.token);
      expect(JSON.stringify(line)).not.toContain(bearer);
    }
  });

  test('組織に入る前に断るので、organizationId と userId は null', async () => {
    const target = await createTarget();
    const person = await createPerson({ organization: target.organization, admin: true, consented: false });
    const line = await loggedLine(() => post(app, workspaceList, { slug: target.slug, token: person.token }));
    expect(line).toMatchObject({ code: 'terms_required', organizationId: null, userId: null });
  });
});

describe('門の判定は consent-status の current と一致する', () => {
  const T = '2026-10-30T00:00:00.000Z';
  const cases: [string, [string, string, string][]][] = [
    ['行なし', []],
    ['今の版', [[TERMS_VERSION, PRIVACY_VERSION, T]]],
    [
      '同じ時刻に、今の版と、より新しい（未来の）版',
      [
        [TERMS_VERSION, PRIVACY_VERSION, T],
        ['9999-12-31', '9999-12-31', T],
      ],
    ],
    [
      '同じ時刻に、今の版と、規約だけ未来の版',
      [
        [TERMS_VERSION, PRIVACY_VERSION, T],
        ['9999-12-31', PRIVACY_VERSION, T],
      ],
    ],
    [
      '同じ時刻に、今の版と、規約が同じでプライバシーだけ未来の版',
      [
        [TERMS_VERSION, PRIVACY_VERSION, T],
        [TERMS_VERSION, '9999-12-31', T],
      ],
    ],
    [
      '同じ時刻に、今の版と、規約が同じでプライバシーが古い版',
      [
        [TERMS_VERSION, PRIVACY_VERSION, T],
        [TERMS_VERSION, OLD, T],
      ],
    ],
    [
      'より新しい時刻の未来の版',
      [
        [TERMS_VERSION, PRIVACY_VERSION, T],
        ['9999-12-31', '9999-12-31', '2026-10-31T00:00:00.000Z'],
      ],
    ],
  ];

  test.each(cases)('%s', async (_name, rows) => {
    const person = await createLoginPerson({ consented: false });
    for (const [terms, privacy, at] of rows) await addConsent(person.accountId, terms, privacy, at);
    const status = (await (await post(app, consentStatus, { token: person.token })).json()) as { current: boolean };
    const gate = await post(app, myOrganizations, { token: person.token });
    expect(gate.status === 200).toBe(status.current);
    if (!status.current) await expectTermsRequired(gate);
  });

  test('行が大量（旧版 300 行）にあっても、最新が今の版なら通り、最新が旧版なら断る', async () => {
    const person = await createLoginPerson({ consented: false });
    const db = commonDb(env);
    const base = Date.parse('2026-01-01T00:00:00.000Z');
    const oldVersion = (n: number) => new Date(Date.parse('2020-01-01') + n * 86400000).toISOString().slice(0, 10);
    for (let chunk = 0; chunk < 3; chunk++) {
      await db.batch(
        Array.from({ length: 100 }, (_, i) => {
          const n = chunk * 100 + i;
          return db.statement((q) =>
            q.insertInto('account_consents').values({
              account_id: person.accountId,
              terms_version: oldVersion(n),
              privacy_version: oldVersion(n),
              consented_at: new Date(base + n * 1000).toISOString(),
            }),
          );
        }),
      );
    }
    await expectTermsRequired(await post(app, myOrganizations, { token: person.token }));
    await addConsent(person.accountId, TERMS_VERSION, PRIVACY_VERSION, '2026-06-01T00:00:00.000Z');
    expect((await post(app, myOrganizations, { token: person.token })).status).toBe(200);
  });
});

describe('同時の呼び出し', () => {
  test('同意の送信と門の対象の呼び出しが同時でも、各応答は 200 か terms_required だけで、同意後は必ず通る', async () => {
    const person = await createLoginPerson({ consented: false });
    const responses = await Promise.all([
      ...Array.from({ length: 4 }, () => post(app, myOrganizations, { token: person.token })),
      post(app, consentRecord, { token: person.token, body: CURRENT_INPUT }),
      ...Array.from({ length: 4 }, () => post(app, me, { token: person.token })),
    ]);
    for (const response of responses.slice(0, 4)) {
      if (response.status !== 200) await expectTermsRequired(response);
    }
    expect(responses[4]!.status).toBe(200);
    expect((await post(app, myOrganizations, { token: person.token })).status).toBe(200);
  });
});

describe('skipsConsent の定義の検査', () => {
  const login = {
    name: 'sample-op',
    description: 'テスト用',
    mode: 'read',
    permission: 'login',
    input: z.object({}),
    output: z.object({}),
  };

  test.each([false, 'true', 1, null])('skipsConsent: %j は true でないので Error', (value) => {
    expect(() =>
      assertOperationDefinition({ ...login, skipsConsent: value } as unknown as AnyOperationDefinition),
    ).toThrow();
  });

  test('skipsConsent の操作はすべて組織の外の操作（slug を持たない）', () => {
    for (const definition of operations) {
      if (definition.skipsConsent === true) expect(isOutsideOperation(definition)).toBe(true);
    }
  });
});
