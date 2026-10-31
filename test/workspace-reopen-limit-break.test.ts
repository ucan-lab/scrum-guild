// workspace-reopen の人数の上限（#284）を崩す手口。test/workspace-reopen-limit.test.ts と重ならないもの:
// 人数の数え方のすり抜け（ログインの手段の違い、管理者の招待、取り消し済みなどの招待）、順序（開いている、二度目、閉じ直し）、
// 権限と組織の越境で、断る前に何も漏らさず何も書かないこと
import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import { workspaceClose, workspaceReopen } from '../src/shared/operations/workspace/index.ts';
import { createApp } from '../src/server/app.ts';
import { commonDb, orgDb } from '../src/server/db/index.ts';
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
import { post } from './operations/harness.ts';
import { createPerson } from './operations/world.ts';

const app = createApp(implementedOperations);

const CLOSED_AT = '2026-10-22T00:00:00.000Z';
const DISABLED_AT = '2026-10-21T00:00:00.000Z';
const FUTURE_AT = '2999-01-01T00:00:00.000Z';

type Login = { provider: string; subject: string };

function newLogin(provider = 'github'): Login {
  return { provider, subject: `b-${crypto.randomUUID()}` };
}

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

function reopen(world: World, workspaceId: string, token = world.admin.token, slug = world.organization.slug) {
  return post(app, workspaceReopen, { slug, token, body: { workspace_id: workspaceId } });
}

async function workspaceRow(organization: OrganizationFixture, workspaceId: string) {
  const db = orgDb(env, organization.verified);
  return db.first(
    db.statement((q) =>
      q
        .selectFrom('workspaces')
        .select(['closed_at', 'updated_at'])
        .where('id', '=', workspaceId)
        .where('organization_id', '=', organization.id),
    ),
  );
}

async function changeLogCount(organization: OrganizationFixture, workspaceId: string) {
  const db = orgDb(env, organization.verified);
  const rows = await db.rows(
    db.statement((q) =>
      q
        .selectFrom('change_logs')
        .select('id')
        .where('organization_id', '=', organization.id)
        .where('workspace_id', '=', workspaceId)
        .where('action', 'in', ['reopen', 'close']),
    ),
  );
  return rows.length;
}

async function setMemberLimit(organization: OrganizationFixture, limit: number) {
  const db = commonDb(env);
  await db.run(
    db.statement((q) => q.updateTable('organizations').set({ member_limit: limit }).where('id', '=', organization.id)),
  );
}

