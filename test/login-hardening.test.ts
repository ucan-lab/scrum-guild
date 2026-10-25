// ログインの開始と戻り先への、ほかのサイトからの読み込みと、入力の検証。
// 枠を使い切らせる読み込み、state の Cookie の扱い、戻り先のパス、GitHub の応答の検証、トークンの取り消し、http の localhost の Cookie
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { me } from '../src/shared/operations/session/index.ts';
import { commonDb } from '../src/server/db/index.ts';
import { createFakeGithub } from './auth/fake-github.ts';
import { createLoginApp, FakeBrowser, loginEnv, STATE_COOKIE } from './auth/browser.ts';
import { accountLoginOf, githubUser, organizationWithAdmin, stateRow } from './auth/helpers.ts';
import { createUser } from './factories.ts';

const github = createFakeGithub();
const app = createLoginApp(github);
const newBrowser = () => new FakeBrowser(app, github);
const toGithub = /^https:\/\/github\.com\//;

afterEach(() => {
  vi.restoreAllMocks();
});

async function rateLimitRow(key: string) {
  const db = commonDb(env);
  return db.first(db.statement((q) => q.selectFrom('rate_limits').selectAll().where('key', '=', key)));
}

async function adminUser(login: string, overrides: Parameters<typeof githubUser>[1] = {}) {
  const { organization } = await organizationWithAdmin();
  const user = githubUser(login, overrides);
  await createUser(organization, { login_provider: 'github', login_subject: String(user.id), is_admin: 1 });
  return user;
}

