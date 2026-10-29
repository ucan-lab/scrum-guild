// メンバーの招待の操作（invitee-resolve、invitation-create、invitation-revoke）と、member-list の組織の人数の振る舞い。
// 組織の分離（別の組織のワークスペースは 404）、権限の種類ごとの許可と拒否、閉じたワークスペースへの書き込みの 409 は、
// 一覧を回す test/operation-registry.test.ts も確かめる。GitHub への通信は差し替えた fetch（test/auth/fake-github.ts）に向ける
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  invitationCreate,
  invitationRevoke,
  inviteeResolve,
  memberList,
} from '../src/shared/operations/workspace/index.ts';
import { WAITING_USER_NAME_IN_LOG } from '../src/shared/claim-token.ts';
import { createApp } from '../src/server/app.ts';
import { sha256Hex } from '../src/server/auth/tokens.ts';
import { commonDb, orgDb } from '../src/server/db/index.ts';
import { envWithD1Hooks } from '../src/server/db/testing.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import { createFakeGithub, type FakeGithubUser } from './auth/fake-github.ts';
import { githubUser } from './auth/helpers.ts';
import {
  createInvitation,
  createMembership,
  createUser,
  createWorkspace,
  hash64,
  type OrganizationFixture,
} from './factories.ts';
import { errorCodeOf, post } from './operations/harness.ts';
import { createPerson, createTarget, testEnv, type Person, type Target } from './operations/world.ts';

const github = createFakeGithub();
const app = createApp(implementedOperations, { fetcher: github.fetcher });

afterEach(() => {
  vi.restoreAllMocks();
});

// GitHub のユーザー名の解決で引ける、新しい個人のアカウント
function newUser(overrides: Partial<FakeGithubUser> = {}): FakeGithubUser {
  const user = githubUser(`invitee-${crypto.randomUUID().slice(0, 8)}`, overrides);
  github.addUser(user);
  return user;
}

// 組織に入っている人（Person）を、GitHub のユーザー名で引けるようにする
function asGithubUser(person: Person): FakeGithubUser {
  const user = { id: Number(person.login.subject), login: `person-${person.login.subject}`, name: null };
  github.addUser(user);
  return user;
}

function resolve(target: Target, person: Person, username: string, workspaceId: string = target.workspace.id) {
  return post(app, inviteeResolve, {
    slug: target.slug,
    token: person.token,
    body: { workspace_id: workspaceId, provider: 'github', username },
  });
}

function invite(
  target: Target,
  person: Person,
  user: FakeGithubUser,
  options: { workspaceId?: string; role?: 'leader' | 'member'; loginSubject?: string } = {},
) {
  return post(app, invitationCreate, {
    slug: target.slug,
    token: person.token,
    body: {
      workspace_id: options.workspaceId ?? target.workspace.id,
      provider: 'github',
      username: user.login,
      login_subject: options.loginSubject ?? String(user.id),
      role: options.role ?? 'member',
    },
  });
}

const DAY_MS = 24 * 60 * 60 * 1000;

type GoogleInvited = { invitation_id: string; login_name: string; invite: { url: string; expires_at: string } };

function inviteGoogle(
  target: Target,
  person: Person,
  email: string,
  options: { workspaceId?: string; role?: 'leader' | 'member' } = {},
) {
  return post(app, invitationCreate, {
    slug: target.slug,
    token: person.token,
    body: {
      workspace_id: options.workspaceId ?? target.workspace.id,
      provider: 'google',
      email,
      role: options.role ?? 'member',
    },
  });
}

function revoke(target: Target, person: Person, invitationId: string, workspaceId: string = target.workspace.id) {
  return post(app, invitationRevoke, {
    slug: target.slug,
    token: person.token,
    body: { workspace_id: workspaceId, invitation_id: invitationId },
  });
}