describe('workspace-reopen の人数の上限を崩す', () => {
  test('同じ ID でもログインの手段が違えば別の人。無効にされた google の人と同じ ID の github の招待は adding に数える', async () => {
    const world = await setup(1);
    const subject = `b-${crypto.randomUUID()}`;
    await createUser(world.organization, {
      login_provider: 'google',
      login_subject: subject,
      disabled_at: DISABLED_AT,
    });
    await invite(world, world.closed.id, { provider: 'github', subject });

    const res = await reopen(world, world.closed.id);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: { code: 'member_limit_reached', details: { adding: 1 } } });
  });

  test('所属している google の人と同じ ID の github の招待は、別の人なので adding に数える', async () => {
    const world = await setup(15);
    const subject = `b-${crypto.randomUUID()}`;
    const member = await createUser(world.organization, { login_provider: 'google', login_subject: subject });
    await createMembership(world.organization, world.open.id, member.id);
    await invite(world, world.closed.id, { provider: 'github', subject });
    await setMemberLimit(world.organization, 2);

    const res = await reopen(world, world.closed.id);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: { details: { used: 2, limit: 2, adding: 1 } } });
  });

  test('管理者自身への招待は、すでに数えられているので adding 0。上限 1 でも開き直せる', async () => {
    const world = await setup(1);
    const db = orgDb(env, world.organization.verified);
    const row = await db.first(
      db.statement((q) =>
        q
          .selectFrom('users')
          .select(['login_provider', 'login_subject'])
          .where('id', '=', world.admin.userId!)
          .where('organization_id', '=', world.organization.id),
      ),
    );
    await invite(world, world.closed.id, { provider: row!.login_provider, subject: row!.login_subject! });
    const res = await reopen(world, world.closed.id);
    expect(res.status).toBe(200);
  });

  test('取り消し・承諾・辞退済みの招待は adding に数えず、人数がいっぱいでも開き直せる', async () => {
    const world = await setup(1);
    await invite(world, world.closed.id, newLogin(), { status: 'revoked' });
    await invite(world, world.closed.id, newLogin(), { status: 'accepted' });
    await invite(world, world.closed.id, newLogin(), { status: 'declined' });

    expect((await reopen(world, world.closed.id)).status).toBe(200);
  });

  test('上限を大きく超える数の招待でも adding はその全員になり、details に正しい数が載る', async () => {
    const world = await setup(15);
    for (let i = 0; i < 25; i++) await invite(world, world.closed.id);

    const res = await reopen(world, world.closed.id);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: { details: { used: 1, limit: 15, adding: 25 } } });
  });

  test('上限 +1 で断り、断った後は workspaces の行も change_logs も変わらない', async () => {
    const world = await setup(2);
    await invite(world, world.closed.id);
    await invite(world, world.closed.id);
    const before = await workspaceRow(world.organization, world.closed.id);

    const res = await reopen(world, world.closed.id);
    expect(res.status).toBe(409);
    expect(await workspaceRow(world.organization, world.closed.id)).toEqual(before);
    expect(await changeLogCount(world.organization, world.closed.id)).toBe(0);
  });

  test('開いているワークスペースの再開は、人数が上限を超えていても conflict で、member_limit_reached にならない', async () => {
    const world = await setup(1);
    await invite(world, world.open.id);
    await invite(world, world.open.id);

    const res = await reopen(world, world.open.id);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: { code: 'conflict' } });
  });

  test('再開を続けて呼ぶと、2回目は conflict で、change_logs は1行のまま', async () => {
    const world = await setup(15);
    await invite(world, world.closed.id);

    expect((await reopen(world, world.closed.id)).status).toBe(200);
    const second = await reopen(world, world.closed.id);
    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({ error: { code: 'conflict' } });
    expect(await changeLogCount(world.organization, world.closed.id)).toBe(1);
  });

  test('開き直して閉じ直すと、その招待の人は数えられなくなり、空いた枠で別のワークスペースを開き直せる。閉じ直した方は人数が足りなければ再び断られる', async () => {
    const world = await setup(2);
    const second = await createWorkspace(world.organization, world.admin.userId!, { closed_at: CLOSED_AT });
    await invite(world, world.closed.id);
    await invite(world, second.id);

    expect((await reopen(world, world.closed.id)).status).toBe(200);
    // used = 2 = 上限。second は新しい1人で断られる
    expect((await reopen(world, second.id)).status).toBe(409);

    const close = await post(app, workspaceClose, {
      slug: world.organization.slug,
      token: world.admin.token,
      body: { workspace_id: world.closed.id },
    });
    expect(close.status).toBe(200);
    // 閉じ直したので招待の人は数えない。second の再開は通る
    expect((await reopen(world, second.id)).status).toBe(200);
    // 閉じ直した方は、枠が埋まったので断られる
    const again = await reopen(world, world.closed.id);
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({
      error: { code: 'member_limit_reached', details: { used: 2, adding: 1 } },
    });
  });

  test('管理者でない人の再開は、人数の検査より先に 403 で断られ、人数の details を漏らさない', async () => {
    const world = await setup(1);
    await invite(world, world.closed.id);
    const member = await createPerson({
      organization: world.organization,
      membership: { workspaceId: world.open.id, role: 'member' },
    });

    const res = await reopen(world, world.closed.id, member.token);
    const text = await res.text();
    expect(res.status).toBe(403);
    expect(text).not.toContain('member_limit_reached');
    expect(text).not.toContain('details');
    expect((await workspaceRow(world.organization, world.closed.id))?.closed_at).toBe(CLOSED_AT);
  });

  test('別の組織の閉じたワークスペースの ID は 404。上限の検査にも書き込みにも進まない', async () => {
    const world = await setup(1);
    await invite(world, world.closed.id);
    const other = await setup(15);
    await invite(other, other.closed.id);

    const res = await reopen(world, other.closed.id);
    expect(res.status).toBe(404);
    expect((await workspaceRow(other.organization, other.closed.id))?.closed_at).toBe(CLOSED_AT);
    expect(await changeLogCount(other.organization, other.closed.id)).toBe(0);
  });

  test('段階を下げて人数が上限を超えている（used > limit）組織でも、adding が 1 以上の再開は断られ、details の数は正しい', async () => {
    const world = await setup(15);
    for (let i = 0; i < 2; i++) {
      const member = await createUser(world.organization, {
        login_provider: 'github',
        login_subject: `b-${crypto.randomUUID()}`,
      });
      await createMembership(world.organization, world.open.id, member.id);
    }
    await invite(world, world.closed.id);
    await setMemberLimit(world.organization, 1);

    const res = await reopen(world, world.closed.id);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      error: { code: 'member_limit_reached', details: { used: 3, limit: 1, adding: 1 } },
    });
    expect((await workspaceRow(world.organization, world.closed.id))?.closed_at).toBe(CLOSED_AT);
    expect(await changeLogCount(world.organization, world.closed.id)).toBe(0);
  });

  // 既存の限界の固定。人数の数え方（docs/data-model.md の organizations の「人数」と、メールアドレスで待つ指名と招待）は、
  // sub の行を (login_provider, login_subject)、待つ行を (login_provider, login_email) で見分けるので、
  // 同じ人でも「メールで待つ招待」と「sub を持つ所属」は別々に数える。開き直しの adding も同じ数え方に従う
  test('メール待ちの招待と sub を持つ同一人物は別々に数える既存の限界。上限ちょうどの組織では、本来 adding 0 のはずの再開が断られる', async () => {
    const world = await setup(3);
    const email = `member-${crypto.randomUUID()}@example.com`;
    const sub = `b-${crypto.randomUUID()}`;
    const member = await createUser(world.organization, {
      login_provider: 'google',
      login_subject: sub,
    });
    await createMembership(world.organization, world.open.id, member.id);
    const other = await createUser(world.organization, { login_provider: 'github', login_subject: newLogin().subject });
    await createMembership(world.organization, world.open.id, other.id);
    await createInvitation(
      world.organization,
      world.closed.id,
      world.admin.userId!,
      { provider: 'google', subject: '' },
      { login_subject: null, login_email: email, claim_token_hash: hash64(), claim_expires_at: FUTURE_AT },
    );

    // used = 管理者、メンバー、もう1人 = 3 = 上限。メール待ちの招待は google:email:<email>、所属は google:subject:<sub> で別の人
    const res = await reopen(world, world.closed.id);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      error: { code: 'member_limit_reached', details: { used: 3, limit: 3, adding: 1 } },
    });
    expect((await workspaceRow(world.organization, world.closed.id))?.closed_at).toBe(CLOSED_AT);
  });
});