describe('ほかのサイトからの読み込み', () => {
  test.each([
    ['<img>', { 'Sec-Fetch-Mode': 'no-cors', 'Sec-Fetch-Dest': 'image' }],
    ['<script>', { 'Sec-Fetch-Mode': 'no-cors', 'Sec-Fetch-Dest': 'script' }],
    ['fetch()', { 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty' }],
    ['<iframe>', { 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'iframe' }],
    // ほかのサイトのページからのリンクの移動（<a> の click、window.open、リダイレクト）
    [
      '別のサイトからの移動',
      { 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document', 'Sec-Fetch-Site': 'cross-site' },
    ],
    // 同じサイトの別のオリジン（兄弟のサブドメイン）からの移動
    [
      '同じサイトの別のオリジンからの移動',
      { 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document', 'Sec-Fetch-Site': 'same-site' },
    ],
    ['Sec-Fetch-Site だけが cross-site', { 'Sec-Fetch-Site': 'cross-site' }],
    ['Sec-Fetch-Site だけが same-site', { 'Sec-Fetch-Site': 'same-site' }],
    // 先読み。利用者が開いたのではない
    [
      'prefetch',
      {
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Site': 'none',
        'Sec-Purpose': 'prefetch',
      },
    ],
    ['prefetch（付記つき）', { 'Sec-Purpose': 'prefetch;anonymous-client-ip' }],
    ['prerender', { 'Sec-Purpose': 'prefetch; prerender' }],
    ['Sec-Purpose の大文字', { 'Sec-Purpose': 'Prefetch' }],
    // 片方のヘッダーだけでも、値が合わなければ断る
    ['Sec-Fetch-Mode だけが no-cors', { 'Sec-Fetch-Mode': 'no-cors' }],
    ['Sec-Fetch-Mode だけが cors', { 'Sec-Fetch-Mode': 'cors' }],
    ['Sec-Fetch-Mode だけが websocket', { 'Sec-Fetch-Mode': 'websocket' }],
    ['Sec-Fetch-Dest だけが image', { 'Sec-Fetch-Dest': 'image' }],
    ['Sec-Fetch-Dest だけが iframe', { 'Sec-Fetch-Dest': 'iframe' }],
    ['Sec-Fetch-Dest だけが empty', { 'Sec-Fetch-Dest': 'empty' }],
  ])('開始を %s で読ませても、数えず、行も Cookie も作らず、ログインの画面へ戻す', async (_label, headers) => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const browser = newBrowser();
    // 上限（60回）を超える回数を読ませても、枠は減らない
    for (let i = 0; i < 70; i++) {
      const started = await browser.start('/aoba', headers);
      expect(started.response.headers.get('Location')).toBe('/login?return_to=%2Faoba');
      expect(started.state).toBe('');
    }
    expect(browser.cookies.size).toBe(0);
    expect(await rateLimitRow(`login:${browser.ip}`)).toBeUndefined();
    // 本物の画面の移動は、そのまま通る
    const navigate = await browser.start('/aoba', { 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' });
    expect(navigate.response.headers.get('Location')).toMatch(toGithub);
    expect((await rateLimitRow(`login:${browser.ip}`))?.count).toBe(1);
    expect((await stateRow(navigate.state))?.return_to).toBe('/aoba');
  });

  test.each([
    [
      'ログインの画面のボタン（同じオリジン）',
      { 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document', 'Sec-Fetch-Site': 'same-origin' },
    ],
    [
      'アドレス欄やブックマーク',
      { 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document', 'Sec-Fetch-Site': 'none' },
    ],
    ['Sec-Fetch-Mode だけ', { 'Sec-Fetch-Mode': 'navigate' }],
    ['Sec-Fetch-Dest だけ', { 'Sec-Fetch-Dest': 'document' }],
    ['Sec-Fetch-Site だけ（同じオリジン）', { 'Sec-Fetch-Site': 'same-origin' }],
    ['Sec-Fetch-Site だけ（none）', { 'Sec-Fetch-Site': 'none' }],
    ['Sec-Purpose が prefetch でない値', { 'Sec-Purpose': 'other' }],
  ])('開始を %s から始めると、通り、数えて行を書く', async (_label, headers) => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const browser = newBrowser();
    const started = await browser.start('/aoba', headers);
    expect(started.response.headers.get('Location')).toMatch(toGithub);
    expect((await rateLimitRow(`login:${browser.ip}`))?.count).toBe(1);
    expect((await stateRow(started.state))?.return_to).toBe('/aoba');
  });

  test('Sec-Fetch を送らない古いブラウザは通す', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    expect((await newBrowser().start()).response.headers.get('Location')).toMatch(toGithub);
  });

  test('戻り先は、state の Cookie が合わないものを数えず、DB の行にも Cookie にも触れない', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const browser = newBrowser();
    // Cookie が無い、state が無い、形が違う、Cookie と違う、のどれも数えない
    for (let i = 0; i < 70; i++) {
      expect((await browser.callback({ code: 'abc', state: 'A'.repeat(43) })).location).toBe('/login?error=retry');
      expect((await browser.callback({ code: 'abc' })).location).toBe('/login?error=retry');
    }
    browser.cookies.set(STATE_COOKIE, 'B'.repeat(43));
    expect((await browser.callback({ code: 'abc', state: 'A'.repeat(43) })).location).toBe('/login?error=retry');
    expect(await rateLimitRow(`login:${browser.ip}`)).toBeUndefined();
    // 合わなかった戻りは、state の Cookie を消さない
    expect(browser.cookies.get(STATE_COOKIE)).toBe('B'.repeat(43));
    // 枠は残っているので、本物のログインは通る
    const started = await browser.start();
    expect(started.response.headers.get('Location')).toMatch(toGithub);
  });

  test('戻りが合わなかったときは、始めたログインの state の Cookie と行を残し、その後の本物の戻りが通る', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const user = await adminUser('cookie-kept');
    const browser = newBrowser();
    const started = await browser.start();
    const mismatch = await browser.callback({ code: 'x', state: 'C'.repeat(43) });
    expect(mismatch.location).toBe('/login?error=retry');
    expect(browser.cookies.get(STATE_COOKIE)).toBe(started.state);
    expect(await stateRow(started.state)).toBeDefined();
    const code = github.issueCode(user, started.challenge);
    expect((await browser.callback({ code, state: started.state })).location).toBe('/');
    // 合った戻りは、成功でも失敗でも state の Cookie を使い切る
    expect(browser.cookies.has(STATE_COOKIE)).toBe(false);
  });

  test('照合に通った戻りは、行が無くても state の Cookie を消す', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const browser = newBrowser();
    const state = 'D'.repeat(43);
    browser.cookies.set(STATE_COOKIE, state);
    expect((await browser.callback({ code: 'x', state })).location).toBe('/login?error=retry');
    expect(browser.cookies.has(STATE_COOKIE)).toBe(false);
  });
});

describe('IPv6 の枠', () => {
  test('同じ /64 の中のアドレスは同じ枠で数え、別の /64 は別の枠', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const a = new FakeBrowser(app, github, loginEnv, '2001:db8:aa:bb::1');
    const b = new FakeBrowser(app, github, loginEnv, '2001:db8:aa:bb:1234:5678:9abc:def0');
    const other = new FakeBrowser(app, github, loginEnv, '2001:db8:aa:cc::1');
    expect((await a.start()).response.headers.get('Location')).toMatch(toGithub);
    const db = commonDb(env);
    await db.batch([
      db.statement((q) =>
        q.updateTable('rate_limits').set({ count: 60 }).where('key', '=', 'login:2001:db8:aa:bb::/64'),
      ),
    ]);
    expect((await b.start()).response.headers.get('Location')).toBe('/login?error=too_many');
    expect((await other.start()).response.headers.get('Location')).toMatch(toGithub);
  });

  test('/64 を変えても、同じ /48 の枠の上限を超えたら断る。別の /48 は通る', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const first = new FakeBrowser(app, github, loginEnv, '2001:db8:ee:1::1');
    const rotated = new FakeBrowser(app, github, loginEnv, '2001:db8:ee:2::1');
    const elsewhere = new FakeBrowser(app, github, loginEnv, '2001:db8:ef:1::1');
    expect((await first.start()).response.headers.get('Location')).toMatch(toGithub);
    const db = commonDb(env);
    await db.batch([
      db.statement((q) =>
        q.updateTable('rate_limits').set({ count: 600 }).where('key', '=', 'login48:2001:db8:ee::/48'),
      ),
    ]);
    // /64 の枠は空（2回目）でも、/48 の枠が上限を超えているので断る
    expect((await rotated.start()).response.headers.get('Location')).toBe('/login?error=too_many');
    expect((await first.start()).response.headers.get('Location')).toBe('/login?error=too_many');
    expect((await elsewhere.start()).response.headers.get('Location')).toMatch(toGithub);
  });
});

