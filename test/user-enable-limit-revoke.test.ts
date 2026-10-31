// user-enable の人数の検査（#577）と、同じ操作が取り消す招待の食い違い。
// 無効にする前に作った承諾待ちの招待は、有効に戻す同じ batch で取り消される。取り消される招待は、有効に戻した後に人を人数へ加えないので、
// 人数の検査でも数えない。数えるのは、無効にした日時以後に作った招待（無効の間に招待し直したもの）だけ。
// 無効の間に、無効にする前に作った Google のメールアドレスの招待を本人が結ぶと、招待の created_at は無効にする前のまま
// login_subject が埋まる（docs/data-model.md の「メールアドレスで待つ指名と招待」）。この形をテストで作る
import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import { userDisable, userEnable } from '../src/shared/operations/organization/index.ts';
import { createApp } from '../src/server/app.ts';
import { orgDb } from '../src/server/db/index.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import { createInvitation, createMembership, createOrganization, createUser, createWorkspace } from './factories.ts';
import { post } from './operations/harness.ts';
import { createPerson } from './operations/world.ts';

const app = createApp(implementedOperations);

const BEFORE_DISABLE_AT = '2000-01-01T00:00:00.000Z';
const AFTER_DISABLE_AT = '2999-01-01T00:00:00.000Z';

// 組織（上限つき）と、人数に数えられる管理者1人と、開いたワークスペース
async function setup(limit: number) {
  const organization = await createOrganization({ member_limit: limit });
  const admin = await createPerson({ organization, admin: true });
  const open = await createWorkspace(organization, admin.userId!);
  return { organization, admin, open };
}
type World = Awaited<ReturnType<typeof setup>>;

async function addMember(world: World) {
  const user = await createUser(world.organization, {
    login_provider: 'github',
    login_subject: `u-${crypto.randomUUID()}`,
  });
  await createMembership(world.organization, world.open.id, user.id);
}

async function disabledPerson(world: World) {
  const person = await createPerson({
    organization: world.organization,
    membership: { workspaceId: world.open.id, role: 'member' },
  });
  const res = await post(app, userDisable, {
    slug: world.organization.slug,
    token: world.admin.token,
    body: { user_id: person.userId! },
  });
  expect(res.status).toBe(200);
  return person;
}

function enable(world: World, userId: string) {
  return post(app, userEnable, {
    slug: world.organization.slug,
    token: world.admin.token,
    body: { user_id: userId },
  });
}

function invite(
  world: World,
  login: { provider: string; subject: string },
  createdAt: string,
  workspaceId: string = world.open.id,
) {
  return createInvitation(world.organization, workspaceId, world.admin.userId!, login, { created_at: createdAt });
}

async function invitationStatus(world: World, invitationId: string) {
  const db = orgDb(env, world.organization.verified);
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

describe('user-enable の人数の検査と、同じ操作が取り消す招待', () => {
  test('無効にする前に作った招待しか持たない人は、上限いっぱいでも有効に戻せ、その招待は取り消される', async () => {
    const world = await setup(2);
    const person = await disabledPerson(world);
    // 無効の間に本人が結んだ、無効にする前に作った招待（承諾待ちで残っている）
    const stale = await invite(world, person.login, BEFORE_DISABLE_AT);
    await addMember(world);
    // 人数は管理者と1人で、上限の 2 人いっぱい

    const res = await enable(world, person.userId!);
    expect(res.status).toBe(200);
    expect(await invitationStatus(world, stale.id)).toBe('revoked');
  });

  test('無効にする前に作った招待と、無効の間に作った招待が両方ある人は、上限いっぱいなら断る（無効の間の招待は残る）', async () => {
    const world = await setup(2);
    const person = await disabledPerson(world);
    await invite(world, person.login, BEFORE_DISABLE_AT);
    // 同じワークスペースには承諾待ちの招待を2つ作れないので、無効の間の招待は別のワークスペースに作る
    const other = await createWorkspace(world.organization, world.admin.userId!);
    const fresh = await invite(world, person.login, AFTER_DISABLE_AT, other.id);
    await addMember(world);

    const res = await enable(world, person.userId!);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string; details?: unknown } };
    expect(body.error.code).toBe('member_limit_reached');
    expect(body.error.details).toEqual({ used: 2, limit: 2, adding: 1 });
    expect(await invitationStatus(world, fresh.id)).toBe('pending');
  });
});
