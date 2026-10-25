// メンバーの一覧の振る舞い。
// 組織の分離と権限の種類ごとの許可と拒否は、一覧を回す test/operation-registry.test.ts が確かめる
import { afterEach, describe, expect, test, vi } from 'vitest';
import { memberList } from '../src/shared/operations/workspace/index.ts';
import { createApp } from '../src/server/app.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import { createInvitation, createMembership, createUser, createWorkspace, hash64 } from './factories.ts';
import { errorCodeOf, post } from './operations/harness.ts';
import { createPerson, createTarget, type Person, type Target } from './operations/world.ts';

const app = createApp(implementedOperations);

afterEach(() => {
  vi.restoreAllMocks();
});

type Listed = {
  members: { id: string; name: string; role: string; joined_on: string }[];
  invitations:
    | {
        id: string;
        login_name: string;
        login_provider: string;
        role: string;
        invited_on: string;
        expires_on: string | null;
        expired: boolean;
      }[]
    | null;
};

async function list(target: Target, person: Person, workspaceId: string = target.workspace.id): Promise<Listed> {
  const res = await post(app, memberList, {
    slug: target.slug,
    token: person.token,
    body: { workspace_id: workspaceId },
  });
  expect(res.status).toBe(200);
  return (await res.json()) as Listed;
}

describe('member-list: 招待を返す相手', () => {
  test('リーダーと管理者（所属していなくてもよい）には承諾待ちの招待が配列で返り、一般のメンバーには null', async () => {
    const target = await createTarget();

    for (const person of [target.leader, target.admin]) {
      const listed = await list(target, person);
      expect(listed.invitations).toEqual([
        {
          id: expect.any(String),
          login_name: 'haruka-aoi',
          login_provider: target.invitee.login.provider,
          role: 'member',
          invited_on: '2026-10-20',
          expires_on: null,
          expired: false,
        },
      ]);
    }
    const listed = await list(target, target.member);
    expect(listed.invitations).toBeNull();
    // 欄を返さない形でなく、null で返す
    expect(Object.keys(listed).sort()).toEqual(['invitations', 'members']);
  });

  test('管理者のロールが一般で所属していても、招待が返る', async () => {
    const target = await createTarget();
    const admin = await createPerson({
      organization: target.organization,
      admin: true,
      membership: { workspaceId: target.workspace.id, role: 'member' },
    });
    expect((await list(target, admin)).invitations).toHaveLength(1);
  });

  test('所属していない管理者にも、メンバーの一覧が返る', async () => {
    const target = await createTarget();
    const listed = await list(target, target.admin);
    expect(listed.members.map((member) => member.id).sort()).toEqual(
      [target.leader.userId, target.member.userId].sort(),
    );
  });
});

describe('member-list: メンバー', () => {
  test('抜けた人、無効の人、login_subject が空の人、ほかのワークスペースだけの人は出ない', async () => {
    const target = await createTarget();
    const { organization, workspace } = target;
    const left = await createPerson({ organization });
    await createMembership(organization, workspace.id, left.userId!, {
      left_on: '2026-10-10',
      left_at: '2026-10-10T00:00:00.000Z',
    });
    const disabled = await createPerson({ organization, disabled: true });
    await createMembership(organization, workspace.id, disabled.userId!);
    const waiting = await createUser(organization, {
      login_provider: 'google',
      login_subject: null,
      login_email: 'waiting@example.com',
      claim_token_hash: hash64(),
      claim_expires_at: '2099-01-01T00:00:00.000Z',
      name: 'waiting@example.com',
    });
    await createMembership(organization, workspace.id, waiting.id);

    const listed = await list(target, target.member);
    expect(listed.members.map((member) => member.id).sort()).toEqual(
      [target.leader.userId, target.member.userId].sort(),
    );
    // bystander は otherWorkspace だけに所属している
    expect(listed.members.map((member) => member.id)).not.toContain(target.bystander.userId);
  });

  test('並びはリーダーが先、続いて参加日、名前、ID', async () => {
    const target = await createTarget();
    const { organization, admin } = target;
    const workspace = await createWorkspace(organization, admin.userId!);
    const add = async (name: string, role: 'leader' | 'member', joinedOn: string, id?: string) => {
      const user = await createUser(organization, { name, ...(id === undefined ? {} : { id }) });
      await createMembership(organization, workspace.id, user.id, { role, joined_on: joinedOn });
      return user.id;
    };
    const a = await add('う', 'member', '2026-10-01');
    const b = await add('あ', 'member', '2026-10-03');
    const c = await add('い', 'member', '2026-10-03');
    // 名前も参加日も同じ人は ID の順
    const d2 = await add('い', 'member', '2026-10-03', 'ffffffff-0000-7000-8000-000000000002');
    const d1 = await add('い', 'member', '2026-10-03', 'ffffffff-0000-7000-8000-000000000001');
    const leaderLate = await add('え', 'leader', '2026-10-09');
    const leaderEarly = await add('お', 'leader', '2026-10-02');

    const listed = await list(target, admin, workspace.id);
    const sameName = [c, d1, d2].sort();
    expect(listed.members.map((member) => member.id)).toEqual([leaderEarly, leaderLate, a, b, ...sameName]);
    expect(listed.members.map((member) => member.role)).toEqual([
      'leader',
      'leader',
      'member',
      'member',
      'member',
      'member',
      'member',
    ]);
    expect(listed.members[0]).toEqual({
      id: leaderEarly,
      name: 'お',
      role: 'leader',
      joined_on: '2026-10-02',
    });
  });
});

