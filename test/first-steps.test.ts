// 最初にやること（first-steps）の読み取り。ロールの決まり方、手順ごとの済みの判定、必須が済むと消えること、別の組織の行を数えないことを確かめる。
// 権限の種類ごとの許可と拒否、組織の分離（スラッグ）は、一覧を回す test/operation-registry.test.ts が確かめる
import { describe, expect, test } from 'vitest';
import { firstSteps } from '../src/shared/operations/organization/index.ts';
import { createApp } from '../src/server/app.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import {
  createInvitation,
  createMembership,
  createOrganization,
  createOrganizationHoliday,
  createSprint,
  createTask,
  createUser,
  createWorkspace,
} from './factories.ts';
import { post } from './operations/harness.ts';
import { createPerson, type Person } from './operations/world.ts';

const app = createApp(implementedOperations);

type View = {
  role: 'member' | 'leader' | 'admin' | null;
  steps: { key: string; done: boolean; optional: boolean; workspace: { id: string; name: string } | null }[];
};

async function read(slug: string, person: Person): Promise<View> {
  const res = await post(app, firstSteps, { slug, token: person.token });
  expect(res.status).toBe(200);
  return (await res.json()) as View;
}

const doneOf = (view: View) => Object.fromEntries(view.steps.map((step) => [step.key, step.done]));
const keysOf = (view: View) => view.steps.map((step) => step.key);

async function createWorld() {
  const organization = await createOrganization();
  const admin = await createPerson({ organization, admin: true });
  const workspace = await createWorkspace(organization, admin.userId!, { name: '青葉チーム' });
  const leader = await createPerson({ organization, membership: { workspaceId: workspace.id, role: 'leader' } });
  const member = await createPerson({ organization, membership: { workspaceId: workspace.id, role: 'member' } });
  return { organization, slug: organization.slug, admin, workspace, leader, member };
}

describe('first-steps: 一般', () => {
  test('起票していない一般は、手順を並びどおりに返し、起票の手順が未完で、今日やるの印は任意', async () => {
    const world = await createWorld();

    const view = await read(world.slug, world.member);

    expect(view.role).toBe('member');
    expect(view.steps).toEqual([
      {
        key: 'joined_workspace',
        done: true,
        optional: false,
        workspace: { id: world.workspace.id, name: '青葉チーム' },
      },
      { key: 'prepare_task', done: false, optional: false, workspace: { id: world.workspace.id, name: '青葉チーム' } },
      { key: 'mark_today', done: false, optional: true, workspace: { id: world.workspace.id, name: '青葉チーム' } },
    ]);
  });

  test('起票すると起票の手順が済み、必須がすべて済むので全体が消える（今日やるの印が未完でも）', async () => {
    const world = await createWorld();
    await createTask(world.organization, world.workspace.id, world.member.userId!);

    expect(await read(world.slug, world.member)).toEqual({ role: null, steps: [] });
  });

  test('ほかの人が起票したタスクと、取り込んだ担当のタスクは、起票の手順を済ませない', async () => {
    const world = await createWorld();
    await createTask(world.organization, world.workspace.id, world.leader.userId!, {
      assignee_user_id: world.member.userId,
    });

    const view = await read(world.slug, world.member);

    expect(doneOf(view).prepare_task).toBe(false);
  });

  test('削除したタスクでも、起票したことは変わらないので手順は済む', async () => {
    const world = await createWorld();
    await createTask(world.organization, world.workspace.id, world.member.userId!, {
      deleted_at: '2026-10-30T00:00:00.000Z',
    });

    expect((await read(world.slug, world.member)).role).toBeNull();
  });

  test('今日やるの印は、自分の担当のタスクに付いていれば済み。ほかの人の担当、削除したタスクは数えない', async () => {
    const world = await createWorld();
    const create = (overrides: Parameters<typeof createTask>[3]) =>
      createTask(world.organization, world.workspace.id, world.leader.userId!, overrides);
    await create({ assignee_user_id: world.leader.userId, today_on: '2026-11-01' });
    await create({
      assignee_user_id: world.member.userId,
      today_on: '2026-11-01',
      deleted_at: '2026-10-30T00:00:00.000Z',
    });
    await create({ assignee_user_id: world.member.userId, today_on: null });
    expect(doneOf(await read(world.slug, world.member)).mark_today).toBe(false);

    await create({ assignee_user_id: world.member.userId, today_on: '2026-11-01' });
    const view = await read(world.slug, world.member);
    expect(doneOf(view)).toEqual({ joined_workspace: true, prepare_task: false, mark_today: true });
    expect(view.role).toBe('member');
  });

  test('別の組織で起票しても、この組織の手順は済まない', async () => {
    const world = await createWorld();
    const other = await createWorld();
    // 同じ人が別の組織にも属する形にはせず、別の組織の人が起票した行は、この組織の一般に影響しない
    await createTask(other.organization, other.workspace.id, other.member.userId!);

    expect(doneOf(await read(world.slug, world.member)).prepare_task).toBe(false);
  });

  test('閉じたワークスペースと抜けたワークスペースは、手順の行き先にならない。閉じたワークスペースだけの人には何も出ない', async () => {
    const world = await createWorld();
    // あさひ班は名前順（文字コード順）で青葉チームより先
    const closed = await createWorkspace(world.organization, world.admin.userId!, {
      name: 'あさひ班',
      closed_at: '2026-10-22T00:00:00.000Z',
    });
    await createMembership(world.organization, closed.id, world.member.userId!);
    const left = await createWorkspace(world.organization, world.admin.userId!, { name: 'あおぞら班' });
    await createMembership(world.organization, left.id, world.member.userId!, {
      left_on: '2026-10-20',
      left_at: '2026-10-20T00:00:00.000Z',
    });

    const view = await read(world.slug, world.member);
    expect(view.steps[0]!.workspace).toEqual({ id: world.workspace.id, name: '青葉チーム' });

    const onlyClosed = await createPerson({
      organization: world.organization,
      membership: { workspaceId: closed.id, role: 'member' },
    });
    expect(await read(world.slug, onlyClosed)).toEqual({ role: null, steps: [] });
  });
});

