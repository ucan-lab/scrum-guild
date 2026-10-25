// Google でログインする流れの結合テスト。Google への通信は差し替えた fetch（test/auth/fake-google.ts）に向け、
// アプリ（開始、戻り先、セッション、me）と D1 は本物を使う。ID トークンの検査そのものは test/google-id-token.test.ts
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { me } from '../src/shared/operations/session/index.ts';
import { commonDb, orgDb } from '../src/server/db/index.ts';
import { verifiedOrganizationForTest } from '../src/server/db/testing.ts';
import { createFakeGithub } from './auth/fake-github.ts';
import {
  createFakeGoogle,
  FAKE_GOOGLE_CLIENT_ID,
  FAKE_GOOGLE_CLIENT_SECRET,
  GOOGLE_TOKEN_URL,
} from './auth/fake-google.ts';
import { createLoginApp, FakeBrowser, loginEnv, STATE_COOKIE } from './auth/browser.ts';
import {
  countAccounts,
  googleAccountLoginOf,
  googleUser,
  organizationWithAdmin,
  sessionRowsOf,
  stateRow,
} from './auth/helpers.ts';
import { createUser } from './factories.ts';

const github = createFakeGithub();
const google = createFakeGoogle();
const app = createLoginApp(github, google);
const newBrowser = (environment: Env = loginEnv) => new FakeBrowser(app, github, environment, undefined, google);
const googleBrowser = (environment: Env = loginEnv) => {
  const browser = newBrowser(environment);
  browser.provider = 'google';
  return browser;
};

afterEach(() => {
  vi.restoreAllMocks();
});

async function memberOf(sub: string, overrides: { account_id?: null } = {}) {
  const { organization } = await organizationWithAdmin();
  const row = await createUser(organization, {
    login_provider: 'google',
    login_subject: sub,
    is_admin: 1,
    ...overrides,
  });
  return { organization, row };
}

