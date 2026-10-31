// GitHub でログインする流れの結合テスト。GitHub への通信は差し替えた fetch（test/auth/fake-github.ts）に向け、
// アプリ（開始、戻り先、セッション、me、logout）と D1 は本物を使う。
// 開始、初めての人、2回目の人、指名で待っていた人、入れない人、運用者の分かれ道、ログアウトを確かめる。
// state、GitHub との通信の失敗、レート制限、ログは test/login-security.test.ts
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { logout, me } from '../src/shared/operations/session/index.ts';
import { hashSessionToken } from '../src/server/auth/session.ts';
import { myOrganizations, organizationInfo } from '../src/shared/operations/organization/index.ts';
import { commonDb, orgDb } from '../src/server/db/index.ts';
import { verifiedOrganizationForTest } from '../src/server/db/testing.ts';
import { createFakeGithub } from './auth/fake-github.ts';
import { post } from './operations/harness.ts';
import { createLoginApp, FakeBrowser, loginEnv, SESSION_COOKIE, STATE_COOKIE } from './auth/browser.ts';
import {
  accountLoginOf,
  countAccounts,
  githubUser,
  organizationWithAdmin,
  sessionRowsOf,
  stateRow,
  userRow,
} from './auth/helpers.ts';
import { createInvitation, createMembership, createUser } from './factories.ts';

const github = createFakeGithub();
const app = createLoginApp(github);
const newBrowser = () => new FakeBrowser(app, github);

async function suspendOrganization(organizationId: string): Promise<void> {
  const db = commonDb(env);
  await db.batch([
    db.statement((q) =>
      q.updateTable('organizations').set({ suspended_at: '2026-10-22T00:00:00.000Z' }).where('id', '=', organizationId),
    ),
  ]);
}

async function resumeOrganization(organizationId: string): Promise<void> {
  const db = commonDb(env);
  await db.batch([
    db.statement((q) => q.updateTable('organizations').set({ suspended_at: null }).where('id', '=', organizationId)),
  ]);
}

// 所属を終える（すべてのワークスペースから外れた人にする）
async function endMembership(organizationId: string, userId: string): Promise<void> {
  const db = orgDb(env, verifiedOrganizationForTest(organizationId));
  await db.batch([
    db.statement((q) =>
      q
        .updateTable('memberships')
        .set({ left_on: '2026-10-21', left_at: '2026-10-21T00:00:00.000Z' })
        .where('user_id', '=', userId),
    ),
  ]);
}

type ListedOrganizations = {
  organizations: { slug: string; name: string }[];
  invitations: { organization_name: string; slug: string }[];
  // #639 で足す。停止していなければ入れた組織のうち、停止したもの
  suspended?: { slug: string; name: string }[];
  operator: boolean;
};

