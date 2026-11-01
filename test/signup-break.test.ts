// 会員登録（Issue #640）を崩す入力。test/signup.test.ts と重ならない手口だけを置く。
//   - signup の値の変種（全角、配列の形、大文字小文字、NUL、パーセント符号化）
//   - 印を付けた state の使い回し、別の手段での消費、Cookie の無い戻り、期限切れ
//   - 印を付けた往復で code が無い・error 付き・検証失敗のとき、アカウントを作らないこと
//   - 権限の越境（運用者にならない、他人のアカウントや指名の行や、宛先の違う招待を奪わない）
//   - 登録の往復も rate limit の枠を使うこと、ログに秘密を出さないこと、不正な return_to
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { LOGIN_RATE_LIMIT } from '../src/server/auth/rate-limit.ts';
import { consumeOAuthState, startOAuthState } from '../src/server/auth/oauth-state.ts';
import { commonDb, orgDb } from '../src/server/db/index.ts';
import { verifiedOrganizationForTest } from '../src/server/db/testing.ts';
import { myOrganizations } from '../src/shared/operations/organization/index.ts';
import { me } from '../src/shared/operations/session/index.ts';
import { createFakeGithub, FAKE_CLIENT_SECRET } from './auth/fake-github.ts';
import { createFakeGoogle, FAKE_GOOGLE_CLIENT_SECRET } from './auth/fake-google.ts';
import { createLoginApp, FakeBrowser, loginEnv, STATE_COOKIE, type LoginProvider } from './auth/browser.ts';
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
const newBrowser = (provider: LoginProvider = 'github', ip?: string) => {
  const browser = new FakeBrowser(app, github, loginEnv, ip, google);
  browser.provider = provider;
  return browser;
};

afterEach(() => {
  vi.restoreAllMocks();
});

type Started = { state: string; location: URL };

async function startGithub(browser: FakeBrowser, query: string): Promise<Started> {
  const response = await browser.request(`/api/auth/github/start${query}`);
  const location = new URL(response.headers.get('Location') ?? '', 'https://scrum-guild.test');
  return { state: location.searchParams.get('state') ?? '', location };
}

const challengeOf = (started: Started) => started.location.searchParams.get('code_challenge') ?? '';

async function rateRow(key: string) {
  const db = commonDb(env);
  return db.first(db.statement((q) => q.selectFrom('rate_limits').selectAll().where('key', '=', key)));
}

async function oauthStateCount(): Promise<number> {
  const db = commonDb(env);
  return (await db.rows(db.statement((q) => q.selectFrom('oauth_states').select('state')))).length;
}

describe('signup の値の変種は印にならない', () => {
  test.each([
    ['全角の１', '?signup=%EF%BC%91'],
    ['1 と NUL', '?signup=1%00'],
    ['1 とカンマ', '?signup=1%2C'],
    ['1 と改行', '?signup=1%0A'],
    ['大文字のキー', '?SIGNUP=1'],
    ['配列の形のキー', '?signup%5B%5D=1'],
    ['別名のキー', '?sign_up=1'],
    ['値の無いキー', '?signup'],
    ['16進', '?signup=0x1'],
    ['1.0', '?signup=1.0'],
    ['+1', '?signup=%2B1'],
    ['true を重ねる', '?signup=1&signup=1'],
  ])('%s（%s）は state の行の is_signup が 0', async (_label, query) => {
    const started = await startGithub(newBrowser(), query);
    expect(started.state).not.toBe('');
    expect((await stateRow(started.state))?.is_signup).toBe(0);
  });

  test('パーセント符号化した 1（%31）は復号後に 1 なので印になる', async () => {
    const started = await startGithub(newBrowser(), '?signup=%31');
    expect((await stateRow(started.state))?.is_signup).toBe(1);
  });

  test('return_to の中に signup=1 を埋めても印にならない', async () => {
    const started = await startGithub(newBrowser(), '?return_to=%2Faoba%3Fsignup%3D1');
    expect(await stateRow(started.state)).toMatchObject({ is_signup: 0 });
  });

  test('印の無いログインとして来た往復は、印の変種でも denied で、アカウントを作らない', async () => {
    const before = await countAccounts();
    for (const query of ['?signup=%EF%BC%91', '?SIGNUP=1', '?signup%5B%5D=1']) {
      const browser = newBrowser();
      const user = githubUser('variant-user');
      const started = await startGithub(browser, query);
      const code = github.issueCode(user, challengeOf(started));
      const finished = await browser.callback({ code, state: started.state });
      expect(finished.location, query).toBe('/login?error=denied');
    }
    expect(await countAccounts()).toBe(before);
  });
});