// メンバーも招待も無い、リーダー1人のワークスペース
async function soloLeaderWorld() {
  const organization = await createOrganization();
  const admin = await createPerson({ organization, admin: true });
  const workspace = await createWorkspace(organization, admin.userId!, { name: '青葉チーム' });
  const leader = await createPerson({ organization, membership: { workspaceId: workspace.id, role: 'leader' } });
  return { organization, slug: organization.slug, admin, workspace, leader };
}

describe('first-steps: リーダー', () => {
  test('何も済んでいないリーダーは、招待とバックログの最初のタスクが必須で、スプリントが任意', async () => {
    const solo = await soloLeaderWorld();
    const view = await read(solo.slug, solo.leader);

    expect(view.role).toBe('leader');
    expect(view.steps.map(({ key, done, optional }) => ({ key, done, optional }))).toEqual([
      { key: 'became_leader', done: true, optional: false },
      { key: 'invite_members', done: false, optional: false },
      { key: 'first_backlog_task', done: false, optional: false },
      { key: 'start_sprint', done: false, optional: true },
    ]);
    expect(view.steps.every((step) => step.workspace?.id === solo.workspace.id)).toBe(true);
  });

  test('承諾待ちの招待を出すと招待の手順が済む。取り消した招待と辞退された招待は数えない', async () => {
    const world = await soloLeaderWorld();
    const invitee = await createPerson();
    await createInvitation(world.organization, world.workspace.id, world.leader.userId!, invitee.login, {
      status: 'revoked',
      responded_at: '2026-10-25T00:00:00.000Z',
    });
    await createInvitation(world.organization, world.workspace.id, world.leader.userId!, invitee.login, {
      status: 'declined',
      responded_at: '2026-10-25T00:00:00.000Z',
    });
    expect(doneOf(await read(world.slug, world.leader)).invite_members).toBe(false);

    await createInvitation(world.organization, world.workspace.id, world.leader.userId!, invitee.login);
    expect(doneOf(await read(world.slug, world.leader)).invite_members).toBe(true);
  });

  test('ほかのメンバーが今所属していれば招待の手順は済む。抜けた人は数えない', async () => {
    const world = await soloLeaderWorld();
    const gone = await createPerson({ organization: world.organization });
    await createMembership(world.organization, world.workspace.id, gone.userId!, {
      left_on: '2026-10-20',
      left_at: '2026-10-20T00:00:00.000Z',
    });
    expect(doneOf(await read(world.slug, world.leader)).invite_members).toBe(false);

    const joined = await createPerson({ organization: world.organization });
    await createMembership(world.organization, world.workspace.id, joined.userId!);
    expect(doneOf(await read(world.slug, world.leader)).invite_members).toBe(true);
  });

  test('バックログのタスクが1件あればバックログの手順が済む。受信箱、アーカイブ、削除したタスクは数えない', async () => {
    const world = await soloLeaderWorld();
    const create = (overrides: Parameters<typeof createTask>[3]) =>
      createTask(world.organization, world.workspace.id, world.admin.userId!, overrides);
    await create({ tray: 'inbox', is_imported: 1, created_by: null });
    await create({ tray: 'archive', is_imported: 1, created_by: null });
    await create({ deleted_at: '2026-10-30T00:00:00.000Z' });
    expect(doneOf(await read(world.slug, world.leader)).first_backlog_task).toBe(false);

    await create({});
    expect(doneOf(await read(world.slug, world.leader)).first_backlog_task).toBe(true);
  });

  test('スプリントは、始めたもの（進行中か終了）があれば済み。計画中と削除したものは数えない', async () => {
    const world = await soloLeaderWorld();
    await createSprint(world.organization, world.workspace.id, { status: 'planned' });
    await createSprint(world.organization, world.workspace.id, {
      status: 'active',
      deleted_at: '2026-10-30T00:00:00.000Z',
    });
    expect(doneOf(await read(world.slug, world.leader)).start_sprint).toBe(false);

    await createSprint(world.organization, world.workspace.id, { status: 'active' });
    expect(doneOf(await read(world.slug, world.leader)).start_sprint).toBe(true);
  });

  test('必須の2つが済むと消える。スプリントが未完でも消える。片方だけでは消えない', async () => {
    const world = await soloLeaderWorld();
    await createTask(world.organization, world.workspace.id, world.admin.userId!);
    const half = await read(world.slug, world.leader);
    expect(half.role).toBe('leader');
    expect(doneOf(half)).toMatchObject({ invite_members: false, first_backlog_task: true, start_sprint: false });

    const invitee = await createPerson();
    await createInvitation(world.organization, world.workspace.id, world.leader.userId!, invitee.login);

    expect(await read(world.slug, world.leader)).toEqual({ role: null, steps: [] });
  });

  test('2つのワークスペースのリーダーは、どちらかで済めば済み。未完の手順は名前順で先頭のワークスペースを指す', async () => {
    const world = await soloLeaderWorld();
    // 名前順（文字コード順）は あさひ班、青葉チーム。青葉チームにだけバックログのタスクがある
    const first = await createWorkspace(world.organization, world.admin.userId!, { name: 'あさひ班' });
    await createMembership(world.organization, first.id, world.leader.userId!, { role: 'leader' });
    await createTask(world.organization, world.workspace.id, world.admin.userId!);

    const view = await read(world.slug, world.leader);

    const byKey = Object.fromEntries(view.steps.map((step) => [step.key, step]));
    expect(byKey.first_backlog_task).toMatchObject({ done: true });
    expect(byKey.invite_members).toMatchObject({ done: false, workspace: { id: first.id, name: 'あさひ班' } });
    expect(byKey.start_sprint).toMatchObject({ done: false, workspace: { id: first.id } });
  });

  test('一般として所属しているだけのワークスペースの招待、タスクは、リーダーの手順に数えない', async () => {
    const world = await soloLeaderWorld();
    const other = await createWorkspace(world.organization, world.admin.userId!, { name: 'ひばり班' });
    await createMembership(world.organization, other.id, world.leader.userId!, { role: 'member' });
    await createTask(world.organization, other.id, world.admin.userId!);
    const invitee = await createPerson();
    await createInvitation(world.organization, other.id, world.admin.userId!, invitee.login);

    const view = await read(world.slug, world.leader);

    expect(doneOf(view)).toMatchObject({ invite_members: false, first_backlog_task: false });
  });

  test('閉じたワークスペースのリーダーは、そのワークスペースの手順を持たない', async () => {
    const world = await soloLeaderWorld();
    const closed = await createWorkspace(world.organization, world.admin.userId!, {
      closed_at: '2026-10-22T00:00:00.000Z',
    });
    const other = await createPerson({
      organization: world.organization,
      membership: { workspaceId: closed.id, role: 'leader' },
    });

    expect(await read(world.slug, other)).toEqual({ role: null, steps: [] });
  });
});

