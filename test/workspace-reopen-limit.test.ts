// ワークスペースの開き直し（workspace-reopen）が、組織の人数の上限（member_limit）を見る振る舞い（#284）。
// 閉じたワークスペースへの承諾待ちの招待は人数に数えないので、開き直すとその招待の人が新しく数えられる。
// 新しく数えられる人（adding）が1人以上で、今の人数（used）に足すと上限を超えるときだけ、409 の member_limit_reached で断る。
// 権限と組織の分離の一覧は test/operation-registry.test.ts が回す
import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import { invitationAccept, workspaceReopen } from '../src/shared/operations/workspace/index.ts';
import { createApp } from '../src/server/app.ts';
import {
  commonDb,
  orgDb,
  personKey,
  seatHoldersOf,
  seatHoldersOfWorkspaceInvitations,
} from '../src/server/db/index.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import {
  createInvitation,
  createMembership,
  createOrganization,
  createUser,
  createWorkspace,
  hash64,
  type OrganizationFixture,
} from './factories.ts';
import { errorCodeOf, post } from './operations/harness.ts';
import { createPerson } from './operations/world.ts';

const app = createApp(implementedOperations);

const CLOSED_AT = '2026-10-22T00:00:00.000Z';
const EXPIRED_AT = '2026-10-01T00:00:00.000Z';
const FUTURE_AT = '2999-01-01T00:00:00.000Z';
const DISABLED_AT = '2026-10-21T00:00:00.000Z';

type Login = { provider: string; subject: string };

function newLogin(): Login {
  return { provider: 'github', subject: `u-${crypto.randomUUID()}` };
}

// 組織（上限つき）と、人数に数えられる管理者1人と、閉じたワークスペース W と、開いたワークスペース V
async function setup(limit: number) {
  const organization = await createOrganization({ member_limit: limit });
  const admin = await createPerson({ organization, admin: true });
  const closed = await createWorkspace(organization, admin.userId!, { closed_at: CLOSED_AT });
  const open = await createWorkspace(organization, admin.userId!);
  return { organization, admin, closed, open };
}
type World = Awaited<ReturnType<typeof setup>>;

function invite(
  world: World,
  workspaceId: string,
  login: Login = newLogin(),
  overrides: Parameters<typeof createInvitation>[4] = {},
) {
  return createInvitation(world.organization, workspaceId, world.admin.userId!, login, overrides);
}

// 今所属する、無効でない人を1人足す（人数に1人増える）
async function addMember(world: World, workspaceId: string, login: Login = newLogin()) {
  const user = await createUser(world.organization, {
    login_provider: login.provider,
    login_subject: login.subject,
  });
  await createMembership(world.organization, workspaceId, user.id);
  return user;
}

function reopen(world: World, workspaceId: string) {
  return post(app, workspaceReopen, {
    slug: world.organization.slug,
    token: world.admin.token,
    body: { workspace_id: workspaceId },
  });
}

async function errorOf(res: Response) {
  return (await res.json()) as { error: { code: string; details?: unknown } };
}

async function closedAtOf(organization: OrganizationFixture, workspaceId: string) {
  const db = orgDb(env, organization.verified);
  const row = await db.first(
    db.statement((q) =>
      q
        .selectFrom('workspaces')
        .select('closed_at')
        .where('id', '=', workspaceId)
        .where('organization_id', '=', organization.id),
    ),
  );
  return row?.closed_at;
}

async function reopenLogs(organization: OrganizationFixture, workspaceId: string) {
  const db = orgDb(env, organization.verified);
  return db.rows(
    db.statement((q) =>
      q
        .selectFrom('change_logs')
        .select('id')
        .where('organization_id', '=', organization.id)
        .where('workspace_id', '=', workspaceId)
        .where('action', '=', 'reopen'),
    ),
  );
}

async function setMemberLimit(organization: OrganizationFixture, limit: number): Promise<void> {
  const db = commonDb(env);
  await db.run(
    db.statement((q) => q.updateTable('organizations').set({ member_limit: limit }).where('id', '=', organization.id)),
  );
}

// 閉じたワークスペースの招待は invitation-revoke（閉じていると 409）で取り消せないので、行の status を直接書く
async function revokeRow(organization: OrganizationFixture, invitationId: string): Promise<void> {
  const db = orgDb(env, organization.verified);
  await db.batch([
    db.statement((q) =>
      q
        .updateTable('invitations')
        .set({ status: 'revoked', responded_at: CLOSED_AT })
        .where('id', '=', invitationId)
        .where('workspace_id', 'in', (eb) =>
          eb.selectFrom('workspaces').select('id').where('organization_id', '=', organization.id),
        ),
    ),
  ]);
}

