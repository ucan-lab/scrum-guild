// 組織の選択と組織の枠の操作（my-organizations、organization）の振る舞い。
// 組織の分離と権限は一覧を回す test/operation-registry.test.ts が確かめる
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { myOrganizations, organizationInfo } from '../src/shared/operations/organization/index.ts';
import { createApp } from '../src/server/app.ts';
import { orgDb } from '../src/server/db/index.ts';
import {
  compiledQueryForTest,
  crossOrganizationStatementsForTest,
  queryPlanForTest,
} from '../src/server/db/testing.ts';
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
import { createPerson, getOperator, testEnv } from './operations/world.ts';

const app = createApp(implementedOperations);

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

type Identity = { provider: string; subject: string };

// 1つのアカウントとセッション。組織ごとに users の行を足して使う。extraLogin は2つ目のログイン（別の手段と ID）
async function createVisitor(options: { extraLogin?: boolean } = {}) {
  const account = await createAccount();
  const login = await createAccountLogin(account.id);
  const identity: Identity = { provider: login.login_provider, subject: login.login_subject };
  let extra: Identity | undefined;
  if (options.extraLogin) {
    const second = await createAccountLogin(account.id, { login_provider: 'google' });
    extra = { provider: second.login_provider, subject: second.login_subject };
  }
  const { token } = await createSessionWithToken(account.id);
  const join = (organization: OrganizationFixture, overrides: Parameters<typeof createUser>[1] = {}) =>
    createUser(organization, {
      account_id: account.id,
      login_provider: identity.provider,
      login_subject: identity.subject,
      ...overrides,
    });
  return { account, token, identity, extra, join };
}

type Listed = {
  organizations: { slug: string; name: string }[];
  invitations: { organization_name: string; slug: string }[];
  operator: boolean;
};

async function listOrganizations(token: string): Promise<Listed> {
  const res = await post(app, myOrganizations, { token });
  expect(res.status).toBe(200);
  return (await res.json()) as Listed;
}

// 入れる組織も届いた招待も無く、運用者でもない人は、ログインできる条件を持たない。組織の外の操作は、
// 一覧を空で返さずに、セッションを消して 401 の unauthenticated にする（組織をまたいで読む関数の読み取りは、空を返す）
async function expectNoAccess(token: string): Promise<void> {
  const res = await post(app, myOrganizations, { token });
  expect(res.status).toBe(401);
  expect(await res.json()).toMatchObject({ error: { code: 'unauthenticated' } });
}

// 管理者の組織を作る。ワークスペースを1つ持つ
async function createOrganizationWithOwner(overrides: Parameters<typeof createOrganization>[0] = {}) {
  const organization = await createOrganization(overrides);
  const owner = await createUser(organization, { is_admin: 1 });
  const workspace = await createWorkspace(organization, owner.id);
  return { organization, owner, workspace };
}

