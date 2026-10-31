// 今の版の規約に同意していない人は、同意するまで API を呼べない（403 の terms_required）。
// 検査は execute() の認証の直後、組織に入る前に1回。検査を飛ばせるのは skipsConsent を付けた login の操作4つだけ
import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import { z } from 'zod';
import { PRIVACY_VERSION, TERMS_VERSION } from '../src/lib/legal/versions.ts';
import { createApp } from '../src/server/app.ts';
import { commonDb } from '../src/server/db/index.ts';
import {
  assertOperationDefinition,
  permissions,
  type AnyOperationDefinition,
} from '../src/shared/operations/define.ts';
import { operations } from '../src/shared/operations/index.ts';
import { organizationInfo } from '../src/shared/operations/organization/organization.ts';
import { myOrganizations } from '../src/shared/operations/organization/my-organizations.ts';
import { listOrganizations } from '../src/shared/operations/operator/list-organizations.ts';
import { consentRecord, consentStatus } from '../src/shared/operations/session/consent.ts';
import { logout, me, operationList, tokenList } from '../src/shared/operations/session/index.ts';
import { workspaceCreate } from '../src/shared/operations/workspace/workspace-create.ts';
import { workspaceList } from '../src/shared/operations/workspace/workspace-list.ts';
import { CONSENTED_AT, createAccount, createOrganization } from './factories.ts';
import { bearerFor } from './operations/api-token.ts';
import { errorCodeOf, post } from './operations/harness.ts';
import { createLoginPerson, createPerson, createTarget, OPERATOR_LOGIN_ID } from './operations/world.ts';

const app = createApp();

const OLD = '2026-01-01';
const CURRENT_INPUT = { terms_version: TERMS_VERSION, privacy_version: PRIVACY_VERSION };
const WORKSPACE_INPUT = (adminUserId: string | null) => ({
  name: '保守チーム',
  timezone: 'Asia/Tokyo',
  leader_user_id: adminUserId,
});

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

// 組織の管理者で、同意の行を持たない人
async function unconsentedAdmin() {
  const organization = await createOrganization();
  const person = await createPerson({ organization, admin: true, consented: false });
  return { organization, person };
}

async function expectTermsRequired(response: Response) {
  expect(response.status).toBe(403);
  expect(await errorCodeOf(response)).toBe('terms_required');
}

describe('同意していない人（行なし）の Cookie のセッション', () => {
  test('組織の中の read と write の操作は 403 の terms_required', async () => {
    const { organization, person } = await unconsentedAdmin();
    await expectTermsRequired(await post(app, workspaceList, { slug: organization.slug, token: person.token }));
    await expectTermsRequired(
      await post(app, workspaceCreate, {
        slug: organization.slug,
        token: person.token,
        body: WORKSPACE_INPUT(person.userId),
      }),
    );
  });

  test('組織の外の操作（my-organizations）は 403 の terms_required', async () => {
    const { person } = await unconsentedAdmin();
    await expectTermsRequired(await post(app, myOrganizations, { token: person.token }));
  });

  test('運用者の操作も 403 の terms_required（運用者も同意するまで入れない）', async () => {
    const operator = await createPerson({
      login: { provider: 'github', subject: OPERATOR_LOGIN_ID.split(':')[1]! },
      consented: false,
    });
    await expectTermsRequired(await post(app, listOrganizations, { token: operator.token }));
    // 同意すれば同じ人が運用者の操作を呼べる
    expect((await post(app, consentRecord, { token: operator.token, body: CURRENT_INPUT })).status).toBe(200);
    expect((await post(app, listOrganizations, { token: operator.token })).status).toBe(200);
  });

  test('存在しない slug の操作も、404 でなく 403 の terms_required（組織があるかを漏らさない）', async () => {
    const { person } = await unconsentedAdmin();
    await expectTermsRequired(await post(app, workspaceList, { slug: 'no-such-organization', token: person.token }));
  });

  test('入れない組織を指す操作も 403 の terms_required で、同意した後は従来の 404', async () => {
    const target = await createTarget();
    const outsider = await createLoginPerson({ consented: false });
    await expectTermsRequired(await post(app, workspaceList, { slug: target.slug, token: outsider.token }));
    expect((await post(app, consentRecord, { token: outsider.token, body: CURRENT_INPUT })).status).toBe(200);
    const after = await post(app, workspaceList, { slug: target.slug, token: outsider.token });
    expect(after.status).toBe(404);
    expect(await errorCodeOf(after)).toBe('not_found');
  });

  test('組織に属さず、入力が壊れていても、入力の検証より前に 403 の terms_required', async () => {
    const { organization, person } = await unconsentedAdmin();
    await expectTermsRequired(
      await post(app, workspaceCreate, { slug: organization.slug, token: person.token, rawBody: 'not json' }),
    );
  });
});