async function seatsOf(target: Target, person: Person = target.admin) {
  const res = await post(app, memberList, {
    slug: target.slug,
    token: person.token,
    body: { workspace_id: target.workspace.id },
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { seats: { used: number; limit: number } | null }).seats;
}

async function setMemberLimit(organization: OrganizationFixture, limit: number): Promise<void> {
  const db = commonDb(env);
  await db.run(
    db.statement((q) => q.updateTable('organizations').set({ member_limit: limit }).where('id', '=', organization.id)),
  );
}

async function invitationRows(organization: OrganizationFixture, workspaceId: string) {
  const db = orgDb(env, organization.verified);
  return db.rows(
    db.statement((q) =>
      q
        .selectFrom('invitations')
        .innerJoin('workspaces', 'workspaces.id', 'invitations.workspace_id')
        .selectAll('invitations')
        .where('workspaces.organization_id', '=', organization.id)
        .where('invitations.workspace_id', '=', workspaceId)
        .orderBy('invitations.created_at')
        .orderBy('invitations.id'),
    ),
  );
}

async function invitationLogs(organization: OrganizationFixture, invitationId: string) {
  const db = orgDb(env, organization.verified);
  return db.rows(
    db.statement((q) =>
      q
        .selectFrom('change_logs')
        .selectAll()
        .where('organization_id', '=', organization.id)
        .where('entity_type', '=', 'invitation')
        .where('entity_id', '=', invitationId),
    ),
  );
}

async function problemCodes(res: Response): Promise<string[]> {
  const body = (await res.json()) as { error: { details?: { code: string }[] } };
  return (body.error.details ?? []).map((detail) => detail.code);
}

describe('invitee-resolve', () => {
  test('リーダーと管理者は、GitHub のユーザー名を ID、ユーザー名、表示名、アバターに解決できる', async () => {
    const target = await createTarget();
    const user = newUser({ name: '朝霧 葵', avatar_url: 'https://avatars.githubusercontent.com/u/1' });
    for (const person of [target.leader, target.admin]) {
      const res = await resolve(target, person, user.login.toUpperCase());
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        login_subject: String(user.id),
        login_name: user.login,
        display_name: '朝霧 葵',
        avatar_url: 'https://avatars.githubusercontent.com/u/1',
        already_counted: false,
      });
    }
  });

  test('すでに組織の人数に数えられている人（別のワークスペースの人、承諾待ちの招待の人、管理者）は already_counted が真', async () => {
    const target = await createTarget();
    for (const person of [target.bystander, target.invitee, target.admin]) {
      const res = await resolve(target, target.leader, asGithubUser(person).login);
      expect(res.status).toBe(200);
      expect(((await res.json()) as { already_counted: boolean }).already_counted).toBe(true);
    }
  });

  test('別の組織のワークスペースは 404 で、GitHub に問い合わせない', async () => {
    const [target, other] = await Promise.all([createTarget(), createTarget()]);
    const before = github.calls.length;
    const res = await resolve(target, target.admin, newUser().login, other.workspace.id);
    expect(res.status).toBe(404);
    expect(await errorCodeOf(res)).toBe('not_found');
    expect(github.calls.length).toBe(before);
  });

  test('一般のメンバーは 403', async () => {
    const target = await createTarget();
    const res = await resolve(target, target.member, newUser().login);
    expect(res.status).toBe(403);
    expect(await errorCodeOf(res)).toBe('forbidden');
  });

  test('見つからない人と個人でないアカウントは 400 の invalid_input で、理由を details の code で分ける', async () => {
    const target = await createTarget();
    const missing = await resolve(target, target.leader, 'no-such-person');
    expect(missing.status).toBe(400);
    expect(await problemCodes(missing)).toEqual(['github_user_not_found']);

    const organization = newUser({ type: 'Organization' });
    const notUser = await resolve(target, target.leader, organization.login);
    expect(notUser.status).toBe(400);
    expect(await problemCodes(notUser)).toEqual(['github_not_a_user']);
  });

  test('GitHub に届かないときは 503 の unavailable で、ログにユーザー名を出さない', async () => {
    const target = await createTarget();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const user = newUser();
    github.failNext.lookup = 'server-error';
    const res = await resolve(target, target.leader, user.login);
    expect(res.status).toBe(503);
    expect(await errorCodeOf(res)).toBe('unavailable');
    const logged = warn.mock.calls.map((call) => String(call[0])).join('\n');
    expect(logged).toContain('"route":"organization"');
    expect(logged).not.toContain(user.login);
  });

  test('アカウントと操作ごとに 10 分に 30 回まで。超えると 429 の rate_limited で、GitHub に問い合わせない', async () => {
    const target = await createTarget();
    const user = newUser();
    for (let i = 0; i < 30; i++) {
      expect((await resolve(target, target.leader, user.login)).status).toBe(200);
    }
    const before = github.calls.length;
    const res = await resolve(target, target.leader, user.login);
    expect(res.status).toBe(429);
    expect(await errorCodeOf(res)).toBe('rate_limited');
    expect(github.calls.length).toBe(before);
    // 別の人の枠は別
    expect((await resolve(target, target.admin, user.login)).status).toBe(200);
  });
});

