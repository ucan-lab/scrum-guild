// ユーザーを有効に戻す操作（user-enable）が、組織の人数の上限（member_limit）を見る振る舞い（#577）。
// 無効にした人への承諾待ちの招待は人数に数えないので、無効の間に作った招待は、有効に戻すとその人が新しく数えられる。
// 新しく数えられる人（adding）が1人以上で、今の人数（used）に足すと上限を超えるときだけ、409 の member_limit_reached で断る。
// 断るときは何も書かない（users.disabled_at も、変更の履歴も、無効の間に作った招待も変わらない）。
// 先行例は test/workspace-reopen-limit.test.ts。権限と組織の分離の一覧は test/operation-registry.test.ts が回す
import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import { userDisable, userEnable } from '../src/shared/operations/organization/index.ts';
import { createApp } from '../src/server/app.ts';
import { commonDb, orgDb, seatHoldersOf } from '../src/server/db/index.ts';
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
import { createPerson, type Person } from './operations/world.ts';

const app = createApp(implementedOperations);

const EXPIRED_AT = '2026-10-01T00:00:00.000Z';
const FUTURE_AT = '2999-01-01T00:00:00.000Z';
const CLOSED_AT = '2026-10-22T00:00:00.000Z';

type Login = { provider: string; subject: string };

function newLogin(): Login {
  return { provider: 'github', subject: `u-${crypto.randomUUID()}` };
}

// 組織（上限つき）と、人数に数えられる管理者1人と、開いたワークスペース V と、閉じたワークスペース W
async function setup(limit: number) {
  const organization = await createOrganization({ member_limit: limit });
  const admin = await createPerson({ organization, admin: true });
  const open = await createWorkspace(organization, admin.userId!);
  const closed = await createWorkspace(organization, admin.userId!, { closed_at: CLOSED_AT });
  return { organization, admin, open, closed };
}
type World = Awaited<ReturnType<typeof setup>>;

function dbOf(organization: OrganizationFixture) {
  return orgDb(env, organization.verified);
}

// 今所属する、無効でない人を1人足す（人数に1人増える）
async function addMember(world: World, workspaceId: string = world.open.id) {
  const user = await createUser(world.organization, {
    login_provider: 'github',
    login_subject: `u-${crypto.randomUUID()}`,
  });
  await createMembership(world.organization, workspaceId, user.id);
  return user;
}

// 無効の間に作った招待（無効にした日時より後。user-enable が取り消すのは無効にする前に作った招待だけ）
function reinvite(
  world: World,
  workspaceId: string,
  login: Login,
  overrides: Parameters<typeof createInvitation>[4] = {},
) {
  return createInvitation(world.organization, workspaceId, world.admin.userId!, login, {
    created_at: FUTURE_AT,
    ...overrides,
  });
}

function disable(world: World, userId: string) {
  return post(app, userDisable, {
    slug: world.organization.slug,
    token: world.admin.token,
    body: { user_id: userId },
  });
}

function enable(world: World, userId: string) {
  return post(app, userEnable, {
    slug: world.organization.slug,
    token: world.admin.token,
    body: { user_id: userId },
  });
}

async function errorOf(res: Response) {
  return (await res.json()) as { error: { code: string; details?: unknown } };
}

async function disabledAtOf(world: World, userId: string) {
  const db = dbOf(world.organization);
  const row = await db.first(
    db.statement((q) =>
      q
        .selectFrom('users')
        .select('disabled_at')
        .where('id', '=', userId)
        .where('organization_id', '=', world.organization.id),
    ),
  );
  return row?.disabled_at;
}

async function userLogCount(world: World, userId: string): Promise<number> {
  const db = dbOf(world.organization);
  const rows = await db.rows(
    db.statement((q) =>
      q
        .selectFrom('change_logs')
        .select('id')
        .where('organization_id', '=', world.organization.id)
        .where('entity_type', '=', 'user')
        .where('entity_id', '=', userId),
    ),
  );
  return rows.length;
}

async function invitationStatus(world: World, invitationId: string) {
  const db = dbOf(world.organization);
  const row = await db.first(
    db.statement((q) =>
      q
        .selectFrom('invitations')
        .select('status')
        .where('id', '=', invitationId)
        .where('workspace_id', 'in', (eb) =>
          eb.selectFrom('workspaces').select('id').where('organization_id', '=', world.organization.id),
        ),
    ),
  );
  return row?.status;
}

async function setMemberLimit(organization: OrganizationFixture, limit: number): Promise<void> {
  const db = commonDb(env);
  await db.run(
    db.statement((q) => q.updateTable('organizations').set({ member_limit: limit }).where('id', '=', organization.id)),
  );
}

async function seatCount(world: World): Promise<number> {
  return (await seatHoldersOf(dbOf(world.organization), new Date())).size;
}