describe('同意していない人の API トークン', () => {
  test.each(['read', 'write'] as const)(
    '%s の範囲のトークンで、組織の中と外の read は 403 の terms_required',
    async (scope) => {
      const { organization, person } = await unconsentedAdmin();
      const bearer = await bearerFor(person, scope);
      await expectTermsRequired(await post(app, workspaceList, { slug: organization.slug, bearer, origin: null }));
      await expectTermsRequired(await post(app, myOrganizations, { bearer, origin: null }));
    },
  );

  test('write のトークンの write は 403 の terms_required', async () => {
    const { organization, person } = await unconsentedAdmin();
    const bearer = await bearerFor(person, 'write');
    await expectTermsRequired(
      await post(app, workspaceCreate, {
        slug: organization.slug,
        bearer,
        origin: null,
        body: WORKSPACE_INPUT(person.userId),
      }),
    );
  });

  test('read のトークンの write も、範囲の検査より前に terms_required で断る', async () => {
    const { organization, person } = await unconsentedAdmin();
    const bearer = await bearerFor(person, 'read');
    await expectTermsRequired(
      await post(app, workspaceCreate, {
        slug: organization.slug,
        bearer,
        origin: null,
        body: WORKSPACE_INPUT(person.userId),
      }),
    );
  });

  test('同意するとトークンの呼び出しが通る', async () => {
    const { organization, person } = await unconsentedAdmin();
    const bearer = await bearerFor(person, 'read');
    await expectTermsRequired(await post(app, workspaceList, { slug: organization.slug, bearer, origin: null }));
    expect((await post(app, consentRecord, { token: person.token, body: CURRENT_INPUT })).status).toBe(200);
    expect((await post(app, workspaceList, { slug: organization.slug, bearer, origin: null })).status).toBe(200);
  });
});

describe('最新の同意の行で決める', () => {
  test.each([
    ['規約だけが古い', OLD, PRIVACY_VERSION],
    ['プライバシーポリシーだけが古い', TERMS_VERSION, OLD],
    ['両方が古い', OLD, OLD],
  ])('最新の行が%sと 403 の terms_required', async (_name, terms, privacy) => {
    const person = await createLoginPerson({ consented: false });
    await addConsent(person.accountId, terms, privacy, '2026-10-30T00:00:00.000Z');
    await expectTermsRequired(await post(app, myOrganizations, { token: person.token }));
    await expectTermsRequired(
      await post(app, myOrganizations, { bearer: await bearerFor(person, 'read'), origin: null }),
    );
  });

  test('最新の行が古く、より前の行が今の版でも 403 の terms_required', async () => {
    const person = await createLoginPerson({ consented: false });
    await addConsent(person.accountId, TERMS_VERSION, PRIVACY_VERSION, '2026-10-29T00:00:00.000Z');
    await addConsent(person.accountId, OLD, OLD, '2026-10-30T00:00:00.000Z');
    await expectTermsRequired(await post(app, myOrganizations, { token: person.token }));
  });

  test('最新の行が今の版なら、より前に古い行があっても通る', async () => {
    const person = await createLoginPerson({ consented: false });
    await addConsent(person.accountId, OLD, OLD, '2026-01-01T00:00:00.000Z');
    await addConsent(person.accountId, TERMS_VERSION, PRIVACY_VERSION, '2026-10-30T00:00:00.000Z');
    expect((await post(app, myOrganizations, { token: person.token })).status).toBe(200);
  });
});

describe('検査を飛ばす操作', () => {
  test('me は未同意でも通る（Cookie も API トークンも）', async () => {
    const person = await createLoginPerson({ consented: false });
    expect((await post(app, me, { token: person.token })).status).toBe(200);
    expect((await post(app, me, { bearer: await bearerFor(person, 'read'), origin: null })).status).toBe(200);
  });

  test('consent-status は未同意でも通る（Cookie も API トークンも）', async () => {
    const person = await createLoginPerson({ consented: false });
    const response = await post(app, consentStatus, { token: person.token });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ current: false });
    expect((await post(app, consentStatus, { bearer: await bearerFor(person, 'read'), origin: null })).status).toBe(
      200,
    );
  });

  test('logout は未同意でも通り、セッションが消える', async () => {
    const person = await createLoginPerson({ consented: false });
    expect((await post(app, logout, { token: person.token })).status).toBe(200);
    const after = await post(app, me, { token: person.token });
    expect(after.status).toBe(401);
  });

  test('consent-record は未同意でも通り、その後に同じ人の組織の操作が通る', async () => {
    const { organization, person } = await unconsentedAdmin();
    await expectTermsRequired(await post(app, workspaceList, { slug: organization.slug, token: person.token }));
    expect((await post(app, consentRecord, { token: person.token, body: CURRENT_INPUT })).status).toBe(200);
    expect((await post(app, workspaceList, { slug: organization.slug, token: person.token })).status).toBe(200);
  });

  test('token-list と operation-list は付けていないので、未同意だと 403 の terms_required', async () => {
    const person = await createLoginPerson({ consented: false });
    await expectTermsRequired(await post(app, tokenList, { token: person.token }));
    await expectTermsRequired(await post(app, operationList, { token: person.token }));
    await expectTermsRequired(
      await post(app, operationList, { bearer: await bearerFor(person, 'read'), origin: null }),
    );
  });
});