describe('invitation-create', () => {
  test('リーダーが招待すると、承諾待ちの招待と変更の履歴が入り、承諾待ちの一覧に出る', async () => {
    const target = await createTarget();
    const user = newUser();
    const res = await invite(target, target.leader, user, { role: 'leader' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { invitation_id: string; login_name: string; invite: unknown };
    expect(body.login_name).toBe(user.login);
    // 招待の URL は Google の招待だけ
    expect(body.invite).toBeNull();

    const rows = await invitationRows(target.organization, target.workspace.id);
    const row = rows.find((item) => item.id === body.invitation_id);
    expect(row).toMatchObject({
      login_provider: 'github',
      login_subject: String(user.id),
      login_email: null,
      claim_token_hash: null,
      login_name: user.login,
      role: 'leader',
      invited_by: target.leader.userId,
      status: 'pending',
      responded_at: null,
    });

    const logs = await invitationLogs(target.organization, body.invitation_id);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      workspace_id: target.workspace.id,
      actor_user_id: target.leader.userId,
      action: 'create',
    });
    expect(JSON.parse(logs[0]!.changes_json)).toEqual({
      login_provider: [null, 'github'],
      login_subject: [null, String(user.id)],
      login_name: [null, user.login],
      role: [null, 'leader'],
    });

    const listed = await post(app, memberList, {
      slug: target.slug,
      token: target.leader.token,
      body: { workspace_id: target.workspace.id },
    });
    const invitations = ((await listed.json()) as { invitations: { id: string }[] }).invitations;
    expect(invitations.map((item) => item.id)).toContain(body.invitation_id);
  });

  test('所属していない管理者も招待でき、一般のメンバーは 403 で何も入らない', async () => {
    const target = await createTarget();
    expect((await invite(target, target.admin, newUser())).status).toBe(200);
    const before = await invitationRows(target.organization, target.workspace.id);
    const res = await invite(target, target.member, newUser());
    expect(res.status).toBe(403);
    expect(await errorCodeOf(res)).toBe('forbidden');
    expect(await invitationRows(target.organization, target.workspace.id)).toHaveLength(before.length);
  });

  test('今所属している人は 409 の already_member', async () => {
    const target = await createTarget();
    const res = await invite(target, target.leader, asGithubUser(target.member));
    expect(res.status).toBe(409);
    expect(await errorCodeOf(res)).toBe('already_member');
  });

  test('別のワークスペースに所属している人は招待でき、無効にされた人への招待も断らない', async () => {
    const target = await createTarget();
    expect((await invite(target, target.leader, asGithubUser(target.bystander))).status).toBe(200);
    const disabled = newUser();
    await createUser(target.organization, {
      login_subject: String(disabled.id),
      disabled_at: '2026-10-21T00:00:00.000Z',
    });
    expect((await invite(target, target.leader, disabled)).status).toBe(200);
  });

  test('同じワークスペースに承諾待ちの招待があれば 409 の already_invited。取り消した後と別のワークスペースは招待できる', async () => {
    const target = await createTarget();
    const user = newUser();
    const first = await invite(target, target.leader, user);
    expect(first.status).toBe(200);
    const again = await invite(target, target.admin, user);
    expect(again.status).toBe(409);
    expect(await errorCodeOf(again)).toBe('already_invited');

    expect((await invite(target, target.admin, user, { workspaceId: target.otherWorkspace.id })).status).toBe(200);
    const { invitation_id } = (await first.json()) as { invitation_id: string };
    expect((await revoke(target, target.leader, invitation_id)).status).toBe(200);
    expect((await invite(target, target.leader, user)).status).toBe(200);
  });

  test('確かめた ID と解決し直した ID が違えば 409 の invitee_changed で、何も入らない', async () => {
    const target = await createTarget();
    const user = newUser();
    const before = await invitationRows(target.organization, target.workspace.id);
    const res = await invite(target, target.leader, user, { loginSubject: String(user.id + 1) });
    expect(res.status).toBe(409);
    expect(await errorCodeOf(res)).toBe('invitee_changed');
    expect(await invitationRows(target.organization, target.workspace.id)).toHaveLength(before.length);
  });

  test('解決できない人は 400 の invalid_input、GitHub に届かなければ 503', async () => {
    const target = await createTarget();
    const missing = await invite(target, target.leader, { id: 1, login: 'no-such-person' });
    expect(missing.status).toBe(400);
    expect(await problemCodes(missing)).toEqual(['github_user_not_found']);

    vi.spyOn(console, 'warn').mockImplementation(() => {});
    github.failNext.lookup = 'rate-limited';
    const down = await invite(target, target.leader, newUser());
    expect(down.status).toBe(503);
    expect(await errorCodeOf(down)).toBe('unavailable');
  });

  test('人数が上限以上なら、まだ数えられていない人は 409 の member_limit_reached で、すでに数えられている人は招待できる', async () => {
    const target = await createTarget();
    // 管理者、リーダー、一般、別のワークスペースの人、承諾待ちの招待の人の5人
    expect(await seatsOf(target)).toEqual({ used: 5, limit: 15 });
    await setMemberLimit(target.organization, 5);

    const before = await invitationRows(target.organization, target.workspace.id);
    const full = await invite(target, target.leader, newUser());
    expect(full.status).toBe(409);
    expect(await errorCodeOf(full)).toBe('member_limit_reached');
    expect(await invitationRows(target.organization, target.workspace.id)).toHaveLength(before.length);

    // 別のワークスペースに所属している人と、別のワークスペースに承諾待ちの招待がある人、所属していない管理者
    expect((await invite(target, target.leader, asGithubUser(target.bystander))).status).toBe(200);
    expect(
      (await invite(target, target.admin, asGithubUser(target.invitee), { workspaceId: target.otherWorkspace.id }))
        .status,
    ).toBe(200);
    expect((await invite(target, target.leader, asGithubUser(target.admin))).status).toBe(200);
    expect(await seatsOf(target)).toEqual({ used: 5, limit: 5 });

    // 1人分空けると1人だけ招待でき、次は断る
    await setMemberLimit(target.organization, 6);
    expect((await invite(target, target.leader, newUser())).status).toBe(200);
    expect(await seatsOf(target)).toEqual({ used: 6, limit: 6 });
    expect(await errorCodeOf(await invite(target, target.leader, newUser()))).toBe('member_limit_reached');
  });

  test('アカウントと操作ごとに 10 分に 30 回まで。31 回目は 429 の rate_limited', async () => {
    const target = await createTarget();
    const user = newUser();
    // 1回目だけが招待でき、続きは already_invited で断られるが、どれも回数に数える
    for (let i = 0; i < 30; i++) {
      expect([200, 409]).toContain((await invite(target, target.leader, user)).status);
    }
    const res = await invite(target, target.leader, newUser());
    expect(res.status).toBe(429);
    expect(await errorCodeOf(res)).toBe('rate_limited');
  });

  test('同じ人を同時に招待すると、1件だけ入り、もう片方は 409 の already_invited で、履歴も1行', async () => {
    const target = await createTarget();
    const user = newUser();
    // 先の要求が所属と招待を読んだ直後に、もう片方の要求を最後まで通す
    let raced: Promise<Response> | undefined;
    const racing = envWithD1Hooks(testEnv, {
      afterBatch: async (sqls) => {
        if (raced !== undefined || !sqls.some((sql) => sql.includes('from "invitations"') && sql.includes('limit')))
          return;
        raced = invite(target, target.admin, user);
        await raced;
      },
    });
    const first = await post(app, invitationCreate, {
      slug: target.slug,
      token: target.leader.token,
      env: racing,
      body: {
        workspace_id: target.workspace.id,
        provider: 'github',
        username: user.login,
        login_subject: String(user.id),
        role: 'member',
      },
    });
    const second = await raced!;
    expect(second.status).toBe(200);
    expect(first.status).toBe(409);
    expect(await errorCodeOf(first)).toBe('already_invited');

    const rows = (await invitationRows(target.organization, target.workspace.id)).filter(
      (row) => row.login_subject === String(user.id),
    );
    expect(rows).toHaveLength(1);
    expect(await invitationLogs(target.organization, rows[0]!.id)).toHaveLength(1);
    const db = orgDb(env, target.organization.verified);
    const created = await db.rows(
      db.statement((q) =>
        q
          .selectFrom('change_logs')
          .select('id')
          .where('organization_id', '=', target.organization.id)
          .where('entity_type', '=', 'invitation')
          .where('action', '=', 'create'),
      ),
    );
    // 承諾待ちの招待の人（createTarget）は履歴を持たないので、この招待の1行だけ
    expect(created).toHaveLength(1);
  });

  test('閉じたワークスペースへの招待は 409 の workspace_closed', async () => {
    const target = await createTarget({ closed: true });
    const res = await invite(target, target.admin, newUser());
    expect(res.status).toBe(409);
    expect(await errorCodeOf(res)).toBe('workspace_closed');
  });

  test('別の組織のワークスペースは、存在しないときと同じ 404', async () => {
    const [target, other] = await Promise.all([createTarget(), createTarget()]);
    const res = await invite(target, target.admin, newUser(), { workspaceId: other.workspace.id });
    expect(res.status).toBe(404);
    expect(await errorCodeOf(res)).toBe('not_found');
  });
});

