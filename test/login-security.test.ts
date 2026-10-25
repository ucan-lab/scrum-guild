// ログインの守り。state（ログインの CSRF、使い回し、期限）、GitHub との通信の失敗、users.account_id を結ぶ書き込みの失敗、
// レート制限、code・トークン・Cookie の値がログに出ないこと。流れそのものは test/login.test.ts
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { logout, me } from '../src/shared/operations/session/index.ts';
import { commonDb } from '../src/server/db/index.ts';
import { createFakeGithub, FAKE_CLIENT_SECRET } from './auth/fake-github.ts';
import { createLoginApp, FakeBrowser, loginEnv, STATE_COOKIE } from './auth/browser.ts';
import {
  accountLoginOf,
  failUserWrites,
  githubUser,
  organizationWithAdmin,
  sessionRowsOf,
  stateRow,
  userRow,
} from './auth/helpers.ts';
import { createUser } from './factories.ts';

const github = createFakeGithub();
const app = createLoginApp(github);
const newBrowser = () => new FakeBrowser(app, github);

afterEach(() => {
  vi.restoreAllMocks();
});

describe('state', () => {
  async function started() {
    const { organization } = await organizationWithAdmin();
    const user = githubUser('state-user');
    await createUser(organization, { login_provider: 'github', login_subject: String(user.id), is_admin: 1 });
    const browser = newBrowser();
    const start = await browser.start();
    return { user, browser, start };
  }

  test('state が無い戻りは断る', async () => {
    const { user, browser, start } = await started();
    const code = github.issueCode(user, start.challenge);
    const result = await browser.callback({ code });
    expect(result.location).toBe('/login?error=retry');
    expect(browser.sessionToken).toBeUndefined();
    expect(await accountLoginOf(user)).toBeUndefined();
  });

  test('state の Cookie が無い戻りは断り、DB の行は残す', async () => {
    const { user, start } = await started();
    const code = github.issueCode(user, start.challenge);
    const victim = newBrowser();
    const result = await victim.callback({ code, state: start.state });
    expect(result.location).toBe('/login?error=retry');
    expect(victim.sessionToken).toBeUndefined();
    expect(await stateRow(start.state)).toBeDefined();
  });

  test('ログインの CSRF: 攻撃者の state と code を付けた戻りは、被害者のブラウザでは通らない', async () => {
    const { user, browser: attacker, start } = await started();
    const code = github.issueCode(user, start.challenge);
    const victim = newBrowser();
    // 被害者も自分のログインを始めていて、別の state の Cookie を持つ
    await victim.start();
    const result = await victim.callback({ code, state: start.state });
    expect(result.location).toBe('/login?error=retry');
    expect(victim.sessionToken).toBeUndefined();
    expect(await accountLoginOf(user)).toBeUndefined();
    // 攻撃者の state は使われていないので、攻撃者本人の戻りは通る
    expect(await stateRow(start.state)).toBeDefined();
    expect((await attacker.callback({ code, state: start.state })).location).toBe('/');
  });

  test('知らない state は断り、state の Cookie も消す', async () => {
    const { user, browser, start } = await started();
    const code = github.issueCode(user, start.challenge);
    const forged = 'A'.repeat(43);
    browser.cookies.set(STATE_COOKIE, forged);
    expect((await browser.callback({ code, state: forged })).location).toBe('/login?error=retry');
    expect(browser.cookies.has(STATE_COOKIE)).toBe(false);
  });

  test('形の違う state は DB を引かずに断る', async () => {
    const { user, browser, start } = await started();
    const code = github.issueCode(user, start.challenge);
    browser.cookies.set(STATE_COOKIE, 'short');
    expect((await browser.callback({ code, state: 'short' })).location).toBe('/login?error=retry');
  });

  test('使い済みの state は断る。GitHub への交換は1回だけ', async () => {
    const { user, browser, start } = await started();
    const code = github.issueCode(user, start.challenge);
    const cookieValue = browser.cookies.get(STATE_COOKIE)!;
    const exchanges = () => github.calls.filter((call) => call.url.endsWith('/access_token')).length;
    const before = exchanges();
    expect((await browser.callback({ code, state: start.state })).location).toBe('/');

    const replay = newBrowser();
    replay.cookies.set(STATE_COOKIE, cookieValue);
    const again = await replay.callback({ code, state: start.state });
    expect(again.location).toBe('/login?error=retry');
    expect(replay.sessionToken).toBeUndefined();
    expect(exchanges()).toBe(before + 1);
  });

  test('10分を過ぎた state は断る', async () => {
    const { user, browser, start } = await started();
    const db = commonDb(env);
    await db.batch([
      db.statement((q) =>
        q
          .updateTable('oauth_states')
          .set({ expires_at: new Date(Date.now() - 1000).toISOString() })
          .where('state', '=', start.state),
      ),
    ]);
    const code = github.issueCode(user, start.challenge);
    expect((await browser.callback({ code, state: start.state })).location).toBe('/login?error=retry');
    expect(browser.sessionToken).toBeUndefined();
    expect(await accountLoginOf(user)).toBeUndefined();
  });

  test('ほかの手段の state は断る', async () => {
    const { user, browser, start } = await started();
    const db = commonDb(env);
    await db.batch([
      db.statement((q) =>
        q.updateTable('oauth_states').set({ login_provider: 'google' }).where('state', '=', start.state),
      ),
    ]);
    const code = github.issueCode(user, start.challenge);
    expect((await browser.callback({ code, state: start.state })).location).toBe('/login?error=retry');
  });

  test('GitHub が拒否した戻り（error 付き）と code の無い戻りは、ログインの画面へ移す', async () => {
    const { browser, start } = await started();
    const denied = await browser.callback({ error: 'access_denied', state: start.state });
    expect(denied.location).toBe('/login?error=retry');
    const second = newBrowser();
    const next = await second.start('/aoba/board');
    expect((await second.callback({ state: next.state })).location).toBe(
      '/login?error=retry&return_to=%2Faoba%2Fboard',
    );
  });
});

