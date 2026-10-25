// 組織の選択と組織の枠の操作（my-organizations、organization）の振る舞い。
// 組織の分離と権限は一覧を回す test/operation-registry.test.ts が確かめる
import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import { myOrganizations, organizationInfo } from '../src/shared/operations/organization/index.ts';
import { createApp } from '../src/server/app.ts';
import { orgDb } from '../src/server/db/index.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import {
  AT,
  createAccount,
  createAccountLogin,
  createInvitation,
  createMembership,
  createOrganization,
  createSessionWithToken,
  createUser,
  createWorkspace,
  type OrganizationFixture,
} from './factories.ts';
import { post } from './operations/harness.ts';
import { createPerson, getOperator } from './operations/world.ts';

const app = createApp(implementedOperations);

// 1つのアカウントとセッション。組織ごとに users の行を足して使う
async function createVisitor() {
  const account = await createAccount();
  const login = await createAccountLogin(account.id);
  const { token } = await createSessionWithToken(account.id);
  const identity = { provider: login.login_provider, subject: login.login_subject };
  const join = (organization: OrganizationFixture, overrides: Parameters<typeof createUser>[1] = {}) =>
    createUser(organization, {
      account_id: account.id,
      login_provider: identity.provider,
      login_subject: identity.subject,
      ...overrides,
    });
  return { account, token, identity, join };
}

async function listOrganizations(token: string) {
  const res = await post(app, myOrganizations, { token });
  expect(res.status).toBe(200);
  return (await res.json()) as {
    organizations: { slug: string; name: string }[];
    invitations: { organization_name: string }[];
    operator: boolean;
  };
}

describe('my-organizations', () => {
  test('管理者の組織と、ワークスペースに所属している組織を名前順に返す', async () => {
    const visitor = await createVisitor();
    const aoba = await createOrganization({ name: 'あおば開発' });
    const hibari = await createOrganization({ name: 'ひばり工房' });
    await visitor.join(aoba, { is_admin: 1 });
    const hibariUser = await visitor.join(hibari);
    const owner = await createUser(hibari, { is_admin: 1 });
    const workspace = await createWorkspace(hibari, owner.id);
    await createMembership(hibari, workspace.id, hibariUser.id);

    const result = await listOrganizations(visitor.token);
    expect(result.organizations).toEqual([
      { slug: aoba.slug, name: 'あおば開発' },
      { slug: hibari.slug, name: 'ひばり工房' },
    ]);
    expect(result.invitations).toEqual([]);
    expect(result.operator).toBe(false);
  });

  test('users の行があっても、管理者でも所属もない組織と、離れたワークスペースだけの組織は返さない', async () => {
    const visitor = await createVisitor();
    const idle = await createOrganization();
    await visitor.join(idle);
    const left = await createOrganization();
    const owner = await createUser(left, { is_admin: 1 });
    const workspace = await createWorkspace(left, owner.id);
    const leftUser = await visitor.join(left);
    await createMembership(left, workspace.id, leftUser.id, { left_at: AT, left_on: '2026-10-10' });

    expect(await listOrganizations(visitor.token)).toEqual({ organizations: [], invitations: [], operator: false });
  });

  test('承諾待ちの招待だけの組織は、組織の名前だけを招待に出す', async () => {
    const visitor = await createVisitor();
    const invitedOnly = await createOrganization({ name: '招待だけの工房' });
    const owner = await createUser(invitedOnly, { is_admin: 1 });
    const workspace = await createWorkspace(invitedOnly, owner.id);
    await createInvitation(invitedOnly, workspace.id, owner.id, visitor.identity);
    // 承諾済みと辞退済みの招待は出さない
    await createInvitation(invitedOnly, workspace.id, owner.id, visitor.identity, {
      status: 'declined',
      responded_at: AT,
    });

    const result = await listOrganizations(visitor.token);
    expect(result.organizations).toEqual([]);
    expect(result.invitations).toEqual([{ organization_name: '招待だけの工房' }]);
    expect(JSON.stringify(result)).not.toContain(invitedOnly.slug);
  });

  test('入れる組織に招待が重なっても、招待には出さない', async () => {
    const visitor = await createVisitor();
    const organization = await createOrganization({ name: '入れる工房' });
    const user = await visitor.join(organization, { is_admin: 1 });
    const workspace = await createWorkspace(organization, user.id);
    await createInvitation(organization, workspace.id, user.id, visitor.identity);

    const result = await listOrganizations(visitor.token);
    expect(result.organizations.map((item) => item.name)).toEqual(['入れる工房']);
    expect(result.invitations).toEqual([]);
  });

  test('無効にされた人と、停止した組織は、どちらも出さない', async () => {
    const visitor = await createVisitor();
    const disabledOrganization = await createOrganization();
    await visitor.join(disabledOrganization, { is_admin: 1, disabled_at: AT });
    const suspended = await createOrganization({ suspended_at: AT });
    await visitor.join(suspended, { is_admin: 1 });
    // アカウントに結ばれる前に無効にされた行（手段と ID で当てる）は、招待があっても止める
    const disabledByLogin = await createOrganization();
    const owner = await createUser(disabledByLogin, { is_admin: 1 });
    const workspace = await createWorkspace(disabledByLogin, owner.id);
    await createUser(disabledByLogin, {
      login_provider: visitor.identity.provider,
      login_subject: visitor.identity.subject,
      disabled_at: AT,
    });
    await createInvitation(disabledByLogin, workspace.id, owner.id, visitor.identity);

    expect(await listOrganizations(visitor.token)).toEqual({ organizations: [], invitations: [], operator: false });
  });

  test('ほかの人の組織と招待は出さない', async () => {
    const visitor = await createVisitor();
    await createPerson({ organization: await createOrganization(), admin: true });
    expect(await listOrganizations(visitor.token)).toEqual({ organizations: [], invitations: [], operator: false });
  });

  test('運用者のログインには operator が真で、入れる組織が無くても返る', async () => {
    const operator = await getOperator();
    expect(await listOrganizations(operator.token)).toEqual({ organizations: [], invitations: [], operator: true });
  });
});