describe('my-organizations', () => {
  test('管理者の組織と、ワークスペースに所属している組織を名前順に返す', async () => {
    const visitor = await createVisitor();
    const aoba = await createOrganization({ name: 'あおば開発' });
    const { organization: hibari, workspace } = await createOrganizationWithOwner({ name: 'ひばり工房' });
    await visitor.join(aoba, { is_admin: 1 });
    const hibariUser = await visitor.join(hibari);
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
    const { organization: left, workspace } = await createOrganizationWithOwner();
    const leftUser = await visitor.join(left);
    await createMembership(left, workspace.id, leftUser.id, { left_at: AT, left_on: '2026-10-10' });

    await expectNoAccess(visitor.token);
  });

  test('承諾待ちの招待だけの組織は、組織の名前と slug だけを招待に出す', async () => {
    const visitor = await createVisitor();
    const { organization, owner, workspace } = await createOrganizationWithOwner({ name: '招待だけの工房' });
    await createInvitation(organization, workspace.id, owner.id, visitor.identity);
    // 辞退済みの招待は出さない
    const other = await createOrganizationWithOwner({ name: '辞退した工房' });
    await createInvitation(other.organization, other.workspace.id, other.owner.id, visitor.identity, {
      status: 'declined',
      responded_at: AT,
    });

    const result = await listOrganizations(visitor.token);
    expect(result.organizations).toEqual([]);
    // slug は承諾と辞退の操作を呼ぶ先。組織の中の値（ワークスペースや招待した人）は出さない
    expect(result.invitations).toEqual([{ organization_name: '招待だけの工房', slug: organization.slug }]);
    expect(JSON.stringify(result)).not.toContain(workspace.id);
    expect(JSON.stringify(result)).not.toContain(owner.id);
  });

  test('入れる組織への承諾待ちの招待も、届いた招待に出す（同じ組織の招待は1件にまとめる）', async () => {
    const visitor = await createVisitor();
    const organization = await createOrganization({ name: '入れる工房' });
    const user = await visitor.join(organization, { is_admin: 1 });
    const first = await createWorkspace(organization, user.id);
    const second = await createWorkspace(organization, user.id);
    await createInvitation(organization, first.id, user.id, visitor.identity);
    await createInvitation(organization, second.id, user.id, visitor.identity);

    const result = await listOrganizations(visitor.token);
    expect(result.organizations.map((item) => item.name)).toEqual(['入れる工房']);
    expect(result.invitations).toEqual([{ organization_name: '入れる工房', slug: organization.slug }]);
  });

  test('無効にされた人と、停止した組織は、どちらも出さない', async () => {
    const visitor = await createVisitor();
    const disabledOrganization = await createOrganization();
    await visitor.join(disabledOrganization, { is_admin: 1, disabled_at: AT });
    const suspended = await createOrganization({ suspended_at: AT });
    await visitor.join(suspended, { is_admin: 1 });
    // アカウントに結ばれる前に無効にされた行（手段と ID で当てる）は、招待があっても止める
    const { organization, owner, workspace } = await createOrganizationWithOwner();
    await createUser(organization, {
      login_provider: visitor.identity.provider,
      login_subject: visitor.identity.subject,
      disabled_at: AT,
    });
    await createInvitation(organization, workspace.id, owner.id, visitor.identity);
    // このアカウントの行が無効なら、招待があっても出さない
    const own = await createOrganizationWithOwner();
    await visitor.join(own.organization, { disabled_at: AT });
    await createInvitation(own.organization, own.workspace.id, own.owner.id, visitor.identity);

    await expectNoAccess(visitor.token);
  });

  test('有効な行と無効な行を持つ人は、enterOrganization と同じく、有効な行で入れる', async () => {
    // 2つのログインを持つアカウントが、一方の手段では有効な管理者、もう一方では無効にされた行を持つ
    const visitor = await createVisitor({ extraLogin: true });
    const { organization } = await createOrganizationWithOwner({ name: '二つの行の工房' });
    await visitor.join(organization, { is_admin: 1 });
    await createUser(organization, {
      login_provider: visitor.extra!.provider,
      login_subject: visitor.extra!.subject,
      disabled_at: AT,
    });

    const result = await listOrganizations(visitor.token);
    expect(result.organizations.map((item) => item.name)).toEqual(['二つの行の工房']);
    const enter = await post(app, organizationInfo, { slug: organization.slug, token: visitor.token });
    expect(enter.status).toBe(200);
  });

  test('管理者でも所属もない人は、別の手段の無効な行があると、招待があっても出さない', async () => {
    const visitor = await createVisitor({ extraLogin: true });
    const { organization, owner, workspace } = await createOrganizationWithOwner();
    await visitor.join(organization);
    await createUser(organization, {
      login_provider: visitor.extra!.provider,
      login_subject: visitor.extra!.subject,
      disabled_at: AT,
    });
    await createInvitation(organization, workspace.id, owner.id, visitor.identity);

    // ほかに入れる組織があれば、この組織の招待は出さず、組織の枠は 404 のまま
    // （入れる組織が1つも無ければ、どちらも 401 になり、セッションが消える。上のテストが確かめる）
    const elsewhere = await createOrganizationWithOwner({ name: 'ほかの工房' });
    await visitor.join(elsewhere.organization, { is_admin: 1 });
    const result = await listOrganizations(visitor.token);
    expect(result.organizations.map((item) => item.name)).toEqual(['ほかの工房']);
    expect(result.invitations).toEqual([]);
    const enter = await post(app, organizationInfo, { slug: organization.slug, token: visitor.token });
    expect(enter.status).toBe(404);
  });

  test('別の人宛の招待、別のアカウントの所属、別の組織のワークスペースを指す所属は、数えない', async () => {
    const visitor = await createVisitor();
    const stranger = await createVisitor();

    // 別の login_subject に宛てた承諾待ちの招待
    const invited = await createOrganizationWithOwner({ name: '別の人宛の工房' });
    await createInvitation(invited.organization, invited.workspace.id, invited.owner.id, stranger.identity);

    // 同じ組織の、別のアカウントの所属（自分は users の行だけ）
    const shared = await createOrganizationWithOwner({ name: '同じ組織の別の人' });
    await visitor.join(shared.organization);
    const strangerUser = await stranger.join(shared.organization);
    await createMembership(shared.organization, shared.workspace.id, strangerUser.id);

    // 別の組織のワークスペースを指す所属（自分の組織の所属には数えない）
    const own = await createOrganizationWithOwner({ name: '自分の組織' });
    const foreign = await createOrganizationWithOwner({ name: '別の組織' });
    const ownUser = await visitor.join(own.organization);
    await createMembership(own.organization, foreign.workspace.id, ownUser.id);

    await expectNoAccess(visitor.token);
    const strangerList = await listOrganizations(stranger.token);
    expect(strangerList.organizations.map((item) => item.name)).toEqual(['同じ組織の別の人']);
    expect(strangerList.invitations).toEqual([
      { organization_name: '別の人宛の工房', slug: invited.organization.slug },
    ]);
  });

  test('運用者のログインには operator が真で、入れる組織が無くても返る', async () => {
    const operator = await getOperator();
    expect(await listOrganizations(operator.token)).toEqual({ organizations: [], invitations: [], operator: true });
  });

  // 共通の表を引く文の束縛は100個まで。組織の数が100を超えても、分けて引いて合わせる
  test('管理者の組織が101件あっても、すべて名前順に返す', async () => {
    const visitor = await createVisitor();
    const names: string[] = [];
    for (let index = 0; index < 101; index++) {
      const name = `工房${String(index).padStart(3, '0')}`;
      names.push(name);
      await visitor.join(await createOrganization({ name }), { is_admin: 1 });
    }
    const result = await listOrganizations(visitor.token);
    expect(result.organizations.map((item) => item.name)).toEqual(names);
  });

  test('所属だけの組織が101件あっても、すべて返す（所属を確かめる文も分ける）', async () => {
    const visitor = await createVisitor();
    for (let index = 0; index < 101; index++) {
      const { organization, workspace } = await createOrganizationWithOwner({
        name: `所属の工房${String(index).padStart(3, '0')}`,
      });
      const user = await visitor.join(organization);
      await createMembership(organization, workspace.id, user.id);
    }
    const result = await listOrganizations(visitor.token);
    expect(result.organizations).toHaveLength(101);
  });

  test('組織の中の表を引く文は、users と memberships と invitations を全件読まず、索引に乗る', async () => {
    const visitor = await createVisitor();
    const statements = crossOrganizationStatementsForTest(
      env,
      { accountId: visitor.account.id, login: visitor.identity },
      ['u1', 'u2'],
    );
    for (const [name, statement] of Object.entries(statements)) {
      const plan = await queryPlanForTest(env, statement);
      expect(plan.length, name).toBeGreaterThan(0);
      for (const line of plan) expect(line, `${name}: ${line}`).not.toMatch(/^SCAN (users|memberships|invitations)\b/);
    }
    // SCAN でないだけでなく、期待する索引を使っていること。users の文はどれも users_login（ログインのたびに結ぶ読む文と書く文を含む）
    for (const name of ['users', 'usersWithUnlinked', 'usersOfNewAccount', 'waiting', 'link'] as const) {
      const plan = await queryPlanForTest(env, statements[name]);
      expect(plan.join('\n'), name).toContain('USING INDEX users_login');
    }
    const plans = {
      memberships: await queryPlanForTest(env, statements.memberships),
      invitations: await queryPlanForTest(env, statements.invitations),
    };
    expect(plans.memberships.join('\n')).toContain('USING INDEX memberships_user_left (user_id=? AND left_at=?)');
    expect(plans.invitations.join('\n')).toContain('USING INDEX invitations_login_pending');
  });

  test('定義に無い API の経路は、見つからないときと同じ not_found の 404', async () => {
    const res = await app.request(
      '/api/no-such-operation',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: testEnv.PUBLIC_ORIGIN,
        },
        body: '{}',
      },
      testEnv,
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: 'not_found', message: 'not found' } });
  });
});

