// 入れる組織を失った人のセッション（#639 から、組織を失ってもセッションと Cookie は消さない）と、
// 操作の回数の上限（定義の rateLimit）、ログインの手段の型（招待する人の指し方）
import { env } from 'cloudflare:workers';
import { describe, expect, test, vi } from 'vitest';
import { z } from 'zod';
import { defineOperation } from '../src/shared/operations/define.ts';
import { logout, me } from '../src/shared/operations/session/index.ts';
import { myOrganizations } from '../src/shared/operations/organization/index.ts';
import { createApp } from '../src/server/app.ts';
import { createGithubLoginMethod } from '../src/server/auth/github.ts';
import { LoginMethodError } from '../src/server/auth/login-method.ts';
import { consumeRateLimit } from '../src/server/auth/rate-limit.ts';
import { createSession, deleteSessionsOf, hashSessionToken } from '../src/server/auth/session.ts';
import { commonDb, orgDb } from '../src/server/db/index.ts';
import { verifiedOrganizationForTest } from '../src/server/db/testing.ts';
import { implement } from '../src/server/operations/implement.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import { createFakeGithub, FAKE_CLIENT_ID, FAKE_CLIENT_SECRET, quietGithubOptions } from './auth/fake-github.ts';
import { createInvitation, createOrganization, createUser, createWorkspace } from './factories.ts';
import { errorCodeOf, post } from './operations/harness.ts';
import { operatorPing, organizationProfile, provisionalOperations, whoAmI } from './operations/provisional.ts';
import {
  admitElsewhere,
  createLoginPerson,
  createPerson,
  createTarget,
  getOperator,
  testEnv,
  withNewSession,
} from './operations/world.ts';

const app = createApp([...implementedOperations]);
const provisionalApp = createApp(provisionalOperations);
const SESSION_COOKIE = '__Host-sg_session';

async function sessionCount(accountId: string): Promise<number> {
  const db = commonDb(env);
  return (
    await db.rows(
      db.statement((q) => q.selectFrom('sessions').select('token_hash').where('account_id', '=', accountId)),
    )
  ).length;
}

// セッションの Cookie を消す Set-Cookie（Max-Age=0）の行
function clearedCookies(res: Response): string[] {
  return res.headers
    .getSetCookie()
    .filter((line) => line.startsWith(`${SESSION_COOKIE}=`) && line.includes('Max-Age=0'));
}

async function endMemberships(organizationId: string, userId: string): Promise<void> {
  const db = orgDb(env, verifiedOrganizationForTest(organizationId));
  await db.batch([
    db.statement((q) =>
      q
        .updateTable('memberships')
        .set({ left_on: '2026-10-21', left_at: '2026-10-21T00:00:00.000Z' })
        .where('user_id', '=', userId),
    ),
  ]);
}

