// 届いた招待の一覧、承諾、辞退（invitation-list、invitation-accept、invitation-decline）。
// 組織の分離（別の組織の招待は 404）、権限（承諾待ちの招待だけの人も通る）は、一覧を回す test/operation-registry.test.ts も確かめる
import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import { organizationInfo } from '../src/shared/operations/organization/index.ts';
import { invitationAccept, invitationDecline, invitationList } from '../src/shared/operations/workspace/index.ts';
import { createApp } from '../src/server/app.ts';
import { orgDb } from '../src/server/db/index.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import {
  createAccountLogin,
  createInvitation,
  createMembership,
  createOrganization,
  createTask,
  createUser,
  createWorkspace,
  uuidv7,
  type OrganizationFixture,
} from './factories.ts';
import { errorCodeOf, post } from './operations/harness.ts';
import { admitElsewhere, createPerson, type Person } from './operations/world.ts';

const app = createApp(implementedOperations, { fetcher: fetch });

// 組織と、招待する管理者（リン）と、ワークスペース1つ
async function organizationWithOwner(overrides: Parameters<typeof createOrganization>[0] = {}) {
  const organization = await createOrganization(overrides);
  const owner = await createUser(organization, { is_admin: 1, name: 'リン' });
  const workspace = await createWorkspace(organization, owner.id, { name: 'デザイン相談室' });
  return { organization, owner, workspace };
}

function list(organization: OrganizationFixture, person: Person) {
  return post(app, invitationList, { slug: organization.slug, token: person.token });
}

function accept(organization: OrganizationFixture, person: Person, invitationId: string) {
  return post(app, invitationAccept, {
    slug: organization.slug,
    token: person.token,
    body: { invitation_id: invitationId },
  });
}

function decline(organization: OrganizationFixture, person: Person, invitationId: string) {
  return post(app, invitationDecline, {
    slug: organization.slug,
    token: person.token,
    body: { invitation_id: invitationId },
  });
}

async function expectError(res: Response, status: number, code: string): Promise<void> {
  expect(res.status).toBe(status);
  expect(await errorCodeOf(res)).toBe(code);
}

async function invitationRow(organization: OrganizationFixture, invitationId: string) {
  const db = orgDb(env, organization.verified);
  return db.first(
    db.statement((q) =>
      q
        .selectFrom('invitations')
        .innerJoin('workspaces', 'workspaces.id', 'invitations.workspace_id')
        .selectAll('invitations')
        .where('workspaces.organization_id', '=', organization.id)
        .where('invitations.id', '=', invitationId),
    ),
  );
}

async function usersWithLogin(organization: OrganizationFixture, login: Person['login']) {
  const db = orgDb(env, organization.verified);
  return db.rows(
    db.statement((q) =>
      q
        .selectFrom('users')
        .selectAll()
        .where('organization_id', '=', organization.id)
        .where('login_provider', '=', login.provider)
        .where('login_subject', '=', login.subject),
    ),
  );
}

async function membershipsIn(organization: OrganizationFixture, workspaceId: string, userId: string) {
  const db = orgDb(env, organization.verified);
  return db.rows(
    db.statement((q) =>
      q
        .selectFrom('memberships')
        .selectAll()
        .where('workspace_id', '=', workspaceId)
        .where('user_id', '=', userId)
        .orderBy('joined_at'),
    ),
  );
}

async function logsOf(organization: OrganizationFixture, entityType: string, entityId: string) {
  const db = orgDb(env, organization.verified);
  return db.rows(
    db.statement((q) =>
      q
        .selectFrom('change_logs')
        .selectAll()
        .where('organization_id', '=', organization.id)
        .where('entity_type', '=', entityType)
        .where('entity_id', '=', entityId),
    ),
  );
}

