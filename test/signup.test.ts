// 会員登録（Issue #640）。ログインと分けた入口で、招待もアカウントも入れる組織も無い人がアカウントを作れること。
//   - completeLogin の登録の分岐（signup: true）と、印なしのログインが今どおり denied で断ること
//   - 登録の印（oauth_states.signup）が startOAuthState と consumeOAuthState の往復で保たれ、DB の CHECK が 0/1 以外を断ること
//   - GET /api/auth/<手段>/start?signup=1 だけが印を付けること（値が 1 のときだけ。招待の URL の POST の開始は付けない）
//   - 開始から戻り先までの往復（GitHub と Google）
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { me } from '../src/shared/operations/session/index.ts';
import { completeLogin } from '../src/server/auth/login.ts';
import { consumeOAuthState, startOAuthState } from '../src/server/auth/oauth-state.ts';
import { commonDb } from '../src/server/db/index.ts';
import { createFakeGithub, type FakeGithubUser } from './auth/fake-github.ts';
import { createFakeGoogle, type FakeGoogleUser } from './auth/fake-google.ts';
import { createLoginApp, FakeBrowser, loginEnv, type LoginProvider } from './auth/browser.ts';
import {
  accountLoginOf,
  countAccounts,
  githubUser,
  googleAccountLoginOf,
  googleUser,
  organizationWithAdmin,
  sessionRowsOf,
  stateRow,
  userRow,
} from './auth/helpers.ts';
import { createInvitation, createUser } from './factories.ts';

const github = createFakeGithub();
const google = createFakeGoogle();
const app = createLoginApp(github, google);
const newBrowser = (provider: LoginProvider = 'github') => {
  const browser = new FakeBrowser(app, github, loginEnv, undefined, google);
  browser.provider = provider;
  return browser;
};

afterEach(() => {
  vi.restoreAllMocks();
});

const profileOf = (user: FakeGithubUser) => ({
  subject: String(user.id),
  loginName: user.login,
  displayName: user.name ?? null,
  avatarUrl: null,
});

const loginInput = (user: FakeGithubUser, signup?: boolean) => ({
  provider: 'github',
  profile: profileOf(user),
  now: new Date(),
  replacedSessionToken: undefined,
  requestId: 'request-signup',
  ...(signup === undefined ? {} : { signup }),
});

async function accountLoginRows(user: FakeGithubUser) {
  const db = commonDb(env);
  return db.rows(
    db.statement((q) => q.selectFrom('account_logins').selectAll().where('login_subject', '=', String(user.id))),
  );
}

// 開始から戻り先までを通す。query は開始の URL の末尾（`?signup=1` など）。FakeBrowser.login は signup を付けられないので、ここで組む
async function roundTrip(browser: FakeBrowser, user: FakeGithubUser, query: string) {
  const response = await browser.request(`/api/auth/github/start${query}`);
  const location = new URL(response.headers.get('Location') ?? '', 'https://scrum-guild.test');
  const state = location.searchParams.get('state') ?? '';
  const code = github.issueCode(user, location.searchParams.get('code_challenge') ?? '');
  const finished = await browser.callback({ code, state });
  return { state, ...finished };
}

async function googleRoundTrip(browser: FakeBrowser, user: FakeGoogleUser, query: string) {
  const response = await browser.request(`/api/auth/google/start${query}`);
  const location = new URL(response.headers.get('Location') ?? '', 'https://scrum-guild.test');
  const state = location.searchParams.get('state') ?? '';
  const code = google.issueCode(user, location);
  const finished = await browser.callback({ code, state });
  return { state, ...finished };
}