describe('ログインできる条件を失った人', () => {
  async function memberOf() {
    const organization = await createOrganization();
    const admin = await createPerson({ organization, admin: true });
    const workspace = await createWorkspace(organization, admin.userId!);
    const member = await createPerson({ organization, membership: { workspaceId: workspace.id, role: 'member' } });
    return { organization, workspace, member };
  }

  // #639: 組織を失ってもログインできる条件（アカウントがある）は失われないので、セッションも Cookie も消さない
  test('入れる組織が1つも無くなった人も、組織の外の操作は 200 で、セッションは消えず、Cookie を消す Set-Cookie も出ない', async () => {
    const { organization, member } = await memberOf();
    const second = await withNewSession(member);
    expect((await post(app, me, { token: member.token })).status).toBe(200);

    await endMemberships(organization.id, member.userId!);
    const res = await post(app, me, { token: member.token });
    expect(res.status).toBe(200);
    expect(clearedCookies(res)).toEqual([]);
    expect(await sessionCount(member.accountId)).toBe(2);
    expect((await post(app, me, { token: second.token })).status).toBe(200);
    const listed = await post(app, myOrganizations, { token: member.token });
    expect(listed.status).toBe(200);
    expect(await listed.json()).toMatchObject({ organizations: [], invitations: [], operator: false });
  });

  test('組織の中の操作は、どの組織にも入れなくなっていても 404 のままで、セッションも Cookie も残す', async () => {
    const { organization, member } = await memberOf();
    const target = await createTarget();
    await endMemberships(organization.id, member.userId!);

    for (const slug of [target.slug, organization.slug]) {
      const lost = await post(provisionalApp, organizationProfile, { slug, token: member.token });
      expect(lost.status, slug).toBe(404);
      expect(await errorCodeOf(lost)).toBe('not_found');
      expect(clearedCookies(lost), slug).toEqual([]);
    }
    expect(await sessionCount(member.accountId)).toBe(1);
  });

  test('停止した組織だけの人、無効にされた人、承諾待ちの招待がある人、運用者の、どのセッションも残る', async () => {
    const suspendedOrg = await createOrganization();
    const suspendedAdmin = await createPerson({ organization: suspendedOrg, admin: true });
    const disabledOrg = await createOrganization();
    const disabledAdmin = await createPerson({ organization: disabledOrg, admin: true, disabled: true });
    const common = commonDb(env);
    await common.batch([
      common.statement((q) =>
        q
          .updateTable('organizations')
          .set({ suspended_at: '2026-10-22T00:00:00.000Z' })
          .where('id', '=', suspendedOrg.id),
      ),
    ]);

    const target = await createTarget();
    const invitee = target.invitee;
    const operator = await withNewSession(await getOperator());

    for (const person of [suspendedAdmin, disabledAdmin, invitee, operator, target.admin]) {
      const res = await post(app, me, { token: person.token });
      expect(res.status, person.accountId).toBe(200);
      expect(clearedCookies(res)).toEqual([]);
      expect(await sessionCount(person.accountId)).toBeGreaterThanOrEqual(1);
    }
  });

  test('停止した組織にしか入れない人も、無効にされた人も、組織の外の操作は 200 で、401 の理由（details.reason）は出ない', async () => {
    const suspendedOrg = await createOrganization({ suspended_at: '2026-10-22T00:00:00.000Z' });
    const suspendedAdmin = await createPerson({ organization: suspendedOrg, admin: true });
    const disabledAdmin = await createPerson({
      organization: await createOrganization(),
      admin: true,
      disabled: true,
    });

    for (const person of [suspendedAdmin, disabledAdmin]) {
      const res = await post(app, myOrganizations, { token: person.token });
      expect(res.status).toBe(200);
      expect(JSON.stringify(await res.json())).not.toContain('"reason"');
    }
  });

  test('停止した組織の中の操作は、ほかに入れる組織が無い人にも 403 organization_suspended で、セッションも Cookie も残す', async () => {
    const suspendedOrg = await createOrganization({ suspended_at: '2026-10-22T00:00:00.000Z' });
    const only = await createPerson({ organization: suspendedOrg, admin: true });
    const second = await withNewSession(only);
    const stayer = await admitElsewhere(await createPerson({ organization: suspendedOrg, admin: true }));
    const call = (token: string) => post(provisionalApp, organizationProfile, { slug: suspendedOrg.slug, token });

    for (const person of [only, second, stayer]) {
      const res = await call(person.token);
      expect(res.status).toBe(403);
      expect(await errorCodeOf(res)).toBe('organization_suspended');
      expect(clearedCookies(res)).toEqual([]);
    }
    expect(await sessionCount(only.accountId)).toBe(2);
    expect(await sessionCount(stayer.accountId)).toBe(1);
    expect((await post(app, me, { token: only.token })).status).toBe(200);
  });

  test('停止した組織の、入れない人（無効にされた人、所属も招待も無い人）は 404 で、セッションは残る', async () => {
    const suspendedOrg = await createOrganization({ suspended_at: '2026-10-22T00:00:00.000Z' });
    const disabled = await createPerson({ organization: suspendedOrg, admin: true, disabled: true });
    const idle = await createPerson({ organization: suspendedOrg });
    const stranger = await createPerson();
    for (const person of [disabled, idle, stranger]) {
      const res = await post(provisionalApp, organizationProfile, { slug: suspendedOrg.slug, token: person.token });
      expect(res.status).toBe(404);
      expect(await errorCodeOf(res)).toBe('not_found');
      expect(clearedCookies(res)).toEqual([]);
      expect(await sessionCount(person.accountId)).toBe(1);
    }
  });

  test('停止した組織への 403 の操作のログに、組織の ID が付く', async () => {
    const suspendedOrg = await createOrganization({ suspended_at: '2026-10-22T00:00:00.000Z' });
    const stayer = await admitElsewhere(await createPerson({ organization: suspendedOrg, admin: true }));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await post(provisionalApp, organizationProfile, { slug: suspendedOrg.slug, token: stayer.token });
    const lines = log.mock.calls.map((call) => JSON.parse(String(call[0])));
    expect(lines).toMatchObject([{ code: 'organization_suspended', status: 403, organizationId: suspendedOrg.id }]);
    log.mockRestore();
  });

  test('運用者の一覧から外れ、入れる組織も無い人も、200 でセッションは残る（運用者ではなくなる）', async () => {
    const operator = await withNewSession(await getOperator());
    const removed: Env = Object.assign({}, testEnv, { OPERATOR_LOGIN_IDS: 'github:9000000000000002' });
    const before = await sessionCount(operator.accountId);
    const res = await post(app, myOrganizations, { token: operator.token, env: removed });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ operator: false });
    expect(await sessionCount(operator.accountId)).toBe(before);
  });

  test('アカウントに結ばれる前の指名の行だけを持つ人は、組織の一覧に数えず、セッションは残る', async () => {
    const organization = await createOrganization();
    const person = await createPerson();
    const second = await withNewSession(person);
    await createUser(organization, {
      account_id: null,
      login_provider: person.login.provider,
      login_subject: person.login.subject,
      is_admin: 1,
    });
    // 組織の枠は account_id で引くので入れない（一覧にも出ない）。もう一度ログインすれば結ばれる（test/login.test.ts）
    expect(await sessionCount(person.accountId)).toBe(2);
    const res = await post(app, myOrganizations, { token: person.token });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ organizations: [], invitations: [] });
    expect(await sessionCount(person.accountId)).toBe(2);
    expect((await post(app, me, { token: second.token })).status).toBe(200);
    const inside = await post(provisionalApp, organizationProfile, { slug: organization.slug, token: person.token });
    expect(inside.status).toBe(404);
  });

  test('運用者の権限の操作を、入れる組織を失った非運用者が呼ぶと、入れる組織のある非運用者と同じ 403 で、セッションは残る', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const lost = await createPerson();
    const res = await post(provisionalApp, operatorPing, { token: lost.token });
    expect(res.status).toBe(403);
    expect(await errorCodeOf(res)).toBe('forbidden');
    expect(await sessionCount(lost.accountId)).toBe(1);

    // 入れる組織のある非運用者も、これまでどおり 403。運用者は通る
    const member = await createLoginPerson();
    const forbidden = await post(provisionalApp, operatorPing, { token: member.token });
    expect(forbidden.status).toBe(403);
    expect(await errorCodeOf(forbidden)).toBe('forbidden');
    expect(await sessionCount(member.accountId)).toBe(1);
    const operator = await withNewSession(await getOperator());
    expect((await post(provisionalApp, operatorPing, { token: operator.token })).status).toBe(200);
  });

  describe('同じ応答のセッションの Set-Cookie', () => {
    const staleSession = { last_used_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString() };
    const sessionCookies = (res: Response) =>
      res.headers.getSetCookie().filter((line) => line.startsWith(`${SESSION_COOKIE}=`));

    test('期限を延ばす古いセッションで、入れる組織を失った人が呼ぶと、期限を延ばす1本だけになる（消さない）', async () => {
      const lost = await createPerson({ sessionOverrides: staleSession });
      const res = await post(app, me, { token: lost.token });
      expect(res.status).toBe(200);
      const cookies = sessionCookies(res);
      expect(cookies).toHaveLength(1);
      expect(cookies[0]).toContain(`${SESSION_COOKIE}=${lost.token}`);
      expect(cookies[0]).toContain('Max-Age=2592000');
    });

    test('期限を延ばす古いセッションのログアウトも、消す1本だけになる', async () => {
      const person = await createLoginPerson({ sessionOverrides: staleSession });
      const res = await post(app, logout, { token: person.token });
      expect(res.status).toBe(200);
      const cookies = sessionCookies(res);
      expect(cookies).toHaveLength(1);
      expect(cookies[0]).toContain('Max-Age=0');
    });

    test('どの組織にも入れない人が組織の中の操作を呼んだ 404 でも、期限を延ばす1本だけになる（消さない）', async () => {
      const target = await createTarget();
      const lost = await createPerson({ sessionOverrides: staleSession });
      const res = await post(provisionalApp, organizationProfile, { slug: target.slug, token: lost.token });
      expect(res.status).toBe(404);
      const cookies = sessionCookies(res);
      expect(cookies).toHaveLength(1);
      expect(cookies[0]).toContain('Max-Age=2592000');
    });

    test('停止した組織にしか入れない人の 403 でも、期限を延ばす1本だけになる（消さない）', async () => {
      const suspendedOrg = await createOrganization({ suspended_at: '2026-10-22T00:00:00.000Z' });
      const only = await createPerson({ organization: suspendedOrg, admin: true, sessionOverrides: staleSession });
      const res = await post(provisionalApp, organizationProfile, { slug: suspendedOrg.slug, token: only.token });
      expect(res.status).toBe(403);
      const cookies = sessionCookies(res);
      expect(cookies).toHaveLength(1);
      expect(cookies[0]).toContain('Max-Age=2592000');
    });

    test('消さない応答では、期限を延ばす1本だけが付く（失敗の応答にも付く）', async () => {
      const person = await createLoginPerson({ sessionOverrides: staleSession });
      const ok = await post(app, me, { token: person.token });
      expect(ok.status).toBe(200);
      expect(sessionCookies(ok)).toHaveLength(1);
      expect(sessionCookies(ok)[0]).toContain(`${SESSION_COOKIE}=${person.token}`);
      expect(sessionCookies(ok)[0]).toContain('Max-Age=2592000');

      // 同じ人が、別の組織の slug を呼んだ失敗（404）の応答にも、期限を延ばす Cookie が付く
      const target = await createTarget();
      const stale = await createLoginPerson({ sessionOverrides: staleSession });
      const notFound = await post(provisionalApp, organizationProfile, { slug: target.slug, token: stale.token });
      expect(notFound.status).toBe(404);
      expect(sessionCookies(notFound)).toHaveLength(1);
      expect(sessionCookies(notFound)[0]).toContain('Max-Age=2592000');
    });
  });

  test('招待の取り消しだけで入れていた人も、承諾待ちが無くなった後に 200 で、セッションは残る', async () => {
    const organization = await createOrganization();
    const admin = await createPerson({ organization, admin: true });
    const workspace = await createWorkspace(organization, admin.userId!);
    const person = await createPerson();
    await createInvitation(organization, workspace.id, admin.userId!, person.login, { status: 'revoked' });
    expect((await post(app, me, { token: person.token })).status).toBe(200);
    expect(await sessionCount(person.accountId)).toBe(1);
  });

  test('組織の外の操作（me、whoAmI）は、入れる組織を失った人にも判定せずに通り、logout は今のセッションだけを消す', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    // 入れる組織を失った人（組織に属さず、招待も無く、運用者でもない）
    const lost = async () => {
      const person = await createPerson();
      return { person, second: await withNewSession(person) };
    };

    for (const [operationApp, definition] of [
      [app, me],
      [provisionalApp, whoAmI],
    ] as const) {
      const checked = await lost();
      const res = await post(operationApp, definition, { token: checked.person.token });
      expect(res.status, definition.name).toBe(200);
      expect(await sessionCount(checked.person.accountId), definition.name).toBe(2);
    }

    const leaving = await lost();
    const res = await post(app, logout, { token: leaving.person.token });
    expect(res.status).toBe(200);
    expect(await sessionCount(leaving.person.accountId)).toBe(1);
    expect((await post(app, me, { token: leaving.second.token })).status).toBe(200);
  });

  test('logout の定義は skipsLoginAccess を持たない（#639 で項目ごと消す）', () => {
    expect(Object.hasOwn(logout, 'skipsLoginAccess')).toBe(false);
  });

  test('createSession の作成の時刻は挿入の直前で、期限だけが渡した時刻から30日', async () => {
    const person = await createPerson();
    const before = Date.now();
    const given = new Date(before - 60 * 60 * 1000);
    const token = await createSession(env, person.accountId, given, undefined);
    const after = Date.now();
    const hash = await hashSessionToken(token);
    const db = commonDb(env);
    const row = await db.first(
      db.statement((q) => q.selectFrom('sessions').selectAll().where('token_hash', '=', hash)),
    );
    // 作成の時刻は、渡した時刻（1時間前）でなく、挿入の直前の今
    expect(Date.parse(row!.created_at)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(row!.created_at)).toBeLessThanOrEqual(after);
    expect(row!.last_used_at).toBe(row!.created_at);
    // 期限だけは、渡した時刻から30日
    expect(Date.parse(row!.expires_at)).toBe(given.getTime() + 30 * 24 * 60 * 60 * 1000);
  });

  test('消すのは判定した時刻までに作られたセッションだけ。判定の後に作られたものは残す', async () => {
    const person = await createPerson();
    const checkedAt = new Date('2026-10-25T00:00:00.000Z');
    const before = await withNewSession(person);
    const after = await withNewSession(person);
    const db = commonDb(env);
    const setCreatedAt = async (token: string, createdAt: string) => {
      const hash = await hashSessionToken(token);
      await db.batch([
        db.statement((q) => q.updateTable('sessions').set({ created_at: createdAt }).where('token_hash', '=', hash)),
      ]);
    };
    await setCreatedAt(before.token, '2026-10-24T23:59:59.999Z');
    await setCreatedAt(after.token, '2026-10-25T00:00:00.001Z');
    // createPerson の最初のセッションは作った時刻が今（判定より後）
    await setCreatedAt(person.token, '2026-10-25T00:00:00.000Z');

    await deleteSessionsOf(db, person.accountId, checkedAt);
    const rows = await db.rows(
      db.statement((q) => q.selectFrom('sessions').select('token_hash').where('account_id', '=', person.accountId)),
    );
    expect(rows.map((row) => row.token_hash)).toEqual([await hashSessionToken(after.token)]);
  });
});