describe('invitation-create（Google）', () => {
  const EMAIL = 'mio.hoshino@example.com';
  // 呼ぶたびに別のメールアドレス（同じテストの中で人を分ける）
  const newEmail = () => `guild-${crypto.randomUUID().slice(0, 8)}@example.com`;

  test('リーダーがメールアドレスで招待すると、そろえたアドレスで待つ招待と記録が入り、応答の本文にだけ招待の URL と14日の期限が入る', async () => {
    const target = await createTarget();
    const res = await inviteGoogle(target, target.leader, `  ${EMAIL.toUpperCase()} `, { role: 'leader' });
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    const body = (await res.json()) as GoogleInvited;
    expect(body.login_name).toBe(EMAIL);
    const url = new URL(body.invite.url);
    expect(url.origin + url.pathname).toBe(`${new URL(env.PUBLIC_ORIGIN).origin}/invite`);
    const claimToken = url.hash.slice(1);
    expect(claimToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    for (const [name, value] of res.headers) {
      expect(value, name).not.toContain(claimToken);
    }
    const lifetime = Date.parse(body.invite.expires_at) - Date.now();
    expect(lifetime).toBeGreaterThan(14 * DAY_MS - 60_000);
    expect(lifetime).toBeLessThanOrEqual(14 * DAY_MS);

    const rows = await invitationRows(target.organization, target.workspace.id);
    const row = rows.find((item) => item.id === body.invitation_id);
    expect(row).toEqual({
      id: body.invitation_id,
      workspace_id: target.workspace.id,
      login_provider: 'google',
      login_subject: null,
      login_email: EMAIL,
      claim_token_hash: await sha256Hex(claimToken),
      claim_expires_at: body.invite.expires_at,
      login_name: EMAIL,
      role: 'leader',
      invited_by: target.leader.userId,
      status: 'pending',
      responded_at: null,
      created_at: expect.any(String),
    });

    // 作成の記録には、メールアドレス、login_subject、秘密を入れない
    const logs = await invitationLogs(target.organization, body.invitation_id);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      workspace_id: target.workspace.id,
      actor_user_id: target.leader.userId,
      action: 'create',
      operator: null,
    });
    expect(JSON.parse(logs[0]!.changes_json)).toEqual({
      login_provider: [null, 'google'],
      login_name: [null, WAITING_USER_NAME_IN_LOG],
      role: [null, 'leader'],
    });

    // 秘密は、どの表にも入らない（ハッシュだけ）。メールアドレスは change_logs に入らない
    const db = orgDb(env, target.organization.verified);
    const stored = JSON.stringify(
      await Promise.all(
        (['invitations', 'change_logs', 'users'] as const).map((table) =>
          db.rows(db.statement((q) => q.selectFrom(table).selectAll())),
        ),
      ),
    );
    expect(stored).not.toContain(claimToken);
    const changeLogs = await db.rows(
      db.statement((q) =>
        q.selectFrom('change_logs').selectAll().where('organization_id', '=', target.organization.id),
      ),
    );
    expect(JSON.stringify(changeLogs)).not.toContain(EMAIL);

    // 承諾待ちの一覧に、手段と期限が出る
    const listed = await post(app, memberList, {
      slug: target.slug,
      token: target.leader.token,
      body: { workspace_id: target.workspace.id },
    });
    const invitations = (
      (await listed.json()) as { invitations: { id: string; login_provider: string; expired: boolean }[] }
    ).invitations;
    expect(invitations.find((item) => item.id === body.invitation_id)).toMatchObject({
      login_provider: 'google',
      expired: false,
    });
  });

  test('形の合わないメールアドレスは 400 の invalid_input（email_invalid）で、何も入らない', async () => {
    const target = await createTarget();
    const before = await invitationRows(target.organization, target.workspace.id);
    for (const email of [
      'mio.hoshino',
      '@example.com',
      'mio@@example.com',
      'mio hoshino@example.com',
      '星野@example.com',
    ]) {
      const res = await inviteGoogle(target, target.leader, email);
      expect(res.status, email).toBe(400);
      expect(await problemCodes(res), email).toEqual(['email_invalid']);
    }
    // 空と長すぎるものは入力の検証で断る
    expect((await inviteGoogle(target, target.leader, '   ')).status).toBe(400);
    expect((await inviteGoogle(target, target.leader, `${'a'.repeat(250)}@example.com`)).status).toBe(400);
    expect(await invitationRows(target.organization, target.workspace.id)).toHaveLength(before.length);
  });

  test('同じメールアドレスで招待し直すと、前の承諾待ちの招待（期限切れも）を取り消して記録を残し、新しい招待だけが待つ。別のアドレスと別のワークスペースの招待は残る', async () => {
    const target = await createTarget();
    const first = (await (await inviteGoogle(target, target.leader, EMAIL)).json()) as GoogleInvited;
    // 期限の過ぎた、同じアドレスの承諾待ち（一意の索引があるので、別のワークスペースに置いてから確かめる）
    const expiredElsewhere = await createInvitation(
      target.organization,
      target.otherWorkspace.id,
      target.admin.userId!,
      { provider: 'google', subject: '' },
      {
        login_subject: null,
        login_email: EMAIL,
        claim_token_hash: hash64(),
        claim_expires_at: '2026-10-01T00:00:00.000Z',
        login_name: EMAIL,
      },
    );
    const other = (await (await inviteGoogle(target, target.leader, newEmail())).json()) as GoogleInvited;

    const again = await inviteGoogle(target, target.admin, EMAIL.toUpperCase(), { role: 'leader' });
    expect(again.status).toBe(200);
    const second = (await again.json()) as GoogleInvited;
    expect(second.invite.url).not.toBe(first.invite.url);

    const rows = await invitationRows(target.organization, target.workspace.id);
    expect(rows.find((row) => row.id === first.invitation_id)).toMatchObject({
      status: 'revoked',
      responded_at: expect.any(String),
    });
    expect(rows.find((row) => row.id === second.invitation_id)).toMatchObject({ status: 'pending', role: 'leader' });
    expect(rows.find((row) => row.id === other.invitation_id)).toMatchObject({ status: 'pending' });
    expect(rows.filter((row) => row.login_email === EMAIL && row.status === 'pending').map((row) => row.id)).toEqual([
      second.invitation_id,
    ]);
    const elsewhere = await invitationRows(target.organization, target.otherWorkspace.id);
    expect(elsewhere.find((row) => row.id === expiredElsewhere.id)).toMatchObject({ status: 'pending' });

    const revokedLogs = await invitationLogs(target.organization, first.invitation_id);
    expect(revokedLogs.map((log) => log.action).sort()).toEqual(['create', 'update']);
    const revokedLog = revokedLogs.find((log) => log.action === 'update');
    expect(revokedLog).toMatchObject({ workspace_id: target.workspace.id, actor_user_id: target.admin.userId });
    expect(JSON.parse(revokedLog!.changes_json)).toEqual({ status: ['pending', 'revoked'] });
    expect(await invitationLogs(target.organization, other.invitation_id)).toHaveLength(1);

    // 期限の過ぎた承諾待ちも、同じワークスペースなら取り消す
    expect((await revoke(target, target.leader, second.invitation_id)).status).toBe(200);
    const expired = await createInvitation(
      target.organization,
      target.workspace.id,
      target.admin.userId!,
      { provider: 'google', subject: '' },
      {
        login_subject: null,
        login_email: EMAIL,
        claim_token_hash: hash64(),
        claim_expires_at: '2026-10-01T00:00:00.000Z',
        login_name: EMAIL,
      },
    );
    expect((await inviteGoogle(target, target.leader, EMAIL)).status).toBe(200);
    expect(
      (await invitationRows(target.organization, target.workspace.id)).find((row) => row.id === expired.id),
    ).toMatchObject({ status: 'revoked' });
  });

  test('同じアドレスへ同時に招待すると、どちらも 200 で、承諾待ちは1件、取り消しは1件、取り消しの記録も1行', async () => {
    const target = await createTarget();
    const [first, second] = await Promise.all([
      inviteGoogle(target, target.leader, EMAIL),
      inviteGoogle(target, target.admin, EMAIL),
    ]);
    expect([first.status, second.status]).toEqual([200, 200]);
    const ids = [
      ((await first.json()) as GoogleInvited).invitation_id,
      ((await second.json()) as GoogleInvited).invitation_id,
    ];
    const rows = (await invitationRows(target.organization, target.workspace.id)).filter(
      (row) => row.login_email === EMAIL,
    );
    expect(rows.map((row) => row.id).sort()).toEqual([...ids].sort());
    expect(rows.map((row) => row.status).sort()).toEqual(['pending', 'revoked']);
    const revoked = rows.find((row) => row.status === 'revoked')!;
    const logs = await invitationLogs(target.organization, revoked.id);
    expect(logs.filter((log) => log.action === 'update')).toHaveLength(1);
    const pending = rows.find((row) => row.status === 'pending')!;
    expect((await invitationLogs(target.organization, pending.id)).map((log) => log.action)).toEqual(['create']);
  });

  test('アカウントと操作ごとに 10 分に 30 回まで（GitHub の招待と同じ枠）。31 回目は 429 の rate_limited で、何も入らない', async () => {
    const target = await createTarget();
    for (let i = 0; i < 30; i++) {
      expect((await inviteGoogle(target, target.leader, EMAIL)).status).toBe(200);
    }
    const before = await invitationRows(target.organization, target.workspace.id);
    const res = await inviteGoogle(target, target.leader, newEmail());
    expect(res.status).toBe(429);
    expect(await errorCodeOf(res)).toBe('rate_limited');
    expect(await invitationRows(target.organization, target.workspace.id)).toHaveLength(before.length);
  });

  test('sub を埋めた後の招待（同じアドレスで結んだもの）は取り消さず、新しい招待を入れる', async () => {
    const target = await createTarget();
    const claimed = await createInvitation(
      target.organization,
      target.workspace.id,
      target.admin.userId!,
      { provider: 'google', subject: `google-sub-${crypto.randomUUID()}` },
      { login_name: EMAIL },
    );
    const res = await inviteGoogle(target, target.leader, EMAIL);
    expect(res.status).toBe(200);
    const rows = await invitationRows(target.organization, target.workspace.id);
    expect(rows.find((row) => row.id === claimed.id)).toMatchObject({ status: 'pending' });
  });

  test('人数が上限以上なら、まだ数えられていないアドレスは 409 の member_limit_reached。同じアドレスの招待し直しは通り、前の招待が期限切れなら断る', async () => {
    const target = await createTarget();
    expect(await seatsOf(target)).toEqual({ used: 5, limit: 15 });
    await setMemberLimit(target.organization, 6);
    const counted = newEmail();
    expect((await inviteGoogle(target, target.leader, counted)).status).toBe(200);
    expect(await seatsOf(target)).toEqual({ used: 6, limit: 6 });

    const before = await invitationRows(target.organization, target.workspace.id);
    const full = await inviteGoogle(target, target.leader, newEmail());
    expect(full.status).toBe(409);
    expect(await errorCodeOf(full)).toBe('member_limit_reached');
    expect(await invitationRows(target.organization, target.workspace.id)).toHaveLength(before.length);

    // 前の招待で数えられているので、上限でも招待し直せる（大文字小文字の違いは同じアドレス）。人数は増えない
    expect((await inviteGoogle(target, target.admin, counted.toUpperCase())).status).toBe(200);
    // 別のワークスペースへの同じアドレスの招待も、同じ人として通る
    expect((await inviteGoogle(target, target.admin, counted, { workspaceId: target.otherWorkspace.id })).status).toBe(
      200,
    );
    expect(await seatsOf(target)).toEqual({ used: 6, limit: 6 });

    // 期限の過ぎた招待しかないアドレスは数えられていないので断る
    const stale = newEmail();
    await createInvitation(
      target.organization,
      target.workspace.id,
      target.admin.userId!,
      { provider: 'google', subject: '' },
      {
        login_subject: null,
        login_email: stale,
        claim_token_hash: hash64(),
        claim_expires_at: '2026-10-01T00:00:00.000Z',
        login_name: stale,
      },
    );
    expect(await errorCodeOf(await inviteGoogle(target, target.leader, stale))).toBe('member_limit_reached');
  });

  test('閉じたワークスペースへの招待は 409 の workspace_closed で、前の招待も取り消さない', async () => {
    const target = await createTarget({ closed: true });
    const waiting = await createInvitation(
      target.organization,
      target.workspace.id,
      target.admin.userId!,
      { provider: 'google', subject: '' },
      {
        login_subject: null,
        login_email: EMAIL,
        claim_token_hash: hash64(),
        claim_expires_at: '2999-01-01T00:00:00.000Z',
        login_name: EMAIL,
      },
    );
    const res = await inviteGoogle(target, target.admin, EMAIL);
    expect(res.status).toBe(409);
    expect(await errorCodeOf(res)).toBe('workspace_closed');
    const rows = await invitationRows(target.organization, target.workspace.id);
    expect(rows.filter((row) => row.login_provider === 'google')).toEqual([
      expect.objectContaining({ id: waiting.id, status: 'pending' }),
    ]);
  });

  test('読んでから書くまでに閉じられたら、何も書かずに 409 の workspace_closed', async () => {
    const target = await createTarget();
    const first = (await (await inviteGoogle(target, target.leader, EMAIL)).json()) as GoogleInvited;
    let closed = false;
    const closing = envWithD1Hooks(testEnv, {
      // 人数を数えた直後（書く前）に閉じる
      afterBatch: async (sqls) => {
        if (closed || !sqls.some((sql) => sql.includes('"i"."claim_expires_at"'))) return;
        closed = true;
        const db = orgDb(env, target.organization.verified);
        await db.run(
          db.statement((q) =>
            q
              .updateTable('workspaces')
              .set({ closed_at: '2026-10-29T00:00:00.000Z' })
              .where('id', '=', target.workspace.id),
          ),
        );
      },
    });
    const res = await post(app, invitationCreate, {
      slug: target.slug,
      token: target.leader.token,
      env: closing,
      body: { workspace_id: target.workspace.id, provider: 'google', email: EMAIL, role: 'member' },
    });
    expect(closed).toBe(true);
    expect(res.status).toBe(409);
    expect(await errorCodeOf(res)).toBe('workspace_closed');
    const rows = (await invitationRows(target.organization, target.workspace.id)).filter(
      (row) => row.login_provider === 'google',
    );
    expect(rows).toEqual([expect.objectContaining({ id: first.invitation_id, status: 'pending' })]);
    expect(await invitationLogs(target.organization, first.invitation_id)).toHaveLength(1);
  });

  test('所属していない管理者も招待でき、一般のメンバーは 403 で何も入らない', async () => {
    const target = await createTarget();
    expect((await inviteGoogle(target, target.admin, newEmail())).status).toBe(200);
    const before = await invitationRows(target.organization, target.workspace.id);
    const res = await inviteGoogle(target, target.member, newEmail());
    expect(res.status).toBe(403);
    expect(await errorCodeOf(res)).toBe('forbidden');
    expect(await invitationRows(target.organization, target.workspace.id)).toHaveLength(before.length);
  });

  test('別の組織のワークスペースは、存在しないときと同じ 404 で、その組織の招待も取り消さない', async () => {
    const [target, other] = await Promise.all([createTarget(), createTarget()]);
    const waiting = (await (await inviteGoogle(other, other.leader, EMAIL)).json()) as GoogleInvited;
    const res = await inviteGoogle(target, target.admin, EMAIL, { workspaceId: other.workspace.id });
    expect(res.status).toBe(404);
    expect(await errorCodeOf(res)).toBe('not_found');
    expect(
      (await invitationRows(other.organization, other.workspace.id)).find((row) => row.id === waiting.invitation_id),
    ).toMatchObject({ status: 'pending' });
  });

  test('ログインに、メールアドレス、秘密、ハッシュを出さない', async () => {
    const lines: string[] = [];
    for (const method of ['log', 'info', 'warn', 'error'] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        lines.push(args.map(String).join(' '));
      });
    }
    const target = await createTarget();
    const body = (await (await inviteGoogle(target, target.leader, EMAIL)).json()) as GoogleInvited;
    await inviteGoogle(target, target.leader, 'not-an-email');
    const claimToken = new URL(body.invite.url).hash.slice(1);
    const logged = lines.join('\n');
    expect(logged).not.toContain(EMAIL);
    expect(logged).not.toContain(claimToken);
    expect(logged).not.toContain(await sha256Hex(claimToken));
    expect(logged).not.toContain('not-an-email');
  });
});