describe('first-steps: 管理者', () => {
  async function adminOnlyWorld() {
    const organization = await createOrganization();
    const admin = await createPerson({ organization, admin: true });
    return { organization, slug: organization.slug, admin };
  }

  test('ワークスペースが無い管理者は、ワークスペースを作る手順が必須で、招待と組織の休日は任意', async () => {
    const world = await adminOnlyWorld();

    const view = await read(world.slug, world.admin);

    expect(view.role).toBe('admin');
    expect(view.steps).toEqual([
      { key: 'became_admin', done: true, optional: false, workspace: null },
      { key: 'create_workspace', done: false, optional: false, workspace: null },
      { key: 'invite_by_admin', done: false, optional: true, workspace: null },
      { key: 'register_holiday', done: false, optional: true, workspace: null },
    ]);
  });

  test('組織にほかのユーザーがいれば招待の手順が済み、休日があれば休日の手順が済む。無効なユーザーは数えない', async () => {
    const world = await adminOnlyWorld();
    await createUser(world.organization, { disabled_at: '2026-10-21T00:00:00.000Z' });
    expect(doneOf(await read(world.slug, world.admin)).invite_by_admin).toBe(false);

    await createUser(world.organization);
    await createOrganizationHoliday(world.organization, world.admin.userId!);
    const view = await read(world.slug, world.admin);

    expect(doneOf(view)).toMatchObject({ invite_by_admin: true, register_holiday: true, create_workspace: false });
    expect(view.role).toBe('admin');
  });

  test('ワークスペースを作ると消える。所属しない管理者にも、ワークスペースがあれば何も出ない', async () => {
    const world = await adminOnlyWorld();
    await createWorkspace(world.organization, world.admin.userId!);

    expect(await read(world.slug, world.admin)).toEqual({ role: null, steps: [] });
  });

  test('閉じたワークスペースだけでも、ワークスペースを作った手順は済み、管理者の手順は消える', async () => {
    const world = await adminOnlyWorld();
    await createWorkspace(world.organization, world.admin.userId!, { closed_at: '2026-10-22T00:00:00.000Z' });

    expect(await read(world.slug, world.admin)).toEqual({ role: null, steps: [] });
  });

  test('管理者がワークスペースのリーダーになっていれば、リーダーの手順を出す', async () => {
    const world = await adminOnlyWorld();
    const workspace = await createWorkspace(world.organization, world.admin.userId!);
    await createMembership(world.organization, workspace.id, world.admin.userId!, { role: 'leader' });

    const view = await read(world.slug, world.admin);

    expect(view.role).toBe('leader');
    expect(keysOf(view)).toEqual(['became_leader', 'invite_members', 'first_backlog_task', 'start_sprint']);
  });

  test('別の組織のワークスペースは、この組織の管理者の手順を消さない', async () => {
    const world = await adminOnlyWorld();
    await createWorld();

    expect((await read(world.slug, world.admin)).role).toBe('admin');
  });

  test('別の組織の休日とユーザーは、この組織の任意の手順を済ませない', async () => {
    const world = await adminOnlyWorld();
    const other = await adminOnlyWorld();
    await createOrganizationHoliday(other.organization, other.admin.userId!);
    await createUser(other.organization);

    expect(doneOf(await read(world.slug, world.admin))).toMatchObject({
      invite_by_admin: false,
      register_holiday: false,
    });
  });
});