describe('invitation-list', () => {
  test('この組織の、自分のログインに当たる承諾待ちの招待だけを、招待した日の順に返す', async () => {
    const { organization, owner, workspace } = await organizationWithOwner({
      name: 'ひばり工房',
      vocabulary: 'scrum',
      theme: 'medieval',
    });
    const closedWorkspace = await createWorkspace(organization, owner.id, {
      name: '旧サイト改修',
      closed_at: '2026-10-22T00:00:00.000Z',
      timezone: 'UTC',
    });
    const revokedWorkspace = await createWorkspace(organization, owner.id, { name: '取り消した先' });
    const invitee = await createPerson();
    // 東京の日付では翌日になる時刻
    const first = await createInvitation(organization, workspace.id, owner.id, invitee.login, {
      role: 'leader',
      created_at: '2026-10-18T15:30:00.000Z',
    });
    const second = await createInvitation(organization, closedWorkspace.id, owner.id, invitee.login, {
      created_at: '2026-10-19T01:00:00.000Z',
    });
    await createInvitation(organization, revokedWorkspace.id, owner.id, invitee.login, { status: 'revoked' });
    // 別の人への招待と、別の組織の招待は出ない
    const someone = await createPerson();
    await createInvitation(organization, workspace.id, owner.id, someone.login);
    const other = await organizationWithOwner();
    await createInvitation(other.organization, other.workspace.id, other.owner.id, invitee.login);

    const res = await list(organization, invitee);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      organization: { name: 'ひばり工房', vocabulary: 'scrum', theme: 'medieval' },
      invitations: [
        {
          invitation_id: first.id,
          workspace_id: workspace.id,
          workspace_name: 'デザイン相談室',
          closed: false,
          role: 'leader',
          invited_by_name: 'リン',
          invited_on: '2026-10-19',
        },
        {
          invitation_id: second.id,
          workspace_id: closedWorkspace.id,
          workspace_name: '旧サイト改修',
          closed: true,
          role: 'member',
          invited_by_name: 'リン',
          invited_on: '2026-10-19',
        },
      ],
    });
  });

  test('アカウントに結んだどのログインに宛てた招待も出る。組織に入れる人は、招待が無ければ空', async () => {
    const { organization, owner, workspace } = await organizationWithOwner();
    const person = await createPerson({ organization, membership: { workspaceId: workspace.id, role: 'member' } });
    const listedEmpty = (await (await list(organization, person)).json()) as { invitations: unknown[] };
    expect(listedEmpty.invitations).toEqual([]);

    const google = await createAccountLogin(person.accountId, {
      login_provider: 'google',
      login_subject: '118000000000000000187',
      login_name: 'aoi@example.com',
    });
    const another = await createWorkspace(organization, owner.id, { name: '広報' });
    const invitation = await createInvitation(organization, another.id, owner.id, {
      provider: 'google',
      subject: google.login_subject,
    });
    const listed = (await (await list(organization, person)).json()) as {
      invitations: { invitation_id: string }[];
    };
    expect(listed.invitations.map((item) => item.invitation_id)).toEqual([invitation.id]);
  });
});