describe('操作の回数の上限', () => {
  const limited = defineOperation({
    name: 'limited-ping',
    description: '回数の上限を確かめる',
    mode: 'write',
    permission: 'login',
    input: z.object({}),
    output: z.object({ ok: z.literal(true) }),
    rateLimit: { max: 2, windowSeconds: 60 },
  });
  const limitedInOrganization = defineOperation({
    name: 'limited-organization-ping',
    description: '組織の中の操作の回数の上限を確かめる',
    mode: 'write',
    permission: 'organization',
    input: z.object({}),
    output: z.object({ ok: z.literal(true) }),
    rateLimit: { max: 1, windowSeconds: 60 },
  });
  const limitedApp = createApp([
    implement(limited, async () => ({ ok: true as const })),
    implement(limitedInOrganization, async () => ({ ok: true as const })),
  ]);

  test('アカウントごとに数え、超えたら 429 の rate_limited。処理は動かない', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const a = await createLoginPerson();
    const b = await createLoginPerson();
    expect((await post(limitedApp, limited, { token: a.token })).status).toBe(200);
    expect((await post(limitedApp, limited, { token: a.token })).status).toBe(200);
    const over = await post(limitedApp, limited, { token: a.token });
    expect(over.status).toBe(429);
    expect(await errorCodeOf(over)).toBe('rate_limited');
    // ほかのアカウントは数えない
    expect((await post(limitedApp, limited, { token: b.token })).status).toBe(200);
  });

  test('窓を過ぎれば数え直す', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const a = await createLoginPerson();
    for (let i = 0; i < 2; i++) await post(limitedApp, limited, { token: a.token });
    expect((await post(limitedApp, limited, { token: a.token })).status).toBe(429);
    const db = commonDb(env);
    await db.batch([
      db.statement((q) =>
        q
          .updateTable('rate_limits')
          .set({ window_start_at: new Date(Date.now() - 61 * 1000).toISOString() })
          .where('key', '=', `operation:limited-ping:${a.accountId}`),
      ),
    ]);
    expect((await post(limitedApp, limited, { token: a.token })).status).toBe(200);
  });

  test('組織の中の操作も数える。権限の無い呼び出しと入れない呼び出しは数えない', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const target = await createTarget();
    const other = await createTarget();
    expect(
      (await post(limitedApp, limitedInOrganization, { slug: target.slug, token: other.admin.token })).status,
    ).toBe(404);
    expect(
      (await post(limitedApp, limitedInOrganization, { slug: target.slug, token: target.admin.token })).status,
    ).toBe(200);
    const over = await post(limitedApp, limitedInOrganization, { slug: target.slug, token: target.admin.token });
    expect(over.status).toBe(429);
    expect(await errorCodeOf(over)).toBe('rate_limited');
  });

  test('定義の上限は正の整数だけ', () => {
    const bad = (rateLimit: { max: number; windowSeconds: number }) => () => defineOperation({ ...limited, rateLimit });
    expect(bad({ max: 0, windowSeconds: 60 })).toThrow(/rateLimit\.max/);
    expect(bad({ max: 1.5, windowSeconds: 60 })).toThrow(/rateLimit\.max/);
    expect(bad({ max: 1, windowSeconds: 0 })).toThrow(/rateLimit\.windowSeconds/);
  });

  test('consumeRateLimit は窓の中で数え、上限を超えたら false を返し、窓を過ぎれば数え直す', async () => {
    const key = `test:${crypto.randomUUID()}`;
    const policy = { max: 3, windowMs: 1000 };
    const start = new Date('2026-10-25T00:00:00.000Z');
    const results = [];
    for (let i = 0; i < 5; i++)
      results.push(await consumeRateLimit(env, key, policy, new Date(start.getTime() + i * 100)));
    expect(results).toEqual([true, true, true, false, false]);
    // 窓の開始からちょうど windowMs たった呼び出しから、新しい窓
    expect(await consumeRateLimit(env, key, policy, new Date(start.getTime() + 1000))).toBe(true);
    expect(await consumeRateLimit(env, key, policy, new Date(start.getTime() + 1100))).toBe(true);
  });
});