describe('member-list の組織の人数', () => {
  test('リーダーと管理者には人数と上限、一般のメンバーには null', async () => {
    const target = await createTarget();
    expect(await seatsOf(target, target.leader)).toEqual({ used: 5, limit: 15 });
    expect(await seatsOf(target, target.member)).toBeNull();
  });

  test('同じ人は1人。無効にした人、離れた人、期限の過ぎた Google の招待、取り消した招待は数えない', async () => {
    const target = await createTarget();
    const organization = target.organization;
    // 承諾待ちの招待の人を、別のワークスペースにも招待する（1人のまま）
    await createInvitation(organization, target.otherWorkspace.id, target.admin.userId!, target.invitee.login);
    // 管理者が所属もしている（1人のまま）
    await createMembership(organization, target.otherWorkspace.id, target.admin.userId!);
    // 無効にした人（所属が残っていても数えない）と、離れた人
    const disabled = await createPerson({ organization, disabled: true });
    await createMembership(organization, target.workspace.id, disabled.userId!);
    const left = await createPerson({ organization });
    await createMembership(organization, target.workspace.id, left.userId!, {
      left_on: '2026-10-10',
      left_at: '2026-10-10T00:00:00.000Z',
    });
    // 取り消した招待と、期限の過ぎた Google の招待
    await createInvitation(
      organization,
      target.workspace.id,
      target.admin.userId!,
      {
        provider: 'github',
        subject: '7999999001',
      },
      { status: 'revoked' },
    );
    await createInvitation(
      organization,
      target.workspace.id,
      target.admin.userId!,
      { provider: 'google', subject: '' },
      {
        login_subject: null,
        login_email: 'expired@example.test',
        claim_token_hash: hash64(),
        claim_expires_at: '2026-10-01T00:00:00.000Z',
      },
    );
    expect(await seatsOf(target)).toEqual({ used: 5, limit: 15 });

    // 期限内の Google の招待は数え、同じメールアドレスを別のワークスペースに招待しても1人
    const waiting = {
      login_subject: null,
      login_email: 'waiting@example.test',
      claim_expires_at: '2999-01-01T00:00:00.000Z',
    };
    await createInvitation(
      organization,
      target.workspace.id,
      target.admin.userId!,
      { provider: 'google', subject: '' },
      {
        ...waiting,
        claim_token_hash: hash64(),
      },
    );
    const third = await createWorkspace(organization, target.admin.userId!);
    await createInvitation(
      organization,
      third.id,
      target.admin.userId!,
      { provider: 'google', subject: '' },
      {
        ...waiting,
        claim_token_hash: hash64(),
      },
    );
    expect(await seatsOf(target)).toEqual({ used: 6, limit: 15 });
  });

  test('閉じたワークスペースへの招待と、無効にされた人への招待は数えない', async () => {
    const target = await createTarget();
    const organization = target.organization;
    const closed = await createWorkspace(organization, target.admin.userId!, {
      closed_at: '2026-10-22T00:00:00.000Z',
    });
    await createInvitation(organization, closed.id, target.admin.userId!, {
      provider: 'github',
      subject: '7999999101',
    });
    const disabled = await createUser(organization, {
      login_subject: '7999999102',
      disabled_at: '2026-10-21T00:00:00.000Z',
    });
    await createInvitation(organization, target.workspace.id, target.admin.userId!, {
      provider: 'github',
      subject: disabled.login_subject!,
    });
    expect(await seatsOf(target)).toEqual({ used: 5, limit: 15 });
  });

  test('別の組織の管理者、所属、招待は数えない', async () => {
    const [target, other] = await Promise.all([createTarget(), createTarget()]);
    await createPerson({ organization: other.organization, admin: true });
    await createInvitation(other.organization, other.workspace.id, other.admin.userId!, {
      provider: 'github',
      subject: '7999999103',
    });
    // 別の組織にいる人と同じログインの手段と ID でも、この組織の人数には入らない
    await createInvitation(other.organization, other.workspace.id, other.admin.userId!, {
      provider: 'github',
      subject: target.member.login.subject,
    });
    expect(await seatsOf(target)).toEqual({ used: 5, limit: 15 });
    expect(await seatsOf(other)).toEqual({ used: 8, limit: 15 });
  });
});