describe('invitation-accept', () => {
  test('招待だけの人は users の行を作られてメンバーになり、組織の操作が通るようになる。変更の履歴が2行残る', async () => {
    const { organization, owner, workspace } = await organizationWithOwner();
    const invitee = await createPerson();
    const invitation = await createInvitation(organization, workspace.id, owner.id, invitee.login, { role: 'leader' });
    expect((await post(app, organizationInfo, { slug: organization.slug, token: invitee.token })).status).toBe(404);

    const res = await accept(organization, invitee, invitation.id);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ workspace_id: workspace.id });

    const users = await usersWithLogin(organization, invitee.login);
    expect(users).toHaveLength(1);
    const user = users[0]!;
    // 名前はログインの手段の側の名前（account_logins.login_name）
    expect(user).toMatchObject({ account_id: invitee.accountId, name: 'mio-hoshino', is_admin: 0, disabled_at: null });
    const memberships = await membershipsIn(organization, workspace.id, user.id);
    expect(memberships).toHaveLength(1);
    expect(memberships[0]).toMatchObject({ role: 'leader', left_at: null });
    expect(memberships[0]!.joined_on).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(await invitationRow(organization, invitation.id)).toMatchObject({ status: 'accepted' });
    expect((await invitationRow(organization, invitation.id))?.responded_at).not.toBeNull();

    const invitationLogs = await logsOf(organization, 'invitation', invitation.id);
    expect(invitationLogs).toHaveLength(1);
    expect(invitationLogs[0]).toMatchObject({
      action: 'update',
      actor_user_id: user.id,
      workspace_id: workspace.id,
    });
    expect(JSON.parse(invitationLogs[0]!.changes_json)).toEqual({ status: ['pending', 'accepted'] });
    const membershipLogs = await logsOf(organization, 'membership', memberships[0]!.id);
    expect(membershipLogs).toHaveLength(1);
    expect(membershipLogs[0]).toMatchObject({ action: 'create', actor_user_id: user.id, workspace_id: workspace.id });
    expect(JSON.parse(membershipLogs[0]!.changes_json)).toEqual({
      user: [null, { id: user.id, name: 'mio-hoshino' }],
      role: [null, 'leader'],
    });

    const info = await post(app, organizationInfo, { slug: organization.slug, token: invitee.token });
    expect(info.status).toBe(200);
    expect(((await info.json()) as { workspaces: { id: string }[] }).workspaces.map((item) => item.id)).toEqual([
      workspace.id,
    ]);
  });

  test('前に抜けた人は同じ users の ID で戻り、経験値の合計が変わらない', async () => {
    const { organization, owner, workspace } = await organizationWithOwner();
    const returning = await createPerson({ organization });
    await createMembership(organization, workspace.id, returning.userId!, {
      joined_on: '2026-09-01',
      joined_at: '2026-09-01T00:00:00.000Z',
      left_on: '2026-09-30',
      left_at: '2026-09-30T00:00:00.000Z',
    });
    const task = await createTask(organization, workspace.id, returning.userId!);
    const db = orgDb(env, organization.verified);
    for (const amount of [3, 5]) {
      await db.run(
        db.statement((q) =>
          q.insertInto('xp_grants').values({
            id: uuidv7(),
            workspace_id: workspace.id,
            user_id: returning.userId!,
            action: 'task_created',
            task_id: task.id,
            amount,
            dedupe_key: `test:${crypto.randomUUID()}`,
            confirmed_at: '2026-09-10T00:00:00.000Z',
          }),
        ),
      );
    }
    const xpTotal = async () =>
      (
        await db.rows(
          db.statement((q) => q.selectFrom('xp_grants').select('amount').where('user_id', '=', returning.userId!)),
        )
      ).reduce((sum, row) => sum + row.amount, 0);
    const invitation = await createInvitation(organization, workspace.id, owner.id, returning.login);

    const res = await accept(organization, returning, invitation.id);
    expect(res.status).toBe(200);

    const users = await usersWithLogin(organization, returning.login);
    expect(users.map((user) => user.id)).toEqual([returning.userId]);
    const memberships = await membershipsIn(organization, workspace.id, returning.userId!);
    expect(memberships.map((membership) => membership.left_at)).toEqual(['2026-09-30T00:00:00.000Z', null]);
    expect(await xpTotal()).toBe(8);
    const membershipLogs = await logsOf(organization, 'membership', memberships[1]!.id);
    expect(JSON.parse(membershipLogs[0]!.changes_json)).toEqual({
      user: [null, { id: returning.userId, name: '星野 澪' }],
      role: [null, 'member'],
    });
  });

  test('組織に入れる人は、別のワークスペースへの招待を承諾して所属を足せる', async () => {
    const { organization, owner, workspace } = await organizationWithOwner();
    const person = await createPerson({ organization, membership: { workspaceId: workspace.id, role: 'member' } });
    const another = await createWorkspace(organization, owner.id, { name: '広報' });
    const invitation = await createInvitation(organization, another.id, owner.id, person.login);

    expect((await accept(organization, person, invitation.id)).status).toBe(200);
    expect(await membershipsIn(organization, another.id, person.userId!)).toHaveLength(1);
    expect(await usersWithLogin(organization, person.login)).toHaveLength(1);
  });

  test('取り消された招待は 409 の conflict で、何も書かない', async () => {
    const { organization, owner, workspace } = await organizationWithOwner();
    const invitee = await createPerson();
    // 組織に入れるよう、別の承諾待ちの招待を持たせる
    const another = await createWorkspace(organization, owner.id);
    await createInvitation(organization, another.id, owner.id, invitee.login);
    const revoked = await createInvitation(organization, workspace.id, owner.id, invitee.login, {
      status: 'revoked',
      responded_at: '2026-10-21T00:00:00.000Z',
    });

    await expectError(await accept(organization, invitee, revoked.id), 409, 'conflict');
    expect(await usersWithLogin(organization, invitee.login)).toHaveLength(0);
    expect(await logsOf(organization, 'invitation', revoked.id)).toHaveLength(0);
  });

  test('同じ招待を2回承諾すると、2回目は 409 の conflict で、所属は1行', async () => {
    const { organization, owner, workspace } = await organizationWithOwner();
    const invitee = await createPerson();
    const invitation = await createInvitation(organization, workspace.id, owner.id, invitee.login);

    expect((await accept(organization, invitee, invitation.id)).status).toBe(200);
    await expectError(await accept(organization, invitee, invitation.id), 409, 'conflict');
    const user = (await usersWithLogin(organization, invitee.login))[0]!;
    expect(await membershipsIn(organization, workspace.id, user.id)).toHaveLength(1);
    expect(await logsOf(organization, 'invitation', invitation.id)).toHaveLength(1);
  });

  test('同時に2回承諾しても、所属は1行で、片方は 409', async () => {
    const { organization, owner, workspace } = await organizationWithOwner();
    const invitee = await createPerson();
    const invitation = await createInvitation(organization, workspace.id, owner.id, invitee.login);

    const statuses = (
      await Promise.all([accept(organization, invitee, invitation.id), accept(organization, invitee, invitation.id)])
    ).map((res) => res.status);
    expect(statuses.sort()).toEqual([200, 409]);
    const users = await usersWithLogin(organization, invitee.login);
    expect(users).toHaveLength(1);
    expect(await membershipsIn(organization, workspace.id, users[0]!.id)).toHaveLength(1);
  });

  test('閉じたワークスペースへの招待は 409 の workspace_closed', async () => {
    const { organization, owner } = await organizationWithOwner();
    const closed = await createWorkspace(organization, owner.id, { closed_at: '2026-10-22T00:00:00.000Z' });
    const invitee = await createPerson();
    const invitation = await createInvitation(organization, closed.id, owner.id, invitee.login);

    await expectError(await accept(organization, invitee, invitation.id), 409, 'workspace_closed');
    expect(await usersWithLogin(organization, invitee.login)).toHaveLength(0);
    expect(await invitationRow(organization, invitation.id)).toMatchObject({ status: 'pending' });
  });

  test('そのワークスペースに今所属していれば 409 の already_member', async () => {
    const { organization, owner, workspace } = await organizationWithOwner();
    const person = await createPerson({ organization, membership: { workspaceId: workspace.id, role: 'member' } });
    const invitation = await createInvitation(organization, workspace.id, owner.id, person.login);

    await expectError(await accept(organization, person, invitation.id), 409, 'already_member');
    expect(await membershipsIn(organization, workspace.id, person.userId!)).toHaveLength(1);
    expect(await invitationRow(organization, invitation.id)).toMatchObject({ status: 'pending' });
  });

  test('この組織で無効にされた人は、招待があっても入れず 404', async () => {
    const { organization, owner, workspace } = await organizationWithOwner();
    // アカウントに結んだ無効な行と、アカウントに結ばれる前の無効な行（同じログイン）
    const disabled = await admitElsewhere(await createPerson({ organization, disabled: true }));
    const invitation = await createInvitation(organization, workspace.id, owner.id, disabled.login);
    await expectError(await accept(organization, disabled, invitation.id), 404, 'not_found');

    const unlinked = await admitElsewhere(await createPerson());
    await createUser(organization, {
      account_id: null,
      login_provider: unlinked.login.provider,
      login_subject: unlinked.login.subject,
      disabled_at: '2026-10-21T00:00:00.000Z',
    });
    const second = await createInvitation(organization, workspace.id, owner.id, unlinked.login);
    await expectError(await accept(organization, unlinked, second.id), 404, 'not_found');
    expect(await invitationRow(organization, invitation.id)).toMatchObject({ status: 'pending' });
    expect(await invitationRow(organization, second.id)).toMatchObject({ status: 'pending' });
  });

  test('別の人に宛てた招待は 404 で、何も書かない', async () => {
    const { organization, owner, workspace } = await organizationWithOwner();
    const invitee = await createPerson();
    await createInvitation(organization, workspace.id, owner.id, invitee.login);
    const someone = await createPerson();
    const theirs = await createInvitation(organization, workspace.id, owner.id, someone.login);

    await expectError(await accept(organization, invitee, theirs.id), 404, 'not_found');
    expect(await invitationRow(organization, theirs.id)).toMatchObject({ status: 'pending' });
    expect(await usersWithLogin(organization, invitee.login)).toHaveLength(0);
  });
});