describe('開始', () => {
  test('Google の認可の URL へ移し、state、PKCE、nonce、アカウントの選択を付け、nonce を state の行に入れる', async () => {
    const browser = googleBrowser();
    const started = await browser.start('/aoba/board');
    expect(started.response.status).toBe(302);
    expect(started.location.origin + started.location.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    const params = started.location.searchParams;
    expect(params.get('response_type')).toBe('code');
    expect(params.get('client_id')).toBe(FAKE_GOOGLE_CLIENT_ID);
    expect(params.get('redirect_uri')).toBe('https://scrum-guild.ucan-lab.workers.dev/api/auth/google/callback');
    expect(params.get('scope')).toBe('openid email profile');
    expect(params.get('code_challenge_method')).toBe('S256');
    expect(params.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(params.get('prompt')).toBe('select_account');
    expect(params.get('state')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(params.get('nonce')).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const row = await stateRow(started.state);
    expect(row).toMatchObject({ login_provider: 'google', return_to: '/aoba/board', nonce: params.get('nonce') });
    expect(browser.cookies.get(STATE_COOKIE)).toBe(started.state);
  });

  test('GitHub の開始は nonce を作らず、認可の URL にも付けない', async () => {
    const started = await newBrowser().start();
    expect(started.location.searchParams.has('nonce')).toBe(false);
    expect((await stateRow(started.state))?.nonce).toBeNull();
  });

  test('Google のクライアント ID と秘密が設定されていなければ、ログインの画面へ移し、行も作らない', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const unconfigured: Env = Object.assign({}, loginEnv, { GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '' });
    const browser = googleBrowser(unconfigured);
    const started = await browser.start('/aoba');
    expect(started.response.headers.get('Location')).toBe('/login?error=unavailable&return_to=%2Faoba');
    expect(browser.cookies.size).toBe(0);
  });

  test('Google だけ未設定でも GitHub は始められる', async () => {
    const unconfigured: Env = Object.assign({}, loginEnv, { GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '' });
    const started = await newBrowser(unconfigured).start();
    expect(started.location.origin).toBe('https://github.com');
  });
});

describe('ログイン', () => {
  test('users の login_subject に sub を入れた人はログインでき、アカウントと account_logins を作って users に結ぶ', async () => {
    const user = googleUser('星野 澪');
    const { organization, row } = await memberOf(user.sub, { account_id: null });
    const before = await countAccounts();

    const browser = googleBrowser();
    const result = await browser.loginWithGoogle(user, { returnTo: '/aoba/board?tab=1' });
    expect(result.response.status).toBe(302);
    expect(result.location).toBe('/aoba/board?tab=1');

    const login = await googleAccountLoginOf(user);
    expect(login).toMatchObject({
      login_provider: 'google',
      login_subject: user.sub,
      login_name: '星野 澪',
      display_name: '星野 澪',
      avatar_url: 'https://lh3.googleusercontent.com/a/fake-avatar',
    });
    expect(await countAccounts()).toBe(before + 1);
    const db = orgDb(env, verifiedOrganizationForTest(organization.id));
    const linked = await db.first(
      db.statement((q) => q.selectFrom('users').select('account_id').where('id', '=', row.id)),
    );
    expect(linked?.account_id).toBe(login!.account_id);

    // state は使い切る
    expect(await stateRow(result.started.state)).toBeUndefined();
    expect(browser.cookies.has(STATE_COOKIE)).toBe(false);

    const mine = await browser.post(me);
    expect(await mine.json()).toEqual({
      account_id: login!.account_id,
      login_provider: 'google',
      login_name: '星野 澪',
      display_name: '星野 澪',
      avatar_url: 'https://lh3.googleusercontent.com/a/fake-avatar',
    });
  });

  test('sub は桁が落ちない文字列のまま account_logins に入る', async () => {
    const user = googleUser('長い sub', { sub: '118234567890123456789' });
    await memberOf(user.sub);
    expect((await googleBrowser().loginWithGoogle(user)).location).toBe('/');
    expect((await googleAccountLoginOf(user))?.login_subject).toBe('118234567890123456789');
  });

  test('メールアドレスは account_logins のどの列にも入らない', async () => {
    const user = googleUser('メール確認', { email: 'private-address@example.test' });
    await memberOf(user.sub);
    await googleBrowser().loginWithGoogle(user);
    const login = await googleAccountLoginOf(user);
    expect(JSON.stringify(login)).not.toContain('private-address');
    expect(JSON.stringify(login)).not.toContain('example.test');
  });

  test('名前が無い人の login_name は「Google ユーザー」、display_name は null', async () => {
    const user = googleUser(null);
    await memberOf(user.sub);
    await googleBrowser().loginWithGoogle(user);
    expect(await googleAccountLoginOf(user)).toMatchObject({ login_name: 'Google ユーザー', display_name: null });
  });

  test('lh3 でないアバターは null にする', async () => {
    const user = googleUser('アバター違い', { picture: 'https://example.test/a.png' });
    await memberOf(user.sub);
    await googleBrowser().loginWithGoogle(user);
    expect((await googleAccountLoginOf(user))?.avatar_url).toBeNull();
  });

  test('email_verified が文字列の "true" でも、メールを使わないログインは断らない', async () => {
    const user = googleUser('未確認', { email_verified: 'true' });
    await memberOf(user.sub);
    expect((await googleBrowser().loginWithGoogle(user)).location).toBe('/');
  });

  test('2回目は表示用の値を書き直し、アカウントは増やさない', async () => {
    const user = googleUser('最初の名前');
    await memberOf(user.sub);
    const browser = googleBrowser();
    await browser.loginWithGoogle(user);
    const first = await googleAccountLoginOf(user);
    const before = await countAccounts();

    await browser.loginWithGoogle({ ...user, name: '新しい名前' });
    expect(await googleAccountLoginOf(user)).toMatchObject({
      account_id: first!.account_id,
      login_name: '新しい名前',
      display_name: '新しい名前',
    });
    expect(await countAccounts()).toBe(before);
    expect(await sessionRowsOf(first!.account_id)).toHaveLength(1);
  });

  test('運用者の一覧の google:<sub> は、入れる組織が無くてもログインできる', async () => {
    // test/operations/world.ts の OPERATOR_LOGIN_IDS にある架空の sub
    const operator = googleUser('運用者', { sub: '424242' });
    const browser = googleBrowser();
    const result = await browser.loginWithGoogle(operator);
    expect(result.location).toBe('/');
    expect((await googleAccountLoginOf(operator))?.login_subject).toBe('424242');
    expect((await browser.post(me)).status).toBe(200);
  });

  test('入れる組織の無い人は denied で、accounts も account_logins も作らない', async () => {
    const stranger = googleUser('部外者');
    const before = await countAccounts();
    const browser = googleBrowser();
    const result = await browser.loginWithGoogle(stranger);
    expect(result.location).toBe('/login?error=denied');
    expect(browser.sessionToken).toBeUndefined();
    expect(await googleAccountLoginOf(stranger)).toBeUndefined();
    expect(await countAccounts()).toBe(before);
  });

  test('GitHub の同じ数字の ID の人とは別の人として扱う', async () => {
    const user = googleUser('数字だけの sub', { sub: '7000999' });
    const { organization } = await organizationWithAdmin();
    await createUser(organization, { login_provider: 'github', login_subject: '7000999', is_admin: 1 });
    expect((await googleBrowser().loginWithGoogle(user)).location).toBe('/login?error=denied');
  });
});

describe('トークンの交換', () => {
  test('form-urlencoded で code、クライアントの資格情報、redirect_uri、code_verifier を送り、トークンのエンドポイントだけを呼ぶ', async () => {
    const user = googleUser('交換');
    await memberOf(user.sub);
    google.calls.length = 0;
    const result = await googleBrowser().loginWithGoogle(user);
    expect(result.location).toBe('/');
    // userinfo も取り消しも呼ばない
    expect(google.calls.map((call) => call.url)).toEqual([GOOGLE_TOKEN_URL]);
    const [call] = google.calls;
    expect(call).toMatchObject({ method: 'POST', contentType: 'application/x-www-form-urlencoded' });
    expect(call!.form).toMatchObject({
      code: result.code,
      client_id: FAKE_GOOGLE_CLIENT_ID,
      client_secret: FAKE_GOOGLE_CLIENT_SECRET,
      redirect_uri: 'https://scrum-guild.ucan-lab.workers.dev/api/auth/google/callback',
      grant_type: 'authorization_code',
    });
    expect(call!.form.code_verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  test('「/」を含む Google の code が、戻り先の形の検査を通る', async () => {
    const user = googleUser('スラッシュ');
    await memberOf(user.sub);
    const result = await googleBrowser().loginWithGoogle(user);
    expect(result.code).toContain('/');
    expect(result.location).toBe('/');
  });

  test('512文字までの code は通し、513文字以上と使えない文字は Google に送らず断る', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const longestAllowed = '4/' + 'a'.repeat(510);
    for (const code of [longestAllowed, '4/' + 'a'.repeat(511), '4/0A b', '4/0A?x']) {
      const browser = googleBrowser();
      const started = await browser.start();
      google.calls.length = 0;
      const result = await browser.callback({ code, state: started.state });
      // 形の検査を通ったものは Google に送る。偽物は知らない code として invalid_grant を返すので retry
      expect(result.location).toBe('/login?error=retry');
      expect(google.calls.length, code.slice(0, 8)).toBe(code === longestAllowed ? 1 : 0);
    }
  });

  test('Google が拒否した戻り（error=access_denied）はログインできず、Google に送らない', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const browser = googleBrowser();
    const started = await browser.start();
    google.calls.length = 0;
    const result = await browser.callback({ error: 'access_denied', state: started.state });
    expect(result.location).toBe('/login?error=retry');
    expect(google.calls.length).toBe(0);
  });

  test('使えない code（invalid_grant）は retry', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const browser = googleBrowser();
    const started = await browser.start();
    const result = await browser.callback({ code: '4/0Aunknown', state: started.state });
    expect(result.location).toBe('/login?error=retry');
    expect(browser.sessionToken).toBeUndefined();
  });

  test.each(['server-error', 'not-json', 'no-id-token'] as const)(
    'トークンの交換が %s なら unavailable で、アカウントを作らない',
    async (failure) => {
      vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const user = googleUser('交換失敗');
      await memberOf(user.sub);
      const browser = googleBrowser();
      const started = await browser.start();
      const code = google.issueCode(user, started.location);
      google.failNext.token = failure;
      const result = await browser.callback({ code, state: started.state });
      expect(result.location).toBe('/login?error=unavailable');
      expect(await googleAccountLoginOf(user)).toBeUndefined();
    },
  );
});

describe('ID トークンの検査（結合）', () => {
  test.each([
    ['nonce が違う', { nonce: 'x'.repeat(43) }, 'retry'],
    ['nonce が無い', { nonce: undefined }, 'retry'],
    ['期限切れ', { exp: Math.floor(Date.now() / 1000) - 10 }, 'retry'],
    ['aud が別のクライアント', { aud: 'other-client', azp: undefined }, 'unavailable'],
    ['iss が別のホスト', { iss: 'https://evil.example' }, 'unavailable'],
  ])('%s のトークンは断り、アカウントを作らない', async (_label, claims, error) => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const user = googleUser('検査');
    await memberOf(user.sub);
    const browser = googleBrowser();
    const result = await browser.loginWithGoogle(user, { claims });
    expect(result.location).toBe(`/login?error=${error}`);
    expect(browser.sessionToken).toBeUndefined();
    expect(await googleAccountLoginOf(user)).toBeUndefined();
  });

  test('nonce の空の oauth_states の行は、Google に送らず断る', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const user = googleUser('nonce 空');
    await memberOf(user.sub);
    const browser = googleBrowser();
    const started = await browser.start();
    const code = google.issueCode(user, started.location);
    const db = commonDb(env);
    await db.batch([
      db.statement((q) => q.updateTable('oauth_states').set({ nonce: null }).where('state', '=', started.state)),
    ]);
    google.calls.length = 0;
    const result = await browser.callback({ code, state: started.state });
    expect(result.location).toBe('/login?error=retry');
    expect(browser.sessionToken).toBeUndefined();
    expect(google.calls.length).toBe(0);
    expect(await googleAccountLoginOf(user)).toBeUndefined();
  });

  test('別のログインの nonce を入れたトークンは断る', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const user = googleUser('nonce 取り違え');
    await memberOf(user.sub);
    const other = await googleBrowser().start();
    const browser = googleBrowser();
    const started = await browser.start();
    const code = google.issueCode(user, started.location, { nonce: other.location.searchParams.get('nonce') });
    const result = await browser.callback({ code, state: started.state });
    expect(result.location).toBe('/login?error=retry');
    expect(await googleAccountLoginOf(user)).toBeUndefined();
  });
});