describe('invitation-revoke', () => {
  test('同時に取り消すと、片方だけが取り消し、もう片方は 409 の conflict で、履歴は1行', async () => {
    const target = await createTarget();
    const invitation = await createInvitation(target.organization, target.workspace.id, target.admin.userId!, {
      provider: 'github',
      subject: '7999999104',
    });
    // 先の要求が招待の状態を読んだ直後に、もう片方の要求を最後まで通す
    let raced: Promise<Response> | undefined;
    const racing = envWithD1Hooks(testEnv, {
      afterQuery: async (sql) => {
        if (raced !== undefined || !sql.includes('select "invitations"."status"')) return;
        raced = revoke(target, target.admin, invitation.id);
        await raced;
      },
    });
    const first = await post(app, invitationRevoke, {
      slug: target.slug,
      token: target.leader.token,
      env: racing,
      body: { workspace_id: target.workspace.id, invitation_id: invitation.id },
    });
    const second = await raced!;
    expect(second.status).toBe(200);
    expect(first.status).toBe(409);
    expect(await errorCodeOf(first)).toBe('conflict');
    const logs = await invitationLogs(target.organization, invitation.id);
    expect(logs).toHaveLength(1);
    expect(logs[0]!.actor_user_id).toBe(target.admin.userId);
  });

  test('リーダーが取り消すと、取り消し済みになって承諾待ちの一覧から消え、変更の履歴に残る', async () => {
    const target = await createTarget();
    const invitation = await createInvitation(target.organization, target.workspace.id, target.admin.userId!, {
      provider: 'github',
      subject: '7999999002',
    });
    const res = await revoke(target, target.leader, invitation.id);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ invitation_id: invitation.id });

    const row = (await invitationRows(target.organization, target.workspace.id)).find(
      (item) => item.id === invitation.id,
    );
    expect(row?.status).toBe('revoked');
    expect(row?.responded_at).not.toBeNull();

    const logs = await invitationLogs(target.organization, invitation.id);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ action: 'update', actor_user_id: target.leader.userId });
    expect(JSON.parse(logs[0]!.changes_json)).toEqual({ status: ['pending', 'revoked'] });

    const listed = await post(app, memberList, {
      slug: target.slug,
      token: target.leader.token,
      body: { workspace_id: target.workspace.id },
    });
    const invitations = ((await listed.json()) as { invitations: { id: string }[] }).invitations;
    expect(invitations.map((item) => item.id)).not.toContain(invitation.id);
  });

  test('承諾待ちでない招待は 409 の conflict で、履歴を足さない', async () => {
    const target = await createTarget();
    const invitation = await createInvitation(target.organization, target.workspace.id, target.admin.userId!, {
      provider: 'github',
      subject: '7999999003',
    });
    expect((await revoke(target, target.admin, invitation.id)).status).toBe(200);
    const again = await revoke(target, target.admin, invitation.id);
    expect(again.status).toBe(409);
    expect(await errorCodeOf(again)).toBe('conflict');
    expect(await invitationLogs(target.organization, invitation.id)).toHaveLength(1);

    const accepted = await createInvitation(
      target.organization,
      target.workspace.id,
      target.admin.userId!,
      { provider: 'github', subject: '7999999004' },
      { status: 'accepted', responded_at: '2026-10-21T00:00:00.000Z' },
    );
    expect(await errorCodeOf(await revoke(target, target.admin, accepted.id))).toBe('conflict');
  });

  test('別のワークスペースと別の組織の招待は、存在しないときと同じ 404', async () => {
    const [target, other] = await Promise.all([createTarget(), createTarget()]);
    const elsewhere = await createInvitation(target.organization, target.otherWorkspace.id, target.admin.userId!, {
      provider: 'github',
      subject: '7999999005',
    });
    const res = await revoke(target, target.leader, elsewhere.id);
    expect(res.status).toBe(404);
    expect(await errorCodeOf(res)).toBe('not_found');

    const foreign = await createInvitation(other.organization, other.workspace.id, other.admin.userId!, {
      provider: 'github',
      subject: '7999999006',
    });
    expect(await errorCodeOf(await revoke(target, target.admin, foreign.id))).toBe('not_found');
    expect(await errorCodeOf(await revoke(target, target.admin, crypto.randomUUID()))).toBe('not_found');
    // どちらも取り消されていない
    expect((await invitationRows(target.organization, target.otherWorkspace.id))[0]?.status).toBe('pending');
    expect(
      (await invitationRows(other.organization, other.workspace.id)).every((row) => row.status === 'pending'),
    ).toBe(true);
  });

  test('一般のメンバーは 403、閉じたワークスペースでは 409 の workspace_closed', async () => {
    const target = await createTarget();
    const invitation = await createInvitation(target.organization, target.workspace.id, target.admin.userId!, {
      provider: 'github',
      subject: '7999999007',
    });
    const res = await revoke(target, target.member, invitation.id);
    expect(res.status).toBe(403);
    expect(await errorCodeOf(res)).toBe('forbidden');

    const closed = await createTarget({ closed: true });
    const pending = await createInvitation(closed.organization, closed.workspace.id, closed.admin.userId!, {
      provider: 'github',
      subject: '7999999008',
    });
    const blocked = await revoke(closed, closed.admin, pending.id);
    expect(blocked.status).toBe(409);
    expect(await errorCodeOf(blocked)).toBe('workspace_closed');
  });
});