describe('ログインの手段の型（GitHub の招待する人の指し方）', () => {
  const method = (github = createFakeGithub()) => ({
    github,
    method: createGithubLoginMethod(
      { clientId: FAKE_CLIENT_ID, clientSecret: FAKE_CLIENT_SECRET },
      github.fetcher,
      quietGithubOptions,
    ),
  });

  test('ユーザー名をユーザー ID に解決する。ID は10進の文字列で、名前は GitHub が返す綴りにする', async () => {
    const { github, method: login } = method();
    github.addUser({
      id: 583231,
      login: 'octo-cat',
      name: ' Octo Cat ',
      avatar_url: 'https://avatars.githubusercontent.com/u/583231',
    });
    expect(await login.resolveInvitee('Octo-Cat')).toEqual({
      kind: 'found',
      invitee: {
        subject: '583231',
        loginName: 'octo-cat',
        displayName: 'Octo Cat',
        avatarUrl: 'https://avatars.githubusercontent.com/u/583231',
      },
    });
    expect(github.calls.at(-1)?.authorization).toBe(`Basic ${btoa(`${FAKE_CLIENT_ID}:${FAKE_CLIENT_SECRET}`)}`);
  });

  test('表示名が無い、アバターが GitHub のホストでない、は null で返す', async () => {
    const { github, method: login } = method();
    github.addUser({ id: 583232, login: 'plain-cat', name: null, avatar_url: 'https://evil.example/a.png' });
    expect(await login.resolveInvitee('plain-cat')).toEqual({
      kind: 'found',
      invitee: { subject: '583232', loginName: 'plain-cat', displayName: null, avatarUrl: null },
    });
  });

  test('表示名の制御文字、双方向の制御、ゼロ幅スペース、BOM は取り除き、取り除いて空になれば null', async () => {
    const { github, method: login } = method();
    const [rlo, lri, zwsp, bom] = [0x202e, 0x2066, 0x200b, 0xfeff].map((code) => String.fromCodePoint(code));
    github.addUser({ id: 583233, login: 'bidi-cat', name: `星野${rlo}${lri}${zwsp}${bom} 澪\u0007` });
    github.addUser({ id: 583234, login: 'blank-cat', name: `${zwsp}${rlo}${bom}` });
    expect(await login.resolveInvitee('bidi-cat')).toMatchObject({
      kind: 'found',
      invitee: { displayName: '星野 澪' },
    });
    expect(await login.resolveInvitee('blank-cat')).toMatchObject({
      kind: 'found',
      invitee: { displayName: null },
    });
  });

  test('絵文字の結合（ZWJ）、ZWNJ、方向の印（LRM、RLM）は、正しい名前に使うので残す', async () => {
    const { github, method: login } = method();
    const [zwj, zwnj, lrm, rlm] = [0x200d, 0x200c, 0x200e, 0x200f].map((code) => String.fromCodePoint(code));
    const name = `👩${zwj}💻 Aki ${zwnj}A${lrm}B${rlm}`;
    github.addUser({ id: 583235, login: 'emoji-cat', name });
    expect(await login.resolveInvitee('emoji-cat')).toMatchObject({
      kind: 'found',
      invitee: { displayName: name.trim() },
    });
  });

  test('見えない演算子（U+2060〜2064）と行の区切り（U+2028、U+2029）も取り除き、ALM（U+061C）は残す', async () => {
    const { github, method: login } = method();
    const chars = (...codePoints: number[]) => String.fromCodePoint(...codePoints);
    github.addUser({
      id: 583237,
      login: 'invisible-cat',
      name: `星野${chars(0x2060, 0x2062, 0x2064, 0x2028, 0x2029)}澪${chars(0x61c)}`,
    });
    expect(await login.resolveInvitee('invisible-cat')).toMatchObject({
      kind: 'found',
      invitee: { displayName: `星野澪${chars(0x61c)}` },
    });
  });

  test('表示名の長さは、コードポイントで200字に切り、絵文字を途中で割らない', async () => {
    const { github, method: login } = method();
    github.addUser({ id: 583236, login: 'long-cat', name: '😀'.repeat(250) });
    const result = await login.resolveInvitee('long-cat');
    expect(result.kind).toBe('found');
    if (result.kind === 'found') expect(result.invitee.displayName).toBe('😀'.repeat(200));
  });

  test('いないユーザー名は not_found', async () => {
    const { method: login } = method();
    expect(await login.resolveInvitee('nobody-here')).toEqual({ kind: 'not_found' });
  });

  test.each(['Organization', 'Bot'])(
    '個人のアカウントでない（type が %s）相手は、not_found と分けて not_a_user で返す',
    async (type) => {
      const { github, method: login } = method();
      github.addUser({ id: 9001, login: 'acme-corp', type });
      expect(await login.resolveInvitee('acme-corp')).toEqual({ kind: 'not_a_user' });
    },
  );

  test('type が無い応答は、想定と違う応答として失敗で投げる', async () => {
    const noType = createGithubLoginMethod(
      { clientId: FAKE_CLIENT_ID, clientSecret: FAKE_CLIENT_SECRET },
      async () => new Response(JSON.stringify({ id: 1, login: 'octo-cat' }), { status: 200 }),
      quietGithubOptions,
    );
    await expect(noType.resolveInvitee('octo-cat')).rejects.toBeInstanceOf(LoginMethodError);
  });

  test.each(['', '-leading', 'trailing-', 'dou--ble', 'a'.repeat(40), '../etc', 'a b', 'ユーザー'])(
    'GitHub のユーザー名の形でない %j は、GitHub に問い合わせずに not_found',
    async (name) => {
      const { github, method: login } = method();
      expect(await login.resolveInvitee(name)).toEqual({ kind: 'not_found' });
      expect(github.calls).toHaveLength(0);
    },
  );

  test.each(['bad name!', 'octo<script>', 'a'.repeat(81), '', null])(
    '解決の応答の login が形に合わない（%j）なら、固定の理由で失敗として投げ、値は出さない',
    async (login) => {
      const { github, method: method_ } = method();
      github.addUser({ id: 583231, login: login as string }, 'octo-cat');
      const error = await method_.resolveInvitee('octo-cat').catch((err: unknown) => err);
      expect(error).toBeInstanceOf(LoginMethodError);
      expect((error as LoginMethodError).failure).toBe('unavailable');
      expect((error as LoginMethodError).message).toBe('GitHub のログイン名がユーザー名の形に合わない');
    },
  );

  test('EMU のように `_` を含むログイン名は解決できる', async () => {
    const { github, method: method_ } = method();
    github.addUser({ id: 77, login: 'octo_acme-corp' }, 'octo_acme-corp'.replaceAll('_', '-'));
    expect(await method_.resolveInvitee('octo-acme-corp')).toMatchObject({
      kind: 'found',
      invitee: { subject: '77', loginName: 'octo_acme-corp' },
    });
  });

  test('GitHub が 5xx を返したら、見つからないのではなく失敗として投げる', async () => {
    const failing = createGithubLoginMethod(
      { clientId: FAKE_CLIENT_ID, clientSecret: FAKE_CLIENT_SECRET },
      async () => new Response('x', { status: 502 }),
      quietGithubOptions,
    );
    await expect(failing.resolveInvitee('octo-cat')).rejects.toBeInstanceOf(LoginMethodError);
  });

  test('認可の URL は固定の GitHub のエンドポイントで、スコープは read:user だけ', () => {
    const { method: login } = method();
    const url = new URL(
      login.authorizeUrl({ state: 's', codeChallenge: 'c', redirectUri: 'https://example.test/cb', nonce: null }),
    );
    expect(url.origin + url.pathname).toBe('https://github.com/login/oauth/authorize');
    expect(url.searchParams.get('scope')).toBe('read:user');
  });
});