// 所属のあった人を、user-disable で無効にする（所属は終わり、人数から外れる）
async function disabledPerson(world: World, options: { login?: Login } = {}): Promise<Person> {
  const person = await createPerson({
    organization: world.organization,
    ...(options.login === undefined ? {} : { login: options.login }),
    membership: { workspaceId: world.open.id, role: 'member' },
  });
  expect((await disable(world, person.userId!)).status).toBe(200);
  return person;
}

// 断った後に、何も書かれていないこと
async function expectRefused(
  world: World,
  person: Person,
  invitationId: string,
  details: { used: number; limit: number; adding: number },
) {
  const logsBefore = await userLogCount(world, person.userId!);
  const stamp = await disabledAtOf(world, person.userId!);
  expect(stamp).not.toBeNull();

  const res = await enable(world, person.userId!);
  expect(res.status).toBe(409);
  const body = await errorOf(res);
  expect(body.error.code).toBe('member_limit_reached');
  expect(body.error.details).toEqual(details);

  expect(await disabledAtOf(world, person.userId!)).toBe(stamp);
  expect(await userLogCount(world, person.userId!)).toBe(logsBefore);
  expect(await invitationStatus(world, invitationId)).toBe('pending');
}

async function expectEnabled(world: World, person: Person) {
  const logsBefore = await userLogCount(world, person.userId!);
  const res = await enable(world, person.userId!);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ user_id: person.userId, is_admin: false, disabled_at: null });
  expect(await disabledAtOf(world, person.userId!)).toBeNull();
  expect(await userLogCount(world, person.userId!)).toBe(logsBefore + 1);
}

describe('user-enable の人数の上限', () => {
  test('無効の間に招待し直した人は、上限まで埋まった後に有効に戻そうとすると 409 の member_limit_reached で、details に used・limit・adding を載せ、何も書かない', async () => {
    // 筋書き: 1) 無効にする 2) 人数が上限未満のうちに招待し直す 3) 別の人を上限まで増やす 4) 有効に戻す
    const world = await setup(3);
    const person = await disabledPerson(world);
    const invitation = await reinvite(world, world.open.id, person.login);
    // 無効の人への招待は人数に数えないので、まだ管理者1人
    expect(await seatCount(world)).toBe(1);
    await addMember(world);
    await addMember(world);
    expect(await seatCount(world)).toBe(3);

    await expectRefused(world, person, invitation.id, { used: 3, limit: 3, adding: 1 });
  });

  test('断られた後、上限を上げると同じ人を有効に戻せ、招待はそのまま承諾待ちで残る', async () => {
    const world = await setup(3);
    const person = await disabledPerson(world);
    const invitation = await reinvite(world, world.open.id, person.login);
    await addMember(world);
    await addMember(world);
    await expectRefused(world, person, invitation.id, { used: 3, limit: 3, adding: 1 });

    await setMemberLimit(world.organization, 4);
    await expectEnabled(world, person);
    expect(await invitationStatus(world, invitation.id)).toBe('pending');
    expect(await seatCount(world)).toBe(4);
  });

  test('ちょうど上限に達する有効化は通る', async () => {
    const world = await setup(3);
    const person = await disabledPerson(world);
    const invitation = await reinvite(world, world.open.id, person.login);
    await addMember(world);
    // used = 2、adding = 1、合計 3 = 上限

    await expectEnabled(world, person);
    expect(await invitationStatus(world, invitation.id)).toBe('pending');
    expect(await seatCount(world)).toBe(3);
  });

  test('エラーのコードは member_limit_reached で、ほかのコードと取り違えない', async () => {
    const world = await setup(2);
    const person = await disabledPerson(world);
    await reinvite(world, world.open.id, person.login);
    await addMember(world);

    expect(await errorCodeOf(await enable(world, person.userId!))).toBe('member_limit_reached');
  });

  test('招待の無い人（adding = 0）は、人数が上限を超えている組織でも通る', async () => {
    const world = await setup(15);
    const person = await disabledPerson(world);
    await addMember(world);
    await addMember(world);
    await setMemberLimit(world.organization, 1);
    expect(await seatCount(world)).toBe(3);

    await expectEnabled(world, person);
  });

  test('招待の無い人（adding = 0）は、ちょうど上限の組織でも通る', async () => {
    const world = await setup(2);
    const person = await disabledPerson(world);
    await addMember(world);

    await expectEnabled(world, person);
  });

  // Google の招待はメールアドレスで待つ行（login_subject が空）で、期限の切れた行は本人のログインに結ばれないまま残る。
  // 結ばれた行は claim の列が空になるので、期限の過ぎた Google の招待が本人のログインの行になることは無い
  test('期限の過ぎた Google の招待（メールアドレスで待つ行）しか無い人は adding に数えず、上限いっぱいでも通る', async () => {
    const world = await setup(2);
    const person = await disabledPerson(world);
    const invitation = await reinvite(
      world,
      world.open.id,
      { provider: 'google', subject: '' },
      {
        login_subject: null,
        login_email: 'mio@example.test',
        claim_token_hash: hash64(),
        claim_expires_at: EXPIRED_AT,
      },
    );
    await addMember(world);
    expect(await seatCount(world)).toBe(2);

    await expectEnabled(world, person);
    expect(await invitationStatus(world, invitation.id)).toBe('pending');
  });

  test('閉じたワークスペースへの招待しか無い人は adding に数えず、上限いっぱいでも通る', async () => {
    const world = await setup(2);
    const person = await disabledPerson(world);
    const invitation = await reinvite(world, world.closed.id, person.login);
    await addMember(world);

    await expectEnabled(world, person);
    expect(await invitationStatus(world, invitation.id)).toBe('pending');
  });

  test('承諾待ちでない招待（取り消し済み、辞退済み）しか無い人は adding に数えず、上限いっぱいでも通る', async () => {
    const world = await setup(2);
    const person = await disabledPerson(world);
    await reinvite(world, world.open.id, person.login, { status: 'revoked', responded_at: FUTURE_AT });
    await reinvite(world, world.open.id, person.login, { status: 'declined', responded_at: FUTURE_AT });
    await addMember(world);

    await expectEnabled(world, person);
  });

  test('同じ人への招待が複数のワークスペースにあっても adding は 1 人', async () => {
    const world = await setup(3);
    const person = await disabledPerson(world);
    const second = await createWorkspace(world.organization, world.admin.userId!);
    const first = await reinvite(world, world.open.id, person.login);
    await reinvite(world, second.id, person.login);
    await addMember(world);
    await addMember(world);

    await expectRefused(world, person, first.id, { used: 3, limit: 3, adding: 1 });
  });

  test('招待の無い、無効の管理者の行（有効にすると管理者として数えられる）は、新しく数える人を求めず、上限いっぱいでも通る', async () => {
    const world = await setup(2);
    const user = await createUser(world.organization, {
      login_provider: 'github',
      login_subject: `u-${crypto.randomUUID()}`,
      is_admin: 1,
      disabled_at: '2026-10-21T00:00:00.000Z',
    });
    await addMember(world);
    expect(await seatCount(world)).toBe(2);

    const res = await enable(world, user.id);
    expect(res.status).toBe(200);
    expect(await disabledAtOf(world, user.id)).toBeNull();
  });

  test('すでに有効な人を有効に戻す操作は何も書かず、招待があって上限いっぱいでも 200 を返す', async () => {
    const world = await setup(2);
    const member = await createPerson({
      organization: world.organization,
      membership: { workspaceId: world.open.id, role: 'member' },
    });
    // 管理者と所属の人で used = 2 = 上限。所属の人への別の招待は、同じ人なので数え直さない
    const invitation = await reinvite(world, world.closed.id, member.login);
    const logsBefore = await userLogCount(world, member.userId!);

    const res = await enable(world, member.userId!);
    expect(res.status).toBe(200);
    expect(await userLogCount(world, member.userId!)).toBe(logsBefore);
    expect(await invitationStatus(world, invitation.id)).toBe('pending');
  });
});