describe('completeLogin の登録の分岐', () => {
  test('登録の印があり、アカウントも組織も招待も無い人は、accounts と account_logins を作り、ログインできる', async () => {
    const user = githubUser('signup-new');
    const before = await countAccounts();

    const result = await completeLogin(env, loginInput(user, true));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(await countAccounts()).toBe(before + 1);
    const login = await accountLoginOf(user);
    expect(login).toMatchObject({ account_id: result.accountId, login_name: user.login });
    expect(await sessionRowsOf(result.accountId)).toHaveLength(1);
  });

  test('登録の印が無い（省略）ログインは、今どおり denied で断り、accounts も account_logins も作らない', async () => {
    const user = githubUser('login-no-signup');
    const before = await countAccounts();

    expect(await completeLogin(env, loginInput(user))).toEqual({ ok: false, reason: 'denied' });
    expect(await countAccounts()).toBe(before);
    expect(await accountLoginOf(user)).toBeUndefined();
  });

  test('登録の印が false のログインも denied で、accounts を作らない', async () => {
    const user = githubUser('login-signup-false');
    const before = await countAccounts();

    expect(await completeLogin(env, loginInput(user, false))).toEqual({ ok: false, reason: 'denied' });
    expect(await countAccounts()).toBe(before);
    expect(await accountLoginOf(user)).toBeUndefined();
  });

  test('すでにアカウントがある人が登録の印で来ても、新しいアカウントを作らず、同じ account_id でログインする', async () => {
    const { organization } = await organizationWithAdmin();
    const user = githubUser('signup-existing');
    await createUser(organization, { login_provider: 'github', login_subject: String(user.id), is_admin: 1 });
    const first = await completeLogin(env, loginInput(user));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const before = await countAccounts();

    const again = await completeLogin(env, loginInput(user, true));

    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.accountId).toBe(first.accountId);
    expect(await countAccounts()).toBe(before);
    expect(await accountLoginRows(user)).toHaveLength(1);
    expect(await sessionRowsOf(first.accountId)).toHaveLength(2);
  });

  test('入れる組織を失ったアカウントがある人が登録の印で来ても、新しいアカウントを作らない', async () => {
    const user = githubUser('signup-orphan');
    const created = await completeLogin(env, loginInput(user, true));
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const before = await countAccounts();

    const again = await completeLogin(env, loginInput(user, true));
    expect(again.ok && again.accountId).toBe(created.accountId);
    expect(await countAccounts()).toBe(before);
  });

  test('指名で待っていた行がある人が登録の印で来ると、通常のログインと同じに users.account_id へ結ばれる', async () => {
    const { organization } = await organizationWithAdmin();
    const user = githubUser('signup-nominated');
    await createUser(organization, {
      account_id: null,
      login_provider: 'github',
      login_subject: String(user.id),
      is_admin: 1,
    });
    const before = await countAccounts();

    const result = await completeLogin(env, loginInput(user, true));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(await countAccounts()).toBe(before + 1);
    expect((await userRow(organization.id, user))?.account_id).toBe(result.accountId);
  });

  test('届いた招待がある人が登録の印で来ても、通常のログインと同じに結ばれ、アカウントは1つ', async () => {
    const { organization, admin, workspace } = await organizationWithAdmin();
    const user = githubUser('signup-invited');
    await createInvitation(organization, workspace.id, admin.id, { provider: 'github', subject: String(user.id) });
    const before = await countAccounts();

    const result = await completeLogin(env, loginInput(user, true));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(await countAccounts()).toBe(before + 1);
    expect(await accountLoginRows(user)).toHaveLength(1);
    expect((await accountLoginOf(user))?.account_id).toBe(result.accountId);
  });

  test.each([
    ['指名で待っていた行', 'nomination'],
    ['届いた招待', 'invitation'],
  ] as const)('%sがある人の登録の印あり・なしは同じ結果（どちらも ok）', async (_label, kind) => {
    const { organization, admin, workspace } = await organizationWithAdmin();
    const withSignup = githubUser(`signup-same-${kind}-1`);
    const withoutSignup = githubUser(`signup-same-${kind}-2`);
    for (const user of [withSignup, withoutSignup]) {
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
    }
    const a = await completeLogin(env, loginInput(withSignup, true));
    const b = await completeLogin(env, loginInput(withoutSignup));
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
  });

  test('停止した組織の招待だけがある人は、登録の印があってもなくても、今どおりログインできる', async () => {
    const { organization, admin, workspace } = await organizationWithAdmin();
    const user = githubUser('signup-suspended-invite');
    const plain = githubUser('login-suspended-invite');
    for (const person of [user, plain]) {
      await createInvitation(organization, workspace.id, admin.id, { provider: 'github', subject: String(person.id) });
    }
    const db = commonDb(env);
    await db.batch([
      db.statement((q) =>
        q
          .updateTable('organizations')
          .set({ suspended_at: '2026-10-22T00:00:00.000Z' })
          .where('id', '=', organization.id),
      ),
    ]);

    expect((await completeLogin(env, loginInput(plain))).ok).toBe(true);
    expect((await completeLogin(env, loginInput(user, true))).ok).toBe(true);
  });

  test('別の人宛の招待しか無い組織があっても、印なしの見知らぬ人は denied のまま', async () => {
    const { organization, admin, workspace } = await organizationWithAdmin();
    await createInvitation(organization, workspace.id, admin.id, { provider: 'github', subject: '424242424242' });
    const stranger = githubUser('stranger-no-signup');
    const before = await countAccounts();

    expect(await completeLogin(env, loginInput(stranger))).toEqual({ ok: false, reason: 'denied' });
    expect(await countAccounts()).toBe(before);
  });

  test('同じ人の登録が並行しても、アカウントは1つで、両方が成功する', async () => {
    const user = githubUser('signup-race');
    const before = await countAccounts();

    const [a, b] = await Promise.all([
      completeLogin(env, loginInput(user, true)),
      completeLogin(env, loginInput(user, true)),
    ]);

    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(await accountLoginRows(user)).toHaveLength(1);
    expect(await countAccounts()).toBe(before + 1);
    const accountId = (await accountLoginOf(user))!.account_id;
    expect(await sessionRowsOf(accountId)).toHaveLength(2);
  });
});

