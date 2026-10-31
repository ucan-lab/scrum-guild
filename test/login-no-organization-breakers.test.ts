// #639 を崩す: 停止した組織の無効な手がかり（終わった所属、応えた招待、無効にされた行、別の組織のワークスペースを指す所属、
// 別の手段の行）で、アカウントの無い人がアカウントを作れないこと、アカウントのある人の my-organizations の suspended に
// 停止していなければ入れなかった組織が漏れないこと。停止した組織にだけ指名された人の並行した初回ログイン。
// 例のデータはすべて架空
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { myOrganizations } from '../src/shared/operations/organization/index.ts';
import { createApp } from '../src/server/app.ts';
import { commonDb } from '../src/server/db/index.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import { createFakeGithub } from './auth/fake-github.ts';
import { createLoginApp, FakeBrowser, loginEnv } from './auth/browser.ts';
import {
  accountLoginOf,
  afterFirstQuery,
  countAccounts,
  githubUser,
  organizationWithAdmin,
  sessionRowsOf,
  userRow,
} from './auth/helpers.ts';
import {
  createAccount,
  createAccountLogin,
  createInvitation,
  createMembership,
  createSessionWithToken,
  createUser,
} from './factories.ts';
import { post } from './operations/harness.ts';

const github = createFakeGithub();
const loginApp = createLoginApp(github);
const newBrowser = () => new FakeBrowser(loginApp, github);
const app = createApp(implementedOperations);

afterEach(() => {
  vi.restoreAllMocks();
});

async function suspend(organizationId: string): Promise<void> {
  const db = commonDb(env);
  await db.batch([
    db.statement((q) =>
      q.updateTable('organizations').set({ suspended_at: '2026-10-22T00:00:00.000Z' }).where('id', '=', organizationId),
    ),
  ]);
}

async function expectDenied(user: ReturnType<typeof githubUser>): Promise<void> {
  const before = await countAccounts();
  const browser = newBrowser();
  const result = await browser.login(user);
  expect(result.location, user.login).toBe('/login?error=denied');
  expect(browser.sessionToken, user.login).toBeUndefined();
  expect(await accountLoginOf(user), user.login).toBeUndefined();
  expect(await countAccounts(), user.login).toBe(before);
}

describe('アカウントの無い人の、停止した組織の無効な手がかりだけではアカウントを作らない', () => {
  test('停止した組織の終わった所属だけの人は denied', async () => {
    const { organization, workspace } = await organizationWithAdmin();
    const user = githubUser('left-in-suspended');
    const row = await createUser(organization, { login_provider: 'github', login_subject: String(user.id) });
    await createMembership(organization, workspace.id, row.id, {
      left_on: '2026-10-21',
      left_at: '2026-10-21T00:00:00.000Z',
    });
    await suspend(organization.id);
    await expectDenied(user);
  });

  test('停止した組織の、承諾済み・辞退・取り消しの招待だけの人は denied', async () => {
    const { organization, admin, workspace } = await organizationWithAdmin();
    const users = (['accepted', 'declined', 'revoked'] as const).map((status) => ({
      status,
      user: githubUser(`answered-${status}`),
    }));
    for (const { status, user } of users) {
      await createInvitation(
        organization,
        workspace.id,
        admin.id,
        { provider: 'github', subject: String(user.id) },
        { status, responded_at: '2026-10-21T00:00:00.000Z' },
      );
    }
    await suspend(organization.id);
    for (const { user } of users) await expectDenied(user);
  });

  test('停止した組織で無効にされた（結ばれる前の）行がある人は、同じ組織の承諾待ちの招待があっても denied', async () => {
    const { organization, admin, workspace } = await organizationWithAdmin();
    const user = githubUser('disabled-and-invited');
    await createUser(organization, {
      login_provider: 'github',
      login_subject: String(user.id),
      disabled_at: '2026-10-21T00:00:00.000Z',
    });
    await createInvitation(organization, workspace.id, admin.id, { provider: 'github', subject: String(user.id) });
    await suspend(organization.id);
    await expectDenied(user);
  });

  test('停止した組織の結ばれる前の行の所属が、別の組織のワークスペースを指すだけなら denied', async () => {
    const own = await organizationWithAdmin();
    const other = await organizationWithAdmin();
    const user = githubUser('cross-workspace');
    const row = await createUser(own.organization, { login_provider: 'github', login_subject: String(user.id) });
    // 自分の組織の行に、別の組織のワークスペースの所属を付ける（壊れた行。どちらの組織にも入れたはずでない）
    await createMembership(own.organization, other.workspace.id, row.id);
    await suspend(own.organization.id);
    await suspend(other.organization.id);
    await expectDenied(user);
  });

  test('停止した組織に、同じ ID で別の手段の指名と招待しか無い人は denied', async () => {
    const { organization, admin, workspace } = await organizationWithAdmin();
    const user = githubUser('other-provider');
    await createUser(organization, { login_provider: 'google', login_subject: String(user.id), is_admin: 1 });
    await createInvitation(organization, workspace.id, admin.id, { provider: 'google', subject: String(user.id) });
    await suspend(organization.id);
    await expectDenied(user);
  });
});