describe('user-enable の人数の上限の組織の分離', () => {
  test('別の組織の招待や所属は used と adding に影響しない', async () => {
    const world = await setup(2);
    const person = await disabledPerson(world);
    const invitation = await reinvite(world, world.open.id, person.login);
    await addMember(world);

    // 別の組織に、同じログインの招待と所属と、たくさんの人がいる
    const other = await setup(15);
    await reinvite(other, other.open.id, person.login);
    await addMember(other);
    await addMember(other);
    const otherUser = await createUser(other.organization, {
      login_provider: person.login.provider,
      login_subject: person.login.subject,
    });
    await createMembership(other.organization, other.open.id, otherUser.id);

    await expectRefused(world, person, invitation.id, { used: 2, limit: 2, adding: 1 });
  });

  test('別の組織だけに招待のある人は、この組織では adding = 0 で、上限いっぱいでも通る', async () => {
    const world = await setup(2);
    const person = await disabledPerson(world);
    await addMember(world);

    const other = await setup(15);
    await reinvite(other, other.open.id, person.login);

    await expectEnabled(world, person);
  });

  test('別の組織が上限いっぱいでも、この組織の有効化はこの組織の人数だけで決まる', async () => {
    const world = await setup(3);
    const person = await disabledPerson(world);
    await reinvite(world, world.open.id, person.login);

    const other = await setup(1);
    await reinvite(other, other.open.id, newLogin());

    await expectEnabled(world, person);
  });

  test('別の組織の ID のユーザーは、存在しないときと同じ 404 で、上限の検査より先に断る', async () => {
    const world = await setup(1);
    const other = await setup(15);
    const person = await disabledPerson(other);
    await reinvite(other, other.open.id, person.login);

    const res = await enable(world, person.userId!);
    expect(res.status).toBe(404);
    expect(await disabledAtOf(other, person.userId!)).not.toBeNull();
  });
});