describe('戻る画面のパス', () => {
  // 解決で `//evil.example` になる書き方。start の検査で `/` に落ち、戻り先でも自分のオリジンにしか戻らない
  const dotted = [
    '/.//evil.example',
    '/..//evil.example',
    '/a/..//evil.example',
    '/%2e//evil.example',
    '/%2E%2e//evil.example',
    '/./\\evil.example',
    '/.\\/evil.example',
    '/x/../\\\\evil.example',
    '/a/./b',
    '/a/../b',
    '/a\\b',
    // 最初の区間をパーセント符号で書いた api と login
    '/%61pi/x',
    '/%6cogin',
    '/%6CoGin?next=/',
  ];

  test.each(dotted)('開始に %j を渡すと、行には / が入り、戻りは自分のオリジンの / になる', async (returnTo) => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const user = await adminUser('dotted-start');
    const browser = newBrowser();
    const started = await browser.start(returnTo);
    expect((await stateRow(started.state))?.return_to).toBe('/');
    const code = github.issueCode(user, started.challenge);
    expect((await browser.callback({ code, state: started.state })).location).toBe('/');
  });

  test.each(dotted)('行に直に入れた %j でも、戻りは自分のオリジンの / になる', async (returnTo) => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const user = await adminUser('dotted-row');
    const browser = newBrowser();
    const started = await browser.start();
    // DB の CHECK は `/` で始まり `//` と `/\` で始まらないことしか見ないので、ここまでは入る
    const db = commonDb(env);
    await db.batch([
      db.statement((q) =>
        q.updateTable('oauth_states').set({ return_to: returnTo }).where('state', '=', started.state),
      ),
    ]);
    const code = github.issueCode(user, started.challenge);
    const result = await browser.callback({ code, state: started.state });
    expect(result.location).toBe('/');
    expect(new URL(result.location, 'https://scrum-guild.ucan-lab.workers.dev').origin).toBe(
      'https://scrum-guild.ucan-lab.workers.dev',
    );
  });

  test('クエリとフラグメントの中のバックスラッシュは拒まず、そのまま戻る', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const user = await adminUser('query-backslash');
    const result = await newBrowser().login(user, { returnTo: '/aoba?x=a\\b#c\\d' });
    expect(result.location).toBe('/aoba?x=a\\b#c\\d');
  });

  test('ふつうのパスは、クエリとフラグメントを含めて戻る', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const user = await adminUser('plain-path');
    const result = await newBrowser().login(user, { returnTo: '/aoba/board?tab=1&q=%E3%81%82#top' });
    expect(result.location).toBe('/aoba/board?tab=1&q=%E3%81%82#top');
  });
});

describe('GitHub の応答の検証', () => {
  test.each([
    ['空白を含む', 'bad name'],
    ['記号を含む', 'octo<script>'],
    ['長すぎる', 'a'.repeat(81)],
    ['ハイフンで始まる', '-octo'],
  ])('ログイン名が%sなら、unavailable で、アカウントを作らない', async (_label, login) => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const user = await adminUser('placeholder', { login });
    const result = await newBrowser().login(user);
    expect(result.location).toBe('/login?error=unavailable');
    expect(await accountLoginOf(user)).toBeUndefined();
    // ログには固定の理由を残し、GitHub が返したログイン名は出さない
    const logged = error.mock.calls.flat().join('\n');
    expect(logged).toContain('GitHub のログイン名がユーザー名の形に合わない');
    expect(logged).not.toContain(login);
  });

  test('Enterprise Managed Users のように `_` を含むログイン名は通す', async () => {
    const user = await adminUser('placeholder', { login: 'octo_acme-corp' });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    expect((await newBrowser().login(user)).location).toBe('/');
    expect((await accountLoginOf(user))?.login_name).toBe('octo_acme-corp');
  });

  test.each([
    [
      'GitHub のアバターのホスト',
      'https://avatars.githubusercontent.com/u/1?v=4',
      'https://avatars.githubusercontent.com/u/1?v=4',
    ],
    ['別のホスト', 'https://evil.example/a.png', null],
    ['似たホスト', 'https://avatars.githubusercontent.com.evil.example/a.png', null],
    ['ユーザー情報を持つ URL', 'https://avatars.githubusercontent.com@evil.example/a.png', null],
    ['http', 'http://avatars.githubusercontent.com/u/1', null],
  ])('アバターの URL が%sのとき', async (_label, avatar, expected) => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const user = await adminUser('avatar-user', { avatar_url: avatar });
    await newBrowser().login(user);
    expect((await accountLoginOf(user))?.avatar_url).toBe(expected);
  });
});