async function myOrganizationsOf(browser: FakeBrowser): Promise<ListedOrganizations> {
  // ログインで作られた人は未同意なので、組織の操作の前に同意する（同意の門は test/consent-gate.test.ts が確かめる）
  await browser.consent();
  const res = await browser.post(myOrganizations);
  expect(res.status).toBe(200);
  return (await res.json()) as ListedOrganizations;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('開始', () => {
  test('GitHub の認可の URL へ移し、state と PKCE を付け、state を HttpOnly の Cookie にも置く', async () => {
    const browser = newBrowser();
    const started = await browser.start('/aoba/board?tab=1');
    expect(started.response.status).toBe(302);
    expect(started.location.origin + started.location.pathname).toBe('https://github.com/login/oauth/authorize');
    const params = started.location.searchParams;
    expect(params.get('client_id')).toBe('test-client-id');
    expect(params.get('redirect_uri')).toBe('https://scrum-guild.ucan-lab.workers.dev/api/auth/github/callback');
    expect(params.get('scope')).toBe('read:user');
    expect(params.get('code_challenge_method')).toBe('S256');
    expect(started.state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(params.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const row = await stateRow(started.state);
    expect(row).toMatchObject({ login_provider: 'github', return_to: '/aoba/board?tab=1', nonce: null });
    expect(Date.parse(row!.expires_at) - Date.now()).toBeGreaterThan(9 * 60 * 1000);
    expect(Date.parse(row!.expires_at) - Date.now()).toBeLessThanOrEqual(10 * 60 * 1000);

    const cookieLine = started.response.headers.getSetCookie().find((line) => line.startsWith(`${STATE_COOKIE}=`));
    expect(cookieLine).toContain(`${STATE_COOKIE}=${started.state}`);
    for (const attribute of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/', 'Max-Age=600']) {
      expect(cookieLine).toContain(attribute);
    }
    expect(started.response.headers.get('Cache-Control')).toBe('no-store');
  });

  test.each([
    ['別のオリジンの URL', 'https://evil.example/steal'],
    ['プロトコル相対の URL', '//evil.example'],
    ['バックスラッシュで始まる', '/\\evil.example'],
    ['タブを含む', '/\t/evil.example'],
    ['パスで始まらない', 'aoba/board'],
    ['API のパス', '/api/health'],
    ['ログインの画面そのもの', '/login?return_to=/x'],
    ['長すぎる', `/${'a'.repeat(3000)}`],
  ])('戻る画面のパスが%sなら、自分のサイトの / に直す', async (_label, returnTo) => {
    const browser = newBrowser();
    const started = await browser.start(returnTo);
    expect(started.response.status).toBe(302);
    expect((await stateRow(started.state))?.return_to).toBe('/');
  });

  test('戻る画面のパスが無ければ / にする', async () => {
    const started = await newBrowser().start();
    expect((await stateRow(started.state))?.return_to).toBe('/');
  });

  test('GitHub のクライアント ID と秘密が設定されていなければ、ログインの画面へ移し、行も作らない', async () => {
    const unconfigured: Env = Object.assign({}, loginEnv, { GITHUB_CLIENT_ID: '', GITHUB_CLIENT_SECRET: '' });
    const browser = new FakeBrowser(app, github, unconfigured);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const started = await browser.start('/aoba');
    expect(started.response.headers.get('Location')).toBe('/login?error=unavailable&return_to=%2Faoba');
    expect(browser.cookies.size).toBe(0);
  });

  test('知らない手段は 404', async () => {
    const res = await newBrowser().request('/api/auth/gitlab/start');
    expect(res.status).toBe(404);
  });
});

describe('初めての人', () => {
  test('指名で待っていた管理者は、accounts と account_logins を作り、users.account_id を結び、セッションを持つ', async () => {
    const { organization } = await organizationWithAdmin();
    const user = githubUser('minato-aoba');
    const pending = await createUser(organization, {
      account_id: null,
      login_provider: 'github',
      login_subject: String(user.id),
      is_admin: 1,
      name: 'ミナト',
    });
    const before = await countAccounts();

    const browser = newBrowser();
    const result = await browser.login(user, { returnTo: '/aoba/board?tab=1#top' });
    expect(result.response.status).toBe(302);
    expect(result.location).toBe('/aoba/board?tab=1#top');

    const login = await accountLoginOf(user);
    expect(login).toMatchObject({
      login_name: 'minato-aoba',
      display_name: '星野 澪',
      avatar_url: 'https://avatars.githubusercontent.com/u/7000000',
    });
    expect(await countAccounts()).toBe(before + 1);

    // 指名の行にアカウントが結ばれる
    expect((await userRow(organization.id, user))?.account_id).toBe(login!.account_id);
    expect((await userRow(organization.id, user))?.id).toBe(pending.id);

    // セッション: Cookie の値の SHA-256 が sessions にあり、30日で切れる
    const token = browser.sessionToken!;
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const [session] = await sessionRowsOf(login!.account_id);
    expect(session!.token_hash).toBe(await hashSessionToken(token));
    // 期限は呼び出しの時刻から30日。作成の時刻は挿入の直前なので、数ミリ秒だけ後になる
    const lifetime = Date.parse(session!.expires_at) - Date.parse(session!.last_used_at);
    expect(lifetime).toBeLessThanOrEqual(30 * 24 * 60 * 60 * 1000);
    expect(lifetime).toBeGreaterThan(30 * 24 * 60 * 60 * 1000 - 5_000);

    const cookieLine = result.response.headers.getSetCookie().find((line) => line.startsWith(`${SESSION_COOKIE}=`));
    for (const attribute of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/', 'Max-Age=2592000']) {
      expect(cookieLine).toContain(attribute);
    }
    // state は使い切る: 行も Cookie も無い
    expect(await stateRow(result.started.state)).toBeUndefined();
    expect(browser.cookies.has(STATE_COOKIE)).toBe(false);

    const mine = await browser.post(me);
    expect(await mine.json()).toEqual({
      account_id: login!.account_id,
      login_provider: 'github',
      login_name: 'minato-aoba',
      display_name: '星野 澪',
      avatar_url: 'https://avatars.githubusercontent.com/u/7000000',
    });
  });

  test('承諾待ちの招待だけの人もログインでき、users の行は作らない', async () => {
    const { organization, admin, workspace } = await organizationWithAdmin();
    const user = githubUser('haruka-invited');
    await createInvitation(organization, workspace.id, admin.id, { provider: 'github', subject: String(user.id) });

    const browser = newBrowser();
    const result = await browser.login(user);
    expect(result.location).toBe('/');
    expect(await accountLoginOf(user)).toBeDefined();
    expect(await userRow(organization.id, user)).toBeUndefined();
    expect((await browser.post(me)).status).toBe(200);
  });

  test('今所属しているワークスペースがある、アカウントに結ばれる前の行も、ログインで結ぶ', async () => {
    const { organization, workspace } = await organizationWithAdmin();
    const user = githubUser('member-pending');
    const row = await createUser(organization, {
      account_id: null,
      login_provider: 'github',
      login_subject: String(user.id),
    });
    await createMembership(organization, workspace.id, row.id);
    const browser = newBrowser();
    expect((await browser.login(user)).location).toBe('/');
    expect((await userRow(organization.id, user))?.account_id).toBe((await accountLoginOf(user))!.account_id);
  });

  test('GitHub のユーザー ID は10進の文字列で持つ', async () => {
    const { organization } = await organizationWithAdmin();
    const user = githubUser('long-id', { id: 9_007_199_254_740 });
    await createUser(organization, { login_provider: 'github', login_subject: '9007199254740', is_admin: 1 });
    await newBrowser().login(user);
    expect((await accountLoginOf(user))?.login_subject).toBe('9007199254740');
  });

  test('表示名が無い人と、https でないアバターは null にする', async () => {
    const { organization } = await organizationWithAdmin();
    const user = githubUser('no-name', { name: null, avatar_url: 'http://insecure.example/a.png' });
    await createUser(organization, { login_provider: 'github', login_subject: String(user.id), is_admin: 1 });
    await newBrowser().login(user);
    expect(await accountLoginOf(user)).toMatchObject({ login_name: 'no-name', display_name: null, avatar_url: null });
  });
});

describe('2回目の人', () => {
  test('表示用の値を書き直し、アカウントは増やさず、前のセッションを同じ書き込みで消す', async () => {
    const { organization } = await organizationWithAdmin();
    const user = githubUser('rin-first');
    await createUser(organization, { login_provider: 'github', login_subject: String(user.id), is_admin: 1 });
    const browser = newBrowser();
    await browser.login(user);
    const first = await accountLoginOf(user);
    const firstToken = browser.sessionToken!;
    const before = await countAccounts();

    const renamed = {
      ...user,
      login: 'rin-renamed',
      name: '新しい名前',
      avatar_url: 'https://avatars.githubusercontent.com/u/2',
    };
    await browser.login(renamed);

    const second = await accountLoginOf(user);
    expect(second).toMatchObject({
      account_id: first!.account_id,
      login_name: 'rin-renamed',
      display_name: '新しい名前',
      avatar_url: 'https://avatars.githubusercontent.com/u/2',
      created_at: first!.created_at,
    });
    expect(await countAccounts()).toBe(before);

    const rows = await sessionRowsOf(first!.account_id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.token_hash).toBe(await hashSessionToken(browser.sessionToken!));
    expect(browser.sessionToken).not.toBe(firstToken);
  });

  test('アカウントができた後に指名された組織の行も、次のログインで結ぶ', async () => {
    const first = await organizationWithAdmin();
    const later = await organizationWithAdmin();
    const user = githubUser('late-nomination');
    await createUser(first.organization, { login_provider: 'github', login_subject: String(user.id), is_admin: 1 });
    const browser = newBrowser();
    await browser.login(user);
    const accountId = (await accountLoginOf(user))!.account_id;

    await createUser(later.organization, {
      account_id: null,
      login_provider: 'github',
      login_subject: String(user.id),
      is_admin: 1,
    });
    await browser.login(user);
    expect((await userRow(later.organization.id, user))?.account_id).toBe(accountId);
  });
});

describe('入れない人', () => {
  test('入れる組織も招待も無い人は、ログインできず、accounts も account_logins も作らない', async () => {
    const user = githubUser('stranger');
    const before = await countAccounts();
    const browser = newBrowser();
    const result = await browser.login(user, { returnTo: '/aoba/board' });
    expect(result.location).toBe('/login?error=denied');
    expect(browser.sessionToken).toBeUndefined();
    expect(await accountLoginOf(user)).toBeUndefined();
    expect(await countAccounts()).toBe(before);
    expect((await browser.post(me)).status).toBe(401);
  });

  test('アカウントが無く、無効にされた行、終わった所属、取り消された招待だけの人も入れない（denied）', async () => {
    const { organization, admin, workspace } = await organizationWithAdmin();
    const disabled = githubUser('disabled');
    await createUser(organization, {
      login_provider: 'github',
      login_subject: String(disabled.id),
      is_admin: 1,
      disabled_at: '2026-10-21T00:00:00.000Z',
    });
    const left = githubUser('left');
    const leftUser = await createUser(organization, { login_provider: 'github', login_subject: String(left.id) });
    await createMembership(organization, workspace.id, leftUser.id, {
      left_on: '2026-10-21',
      left_at: '2026-10-21T00:00:00.000Z',
    });
    const revoked = githubUser('revoked');
    await createInvitation(
      organization,
      workspace.id,
      admin.id,
      { provider: 'github', subject: String(revoked.id) },
      { status: 'revoked' },
    );

    for (const user of [disabled, left, revoked]) {
      const before = await countAccounts();
      const browser = newBrowser();
      const result = await browser.login(user);
      expect(result.location, user.login).toBe('/login?error=denied');
      expect(browser.sessionToken, user.login).toBeUndefined();
      expect(await accountLoginOf(user), user.login).toBeUndefined();
      expect(await countAccounts(), user.login).toBe(before);
    }
  });

  test('アカウントが無く、停止した組織で無効にされた行だけの人は denied（停止していなければ入れた人ではない）', async () => {
    const { organization } = await organizationWithAdmin();
    const disabled = githubUser('disabled-in-suspended');
    await createUser(organization, {
      login_provider: 'github',
      login_subject: String(disabled.id),
      is_admin: 1,
      disabled_at: '2026-10-21T00:00:00.000Z',
    });
    await suspendOrganization(organization.id);

    const browser = newBrowser();
    expect((await browser.login(disabled)).location).toBe('/login?error=denied');
    expect(browser.sessionToken).toBeUndefined();
    expect(await accountLoginOf(disabled)).toBeUndefined();
  });

  test('アカウントが無く、別の人宛の招待しか無い組織が停止していても denied', async () => {
    const { organization, admin, workspace } = await organizationWithAdmin();
    const invited = githubUser('invited-someone');
    await createInvitation(organization, workspace.id, admin.id, { provider: 'github', subject: String(invited.id) });
    await suspendOrganization(organization.id);
    const stranger = githubUser('stranger-of-suspended');
    expect((await newBrowser().login(stranger)).location).toBe('/login?error=denied');
    expect(await accountLoginOf(stranger)).toBeUndefined();
  });

  test('ある組織で無効にされていても、別の組織に入れる人はログインできる', async () => {
    const a = await organizationWithAdmin();
    const b = await organizationWithAdmin();
    const user = githubUser('two-orgs');
    await createUser(a.organization, {
      login_provider: 'github',
      login_subject: String(user.id),
      is_admin: 1,
      disabled_at: '2026-10-21T00:00:00.000Z',
    });
    await createUser(b.organization, { login_provider: 'github', login_subject: String(user.id), is_admin: 1 });
    expect((await newBrowser().login(user)).location).toBe('/');
  });
});

// #639: ログインは、運用者、アカウントがある人、停止していなければ入れた組織か招待がある人（停止した組織の分も数える）を通す
describe('入れる組織が無くてもアカウントがある人と、停止した組織にだけ入れる人', () => {
  test('すべてのワークスペースから外れた人は、ログインし直しても入れ、/ へ戻り、組織の一覧は空', async () => {
    const { organization, workspace } = await organizationWithAdmin();
    const user = githubUser('left-all');
    const row = await createUser(organization, { login_provider: 'github', login_subject: String(user.id) });
    await createMembership(organization, workspace.id, row.id);
    const first = newBrowser();
    expect((await first.login(user)).location).toBe('/');
    const accountId = (await accountLoginOf(user))!.account_id;

    await endMembership(organization.id, row.id);
    const before = await countAccounts();
    const again = newBrowser();
    const result = await again.login(user, { returnTo: '/' });
    expect(result.location).toBe('/');
    expect(again.sessionToken).toBeDefined();
    expect((await accountLoginOf(user))!.account_id).toBe(accountId);
    expect(await countAccounts()).toBe(before);
    expect((await again.post(me)).status).toBe(200);
    expect(await myOrganizationsOf(again)).toMatchObject({ organizations: [], invitations: [], operator: false });
    // その組織の画面は、今どおり見つからないときと同じ 404
    const inside = await post(app, organizationInfo, { slug: organization.slug, token: again.sessionToken! });
    expect(inside.status).toBe(404);
  });

  test('すべての組織で無効にされた人も、アカウントがあればログインできる', async () => {
    const { organization } = await organizationWithAdmin();
    const user = githubUser('disabled-everywhere');
    const row = await createUser(organization, {
      login_provider: 'github',
      login_subject: String(user.id),
      is_admin: 1,
    });
    await newBrowser().login(user);
    const db = orgDb(env, verifiedOrganizationForTest(organization.id));
    await db.batch([
      db.statement((q) =>
        q.updateTable('users').set({ disabled_at: '2026-10-21T00:00:00.000Z' }).where('id', '=', row.id),
      ),
    ]);
    const browser = newBrowser();
    expect((await browser.login(user)).location).toBe('/');
    expect((await browser.post(me)).status).toBe(200);
    // 無効にされた組織は、停止していても一覧に出ない
    await suspendOrganization(organization.id);
    const listed = await myOrganizationsOf(browser);
    expect(listed.organizations).toEqual([]);
    expect(listed.suspended ?? []).toEqual([]);
  });

  test('アカウントがあり、停止した組織にしか入れない人はログインでき、/ の一覧にその組織が停止として出る', async () => {
    const { organization } = await organizationWithAdmin();
    const user = githubUser('only-suspended-account');
    await createUser(organization, { login_provider: 'github', login_subject: String(user.id), is_admin: 1 });
    await newBrowser().login(user);
    await suspendOrganization(organization.id);

    const browser = newBrowser();
    const result = await browser.login(user);
    expect(result.location).toBe('/');
    expect(browser.sessionToken).toBeDefined();
    const listed = await myOrganizationsOf(browser);
    expect(listed.organizations).toEqual([]);
    expect(listed.suspended).toEqual([{ slug: organization.slug, name: organization.name }]);
    // 組織の中は今どおり 403 の organization_suspended で、セッションは残る
    const inside = await post(app, organizationInfo, { slug: organization.slug, token: browser.sessionToken! });
    expect(inside.status).toBe(403);
    expect((await browser.post(me)).status).toBe(200);
  });

  test('アカウントが無く、停止した組織にだけ指名されている人は、ログインでき、アカウントが作られる', async () => {
    const { organization } = await organizationWithAdmin();
    const user = githubUser('nominated-in-suspended');
    await createUser(organization, {
      account_id: null,
      login_provider: 'github',
      login_subject: String(user.id),
      is_admin: 1,
    });
    await suspendOrganization(organization.id);
    const before = await countAccounts();

    const browser = newBrowser();
    const result = await browser.login(user);
    expect(result.location).toBe('/');
    expect(browser.sessionToken).toBeDefined();
    const login = await accountLoginOf(user);
    expect(login).toBeDefined();
    expect(await countAccounts()).toBe(before + 1);
    expect(await sessionRowsOf(login!.account_id)).toHaveLength(1);
    expect((await myOrganizationsOf(browser)).suspended).toEqual([
      { slug: organization.slug, name: organization.name },
    ]);

    // 再開すれば、結んだ行で組織に入れる
    await resumeOrganization(organization.id);
    expect((await userRow(organization.id, user))?.account_id).toBe(login!.account_id);
    const listed = await myOrganizationsOf(browser);
    expect(listed.organizations).toEqual([{ slug: organization.slug, name: organization.name }]);
    expect(listed.suspended).toEqual([]);
  });

  test('アカウントが無く、停止した組織の承諾待ちの招待だけの人も、ログインでき、アカウントが作られる', async () => {
    const { organization, admin, workspace } = await organizationWithAdmin();
    const invited = githubUser('invited-to-suspended');
    await createInvitation(organization, workspace.id, admin.id, { provider: 'github', subject: String(invited.id) });
    await suspendOrganization(organization.id);

    const browser = newBrowser();
    expect((await browser.login(invited)).location).toBe('/');
    expect(browser.sessionToken).toBeDefined();
    expect(await accountLoginOf(invited)).toBeDefined();
    const listed = await myOrganizationsOf(browser);
    expect(listed.invitations).toEqual([]);
    expect(listed.suspended).toEqual([{ slug: organization.slug, name: organization.name }]);
  });
});

describe('運用者', () => {
  test('運用者の一覧にあるログインの ID は、入れる組織が無くてもログインでき、一覧から外れてもアカウントがあれば入れる', async () => {
    // 開発用の運用者のログインの ID（seed/sessions.ts と同じ。実在の人に当たらない桁）
    const operator = githubUser('operator--test', { id: 9_000_000_000_000_001 });
    const browser = newBrowser();
    const result = await browser.login(operator);
    expect(result.location).toBe('/');
    expect((await accountLoginOf(operator))?.login_subject).toBe('9000000000000001');
    expect((await browser.post(me)).status).toBe(200);

    // 一覧から外れても、アカウントはあるのでログインできる（#639）。運用者ではなくなる
    const removed: Env = Object.assign({}, loginEnv, { OPERATOR_LOGIN_IDS: 'github:9000000000000002' });
    const other = new FakeBrowser(app, github, removed);
    expect((await other.login(operator)).location).toBe('/');
    expect(other.sessionToken).toBeDefined();
    await other.consent();
    const listed = await other.post(myOrganizations);
    expect(listed.status).toBe(200);
    expect(await listed.json()).toMatchObject({ organizations: [], invitations: [], operator: false });
  });

  test('アカウントの無い人は、運用者の一覧に無ければ、入れる組織も無いので denied', async () => {
    const removed: Env = Object.assign({}, loginEnv, { OPERATOR_LOGIN_IDS: 'github:9000000000000002' });
    const browser = new FakeBrowser(app, github, removed);
    const stranger = githubUser('not-operator');
    expect((await browser.login(stranger)).location).toBe('/login?error=denied');
    expect(browser.sessionToken).toBeUndefined();
  });

  test('運用者の一覧が未設定なら、運用者はいない', async () => {
    const none: Env = Object.assign({}, loginEnv);
    delete (none as { OPERATOR_LOGIN_IDS?: string }).OPERATOR_LOGIN_IDS;
    const browser = new FakeBrowser(app, github, none);
    expect((await browser.login(githubUser('nobody'))).location).toBe('/login?error=denied');
  });
});

describe('ログアウト', () => {
  test('今のセッションの行と Cookie を消し、同じ人のほかのセッションは残す', async () => {
    const { organization } = await organizationWithAdmin();
    const user = githubUser('logout-user');
    await createUser(organization, { login_provider: 'github', login_subject: String(user.id), is_admin: 1 });
    const laptop = newBrowser();
    const phone = newBrowser();
    await laptop.login(user);
    await phone.login(user);
    const accountId = (await accountLoginOf(user))!.account_id;
    expect(await sessionRowsOf(accountId)).toHaveLength(2);

    const res = await laptop.post(logout);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
    const cookie = res.headers.getSetCookie().find((line) => line.startsWith(`${SESSION_COOKIE}=`));
    expect(cookie).toContain('Max-Age=0');
    expect(laptop.sessionToken).toBeUndefined();

    const rows = await sessionRowsOf(accountId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.token_hash).toBe(await hashSessionToken(phone.sessionToken!));
    expect((await laptop.post(me)).status).toBe(401);
    expect((await phone.post(me)).status).toBe(200);
  });

  test('Origin が違う呼び出しでは、セッションを消さない', async () => {
    const { organization } = await organizationWithAdmin();
    const user = githubUser('logout-csrf');
    await createUser(organization, { login_provider: 'github', login_subject: String(user.id), is_admin: 1 });
    const browser = newBrowser();
    await browser.login(user);
    const res = await browser.request('/api/logout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
      body: '{}',
    });
    expect(res.status).toBe(403);
    expect((await browser.post(me)).status).toBe(200);
  });
});

describe('組織を失ったあと、結ばれる前の指名の行だけを持つ人', () => {
  test('セッションは残り、その組織にはまだ入れず、もう一度ログインすると結ばれて入れる', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const user = githubUser('renominated');
    const first = await organizationWithAdmin();
    const row = await createUser(first.organization, {
      login_provider: 'github',
      login_subject: String(user.id),
      is_admin: 1,
    });
    const browser = newBrowser();
    await browser.login(user);
    expect((await browser.post(me)).status).toBe(200);
    await browser.consent();
    const accountId = (await accountLoginOf(user))!.account_id;

    // 最初の組織で無効にされ、別の組織に account_id が空の行で指名される
    const firstDb = orgDb(env, verifiedOrganizationForTest(first.organization.id));
    await firstDb.batch([
      firstDb.statement((q) =>
        q.updateTable('users').set({ disabled_at: '2026-10-21T00:00:00.000Z' }).where('id', '=', row.id),
      ),
    ]);
    const second = await organizationWithAdmin();
    await createUser(second.organization, {
      account_id: null,
      login_provider: 'github',
      login_subject: String(user.id),
      is_admin: 1,
    });

    // 組織の一覧も組織の枠も account_id で引くので、結ばれる前の行には入れない。組織を失ってもセッションは消さない（#639）
    const token = browser.sessionToken!;
    const kept = await browser.post(me);
    expect(kept.status).toBe(200);
    expect(kept.headers.getSetCookie().find((line) => line.includes('Max-Age=0'))).toBeUndefined();
    expect(await sessionRowsOf(accountId)).toHaveLength(1);
    expect(browser.sessionToken).toBe(token);
    expect((await post(app, organizationInfo, { slug: second.organization.slug, token })).status).toBe(404);
    expect((await userRow(second.organization.id, user))?.account_id).toBeNull();

    // もう一度ログインすると、ログインのときの判定は結ばれる前の行を数え、結んでから、セッションを作る
    const again = await browser.login(user);
    expect(again.location).toBe('/');
    expect((await userRow(second.organization.id, user))?.account_id).toBe(accountId);
    const entered = await post(app, organizationInfo, {
      slug: second.organization.slug,
      token: browser.sessionToken!,
    });
    expect(entered.status).toBe(200);
    expect((await browser.post(me)).status).toBe(200);
  });
});