describe('印を付けた state の扱い', () => {
  test('同じ戻りを2回送っても、2回目は retry で、セッションもアカウントも増えない', async () => {
    const user = githubUser('replay-user');
    const browser = newBrowser();
    const started = await startGithub(browser, '?signup=1');
    const code = github.issueCode(user, challengeOf(started));
    const stateCookie = browser.cookies.get(STATE_COOKIE)!;

    expect((await browser.callback({ code, state: started.state })).location).toBe('/');
    const accountId = (await accountLoginOf(user))!.account_id;
    const before = await countAccounts();
    const sessions = (await sessionRowsOf(accountId)).length;

    // Cookie を持ち直した別のブラウザが、同じ state と code を再送する
    const replayer = newBrowser();
    replayer.cookies.set(STATE_COOKIE, stateCookie);
    const second = await replayer.callback({ code, state: started.state });
    expect(second.location).toBe('/login?error=retry');
    expect(replayer.sessionToken).toBeUndefined();
    expect(await countAccounts()).toBe(before);
    expect(await sessionRowsOf(accountId)).toHaveLength(sessions);
  });

  test('並行して同じ state を戻すと、どちらか1つだけがログインし、アカウントは1つ', async () => {
    const user = githubUser('state-race');
    const before = await countAccounts();
    const a = newBrowser();
    const started = await startGithub(a, '?signup=1');
    const b = newBrowser();
    b.cookies.set(STATE_COOKIE, a.cookies.get(STATE_COOKIE)!);
    const code = github.issueCode(user, challengeOf(started));

    const [first, second] = await Promise.all([
      a.callback({ code, state: started.state }),
      b.callback({ code, state: started.state }),
    ]);

    const locations = [first.location, second.location].sort();
    expect(locations).toEqual(['/', '/login?error=retry']);
    expect(await countAccounts()).toBe(before + 1);
  });

  test('別の手段の戻りで消費された印つきの state は、本来の手段の戻りでも使えず、アカウントは作られない', async () => {
    const user = githubUser('cross-provider');
    const browser = newBrowser();
    const started = await startGithub(browser, '?signup=1');
    const code = github.issueCode(user, challengeOf(started));
    const before = await countAccounts();

    browser.provider = 'google';
    const wrong = await browser.callback({ code: '4/any', state: started.state });
    expect(wrong.location).toBe('/login?error=retry');
    expect(await stateRow(started.state)).toBeUndefined();

    browser.provider = 'github';
    const right = await browser.callback({ code, state: started.state });
    expect(right.location).toBe('/login?error=retry');
    expect(await countAccounts()).toBe(before);
    expect(await accountLoginOf(user)).toBeUndefined();
  });

  test('state の Cookie が無い戻りは、印つきでも行に触れず、アカウントを作らない。持ち主はその後に完了できる', async () => {
    const user = githubUser('no-cookie');
    const owner = newBrowser();
    const started = await startGithub(owner, '?signup=1');
    const code = github.issueCode(user, challengeOf(started));
    const before = await countAccounts();

    const attacker = newBrowser();
    expect((await attacker.callback({ code, state: started.state })).location).toBe('/login?error=retry');
    expect(attacker.sessionToken).toBeUndefined();
    expect(await countAccounts()).toBe(before);
    expect((await stateRow(started.state))?.is_signup).toBe(1);

    expect((await owner.callback({ code, state: started.state })).location).toBe('/');
    expect(await countAccounts()).toBe(before + 1);
  });

  test('期限切れの印つきの state は消費できず、使えない', async () => {
    const past = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const started = await startOAuthState(env, 'github', '/', past, false, null, true);
    expect(await consumeOAuthState(env, 'github', started.state, new Date())).toBeUndefined();
    expect(await stateRow(started.state)).toBeUndefined();
  });

  test('印つきの state の code_verifier が違えば、検証が失敗してアカウントを作らない', async () => {
    const user = githubUser('wrong-challenge');
    const browser = newBrowser();
    const started = await startGithub(browser, '?signup=1');
    const before = await countAccounts();
    // 別の開始の challenge で発行した code は、この state の verifier と合わない
    const other = await startGithub(newBrowser(), '');
    const code = github.issueCode(user, challengeOf(other));

    const finished = await browser.callback({ code, state: started.state });

    expect(finished.location).toMatch(/^\/login\?error=(retry|unavailable)/);
    expect(browser.sessionToken).toBeUndefined();
    expect(await countAccounts()).toBe(before);
    expect(await accountLoginOf(user)).toBeUndefined();
  });
});