async function readOrganization(slug: string, token: string) {
  const res = await post(app, organizationInfo, { slug, token });
  expect(res.status).toBe(200);
  return (await res.json()) as {
    organization: { name: string; vocabulary: string; theme: string };
    me: { id: string; name: string; is_admin: boolean; theme: string | null };
    workspaces: { id: string; name: string; role: string }[];
  };
}

async function readLastSeen(organization: OrganizationFixture, userId: string): Promise<string | null> {
  const db = orgDb(env, organization.verified);
  const row = await db.first(
    db.statement((q) =>
      q
        .selectFrom('users')
        .select('last_seen_at')
        .where('id', '=', userId)
        .where('organization_id', '=', organization.id),
    ),
  );
  return row?.last_seen_at ?? null;
}

describe('organization', () => {
  test('組織の名前、言葉づかい、既定のテーマと、この組織での自分と所属するワークスペースを返す', async () => {
    const organization = await createOrganization({ name: '青葉工房', vocabulary: 'scrum', theme: 'medieval' });
    const person = await createPerson({ organization });
    const owner = await createUser(organization, { is_admin: 1 });
    const second = await createWorkspace(organization, owner.id, { name: 'う開発' });
    const first = await createWorkspace(organization, owner.id, { name: 'あ開発' });
    // 所属しないワークスペースと、離れたワークスペースは出さない
    await createWorkspace(organization, owner.id, { name: '所属しない' });
    const left = await createWorkspace(organization, owner.id, { name: '離れた' });
    await createMembership(organization, second.id, person.userId!, { role: 'leader' });
    await createMembership(organization, first.id, person.userId!);
    await createMembership(organization, left.id, person.userId!, { left_at: AT, left_on: '2026-10-10' });

    const result = await readOrganization(organization.slug, person.token);
    expect(result.organization).toEqual({ name: '青葉工房', vocabulary: 'scrum', theme: 'medieval' });
    expect(result.me).toEqual({ id: person.userId, name: '星野 澪', is_admin: false, theme: null });
    expect(result.workspaces).toEqual([
      { id: first.id, name: 'あ開発', role: 'member' },
      { id: second.id, name: 'う開発', role: 'leader' },
    ]);
  });

  test('管理者の印と自分のテーマは、組織ごとに別の値を返す', async () => {
    const visitor = await createVisitor();
    const a = await createOrganization({ theme: 'modern' });
    const b = await createOrganization({ theme: 'simple_dark' });
    await visitor.join(a, { is_admin: 1, name: 'ミナト', theme: 'medieval' });
    const bUser = await visitor.join(b, { name: 'ミナ' });
    const owner = await createUser(b, { is_admin: 1 });
    const workspace = await createWorkspace(b, owner.id);
    await createMembership(b, workspace.id, bUser.id);

    const inA = await readOrganization(a.slug, visitor.token);
    expect(inA.me).toMatchObject({ name: 'ミナト', is_admin: true, theme: 'medieval' });
    expect(inA.organization.theme).toBe('modern');
    expect(inA.workspaces).toEqual([]);
    const inB = await readOrganization(b.slug, visitor.token);
    expect(inB.me).toMatchObject({ name: 'ミナ', is_admin: false, theme: null });
    expect(inB.organization.theme).toBe('simple_dark');
  });

  test('last_seen_at は初めて入ったときに書き、1時間たつまで書き直さない', async () => {
    const organization = await createOrganization();
    const person = await createPerson({ organization, admin: true });
    const userId = person.userId!;
    expect(await readLastSeen(organization, userId)).toBeNull();

    await readOrganization(organization.slug, person.token);
    const first = await readLastSeen(organization, userId);
    expect(first).not.toBeNull();
    expect(Date.now() - Date.parse(first!)).toBeLessThan(60_000);

    // すぐ後の呼び出しは書かない
    await readOrganization(organization.slug, person.token);
    expect(await readLastSeen(organization, userId)).toBe(first);

    // 1時間に満たない前の値は書き直さない
    const recent = new Date(Date.now() - 59 * 60 * 1000).toISOString();
    const db = orgDb(env, organization.verified);
    await db.batch([
      db.statement((q) =>
        q
          .updateTable('users')
          .set({ last_seen_at: recent })
          .where('id', '=', userId)
          .where('organization_id', '=', organization.id),
      ),
    ]);
    await readOrganization(organization.slug, person.token);
    expect(await readLastSeen(organization, userId)).toBe(recent);

    // 1時間以上前の値は書き直す
    const stale = new Date(Date.now() - 61 * 60 * 1000).toISOString();
    await db.batch([
      db.statement((q) =>
        q
          .updateTable('users')
          .set({ last_seen_at: stale })
          .where('id', '=', userId)
          .where('organization_id', '=', organization.id),
      ),
    ]);
    await readOrganization(organization.slug, person.token);
    const rewritten = await readLastSeen(organization, userId);
    expect(rewritten).not.toBe(stale);
    expect(Date.now() - Date.parse(rewritten!)).toBeLessThan(60_000);
  });

  test('last_seen_at は入った組織の自分の行だけを書く', async () => {
    const visitor = await createVisitor();
    const a = await createOrganization();
    const b = await createOrganization();
    const aUser = await visitor.join(a, { is_admin: 1 });
    const bUser = await visitor.join(b, { is_admin: 1 });

    await readOrganization(a.slug, visitor.token);
    expect(await readLastSeen(a, aUser.id)).not.toBeNull();
    expect(await readLastSeen(b, bUser.id)).toBeNull();
  });
});