type Info = {
  organization: { name: string; theme: string; has_workspaces: boolean };
  me: { id: string; name: string; is_admin: boolean; theme: string | null };
  workspaces: { id: string; name: string; role: string }[];
};

async function readOrganization(slug: string, token: string): Promise<Info> {
  const res = await post(app, organizationInfo, { slug, token });
  expect(res.status).toBe(200);
  return (await res.json()) as Info;
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

async function writeLastSeen(organization: OrganizationFixture, userId: string, value: string | null) {
  const db = orgDb(env, organization.verified);
  await db.batch([
    db.statement((q) =>
      q
        .updateTable('users')
        .set({ last_seen_at: value })
        .where('id', '=', userId)
        .where('organization_id', '=', organization.id),
    ),
  ]);
}

// users の更新を送る batch() を見張る。呼ぶたびに、書いた件数（changes）を集める
// fail は書き込みを失敗させる。gate は、開くまで書き込みを送らない（応答の時点で書き込みが終わっていないことを作る）
function watchUserUpdates(
  organization: OrganizationFixture,
  { fail = false, gate }: { fail?: boolean; gate?: Promise<void> } = {},
) {
  const entryPrototype = Object.getPrototypeOf(Object.getPrototypeOf(orgDb(env, organization.verified)));
  const original = entryPrototype.batch as (statements: readonly never[]) => Promise<{ changes: number }[]>;
  const writes: Promise<number>[] = [];
  vi.spyOn(entryPrototype, 'batch').mockImplementation(async function (this: unknown, ...args: unknown[]) {
    const statements = args[0] as readonly never[];
    const isUserUpdate = statements.some((statement) =>
      compiledQueryForTest(statement).sql.startsWith('update "users"'),
    );
    if (isUserUpdate && gate) await gate;
    if (isUserUpdate && fail) throw new Error('書き込みに失敗: 秘密の詳細');
    const results = await original.call(this, statements);
    if (isUserUpdate) writes.push(Promise.resolve(results[0]?.changes ?? 0));
    return results;
  });
  return {
    changes: async () => (await Promise.all(writes)).reduce((sum, value) => sum + value, 0),
    count: () => writes.length,
  };
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
    expect(result.organization).toEqual({
      name: '青葉工房',
      theme: 'medieval',
      has_workspaces: true,
    });
    expect(result.organization).not.toHaveProperty('vocabulary');
    expect(result.me).toEqual({ id: person.userId, name: '星野 澪', is_admin: false, theme: null, level: 1 });
    expect(result.workspaces).toEqual([
      { id: first.id, name: 'あ開発', role: 'member' },
      { id: second.id, name: 'う開発', role: 'leader' },
    ]);
  });

  test('has_workspaces は、組織にワークスペースがあるかを、所属と別に返す', async () => {
    // ワークスペースが1つも無い組織の管理者
    const empty = await createOrganization();
    const emptyAdmin = await createPerson({ organization: empty, admin: true });
    const none = await readOrganization(empty.slug, emptyAdmin.token);
    expect(none.organization.has_workspaces).toBe(false);
    expect(none.workspaces).toEqual([]);

    // ワークスペースはあるが、所属は0件の管理者
    const filled = await createOrganization();
    const filledAdmin = await createPerson({ organization: filled, admin: true });
    await createWorkspace(filled, filledAdmin.userId!);
    const other = await createOrganization();
    const otherAdmin = await createPerson({ organization: other, admin: true });
    await createWorkspace(other, otherAdmin.userId!);
    const some = await readOrganization(filled.slug, filledAdmin.token);
    expect(some.organization.has_workspaces).toBe(true);
    expect(some.workspaces).toEqual([]);
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

  test('定義の説明に、last_seen_at を書くことがある', () => {
    expect(organizationInfo.description).toContain('last_seen_at');
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
    await writeLastSeen(organization, userId, recent);
    await readOrganization(organization.slug, person.token);
    expect(await readLastSeen(organization, userId)).toBe(recent);

    // 1時間以上前の値は書き直す
    const stale = new Date(Date.now() - 61 * 60 * 1000).toISOString();
    await writeLastSeen(organization, userId, stale);
    await readOrganization(organization.slug, person.token);
    const rewritten = await readLastSeen(organization, userId);
    expect(rewritten).not.toBe(stale);
    expect(Date.now() - Date.parse(rewritten!)).toBeLessThan(60_000);
  });

  test('last_seen_at は、60分ちょうど前なら書き直し、1ミリ秒でも新しければ書き直さない', async () => {
    const organization = await createOrganization();
    const person = await createPerson({ organization, admin: true });
    const userId = person.userId!;
    vi.useFakeTimers({ toFake: ['Date'] });
    const now = new Date('2026-10-25T12:00:00.000Z');
    vi.setSystemTime(now);

    const exactlyAnHour = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
    await writeLastSeen(organization, userId, exactlyAnHour);
    await readOrganization(organization.slug, person.token);
    expect(await readLastSeen(organization, userId)).toBe(now.toISOString());

    const justUnderAnHour = new Date(now.getTime() - 60 * 60 * 1000 + 1).toISOString();
    await writeLastSeen(organization, userId, justUnderAnHour);
    await readOrganization(organization.slug, person.token);
    expect(await readLastSeen(organization, userId)).toBe(justUnderAnHour);
  });

  test('同時に2回呼んでも、last_seen_at の書き込みは1回だけ効く', async () => {
    const organization = await createOrganization();
    const person = await createPerson({ organization, admin: true });
    const writes = watchUserUpdates(organization);

    const results = await Promise.all([
      post(app, organizationInfo, { slug: organization.slug, token: person.token }),
      post(app, organizationInfo, { slug: organization.slug, token: person.token }),
    ]);
    expect(results.map((res) => res.status)).toEqual([200, 200]);
    expect(writes.count()).toBe(2);
    expect(await writes.changes()).toBe(1);
  });

  test('last_seen_at の書き込みが失敗しても画面の値は返り、ログには例外の名前だけを残す', async () => {
    const organization = await createOrganization();
    const person = await createPerson({ organization, admin: true });
    watchUserUpdates(organization, { fail: true });
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const res = await post(app, organizationInfo, { slug: organization.slug, token: person.token });
    expect(res.status).toBe(200);
    expect(await readLastSeen(organization, person.userId!)).toBeNull();
    const lines = error.mock.calls.map((call) => String(call[0]));
    expect(
      lines.some((line) => line.includes('応答の後の書き込みに失敗した') && line.includes('"error":"Error"')),
    ).toBe(true);
    expect(lines.join('\n')).not.toContain('秘密の詳細');
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

// 本番は ExecutionContext の waitUntil に書き込みを渡す。渡された Promise を集めるダミーで、その経路を通す
describe('organization の last_seen_at の書き込み（waitUntil の経路）', () => {
  function collectingContext(waitUntil?: (promise: Promise<unknown>) => void) {
    const waited: Promise<unknown>[] = [];
    const executionCtx = {
      waitUntil: waitUntil ?? ((promise: Promise<unknown>) => void waited.push(promise)),
      passThroughOnException: () => undefined,
    } as unknown as ExecutionContext;
    return { waited, executionCtx };
  }

  test('書き込みは waitUntil に1件渡り、応答の時点で終わっていなくてよい', async () => {
    const organization = await createOrganization();
    const person = await createPerson({ organization, admin: true });
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    watchUserUpdates(organization, { gate });
    const { waited, executionCtx } = collectingContext();

    const res = await post(app, organizationInfo, { slug: organization.slug, token: person.token, executionCtx });
    expect(res.status).toBe(200);
    expect(waited).toHaveLength(1);
    // 応答は返っているが、書き込みは門で止まっていて、まだ書かれていない
    expect(await readLastSeen(organization, person.userId!)).toBeNull();

    open();
    await Promise.all(waited);
    expect(await readLastSeen(organization, person.userId!)).not.toBeNull();
  });

  test('書き込みが失敗しても、waitUntil に渡った Promise は拒否にならず、ログだけ残る', async () => {
    const organization = await createOrganization();
    const person = await createPerson({ organization, admin: true });
    watchUserUpdates(organization, { fail: true });
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { waited, executionCtx } = collectingContext();

    const res = await post(app, organizationInfo, { slug: organization.slug, token: person.token, executionCtx });
    expect(res.status).toBe(200);
    expect(waited).toHaveLength(1);
    await expect(waited[0]).resolves.toBeUndefined();
    const lines = error.mock.calls.map((call) => String(call[0]));
    expect(
      lines.some((line) => line.includes('応答の後の書き込みに失敗した') && line.includes('"error":"Error"')),
    ).toBe(true);
    expect(lines.join('\n')).not.toContain('秘密の詳細');
  });

  test('waitUntil 自身が投げたときは、隠さず 500 にする', async () => {
    const organization = await createOrganization();
    const person = await createPerson({ organization, admin: true });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { executionCtx } = collectingContext(() => {
      throw new Error('waitUntil が使えない');
    });

    const res = await post(app, organizationInfo, { slug: organization.slug, token: person.token, executionCtx });
    expect(res.status).toBe(500);
  });
});