describe('印を付けた往復が完了しないとき、アカウントを作らない', () => {
  test.each([
    ['code が無い', () => ({})],
    ['error だけ（利用者が拒否）', () => ({ error: 'access_denied' })],
    ['空の code', () => ({ code: '' })],
    ['形の合わない code', () => ({ code: 'a b/../c' })],
    ['有効な code と error', (code: string) => ({ code, error: 'access_denied' })],
  ])('%s', async (_label, extra) => {
    const user = githubUser('incomplete-user');
    const browser = newBrowser();
    const started = await startGithub(browser, '?signup=1&return_to=%2Faoba');
    const before = await countAccounts();
    const calls = github.calls.length;
    const code = github.issueCode(user, challengeOf(started));

    const finished = await browser.callback({ state: started.state, ...extra(code) });

    expect(finished.location).toBe('/login?error=retry&return_to=%2Faoba');
    expect(browser.sessionToken).toBeUndefined();
    expect(await countAccounts()).toBe(before);
    expect(await accountLoginOf(user)).toBeUndefined();
    // 手段の側へ問い合わせにも行かない
    expect(github.calls.length).toBe(calls);
    expect(await stateRow(started.state)).toBeUndefined();
  });

  test.each(['server-error', 'not-json', 'wrong-shape'] as const)(
    'GitHub のトークン交換が %s で失敗しても、アカウントを作らない',
    async (kind) => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const user = githubUser('verify-fail-token');
      const browser = newBrowser();
      const started = await startGithub(browser, '?signup=1');
      const before = await countAccounts();
      github.failNext.token = kind;
      const code = github.issueCode(user, challengeOf(started));

      const finished = await browser.callback({ code, state: started.state });

      expect(finished.location).toMatch(/^\/login\?error=(retry|unavailable)/);
      expect(browser.sessionToken).toBeUndefined();
      expect(await countAccounts()).toBe(before);
      expect(await accountLoginOf(user)).toBeUndefined();
    },
  );

  test.each(['server-error', 'unauthorized'] as const)(
    'GitHub のユーザー取得が %s で失敗しても、アカウントを作らない',
    async (kind) => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const user = githubUser('verify-fail-user');
      const browser = newBrowser();
      const started = await startGithub(browser, '?signup=1');
      const before = await countAccounts();
      github.failNext.user = kind;
      const code = github.issueCode(user, challengeOf(started));

      const finished = await browser.callback({ code, state: started.state });

      expect(finished.location).toMatch(/^\/login\?error=(retry|unavailable)/);
      expect(await countAccounts()).toBe(before);
      expect(await accountLoginOf(user)).toBeUndefined();
    },
  );

  test.each([
    ['audience が違う', { aud: 'other-client' }],
    ['nonce が違う', { nonce: 'forged-nonce' }],
  ])('Google の ID トークンの %s とき、印つきでもアカウントを作らない', async (_label, claims) => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const user = googleUser('検証 失敗');
    const browser = newBrowser('google');
    const response = await browser.request('/api/auth/google/start?signup=1');
    const location = new URL(response.headers.get('Location') ?? '', 'https://scrum-guild.test');
    const state = location.searchParams.get('state') ?? '';
    const before = await countAccounts();
    const code = google.issueCode(user, location, claims);

    const finished = await browser.callback({ code, state });

    expect(browser.sessionToken).toBeUndefined();
    expect(await countAccounts()).toBe(before);
    expect(await googleAccountLoginOf(user)).toBeUndefined();
    expect(finished.location).toMatch(/^\/login\?error=(retry|unavailable)/);
  });
});