describe('member-list: 承諾待ちの招待', () => {
  test('accepted、declined、revoked の招待は出ない。Google の招待は期限の内も外も出て、期限の日と切れたかを返す', async () => {
    const target = await createTarget();
    const { organization, workspace } = target;
    const inviter = target.admin.userId!;
    const github = (subject: string) => ({ provider: 'github', subject });
    for (const status of ['accepted', 'declined', 'revoked']) {
      await createInvitation(organization, workspace.id, inviter, github(`s-${status}`), {
        status,
        login_name: `gone-${status}`,
        responded_at: '2026-10-21T00:00:00.000Z',
      });
    }
    const google = (name: string, expiresAt: string, email: string) =>
      createInvitation(
        organization,
        workspace.id,
        inviter,
        { provider: 'google', subject: 'unused' },
        {
          login_name: name,
          login_subject: null,
          login_email: email,
          claim_token_hash: hash64(),
          claim_expires_at: expiresAt,
        },
      );
    await google('expired-google', '2020-01-01T00:00:00.000Z', 'expired@example.com');
    await google('valid-google', '2099-01-01T00:00:00.000Z', 'valid@example.com');
    // ほかのワークスペースの招待は出ない
    await createInvitation(organization, target.otherWorkspace.id, inviter, github('other'), {
      login_name: 'other-ws',
    });

    const listed = await list(target, target.leader);
    expect(
      listed.invitations
        ?.map((invitation) => [
          invitation.login_name,
          invitation.login_provider,
          invitation.expires_on,
          invitation.expired,
        ])
        .sort(),
    ).toEqual([
      ['expired-google', 'google', '2020-01-01', true],
      ['haruka-aoi', target.invitee.login.provider, null, false],
      ['valid-google', 'google', '2099-01-01', false],
    ]);
  });

  test('招待した日はワークスペースのタイムゾーンの日付', async () => {
    const target = await createTarget();
    const workspace = await createWorkspace(target.organization, target.admin.userId!, { timezone: 'Asia/Tokyo' });
    await createMembership(target.organization, workspace.id, target.leader.userId!, { role: 'leader' });
    // UTC では 10-20 の 16:00、東京では 10-21 の 01:00
    await createInvitation(
      target.organization,
      workspace.id,
      target.admin.userId!,
      { provider: 'github', subject: 'tz' },
      { created_at: '2026-10-20T16:00:00.000Z' },
    );
    const listed = await list(target, target.leader, workspace.id);
    expect(listed.invitations?.map((invitation) => invitation.invited_on)).toEqual(['2026-10-21']);
  });

  test('並びは招待した順（created_at）で、同じ時刻は ID の順', async () => {
    const target = await createTarget();
    const { organization, admin } = target;
    const workspace = await createWorkspace(organization, admin.userId!);
    const invite = async (name: string, createdAt: string, id: string) => {
      await createInvitation(
        organization,
        workspace.id,
        admin.userId!,
        { provider: 'github', subject: `order-${name}` },
        { id, login_name: name, created_at: createdAt },
      );
    };
    await invite('late', '2026-10-22T00:00:00.000Z', '019a0000-0000-7000-8000-0000000000a1');
    await invite('same-b', '2026-10-21T00:00:00.000Z', '019a0000-0000-7000-8000-0000000000b2');
    await invite('same-a', '2026-10-21T00:00:00.000Z', '019a0000-0000-7000-8000-0000000000b1');
    await invite('early', '2026-10-20T00:00:00.000Z', '019a0000-0000-7000-8000-0000000000c9');

    const listed = await list(target, admin, workspace.id);
    expect(listed.invitations?.map((invitation) => invitation.login_name)).toEqual([
      'early',
      'same-a',
      'same-b',
      'late',
    ]);
  });

  test('保存されたタイムゾーンが Intl で作れないワークスペースでも 200 で、招待した日は UTC の日付', async () => {
    const target = await createTarget();
    const { organization, admin } = target;
    const workspace = await createWorkspace(organization, admin.userId!, { timezone: 'Mars/Olympus' });
    await createInvitation(
      organization,
      workspace.id,
      admin.userId!,
      { provider: 'github', subject: 'broken-tz' },
      { created_at: '2026-10-20T16:00:00.000Z' },
    );
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

    const listed = await list(target, admin, workspace.id);
    expect(listed.invitations?.map((invitation) => invitation.invited_on)).toEqual(['2026-10-20']);
    // 例外の名前だけをログに残し、タイムゾーンの値は出さない
    const logged = errors.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.includes('保存されたタイムゾーン'));
    expect(logged).toHaveLength(1);
    expect(JSON.parse(logged[0]!)).toMatchObject({ level: 'error', operation: 'member-list', error: 'RangeError' });
    expect(logged[0]).not.toContain('Mars');
  });
});

describe('member-list: 閉じたワークスペース', () => {
  test('読む操作なので、閉じていても所属している人と招待を返す', async () => {
    const target = await createTarget({ closed: true });

    const leaderView = await list(target, target.leader);
    expect(leaderView.members.map((member) => member.id).sort()).toEqual(
      [target.leader.userId, target.member.userId].sort(),
    );
    expect(leaderView.invitations).toHaveLength(1);
    expect((await list(target, target.member)).invitations).toBeNull();
  });
});

describe('member-list: 別の組織', () => {
  test('別の組織のワークスペースの ID は 404 の not_found', async () => {
    const [target, other] = await Promise.all([createTarget(), createTarget()]);
    const res = await post(app, memberList, {
      slug: target.slug,
      token: target.admin.token,
      body: { workspace_id: other.workspace.id },
    });
    expect(res.status).toBe(404);
    expect(await errorCodeOf(res)).toBe('not_found');
  });
});