function googleInvite(world: World, workspaceId: string, email: string, claimExpiresAt: string) {
  return createInvitation(
    world.organization,
    workspaceId,
    world.admin.userId!,
    { provider: 'google', subject: '' },
    { login_subject: null, login_email: email, claim_token_hash: hash64(), claim_expires_at: claimExpiresAt },
  );
}

async function expectRefused(
  world: World,
  workspaceId: string,
  details: { used: number; limit: number; adding: number },
) {
  const res = await reopen(world, workspaceId);
  expect(res.status).toBe(409);
  const body = await errorOf(res);
  expect(body.error.code).toBe('member_limit_reached');
  expect(body.error.details).toEqual(details);
  expect(await closedAtOf(world.organization, workspaceId)).toBe(CLOSED_AT);
  expect(await reopenLogs(world.organization, workspaceId)).toEqual([]);
}

async function expectReopened(world: World, workspaceId: string) {
  const res = await reopen(world, workspaceId);
  expect(res.status).toBe(200);
  expect(await closedAtOf(world.organization, workspaceId)).toBeNull();
  expect(await reopenLogs(world.organization, workspaceId)).toHaveLength(1);
}

describe('workspace-reopen の人数の上限', () => {
  test('閉じている間に上限まで埋まると 409 の member_limit_reached で、details に used・limit・adding を載せ、何も書かない', async () => {
    const world = await setup(3);
    await invite(world, world.closed.id);
    // 管理者、V への招待2人で used = 3 = 上限
    await invite(world, world.open.id);
    await invite(world, world.open.id);

    await expectRefused(world, world.closed.id, { used: 3, limit: 3, adding: 1 });
  });

  test('断られた後、その招待を取り消すと同じワークスペースを開き直せる', async () => {
    const world = await setup(3);
    const pending = await invite(world, world.closed.id);
    await invite(world, world.open.id);
    await invite(world, world.open.id);
    await expectRefused(world, world.closed.id, { used: 3, limit: 3, adding: 1 });

    await revokeRow(world.organization, pending.id);
    await expectReopened(world, world.closed.id);
  });

  test('断られた後、上限を上げると同じワークスペースを開き直せる', async () => {
    const world = await setup(3);
    await invite(world, world.closed.id);
    await invite(world, world.open.id);
    await invite(world, world.open.id);
    await expectRefused(world, world.closed.id, { used: 3, limit: 3, adding: 1 });

    await setMemberLimit(world.organization, 4);
    await expectReopened(world, world.closed.id);
  });

  test('招待が2人で2人分の空きが無いと、adding は 2 で断る', async () => {
    const world = await setup(3);
    await invite(world, world.closed.id);
    await invite(world, world.closed.id);
    await invite(world, world.open.id);

    await expectRefused(world, world.closed.id, { used: 2, limit: 3, adding: 2 });
  });

  test('ちょうど上限に達する開き直しは通る', async () => {
    const world = await setup(3);
    await invite(world, world.closed.id);
    await invite(world, world.open.id);
    // used = 2、adding = 1、合計 3 = 上限

    await expectReopened(world, world.closed.id);
  });

  test('adding = 0 の開き直し（招待が無い）は、人数が上限を超えている組織でも通る', async () => {
    const world = await setup(15);
    await addMember(world, world.open.id);
    await addMember(world, world.open.id);
    await setMemberLimit(world.organization, 1);
    expect((await seatHoldersOf(orgDb(env, world.organization.verified), new Date())).size).toBe(3);

    await expectReopened(world, world.closed.id);
  });

  test('adding = 0 の開き直し（招待の人がすでに別の所属で数えられている）は、上限を超えていても通る', async () => {
    const world = await setup(15);
    const member = await addMember(world, world.open.id);
    await invite(world, world.closed.id, { provider: member.login_provider, subject: member.login_subject! });
    await setMemberLimit(world.organization, 1);

    await expectReopened(world, world.closed.id);
  });

  test('adding = 0 の開き直し（招待の人が別のワークスペースの招待で数えられている）は、上限を超えていても通る', async () => {
    const world = await setup(15);
    const login = newLogin();
    await invite(world, world.closed.id, login);
    await invite(world, world.open.id, login);
    await invite(world, world.open.id);
    await setMemberLimit(world.organization, 1);

    await expectReopened(world, world.closed.id);
  });

  test('期限切れの Google の招待と、無効にされた人への招待は adding に数えず、上限いっぱいでも開き直せる', async () => {
    const world = await setup(2);
    await invite(world, world.open.id);
    await googleInvite(world, world.closed.id, 'expired@example.com', EXPIRED_AT);
    const disabled = newLogin();
    await createUser(world.organization, {
      login_provider: disabled.provider,
      login_subject: disabled.subject,
      disabled_at: DISABLED_AT,
    });
    await invite(world, world.closed.id, disabled);

    await expectReopened(world, world.closed.id);
  });

  test('期限切れと無効にされた人を除いた分だけが adding になる', async () => {
    const world = await setup(2);
    await invite(world, world.open.id);
    await googleInvite(world, world.closed.id, 'expired@example.com', EXPIRED_AT);
    await googleInvite(world, world.closed.id, 'valid@example.com', FUTURE_AT);
    const disabled = newLogin();
    await createUser(world.organization, {
      login_provider: disabled.provider,
      login_subject: disabled.subject,
      disabled_at: DISABLED_AT,
    });
    await invite(world, world.closed.id, disabled);

    await expectRefused(world, world.closed.id, { used: 2, limit: 2, adding: 1 });
  });

  test('同じ人が2つの閉じたワークスペースに招待されていても、1つを開き直すときの adding は1人。開き直した後はもう片方の adding は 0', async () => {
    const world = await setup(1);
    const second = await createWorkspace(world.organization, world.admin.userId!, { closed_at: CLOSED_AT });
    const login = newLogin();
    await invite(world, world.closed.id, login);
    await invite(world, second.id, login);

    await expectRefused(world, world.closed.id, { used: 1, limit: 1, adding: 1 });

    await setMemberLimit(world.organization, 2);
    await expectReopened(world, world.closed.id);
    // 1人目の開き直しで招待の人が数えられているので、2つ目は新しく数える人がいない（used = 2 = 上限でも通る）
    await expectReopened(world, second.id);
  });

  test('別の組織の招待や所属は used と adding に影響しない', async () => {
    const world = await setup(1);
    const login = newLogin();
    await invite(world, world.closed.id, login);

    const other = await setup(15);
    await invite(other, other.open.id, login);
    await invite(other, other.open.id);
    await addMember(other, other.open.id, login);
    await addMember(other, other.open.id);

    await expectRefused(world, world.closed.id, { used: 1, limit: 1, adding: 1 });
  });

  test('別の組織が上限いっぱいでも、自分の組織の開き直しは自分の組織の人数だけで決まる', async () => {
    const world = await setup(2);
    const login = newLogin();
    await invite(world, world.closed.id, login);

    const other = await setup(1);
    await addMember(other, other.open.id, login);

    await expectReopened(world, world.closed.id);
  });

  test('invitation-accept は上限を見ない。承諾待ちの招待は人数に数えられているので、上限いっぱいでも承諾できる', async () => {
    const world = await setup(2);
    const invitee = await createPerson();
    const invitation = await invite(world, world.open.id, invitee.login);
    // used = 管理者 + 招待の人 = 2 = 上限
    expect((await seatHoldersOf(orgDb(env, world.organization.verified), new Date())).size).toBe(2);

    const res = await post(app, invitationAccept, {
      slug: world.organization.slug,
      token: invitee.token,
      body: { invitation_id: invitation.id },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ workspace_id: world.open.id });
  });

  test('エラーのコードは member_limit_reached で、ほかのコードと取り違えない', async () => {
    const world = await setup(1);
    await invite(world, world.closed.id);
    const res = await reopen(world, world.closed.id);
    expect(await errorCodeOf(res)).toBe('member_limit_reached');
  });
});