describe('登録の印の往復（oauth_states.signup）', () => {
  const now = new Date();

  test('startOAuthState の既定は印なしで、consumeOAuthState も false で返す', async () => {
    const started = await startOAuthState(env, 'github', '/', now, false);
    expect((await stateRow(started.state))?.signup).toBe(0);

    const consumed = await consumeOAuthState(env, 'github', started.state, now);
    expect(consumed?.signup).toBe(false);
  });

  test('false を渡すと 0 で入り、false で返る', async () => {
    const started = await startOAuthState(env, 'github', '/', now, false, null, false);
    expect((await stateRow(started.state))?.signup).toBe(0);
    expect((await consumeOAuthState(env, 'github', started.state, now))?.signup).toBe(false);
  });

  test('true を渡すと 1 で入り、true で返る', async () => {
    const started = await startOAuthState(env, 'github', '/aoba', now, false, null, true);
    expect((await stateRow(started.state))?.signup).toBe(1);

    const consumed = await consumeOAuthState(env, 'github', started.state, now);
    expect(consumed).toMatchObject({ signup: true, returnTo: '/aoba', claimTokenHash: null });
    expect(await stateRow(started.state)).toBeUndefined();
  });

  test('招待の URL の秘密のハッシュと登録の印は、互いに影響せず保たれる', async () => {
    const hash = 'a'.repeat(64);
    const started = await startOAuthState(env, 'google', '/', now, true, hash, true);
    const consumed = await consumeOAuthState(env, 'google', started.state, now);
    expect(consumed).toMatchObject({ signup: true, claimTokenHash: hash });
  });

  test('別の手段で消費しても signup は返らない（行は使い切られる）', async () => {
    const started = await startOAuthState(env, 'github', '/', now, false, null, true);
    expect(await consumeOAuthState(env, 'google', started.state, now)).toBeUndefined();
    expect(await stateRow(started.state)).toBeUndefined();
  });
});

describe('開始のルート（signup の値）', () => {
  test.each([
    ['github', '?signup=1', 1],
    ['github', '?signup=1&return_to=%2Faoba', 1],
    ['google', '?signup=1', 1],
    ['github', '', 0],
    ['github', '?signup=0', 0],
    ['github', '?signup=true', 0],
    ['github', '?signup=', 0],
    ['github', '?signup=2', 0],
    ['github', '?signup=01', 0],
    ['github', '?signup=%201', 0],
    ['github', '?signup=1&signup=0', 0],
    ['github', '?signup=0&signup=1', 0],
    ['google', '', 0],
    ['google', '?signup=true', 0],
    ['google', '?signup=1&signup=0', 0],
  ] as const)('%s の開始 %s は、state の行の signup が %i', async (provider, query, expected) => {
    const browser = newBrowser(provider);
    const response = await browser.request(`/api/auth/${provider}/start${query}`);
    expect(response.status).toBe(302);
    const state = new URL(response.headers.get('Location') ?? '', 'https://scrum-guild.test').searchParams.get('state');
    expect((await stateRow(state ?? ''))?.signup).toBe(expected);
  });

  test('return_to は登録の印と別に、今までどおり保たれる', async () => {
    const response = await newBrowser().request('/api/auth/github/start?signup=1&return_to=%2Faoba%2Fboard');
    const state = new URL(response.headers.get('Location') ?? '', 'https://scrum-guild.test').searchParams.get('state');
    expect(await stateRow(state ?? '')).toMatchObject({ signup: 1, return_to: '/aoba/board' });
  });

  test('招待の URL の POST の開始（POST /google/start）は、印を付けない', async () => {
    const claimToken = 'A'.repeat(43);
    const started = await newBrowser('google').startInvite(claimToken);
    expect(started.response.status).toBe(302);
    expect(started.state).not.toBe('');
    expect(await stateRow(started.state)).toMatchObject({ signup: 0 });
  });

  test('画面の移動でない読み込み（Sec-Fetch-Mode: no-cors）の ?signup=1 は、行を書かない', async () => {
    const db = commonDb(env);
    const count = async () => (await db.rows(db.statement((q) => q.selectFrom('oauth_states').select('state')))).length;
    const before = await count();
    const response = await newBrowser().request('/api/auth/github/start?signup=1', {
      headers: { 'Sec-Fetch-Mode': 'no-cors', 'Sec-Fetch-Dest': 'image', 'Sec-Fetch-Site': 'cross-site' },
    });
    expect(response.headers.get('Location')).toBe('/login');
    expect(await count()).toBe(before);
  });
});