type Listed = {
  organizations: { slug: string; name: string }[];
  invitations: { organization_name: string; slug: string }[];
  suspended: { slug: string; name: string }[];
  operator: boolean;
};

// アカウントとセッション。github のログインを1つ持つ
async function accountHolder() {
  const account = await createAccount();
  const login = await createAccountLogin(account.id, { login_provider: 'github' });
  const { token } = await createSessionWithToken(account.id);
  return { account, token, provider: login.login_provider, subject: login.login_subject };
}

async function listed(token: string): Promise<Listed> {
  const res = await post(app, myOrganizations, { token });
  expect(res.status).toBe(200);
  return (await res.json()) as Listed;
}

describe('my-organizations の suspended に、停止していなければ入れなかった組織を出さない', () => {
  test('自分の行の所属が別の組織のワークスペースを指すとき、どちらの組織も停止していても出さない', async () => {
    const holder = await accountHolder();
    const own = await organizationWithAdmin();
    const other = await organizationWithAdmin();
    const row = await createUser(own.organization, {
      account_id: holder.account.id,
      login_provider: holder.provider,
      login_subject: holder.subject,
    });
    await createMembership(own.organization, other.workspace.id, row.id);
    await suspend(own.organization.id);
    await suspend(other.organization.id);
    expect(await listed(holder.token)).toEqual({ organizations: [], invitations: [], suspended: [], operator: false });
  });

  // 辞退は test/organization.test.ts が確かめる
  test('停止した組織の承諾済み・取り消しの招待は出さない', async () => {
    const holder = await accountHolder();
    const fixtures = [];
    for (const status of ['accepted', 'revoked'] as const) {
      const fixture = await organizationWithAdmin();
      await createInvitation(
        fixture.organization,
        fixture.workspace.id,
        fixture.admin.id,
        { provider: holder.provider, subject: holder.subject },
        { status, responded_at: '2026-10-21T00:00:00.000Z' },
      );
      fixtures.push(fixture);
    }
    for (const { organization } of fixtures) await suspend(organization.id);
    expect((await listed(holder.token)).suspended).toEqual([]);
  });

  test('停止した組織で、同じログインの結ばれる前の無効な行があれば、承諾待ちの招待を出さない', async () => {
    const holder = await accountHolder();
    const { organization, admin, workspace } = await organizationWithAdmin();
    await createUser(organization, {
      account_id: null,
      login_provider: holder.provider,
      login_subject: holder.subject,
      disabled_at: '2026-10-21T00:00:00.000Z',
    });
    await createInvitation(organization, workspace.id, admin.id, {
      provider: holder.provider,
      subject: holder.subject,
    });
    await suspend(organization.id);
    expect((await listed(holder.token)).suspended).toEqual([]);
  });

  test('停止した組織の、同じ ID で別の手段の行と招待は出さない', async () => {
    const holder = await accountHolder();
    const { organization, admin, workspace } = await organizationWithAdmin();
    await createUser(organization, {
      account_id: null,
      login_provider: 'google',
      login_subject: holder.subject,
      is_admin: 1,
    });
    await createInvitation(organization, workspace.id, admin.id, { provider: 'google', subject: holder.subject });
    await suspend(organization.id);
    expect((await listed(holder.token)).suspended).toEqual([]);
  });
});

describe('停止した組織にだけ指名された人の、並行した初回ログイン', () => {
  test('片方がアカウントを作り、指名の行を結んだ後に、もう片方の判定が走っても、断られず、アカウントは1つ', async () => {
    const { organization } = await organizationWithAdmin();
    const user = githubUser('race-suspended');
    await createUser(organization, {
      account_id: null,
      login_provider: 'github',
      login_subject: String(user.id),
      is_admin: 1,
    });
    await suspend(organization.id);
    const first = newBrowser();
    const second = new FakeBrowser(
      loginApp,
      github,
      afterFirstQuery(
        loginEnv,
        (sql) => sql.startsWith('select "account_id" from "account_logins"'),
        async () => void (await first.login(user)),
      ),
    );
    const result = await second.login(user);
    expect(result.location).toBe('/');
    expect(first.sessionToken).toBeDefined();
    expect(second.sessionToken).toBeDefined();

    const accountId = (await accountLoginOf(user))!.account_id;
    expect(await sessionRowsOf(accountId)).toHaveLength(2);
    expect((await userRow(organization.id, user))?.account_id).toBe(accountId);
  });
});