describe('invitation-decline', () => {
  test('辞退すると declined になり、変更の履歴が1行残り、招待だけの組織には入れなくなる', async () => {
    const { organization, owner, workspace } = await organizationWithOwner();
    // 組織に入れなくなった後の 404 を、どの組織にも入れなくなった 401 と分けて見るため、ほかの組織に入れる人にする
    const invitee = await admitElsewhere(await createPerson());
    const invitation = await createInvitation(organization, workspace.id, owner.id, invitee.login);

    const res = await decline(organization, invitee, invitation.id);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ invitation_id: invitation.id });
    const row = await invitationRow(organization, invitation.id);
    expect(row).toMatchObject({ status: 'declined' });
    expect(row?.responded_at).not.toBeNull();
    const logs = await logsOf(organization, 'invitation', invitation.id);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ action: 'update', actor_user_id: null, workspace_id: workspace.id });
    expect(JSON.parse(logs[0]!.changes_json)).toEqual({ status: ['pending', 'declined'] });

    await expectError(await list(organization, invitee), 404, 'not_found');
    await expectError(
      await post(app, organizationInfo, { slug: organization.slug, token: invitee.token }),
      404,
      'not_found',
    );
    expect(await usersWithLogin(organization, invitee.login)).toHaveLength(0);
  });

  test('2回目の辞退は 409 の conflict で、履歴は1行のまま', async () => {
    const { organization, owner, workspace } = await organizationWithOwner();
    const invitee = await createPerson();
    // 辞退した後も組織に入れるよう、別の承諾待ちの招待を持たせる
    const another = await createWorkspace(organization, owner.id);
    await createInvitation(organization, another.id, owner.id, invitee.login);
    const invitation = await createInvitation(organization, workspace.id, owner.id, invitee.login);

    expect((await decline(organization, invitee, invitation.id)).status).toBe(200);
    await expectError(await decline(organization, invitee, invitation.id), 409, 'conflict');
    expect(await logsOf(organization, 'invitation', invitation.id)).toHaveLength(1);
  });

  test('閉じたワークスペースへの招待も辞退できる。組織に入れる人の辞退は、変えた人に自分の行を残す', async () => {
    const { organization, owner, workspace } = await organizationWithOwner();
    const person = await createPerson({ organization, membership: { workspaceId: workspace.id, role: 'member' } });
    const closed = await createWorkspace(organization, owner.id, { closed_at: '2026-10-22T00:00:00.000Z' });
    const invitation = await createInvitation(organization, closed.id, owner.id, person.login);

    expect((await decline(organization, person, invitation.id)).status).toBe(200);
    expect(await invitationRow(organization, invitation.id)).toMatchObject({ status: 'declined' });
    expect((await logsOf(organization, 'invitation', invitation.id))[0]).toMatchObject({
      actor_user_id: person.userId,
    });
  });

  test('別の人に宛てた招待は 404 で、何も書かない', async () => {
    const { organization, owner, workspace } = await organizationWithOwner();
    const invitee = await createPerson();
    await createInvitation(organization, workspace.id, owner.id, invitee.login);
    const someone = await createPerson();
    const theirs = await createInvitation(organization, workspace.id, owner.id, someone.login);

    await expectError(await decline(organization, invitee, theirs.id), 404, 'not_found');
    expect(await invitationRow(organization, theirs.id)).toMatchObject({ status: 'pending' });
  });
});