describe('権限の越境', () => {
  test('登録の印は運用者の権限を与えない（運用者でない人は operator: false のまま）', async () => {
    const user = githubUser('signup-not-operator');
    const browser = newBrowser();
    const started = await startGithub(browser, '?signup=1');
    const code = github.issueCode(user, challengeOf(started));
    expect((await browser.callback({ code, state: started.state })).location).toBe('/');
    await browser.consent();

    const listed = await browser.post(myOrganizations);
    expect(listed.status).toBe(200);
    expect(await listed.json()).toMatchObject({ organizations: [], invitations: [], operator: false });
  });

  test('登録で来た2人は別々のアカウントで、互いのセッションにも結ばれない', async () => {
    const one = githubUser('signup-one');
    const two = githubUser('signup-two');
    const a = newBrowser();
    const b = newBrowser();
    const sa = await startGithub(a, '?signup=1');
    const sb = await startGithub(b, '?signup=1');
    await a.callback({ code: github.issueCode(one, challengeOf(sa)), state: sa.state });
    await b.callback({ code: github.issueCode(two, challengeOf(sb)), state: sb.state });

    const accountA = (await accountLoginOf(one))!.account_id;
    const accountB = (await accountLoginOf(two))!.account_id;
    expect(accountA).not.toBe(accountB);
    await a.consent();
    await b.consent();
    expect(await (await a.post(me)).json()).toMatchObject({ account_id: accountA });
    expect(await (await b.post(me)).json()).toMatchObject({ account_id: accountB });
  });

  test('宛先の違う招待は、登録した人に結ばれず、pending のまま残る', async () => {
    const { organization, admin, workspace } = await organizationWithAdmin();
    const other = githubUser('someone-else');
    const invitation = await createInvitation(organization, workspace.id, admin.id, {
      provider: 'github',
      subject: String(other.id),
    });
    const user = githubUser('signup-uninvited');
    const browser = newBrowser();
    const started = await startGithub(browser, '?signup=1');

    const finished = await browser.callback({
      code: github.issueCode(user, challengeOf(started)),
      state: started.state,
    });
    expect(finished.location).toBe('/');
    await browser.consent();

    const listed = await (await browser.post(myOrganizations)).json();
    expect(listed).toMatchObject({ organizations: [], invitations: [] });
    const db = orgDb(env, verifiedOrganizationForTest(organization.id));
    const row = await db.first(
      db.statement((q) => q.selectFrom('invitations').selectAll().where('id', '=', invitation.id)),
    );
    expect(row).toMatchObject({ status: 'pending', login_subject: String(other.id) });
    expect(await userRow(organization.id, user)).toBeUndefined();
  });

  test('他人の指名で待っている行（別の subject）は、登録した人に結ばれず account_id が空のまま', async () => {
    const { organization } = await organizationWithAdmin();
    const other = githubUser('nominated-other');
    const nominated = await createUser(organization, {
      account_id: null,
      login_provider: 'github',
      login_subject: String(other.id),
      is_admin: 1,
    });
    const user = githubUser('signup-not-nominated');
    const browser = newBrowser();
    const started = await startGithub(browser, '?signup=1');

    expect(
      (await browser.callback({ code: github.issueCode(user, challengeOf(started)), state: started.state })).location,
    ).toBe('/');

    const row = await userRow(organization.id, other);
    expect(row?.id).toBe(nominated.id);
    expect(row?.account_id).toBeNull();
    await browser.consent();
    expect(await (await browser.post(myOrganizations)).json()).toMatchObject({ organizations: [], operator: false });
  });

  test('同じ ID でも手段が違う人（Google の sub が GitHub の ID と同じ文字列）の指名の行を奪わない', async () => {
    const { organization } = await organizationWithAdmin();
    const gh = githubUser('same-id-github');
    const nominated = await createUser(organization, {
      account_id: null,
      login_provider: 'google',
      login_subject: String(gh.id),
      is_admin: 1,
    });
    const browser = newBrowser();
    const started = await startGithub(browser, '?signup=1');
    await browser.callback({ code: github.issueCode(gh, challengeOf(started)), state: started.state });

    const db = orgDb(env, verifiedOrganizationForTest(organization.id));
    const row = await db.first(db.statement((q) => q.selectFrom('users').selectAll().where('id', '=', nominated.id)));
    expect(row?.account_id).toBeNull();
  });
});