describe('登録の往復（GitHub）', () => {
  test('招待の無い人が登録の往復を通すと、accounts と account_logins ができ、ログインした状態になる', async () => {
    const user = githubUser('signup-flow-new');
    const browser = newBrowser();
    const before = await countAccounts();

    const result = await roundTrip(browser, user, '?signup=1');

    expect(result.location).not.toMatch(/^\/login/);
    expect(browser.sessionToken).toBeDefined();
    expect(await countAccounts()).toBe(before + 1);
    const login = await accountLoginOf(user);
    expect(login).toMatchObject({ login_provider: 'github', login_name: user.login });
    expect(await sessionRowsOf(login!.account_id)).toHaveLength(1);
    expect(await stateRow(result.state)).toBeUndefined();

    await browser.consent();
    const mine = await browser.post(me);
    expect(mine.status).toBe(200);
    expect(await mine.json()).toMatchObject({ account_id: login!.account_id, login_provider: 'github' });
  });

  test('ログインの往復（印なし）は、今どおり /login?error=denied で断り、accounts を作らず、セッションも置かない', async () => {
    const user = githubUser('signup-flow-login-only');
    const browser = newBrowser();
    const before = await countAccounts();

    const result = await roundTrip(browser, user, '');

    expect(result.location).toBe('/login?error=denied');
    expect(browser.sessionToken).toBeUndefined();
    expect(await countAccounts()).toBe(before);
    expect(await accountLoginOf(user)).toBeUndefined();
  });

  test.each(['?signup=0', '?signup=true', '?signup=1&signup=0'])(
    '印にならない開始（%s）の往復は denied で、accounts を作らない',
    async (query) => {
      const user = githubUser('signup-flow-not-flag');
      const before = await countAccounts();
      const result = await roundTrip(newBrowser(), user, query);
      expect(result.location).toBe('/login?error=denied');
      expect(await countAccounts()).toBe(before);
    },
  );

  test('戻りの URL に signup=1 を足しても、開始が印を付けていなければ、アカウントは作られない（印は state の行から読む）', async () => {
    const user = githubUser('signup-flow-tamper');
    const browser = newBrowser();
    const response = await browser.request('/api/auth/github/start');
    const location = new URL(response.headers.get('Location') ?? '', 'https://scrum-guild.test');
    const state = location.searchParams.get('state') ?? '';
    const code = github.issueCode(user, location.searchParams.get('code_challenge') ?? '');
    const before = await countAccounts();

    const finished = await browser.callback({ code, state, signup: '1' });

    expect(finished.location).toBe('/login?error=denied');
    expect(await countAccounts()).toBe(before);
  });

  test('すでにアカウントがある人が登録の往復を通すと、新しく作らず同じ account_id でログインする', async () => {
    const { organization } = await organizationWithAdmin();
    const user = githubUser('signup-flow-existing');
    await createUser(organization, { login_provider: 'github', login_subject: String(user.id), is_admin: 1 });
    const first = await roundTrip(newBrowser(), user, '');
    expect(first.location).toBe('/');
    const accountId = (await accountLoginOf(user))!.account_id;
    const before = await countAccounts();

    const browser = newBrowser();
    const result = await roundTrip(browser, user, '?signup=1');

    expect(result.location).not.toMatch(/^\/login/);
    expect(browser.sessionToken).toBeDefined();
    expect(await countAccounts()).toBe(before);
    expect(await accountLoginRows(user)).toHaveLength(1);
    expect((await accountLoginOf(user))!.account_id).toBe(accountId);
    expect(await sessionRowsOf(accountId)).toHaveLength(2);
  });

  test('登録で作ったばかりのアカウントの人が、もう一度登録の往復を通しても、アカウントは1つのまま', async () => {
    const user = githubUser('signup-flow-twice');
    const before = await countAccounts();
    await roundTrip(newBrowser(), user, '?signup=1');
    await roundTrip(newBrowser(), user, '?signup=1');
    expect(await countAccounts()).toBe(before + 1);
    expect(await accountLoginRows(user)).toHaveLength(1);
  });

  test('指名で待っていた行がある人が登録の往復を通すと、通常のログインと同じに users.account_id へ結ばれる', async () => {
    const { organization } = await organizationWithAdmin();
    const user = githubUser('signup-flow-nominated');
    await createUser(organization, {
      account_id: null,
      login_provider: 'github',
      login_subject: String(user.id),
      is_admin: 1,
    });

    const browser = newBrowser();
    const result = await roundTrip(browser, user, '?signup=1');

    expect(result.location).not.toMatch(/^\/login/);
    expect(browser.sessionToken).toBeDefined();
    const accountId = (await accountLoginOf(user))!.account_id;
    expect((await userRow(organization.id, user))?.account_id).toBe(accountId);
  });

  test('届いた招待がある人が登録の往復を通すと、通常のログインと同じにログインし、アカウントは1つ', async () => {
    const { organization, admin, workspace } = await organizationWithAdmin();
    const user = githubUser('signup-flow-invited');
    await createInvitation(organization, workspace.id, admin.id, { provider: 'github', subject: String(user.id) });
    const before = await countAccounts();

    const browser = newBrowser();
    const result = await roundTrip(browser, user, '?signup=1');

    expect(result.location).not.toMatch(/^\/login/);
    expect(browser.sessionToken).toBeDefined();
    expect(await countAccounts()).toBe(before + 1);
    expect(await accountLoginRows(user)).toHaveLength(1);
  });

  test('同じ人の登録の往復が並行しても、アカウントは1つで、両方がログインできる', async () => {
    const user = githubUser('signup-flow-race');
    const before = await countAccounts();
    const a = newBrowser();
    const b = newBrowser();

    const [first, second] = await Promise.all([roundTrip(a, user, '?signup=1'), roundTrip(b, user, '?signup=1')]);

    expect(first.location).not.toMatch(/^\/login/);
    expect(second.location).not.toMatch(/^\/login/);
    expect(a.sessionToken).toBeDefined();
    expect(b.sessionToken).toBeDefined();
    expect(await countAccounts()).toBe(before + 1);
    expect(await accountLoginRows(user)).toHaveLength(1);
  });
});

