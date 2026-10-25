// ログインの競合。同じ人の最初のログインが並行したとき、同じ state の戻りが並行したときに、
// 行が重ならず、権限のある人が断られないことを確かめる。実行の順を固定するもの（afterFirstQuery）と、Promise.all で流すものがある
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { completeLogin } from '../src/server/auth/login.ts';
import { commonDb } from '../src/server/db/index.ts';
import { createFakeGithub, type FakeGithubUser } from './auth/fake-github.ts';
import { createLoginApp, FakeBrowser, loginEnv, STATE_COOKIE } from './auth/browser.ts';
import {
  accountLoginOf,
  afterFirstQuery,
  countAccounts,
  githubUser,
  organizationWithAdmin,
  sessionRowsOf,
  userRow,
} from './auth/helpers.ts';
import { createInvitation, createUser } from './factories.ts';

const github = createFakeGithub();
const app = createLoginApp(github);
const newBrowser = () => new FakeBrowser(app, github);

afterEach(() => {
  vi.restoreAllMocks();
});

const profileOf = (user: FakeGithubUser) => ({
  subject: String(user.id),
  loginName: user.login,
  displayName: user.name ?? null,
  avatarUrl: null,
});

const loginInput = (user: FakeGithubUser) => ({
  provider: 'github',
  profile: profileOf(user),
  now: new Date(),
  replacedSessionToken: undefined,
  requestId: 'request-race',
});

async function accountLoginRows(user: FakeGithubUser) {
  const db = commonDb(env);
  return db.rows(
    db.statement((q) => q.selectFrom('account_logins').selectAll().where('login_subject', '=', String(user.id))),
  );
}

describe('同じ人の最初のログインの競合', () => {
  test('片方がアカウントを作り、指名の行を結んだ後に、もう片方の判定が走っても、断られない', async () => {
    const { organization } = await organizationWithAdmin();
    const user = githubUser('race-fixed');
    await createUser(organization, {
      account_id: null,
      login_provider: 'github',
      login_subject: String(user.id),
      is_admin: 1,
    });
    const first = newBrowser();
    // 後の側がアカウントを「無い」と読んだ直後に、先の側のログインを最後まで進める。結んだ行は、アカウントが無い側からは当たらなくなる
    const second = new FakeBrowser(
      app,
      github,
      afterFirstQuery(
        loginEnv,
        (sql) => sql.startsWith('select "account_id" from "account_logins"'),
        async () => void (await first.login(user)),
      ),
    );
    const result = await second.login(user);
    expect(result.location).toBe('/');
    expect(second.sessionToken).toBeDefined();
    expect(first.sessionToken).toBeDefined();

    const rows = await accountLoginRows(user);
    expect(rows).toHaveLength(1);
    expect(await sessionRowsOf(rows[0]!.account_id)).toHaveLength(2);
    expect((await userRow(organization.id, user))?.account_id).toBe(rows[0]!.account_id);
  });

  test('入れない人は、アカウントを読み直しても断られ、アカウントを作らない', async () => {
    const user = githubUser('race-denied');
    const before = await countAccounts();
    const result = await newBrowser().login(user);
    expect(result.location).toBe('/login?error=denied');
    expect(await countAccounts()).toBe(before);
  });

  test.each([
    ['承諾待ちの招待で入る人', 'invitation'],
    ['指名で待っていた管理者', 'nomination'],
  ] as const)('%sの completeLogin を2つ並行して流すと、アカウントは1つで、両方が成功する', async (_label, kind) => {
    const { organization, admin, workspace } = await organizationWithAdmin();
    const user = githubUser(`race-${kind}`);
    if (kind === 'invitation') {
      await createInvitation(organization, workspace.id, admin.id, { provider: 'github', subject: String(user.id) });
    } else {
      await createUser(organization, {
        account_id: null,
        login_provider: 'github',
        login_subject: String(user.id),
        is_admin: 1,
      });
    }
    const before = await countAccounts();

    const [a, b] = await Promise.all([completeLogin(env, loginInput(user)), completeLogin(env, loginInput(user))]);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(await accountLoginRows(user)).toHaveLength(1);
    expect(await countAccounts()).toBe(before + 1);
    const accountId = (await accountLoginOf(user))!.account_id;
    expect(await sessionRowsOf(accountId)).toHaveLength(2);
    if (kind === 'nomination') expect((await userRow(organization.id, user))?.account_id).toBe(accountId);
  });
});

describe('同じ state の戻りの競合', () => {
  test('並行して流しても、GitHub と交換するのは片方だけで、もう片方は retry', async () => {
    const { organization } = await organizationWithAdmin();
    const user = githubUser('race-state');
    await createUser(organization, { login_provider: 'github', login_subject: String(user.id), is_admin: 1 });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const first = newBrowser();
    const started = await first.start();
    const second = newBrowser();
    second.cookies.set(STATE_COOKIE, started.state);
    const code = github.issueCode(user, started.challenge);
    const exchanges = () => github.calls.filter((call) => call.url.endsWith('/access_token')).length;
    const before = exchanges();

    const results = await Promise.all([
      first.callback({ code, state: started.state }),
      second.callback({ code, state: started.state }),
    ]);
    expect(results.map((result) => result.location).sort()).toEqual(['/', '/login?error=retry']);
    expect(exchanges()).toBe(before + 1);
    expect([first.sessionToken, second.sessionToken].filter((token) => token !== undefined)).toHaveLength(1);
  });
});