describe('rate limit の枠', () => {
  test('印つきの開始は IP の枠を使い、上限を超えたら too_many で state の行を書かない', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const browser = newBrowser('github', '203.0.113.201');
    expect((await startGithub(browser, '?signup=1')).state).not.toBe('');
    expect((await rateRow(`login:${browser.ip}`))?.count).toBe(1);

    const db = commonDb(env);
    await db.batch([
      db.statement((q) =>
        q.updateTable('rate_limits').set({ count: LOGIN_RATE_LIMIT.max }).where('key', '=', `login:${browser.ip}`),
      ),
    ]);
    const before = await oauthStateCount();

    const blocked = await browser.request('/api/auth/github/start?signup=1&return_to=%2Faoba');
    expect(blocked.headers.get('Location')).toBe('/login?error=too_many&return_to=%2Faoba');
    expect(await oauthStateCount()).toBe(before);
    expect(browser.cookies.get(STATE_COOKIE)).toBeDefined();
  });

  test('印つきの戻りも枠を使い、枠を超えていたら too_many で、アカウントを作らず手段にも問い合わせない', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const user = githubUser('signup-limited');
    const browser = newBrowser('github', '203.0.113.202');
    const started = await startGithub(browser, '?signup=1');
    const db = commonDb(env);
    await db.batch([
      db.statement((q) =>
        q.updateTable('rate_limits').set({ count: LOGIN_RATE_LIMIT.max }).where('key', '=', `login:${browser.ip}`),
      ),
    ]);
    const before = await countAccounts();
    const calls = github.calls.length;

    const finished = await browser.callback({
      code: github.issueCode(user, challengeOf(started)),
      state: started.state,
    });

    expect(finished.location).toBe('/login?error=too_many');
    expect(browser.sessionToken).toBeUndefined();
    expect(await countAccounts()).toBe(before);
    expect(github.calls.length).toBe(calls);
  });

  test('登録の往復を通すと、開始と戻りの2回分が IP の枠に数えられる', async () => {
    const user = githubUser('signup-counted');
    const browser = newBrowser('github', '203.0.113.203');
    const started = await startGithub(browser, '?signup=1');
    expect((await rateRow(`login:${browser.ip}`))?.count).toBe(1);
    await browser.callback({ code: github.issueCode(user, challengeOf(started)), state: started.state });
    expect((await rateRow(`login:${browser.ip}`))?.count).toBe(2);
  });

  test.each([
    [
      'no-cors の画像読み込み',
      { 'Sec-Fetch-Mode': 'no-cors', 'Sec-Fetch-Dest': 'image', 'Sec-Fetch-Site': 'cross-site' },
    ],
    [
      '別サイトからの移動',
      { 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document', 'Sec-Fetch-Site': 'cross-site' },
    ],
    [
      '同じサイトの別オリジン',
      { 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document', 'Sec-Fetch-Site': 'same-site' },
    ],
    ['iframe', { 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'iframe', 'Sec-Fetch-Site': 'same-origin' }],
    ['先読み', { 'Sec-Purpose': 'prefetch' }],
    ['先読み（prerender）', { 'Sec-Purpose': 'prefetch;prerender' }],
  ])('署名つきの印を付けても、%s は行も枠も書かない', async (_label, headers) => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const browser = newBrowser('github', `203.0.113.${210 + Math.floor(Math.random() * 40)}`);
    const before = await oauthStateCount();
    const response = await browser.request('/api/auth/github/start?signup=1', { headers });
    expect(response.headers.get('Location')).toBe('/login');
    expect(await oauthStateCount()).toBe(before);
    expect(await rateRow(`login:${browser.ip}`)).toBeUndefined();
    expect(browser.cookies.get(STATE_COOKIE)).toBeUndefined();
  });
});