describe('トークンの取り消し', () => {
  test('ログインの応答を待たせず、waitUntil で走らせ、終わると取り消している', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const user = await adminUser('revoke-background');
    const browser = newBrowser();
    const before = github.revoked.length;
    const started = await browser.start();
    const code = github.issueCode(user, started.challenge);
    const result = await browser.callback({ code, state: started.state });
    expect(result.location).toBe('/');
    // 取り消しは、応答とは別に waitUntil へ渡されている
    expect(browser.background).toHaveLength(1);
    await browser.settle();
    expect(github.revoked).toHaveLength(before + 1);
  });

  test('実行の文脈（executionCtx）が無い呼び出しでも、ログインは通り、取り消しは走る', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const user = await adminUser('revoke-no-context');
    const browser = newBrowser();
    browser.useExecutionContext = false;
    const before = github.revoked.length;
    const started = await browser.start();
    const code = github.issueCode(user, started.challenge);
    const result = await browser.callback({ code, state: started.state });
    expect(result.location).toBe('/');
    expect(browser.background).toHaveLength(0);
    // waitUntil が無いので、待たずに走らせる。終わるまで少し待つ
    await vi.waitFor(() => expect(github.revoked).toHaveLength(before + 1));
  });

  test('取り消しが失敗しても、ログインは通り、失敗は固定の文でログに出て、トークンは出ない', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const user = await adminUser('revoke-fails');

    for (const failure of ['server-error', 'network'] as const) {
      const browser = newBrowser();
      const started = await browser.start();
      github.failNext.revoke = failure;
      const code = github.issueCode(user, started.challenge);
      const result = await browser.callback({ code, state: started.state });
      expect(result.location).toBe('/');
      await browser.settle();
    }
    const logged = warn.mock.calls.flat().join('\n');
    expect(logged).toContain('GitHub のトークンの取り消しが 500 を返した');
    expect(logged).toContain('GitHub に届かなかった（Error）');
    expect(logged).not.toContain('gho_fake_token');
    expect(logged).not.toContain('secret-detail');
    for (const line of warn.mock.calls.flat()) expect(JSON.parse(String(line))).toMatchObject({ level: 'warn' });
  });
});

describe('http の localhost', () => {
  test('state とセッションの Cookie に Secure を付けず、名前に __Host- を付けない', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const httpEnv: Env = Object.assign({}, loginEnv, { PUBLIC_ORIGIN: 'http://localhost:5173' });
    const user = await adminUser('http-localhost');
    const browser = new FakeBrowser(app, github, httpEnv);

    const started = await browser.start('/aoba');
    expect(new URL(started.location).searchParams.get('redirect_uri')).toBe(
      'http://localhost:5173/api/auth/github/callback',
    );
    const stateLine = started.response.headers.getSetCookie().find((line) => line.startsWith('sg_oauth_state='));
    expect(stateLine).toBeDefined();
    for (const attribute of ['HttpOnly', 'SameSite=Lax', 'Path=/', 'Max-Age=600'])
      expect(stateLine).toContain(attribute);
    expect(stateLine).not.toContain('Secure');

    const code = github.issueCode(user, started.challenge);
    const finished = await browser.callback({ code, state: started.state });
    expect(finished.location).toBe('/aoba');
    const sessionLine = finished.response.headers.getSetCookie().find((line) => line.startsWith('sg_session='));
    expect(sessionLine).toBeDefined();
    for (const attribute of ['HttpOnly', 'SameSite=Lax', 'Path=/']) expect(sessionLine).toContain(attribute);
    expect(sessionLine).not.toContain('Secure');
    expect((await browser.post(me)).status).toBe(200);
  });

  test('https の公開 URL では、どちらも Secure を付ける', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const user = await adminUser('https-secure');
    const browser = newBrowser();
    const started = await browser.start();
    const finished = await browser.callback({
      code: github.issueCode(user, started.challenge),
      state: started.state,
    });
    const lines = [...started.response.headers.getSetCookie(), ...finished.response.headers.getSetCookie()];
    for (const name of ['__Host-sg_oauth_state=', '__Host-sg_session=']) {
      expect(lines.find((line) => line.startsWith(name))).toContain('Secure');
    }
  });
});