describe('登録の往復（Google）', () => {
  test('招待の無い人が登録の往復を通すと、アカウントができ、ログインした状態になる', async () => {
    const user = googleUser('登録 太郎');
    const browser = newBrowser('google');
    const before = await countAccounts();

    const result = await googleRoundTrip(browser, user, '?signup=1');

    expect(result.location).not.toMatch(/^\/login/);
    expect(browser.sessionToken).toBeDefined();
    expect(await countAccounts()).toBe(before + 1);
    const login = await googleAccountLoginOf(user);
    expect(login).toBeDefined();
    expect(await sessionRowsOf(login!.account_id)).toHaveLength(1);
  });

  test('ログインの往復（印なし）は denied で、アカウントを作らない', async () => {
    const user = googleUser('登録 次郎');
    const before = await countAccounts();

    const result = await googleRoundTrip(newBrowser('google'), user, '');

    expect(result.location).toBe('/login?error=denied');
    expect(await countAccounts()).toBe(before);
    expect(await googleAccountLoginOf(user)).toBeUndefined();
  });

  test('すでにアカウントがある人が登録の往復を通すと、同じ account_id でログインする', async () => {
    const { organization } = await organizationWithAdmin();
    const user = googleUser('登録 三郎');
    await createUser(organization, { login_provider: 'google', login_subject: user.sub, is_admin: 1 });
    expect((await googleRoundTrip(newBrowser('google'), user, '')).location).toBe('/');
    const accountId = (await googleAccountLoginOf(user))!.account_id;
    const before = await countAccounts();

    const result = await googleRoundTrip(newBrowser('google'), user, '?signup=1');

    expect(result.location).not.toMatch(/^\/login/);
    expect(await countAccounts()).toBe(before);
    expect((await googleAccountLoginOf(user))!.account_id).toBe(accountId);
  });
});