describe('応答とログ', () => {
  test('登録の往復の応答とログに、code、state、トークン、クライアントの秘密を出さない', async () => {
    const lines: string[] = [];
    const capture = (...args: unknown[]) => void lines.push(args.map(String).join(' '));
    for (const method of ['log', 'error', 'warn', 'info', 'debug'] as const) {
      vi.spyOn(console, method).mockImplementation(capture);
    }
    const secrets: string[] = [FAKE_CLIENT_SECRET, FAKE_GOOGLE_CLIENT_SECRET];

    const user = githubUser('signup-log');
    const browser = newBrowser();
    const started = await startGithub(browser, '?signup=1');
    const code = github.issueCode(user, challengeOf(started));
    const done = await browser.callback({ code, state: started.state });
    secrets.push(code, started.state, challengeOf(started), browser.sessionToken!, 'gho_fake_token');

    const failing = newBrowser();
    const failed = await startGithub(failing, '?signup=1');
    const badCode = 'signup-secret-bad-code';
    const bad = await failing.callback({ code: badCode, state: failed.state });
    secrets.push(badCode, failed.state);

    const gUser = googleUser('ログ 登録', { email: 'signup-log-address@example.test' });
    const gBrowser = newBrowser('google');
    const gStart = await gBrowser.request('/api/auth/google/start?signup=1');
    const gLocation = new URL(gStart.headers.get('Location') ?? '', 'https://scrum-guild.test');
    const gCode = google.issueCode(gUser, gLocation);
    await gBrowser.callback({ code: gCode, state: gLocation.searchParams.get('state')! });
    secrets.push(gCode, gLocation.searchParams.get('state')!, gLocation.searchParams.get('nonce')!, gUser.email!);

    // 応答の Location にも code と state を載せない
    for (const location of [done.location, bad.location]) {
      expect(location).not.toContain('code=');
      expect(location).not.toContain('state=');
    }
    expect(lines.length).toBeGreaterThan(0);
    const logged = lines.join('\n');
    for (const secret of secrets) expect(logged, secret.slice(0, 12)).not.toContain(secret);
    expect(logged).not.toContain('code_verifier');
    expect(logged).not.toContain('Bearer');
    expect(logged).not.toContain('"signup"');
  });
});

describe('return_to', () => {
  test.each([
    ['//evil.example', '//evil.example'],
    ['https://evil.example/', 'https%3A%2F%2Fevil.example%2F'],
    ['/\\evil.example', '%2F%5Cevil.example'],
    ['javascript:alert(1)', 'javascript%3Aalert(1)'],
    ['改行を含む', '%2Faoba%0D%0ASet-Cookie%3Ax%3D1'],
  ])('印つきの往復で return_to が不正（%s）でも、安全な行き先に移り、アカウントは作られる', async (_label, encoded) => {
    const user = githubUser('signup-bad-return');
    const browser = newBrowser();
    const started = await startGithub(browser, `?signup=1&return_to=${encoded}`);
    expect(started.state).not.toBe('');
    const before = await countAccounts();

    const finished = await browser.callback({
      code: github.issueCode(user, challengeOf(started)),
      state: started.state,
    });

    expect(finished.location).toBe('/');
    expect(finished.response.headers.get('Set-Cookie') ?? '').not.toContain('Set-Cookie:x');
    expect(await countAccounts()).toBe(before + 1);
  });

  test('返ったときの return_to は、印つきでも登録の画面（/signup）には戻らず、ログインの失敗でも保たれる', async () => {
    const user = githubUser('signup-return-kept');
    const browser = newBrowser();
    const started = await startGithub(browser, '?signup=1&return_to=%2Faoba%2Fboard');
    const finished = await browser.callback({ state: started.state });
    expect(finished.location).toBe('/login?error=retry&return_to=%2Faoba%2Fboard');
    expect(await accountLoginOf(user)).toBeUndefined();
  });
});
