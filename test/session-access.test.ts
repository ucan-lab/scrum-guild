// ログインできる条件を失った人のセッション（docs/data-model.md の「書き込みの単位」の失敗の扱い）と、
// 操作の回数の上限（定義の rateLimit）、ログインの手段の型（招待する人の指し方）
import { env } from 'cloudflare:workers';
import { describe, expect, test, vi } from 'vitest';
import { z } from 'zod';
import { defineOperation } from '../src/shared/operations/define.ts';
import { logout, me } from '../src/shared/operations/session/index.ts';
import { createApp } from '../src/server/app.ts';
import { createGithubLoginMethod } from '../src/server/auth/github.ts';
import { LoginMethodError } from '../src/server/auth/login-method.ts';
import { consumeRateLimit } from '../src/server/auth/rate-limit.ts';
import { createSession, deleteSessionsOf, hashSessionToken } from '../src/server/auth/session.ts';
import { commonDb, orgDb } from '../src/server/db/index.ts';
import { verifiedOrganizationForTest } from '../src/server/db/testing.ts';
import { implement, type ImplementedOperation } from '../src/server/operations/implement.ts';
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

  test('入れる組織が1つも無くなった人は、次のリクエストでセッションをすべて消され、Cookie も消えて 401', async () => {
    const { organization, member } = await memberOf();
    const second = await withNewSession(member);
    expect((await post(app, me, { token: member.token })).status).toBe(200);

    await endMemberships(organization.id, member.userId!);
    const res = await post(app, me, { token: member.token });
    expect(res.status).toBe(401);
    expect(await errorCodeOf(res)).toBe('unauthenticated');
    expect(res.headers.getSetCookie().find((line) => line.startsWith(`${SESSION_COOKIE}=`))).toContain('Max-Age=0');
    expect(await sessionCount(member.accountId)).toBe(0);
    expect((await post(app, me, { token: second.token })).status).toBe(401);
  });

  test('組織の中の操作でも、どの組織にも入れなくなっていれば 401 で消し、ほかの組織に入れるなら 404 のまま残す', async () => {
    const { organization, member } = await memberOf();
    const stayer = await admitElsewhere(await createPerson());
    const target = await createTarget();
    await endMemberships(organization.id, member.userId!);

    const lost = await post(provisionalApp, organizationProfile, { slug: target.slug, token: member.token });
    expect(lost.status).toBe(401);
    expect(await sessionCount(member.accountId)).toBe(0);

    const other = await post(provisionalApp, organizationProfile, { slug: target.slug, token: stayer.token });
    expect(other.status).toBe(404);
    expect(await sessionCount(stayer.accountId)).toBe(1);
  });

  test('停止した組織だけの人、無効にされた人も同じ。承諾待ちの招待がある人と、運用者は残る', async () => {
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

    for (const person of [suspendedAdmin, disabledAdmin]) {
      expect((await post(app, me, { token: person.token })).status, 'lost').toBe(401);
      expect(await sessionCount(person.accountId)).toBe(0);
    }
    for (const person of [invitee, operator, target.admin]) {
      expect((await post(app, me, { token: person.token })).status, 'kept').toBe(200);
    }
  });

  test('運用者の一覧から外れ、入れる組織も無い人は 401 になる', async () => {
    const operator = await withNewSession(await getOperator());
    const removed: Env = Object.assign({}, testEnv, { OPERATOR_LOGIN_IDS: 'github:9000000000000002' });
    const res = await post(app, me, { token: operator.token, env: removed });
    expect(res.status).toBe(401);
    expect(await sessionCount(operator.accountId)).toBe(0);
  });

  test('アカウントに結ばれる前の指名の行だけを持つ人は、セッションの判定では数えず、401 でセッションが消える', async () => {
    const organization = await createOrganization();
    const person = await createPerson();
    const second = await withNewSession(person);
    await createUser(organization, {
      account_id: null,
      login_provider: person.login.provider,
      login_subject: person.login.subject,
      is_admin: 1,
    });
    // 組織の枠は account_id で引くので入れない。セッションの判定も同じ読み取りで、数えない。
    // 数えると、どこにも入れないまま、セッションが30日以上続く。もう一度ログインすれば結ばれる（test/login.test.ts）
    expect(await sessionCount(person.accountId)).toBe(2);
    const res = await post(app, me, { token: person.token });
    expect(res.status).toBe(401);
    expect(await errorCodeOf(res)).toBe('unauthenticated');
    expect(await sessionCount(person.accountId)).toBe(0);
    expect((await post(app, me, { token: second.token })).status).toBe(401);
  });

  test('運用者の権限の操作を、入れる組織を失った非運用者が呼ぶと、403 でなく 401 でセッションが消える', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const lost = await createPerson();
    const res = await post(provisionalApp, operatorPing, { token: lost.token });
    expect(res.status).toBe(401);
    expect(await errorCodeOf(res)).toBe('unauthenticated');
    expect(await sessionCount(lost.accountId)).toBe(0);

    // 入れる組織のある非運用者は、これまでどおり 403。運用者は通る
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

    test('期限を延ばす古いセッションで、入れる組織を失った人が呼ぶと、消す1本だけになる', async () => {
      const lost = await createPerson({ sessionOverrides: staleSession });
      const res = await post(app, me, { token: lost.token });
      expect(res.status).toBe(401);
      const cookies = sessionCookies(res);
      expect(cookies).toHaveLength(1);
      expect(cookies[0]).toContain('Max-Age=0');
      expect(cookies[0]).not.toContain(lost.token);
    });

    test('期限を延ばす古いセッションのログアウトも、消す1本だけになる', async () => {
      const person = await createLoginPerson({ sessionOverrides: staleSession });
      const res = await post(app, logout, { token: person.token });
      expect(res.status).toBe(200);
      const cookies = sessionCookies(res);
      expect(cookies).toHaveLength(1);
      expect(cookies[0]).toContain('Max-Age=0');
    });

    test('組織に入れなかった組織の中の操作でも、消す1本だけになる', async () => {
      const target = await createTarget();
      const lost = await createPerson({ sessionOverrides: staleSession });
      const res = await post(provisionalApp, organizationProfile, { slug: target.slug, token: lost.token });
      expect(res.status).toBe(401);
      const cookies = sessionCookies(res);
      expect(cookies).toHaveLength(1);
      expect(cookies[0]).toContain('Max-Age=0');
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

  test('招待の取り消しだけで入れていた人は、承諾待ちが無くなれば 401', async () => {
    const organization = await createOrganization();
    const admin = await createPerson({ organization, admin: true });
    const workspace = await createWorkspace(organization, admin.userId!);
    const person = await createPerson();
    await createInvitation(organization, workspace.id, admin.userId!, person.login, { status: 'revoked' });
    expect((await post(app, me, { token: person.token })).status).toBe(401);
  });

  test('組織の外の操作は既定で判定する。skipsLoginAccess を付けた操作（logout）だけ判定しない', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    // 入れる組織を失った人（組織に属さず、招待も無く、運用者でもない）
    const lost = async () => {
      const person = await createPerson();
      return { person, second: await withNewSession(person) };
    };
    const skipping = defineOperation({
      name: 'skipping-ping',
      description: '判定しない組織の外の操作',
      mode: 'read',
      permission: 'login',
      skipsLoginAccess: true,
      input: z.object({}),
      output: z.object({ ok: z.literal(true) }),
    });
    const skippingApp = createApp([implement(skipping, async () => ({ ok: true as const }))]);

    // 何も付けない操作（me、whoAmI）は、全部のセッションを消して 401
    for (const [operationApp, definition] of [
      [app, me],
      [provisionalApp, whoAmI],
    ] as const) {
      const checked = await lost();
      const res = await post(operationApp, definition, { token: checked.person.token });
      expect(res.status, definition.name).toBe(401);
      expect(await sessionCount(checked.person.accountId), definition.name).toBe(0);
    }

    // skipsLoginAccess を付けた操作は、判定せずに通り、セッションも消えない
    const skipped = await lost();
    expect((await post(skippingApp, skipping, { token: skipped.person.token })).status).toBe(200);
    expect(await sessionCount(skipped.person.accountId)).toBe(2);

    // logout は、今のセッションだけを消す（判定で全部を消すのではない）
    const leaving = await lost();
    const res = await post(app, logout, { token: leaving.person.token });
    expect(res.status).toBe(200);
    expect(await sessionCount(leaving.person.accountId)).toBe(1);

    // 運用者と、入れる組織のある人は、判定を通る
    const operator = await withNewSession(await getOperator());
    expect((await post(app, me, { token: operator.token })).status).toBe(200);
    expect((await post(provisionalApp, whoAmI, { token: (await createLoginPerson()).token })).status).toBe(200);
  });

  test('skipsLoginAccess は組織の外の操作に true だけ付けられる。登録の時に投げる', () => {
    const base = {
      name: 'skips-check',
      description: '登録の時の検査',
      mode: 'read',
      input: z.object({}),
      output: z.object({}),
    } as const;
    const forged = (overrides: Record<string, unknown>) => () =>
      defineOperation({ ...base, permission: 'login', ...overrides } as unknown as Parameters<
        typeof defineOperation
      >[0]);
    expect(forged({ skipsLoginAccess: true })).not.toThrow();
    expect(forged({ skipsLoginAccess: false })).toThrow(/skipsLoginAccess/);
    expect(forged({ skipsLoginAccess: 'yes' })).toThrow(/skipsLoginAccess/);
    for (const permission of ['organization', 'invitee', 'admin']) {
      expect(forged({ permission, skipsLoginAccess: true }), permission).toThrow(/skipsLoginAccess/);
    }
    expect(forged({ permission: 'member', workspace: true, skipsLoginAccess: true })).toThrow(/skipsLoginAccess/);
    // 一覧に登録する関数も落ちる（型を消した定義）
    expect(() =>
      createApp([
        {
          definition: { ...base, permission: 'organization', skipsLoginAccess: true },
          handler: async () => ({}),
        } as unknown as ImplementedOperation,
      ]),
    ).toThrow(/skipsLoginAccess/);
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

  test('表示名の制御文字と書式文字（双方向の制御、ゼロ幅）は取り除き、取り除いて空になれば null', async () => {
    const { github, method: login } = method();
    github.addUser({ id: 583233, login: 'bidi-cat', name: '星野‮​ 澪\u0007' });
    github.addUser({ id: 583234, login: 'blank-cat', name: '​‮' });
    expect(await login.resolveInvitee('bidi-cat')).toMatchObject({
      kind: 'found',
      invitee: { displayName: '星野 澪' },
    });
    expect(await login.resolveInvitee('blank-cat')).toMatchObject({
      kind: 'found',
      invitee: { displayName: null },
    });
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
    const url = new URL(login.authorizeUrl({ state: 's', codeChallenge: 'c', redirectUri: 'https://example.test/cb' }));
    expect(url.origin + url.pathname).toBe('https://github.com/login/oauth/authorize');
    expect(url.searchParams.get('scope')).toBe('read:user');
  });
});