describe('同意済みの人は今までどおり通る', () => {
  test('管理者と一般の人が、組織の中と外の操作を呼べる', async () => {
    const target = await createTarget();
    expect((await post(app, workspaceList, { slug: target.slug, token: target.admin.token })).status).toBe(200);
    expect((await post(app, myOrganizations, { token: target.admin.token })).status).toBe(200);
    for (const person of [target.leader, target.member]) {
      expect((await post(app, organizationInfo, { slug: target.slug, token: person.token })).status).toBe(200);
      expect((await post(app, myOrganizations, { token: person.token })).status).toBe(200);
    }
  });

  test('運用者が運用者の操作を呼べる', async () => {
    const operator = await createPerson({ login: { provider: 'google', subject: '424242' } });
    expect((await post(app, listOrganizations, { token: operator.token })).status).toBe(200);
  });

  test('今の版の同意の行を持つ人のトークンも通る', async () => {
    const target = await createTarget();
    const bearer = await bearerFor(target.admin, 'write');
    expect((await post(app, workspaceList, { slug: target.slug, bearer, origin: null })).status).toBe(200);
  });
});

describe('認証が先', () => {
  test('セッションが無い呼び出しは 401 の unauthenticated', async () => {
    const response = await post(app, myOrganizations, {});
    expect(response.status).toBe(401);
    expect(await errorCodeOf(response)).toBe('unauthenticated');
  });

  test('存在しないセッションの Cookie は 401 の unauthenticated', async () => {
    const response = await post(app, myOrganizations, { token: 'x'.repeat(43) });
    expect(response.status).toBe(401);
    expect(await errorCodeOf(response)).toBe('unauthenticated');
  });

  test('無効な Bearer は 401 の unauthenticated', async () => {
    const response = await post(app, myOrganizations, { bearer: 'sgp_invalid', origin: null });
    expect(response.status).toBe(401);
    expect(await errorCodeOf(response)).toBe('unauthenticated');
  });

  test('未同意の人でも、Origin が違えば terms_required でなく従来の 403 の forbidden', async () => {
    const person = await createLoginPerson({ consented: false });
    const response = await post(app, myOrganizations, { token: person.token, origin: 'https://evil.example' });
    expect(response.status).toBe(403);
    expect(await errorCodeOf(response)).toBe('forbidden');
  });
});

describe('操作の定義の skipsConsent', () => {
  const base = {
    name: 'sample-op',
    description: 'テスト用',
    mode: 'read',
    input: z.object({}),
    output: z.object({}),
  } as const;

  function definitionFor(permission: (typeof permissions)[number], extra: Record<string, unknown>) {
    const workspace = permission === 'member' || permission === 'leader' ? { workspace: true } : {};
    return { ...base, permission, ...workspace, ...extra } as unknown as AnyOperationDefinition;
  }

  test('login の操作には skipsConsent: true を付けられる', () => {
    expect(() => assertOperationDefinition(definitionFor('login', { skipsConsent: true }))).not.toThrow();
  });

  test.each(permissions.filter((permission) => permission !== 'login'))(
    'permission: %s に付けると Error（付けなければ通る）',
    (permission) => {
      expect(() => assertOperationDefinition(definitionFor(permission, {}))).not.toThrow();
      expect(() => assertOperationDefinition(definitionFor(permission, { skipsConsent: true }))).toThrow();
    },
  );

  test('登録されている全操作のうち skipsConsent が付いているのは me、logout、consent-status、consent-record だけ', () => {
    const names = operations
      .filter((definition) => definition.skipsConsent === true)
      .map((definition) => definition.name)
      .sort();
    expect(names).toEqual(['consent-record', 'consent-status', 'logout', 'me']);
  });
});

describe('createAccount の同意の行', () => {
  async function consentRows(accountId: string) {
    const db = commonDb(env);
    return db.rows(
      db.statement((q) => q.selectFrom('account_consents').selectAll().where('account_id', '=', accountId)),
    );
  }

  test('既定は今の版の同意の行を1つ足す', async () => {
    const account = await createAccount();
    expect(await consentRows(account.id)).toEqual([
      {
        account_id: account.id,
        terms_version: TERMS_VERSION,
        privacy_version: PRIVACY_VERSION,
        consented_at: CONSENTED_AT,
      },
    ]);
  });

  test('{ consented: false } は行を足さない', async () => {
    const account = await createAccount({}, { consented: false });
    expect(await consentRows(account.id)).toEqual([]);
  });
});