describe('GitHub との通信の失敗', () => {
  async function ready() {
    const { organization } = await organizationWithAdmin();
    const user = githubUser('flaky');
    await createUser(organization, { login_provider: 'github', login_subject: String(user.id), is_admin: 1 });
    const browser = newBrowser();
    const start = await browser.start('/aoba');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    return { user, browser, start };
  }

  test('使えない code は retry で、セッションを作らない', async () => {
    const { user, browser, start } = await ready();
    const result = await browser.callback({ code: 'never-issued', state: start.state });
    expect(result.location).toBe('/login?error=retry&return_to=%2Faoba');
    expect(browser.sessionToken).toBeUndefined();
    expect(await accountLoginOf(user)).toBeUndefined();
  });

  test.each([
    ['トークンのエンドポイントが 5xx', { token: 'server-error' }],
    ['トークンの応答が JSON でない', { token: 'not-json' }],
    ['トークンの応答に access_token が無い', { token: 'wrong-shape' }],
    ['ユーザーの API が 5xx', { user: 'server-error' }],
  ] as const)('%sなら unavailable で、セッションを作らない', async (_label, failure) => {
    const { user, browser, start } = await ready();
    Object.assign(github.failNext, failure);
    const code = github.issueCode(user, start.challenge);
    const result = await browser.callback({ code, state: start.state });
    expect(result.location).toBe('/login?error=unavailable&return_to=%2Faoba');
    expect(browser.sessionToken).toBeUndefined();
    expect(await accountLoginOf(user)).toBeUndefined();
  });

  test('ユーザーの API がトークンを受け付けなければ retry', async () => {
    const { user, browser, start } = await ready();
    github.failNext.user = 'unauthorized';
    const code = github.issueCode(user, start.challenge);
    expect((await browser.callback({ code, state: start.state })).location).toBe(
      '/login?error=retry&return_to=%2Faoba',
    );
  });

  test('使い終えたトークンは GitHub 側でも取り消す', async () => {
    const { user, browser, start } = await ready();
    const before = github.revoked.length;
    const code = github.issueCode(user, start.challenge);
    await browser.callback({ code, state: start.state });
    expect(github.revoked).toHaveLength(before + 1);
    const call = github.calls.findLast((entry) => entry.method === 'DELETE');
    expect(call?.authorization).toBe(`Basic ${btoa(`test-client-id:${FAKE_CLIENT_SECRET}`)}`);
  });

  test('users.account_id を結ぶ書き込みが失敗したら、セッションを作らず retry。次のログインで結ばれる', async () => {
    const { organization } = await organizationWithAdmin();
    const user = githubUser('link-fails');
    await createUser(organization, {
      account_id: null,
      login_provider: 'github',
      login_subject: String(user.id),
      is_admin: 1,
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    const failing = new FakeBrowser(app, github, failUserWrites(loginEnv));
    const failed = await failing.login(user, { returnTo: '/aoba' });
    expect(failed.location).toBe('/login?error=retry&return_to=%2Faoba');
    expect(failing.sessionToken).toBeUndefined();
    const login = await accountLoginOf(user);
    expect(login).toBeDefined();
    expect(await sessionRowsOf(login!.account_id)).toHaveLength(0);
    expect((await userRow(organization.id, user))?.account_id).toBeNull();
    expect(error.mock.calls.flat().join('\n')).not.toContain('secret SQL detail');

    const retry = newBrowser();
    expect((await retry.login(user)).location).toBe('/');
    expect((await userRow(organization.id, user))?.account_id).toBe(login!.account_id);
    expect((await retry.post(me)).status).toBe(200);
  });
});

describe('レート制限', () => {
  test('ログインの開始と戻り先を同じ IP から10分に60回まで数え、超えたら断る', async () => {
    const browser = newBrowser();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const toGithub = /^https:\/\/github\.com\//;
    for (let i = 0; i < 59; i++) {
      expect((await browser.start()).response.headers.get('Location')).toMatch(toGithub);
    }
    // 60回目は通り、61回目から断る。戻り先も同じ数に入る
    const last = await browser.start();
    expect(last.response.headers.get('Location')).toMatch(toGithub);
    const over = await browser.start('/aoba');
    expect(over.response.status).toBe(302);
    expect(over.response.headers.get('Location')).toBe('/login?error=too_many&return_to=%2Faoba');
    // state の行を使い切れた戻りは、同じ枠で数える
    expect(browser.cookies.get(STATE_COOKIE)).toBe(last.state);
    const callback = await browser.callback({ code: 'x', state: last.state });
    expect(callback.location).toBe('/login?error=too_many');
    // 照合に通った戻りは、枠を超えていても state の Cookie を使い切る
    expect(browser.cookies.has(STATE_COOKIE)).toBe(false);

    // ほかの IP は数えない
    expect((await newBrowser().start()).response.headers.get('Location')).toMatch(toGithub);

    // 窓を過ぎれば数え直す
    const db = commonDb(env);
    await db.batch([
      db.statement((q) =>
        q
          .updateTable('rate_limits')
          .set({ window_start_at: new Date(Date.now() - 10 * 60 * 1000 - 1000).toISOString() })
          .where('key', '=', `login:${browser.ip}`),
      ),
    ]);
    expect((await browser.start()).response.headers.get('Location')).toMatch(toGithub);
    const row = await db.first(
      db.statement((q) => q.selectFrom('rate_limits').selectAll().where('key', '=', `login:${browser.ip}`)),
    );
    expect(row?.count).toBe(1);
  });

  test('超えた戻りは GitHub に問い合わせない', async () => {
    const { organization } = await organizationWithAdmin();
    const user = githubUser('limited');
    await createUser(organization, { login_provider: 'github', login_subject: String(user.id), is_admin: 1 });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const browser = newBrowser();
    const start = await browser.start();
    const db = commonDb(env);
    await db.batch([
      db.statement((q) => q.updateTable('rate_limits').set({ count: 60 }).where('key', '=', `login:${browser.ip}`)),
    ]);
    const before = github.calls.length;
    const result = await browser.callback({ code: github.issueCode(user, start.challenge), state: start.state });
    expect(result.location).toBe('/login?error=too_many');
    expect(github.calls.length).toBe(before);
    expect(browser.sessionToken).toBeUndefined();
  });
});

describe('ログ', () => {
  test('code、トークン、state、Cookie の値、クライアントの秘密をログに出さない', async () => {
    const lines: string[] = [];
    const capture = (...args: unknown[]) => void lines.push(args.map(String).join(' '));
    for (const method of ['log', 'error', 'warn', 'info', 'debug'] as const) {
      vi.spyOn(console, method).mockImplementation(capture);
    }

    const { organization } = await organizationWithAdmin();
    const user = githubUser('log-check');
    await createUser(organization, { login_provider: 'github', login_subject: String(user.id), is_admin: 1 });

    // 成功の経路
    const secrets: string[] = [FAKE_CLIENT_SECRET];
    const browser = newBrowser();
    const ok = await browser.login(user);
    secrets.push(ok.code, ok.started.state, ok.started.challenge, browser.sessionToken!);
    secrets.push(...github.revoked, 'gho_fake_token');

    // 失敗の経路: 使えない code、state の不一致、GitHub の 5xx、入れない人
    const failing = newBrowser();
    const start = await failing.start();
    secrets.push(start.state);
    const bad = await failing.callback({ code: 'secret-bad-code', state: start.state });
    secrets.push('secret-bad-code');
    expect(bad.location).toContain('error=retry');
    const mismatch = await newBrowser().callback({ code: 'secret-other-code', state: start.state });
    secrets.push('secret-other-code');
    expect(mismatch.location).toContain('error=retry');
    const serverError = newBrowser();
    const failStart = await serverError.start();
    github.failNext.token = 'server-error';
    const failCode = github.issueCode(user, failStart.challenge);
    await serverError.callback({ code: failCode, state: failStart.state });
    secrets.push(failCode, failStart.state);
    const strangerLogin = await newBrowser().login(githubUser('log-stranger'));
    secrets.push(strangerLogin.code, strangerLogin.started.state);

    // 認証済みの操作のログ（me、logout）にも Cookie の値は出ない
    await browser.post(me);
    await browser.post(logout);

    expect(lines.length).toBeGreaterThan(0);
    const logged = lines.join('\n');
    for (const secret of secrets) {
      expect(logged, secret.slice(0, 12)).not.toContain(secret);
    }
    expect(logged).not.toContain('Bearer');
    expect(logged).not.toContain('code_verifier');
    // ログの1行は JSON で、どれも requestId を持つ
    for (const line of lines) expect(JSON.parse(line)).toHaveProperty('requestId');
  });
});