describe('seatHoldersOfWorkspaceInvitations', () => {
  const AT = new Date('2026-10-26T03:00:00.000Z');

  function entry(world: World) {
    return orgDb(env, world.organization.verified);
  }

  test('そのワークスペースの承諾待ちの招待の人の personKey を返す。ワークスペースが閉じていても数える', async () => {
    const world = await setup(15);
    const a = newLogin();
    const b = newLogin();
    await invite(world, world.closed.id, a);
    await invite(world, world.closed.id, b);

    const keys = await seatHoldersOfWorkspaceInvitations(entry(world), world.closed.id, AT);
    expect(keys).toEqual(
      new Set([
        personKey({ login_provider: a.provider, login_subject: a.subject, login_email: null }),
        personKey({ login_provider: b.provider, login_subject: b.subject, login_email: null }),
      ]),
    );
  });

  test('開いているワークスペースの招待も数える', async () => {
    const world = await setup(15);
    const a = newLogin();
    await invite(world, world.open.id, a);

    const keys = await seatHoldersOfWorkspaceInvitations(entry(world), world.open.id, AT);
    expect(keys).toEqual(
      new Set([personKey({ login_provider: a.provider, login_subject: a.subject, login_email: null })]),
    );
  });

  test('承諾待ちでない招待（取り消し、承諾、辞退）は含めない', async () => {
    const world = await setup(15);
    await invite(world, world.closed.id, newLogin(), { status: 'revoked' });
    await invite(world, world.closed.id, newLogin(), { status: 'accepted' });
    await invite(world, world.closed.id, newLogin(), { status: 'declined' });

    expect(await seatHoldersOfWorkspaceInvitations(entry(world), world.closed.id, AT)).toEqual(new Set());
  });

  test('期限切れの Google の招待を除き、期限内の Google の招待はメールアドレスの personKey で返す。期限は at 以前で切れる', async () => {
    const world = await setup(15);
    await googleInvite(world, world.closed.id, 'expired@example.com', EXPIRED_AT);
    await googleInvite(world, world.closed.id, 'edge@example.com', AT.toISOString());
    await googleInvite(world, world.closed.id, 'valid@example.com', FUTURE_AT);

    expect(await seatHoldersOfWorkspaceInvitations(entry(world), world.closed.id, AT)).toEqual(
      new Set([personKey({ login_provider: 'google', login_subject: null, login_email: 'valid@example.com' })]),
    );
  });

  test('同じ組織で無効にされた人への招待を除く', async () => {
    const world = await setup(15);
    const disabled = newLogin();
    await createUser(world.organization, {
      login_provider: disabled.provider,
      login_subject: disabled.subject,
      disabled_at: DISABLED_AT,
    });
    await invite(world, world.closed.id, disabled);
    const active = newLogin();
    await invite(world, world.closed.id, active);

    expect(await seatHoldersOfWorkspaceInvitations(entry(world), world.closed.id, AT)).toEqual(
      new Set([personKey({ login_provider: active.provider, login_subject: active.subject, login_email: null })]),
    );
  });

  test('別のワークスペースの招待は含めない', async () => {
    const world = await setup(15);
    const mine = newLogin();
    await invite(world, world.closed.id, mine);
    await invite(world, world.open.id, newLogin());

    expect(await seatHoldersOfWorkspaceInvitations(entry(world), world.closed.id, AT)).toEqual(
      new Set([personKey({ login_provider: mine.provider, login_subject: mine.subject, login_email: null })]),
    );
  });

  test('別の組織の無効にされた人や招待を数えない。別の組織で無効な人への招待は、この組織では数える', async () => {
    const world = await setup(15);
    const login = newLogin();
    await invite(world, world.closed.id, login);

    const other = await setup(15);
    await createUser(other.organization, {
      login_provider: login.provider,
      login_subject: login.subject,
      disabled_at: DISABLED_AT,
    });
    await invite(other, other.closed.id, newLogin());

    expect(await seatHoldersOfWorkspaceInvitations(entry(world), world.closed.id, AT)).toEqual(
      new Set([personKey({ login_provider: login.provider, login_subject: login.subject, login_email: null })]),
    );
    // 別の組織のワークスペースの ID を渡しても、この組織の入口では何も数えない
    expect(await seatHoldersOfWorkspaceInvitations(entry(world), other.closed.id, AT)).toEqual(new Set());
  });

  test('すでに所属している人への招待も返す（すでに数えられているかは呼び出し側が seatHoldersOf との差で決める）', async () => {
    const world = await setup(15);
    const member = await addMember(world, world.open.id);
    await invite(world, world.closed.id, { provider: member.login_provider, subject: member.login_subject! });

    expect(await seatHoldersOfWorkspaceInvitations(entry(world), world.closed.id, AT)).toEqual(
      new Set([
        personKey({ login_provider: member.login_provider, login_subject: member.login_subject, login_email: null }),
      ]),
    );
  });
});
