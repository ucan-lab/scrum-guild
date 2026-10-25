// ログインの開始の全体の枠（src/server/auth/rate-limit.ts の consumeLoginStartRateLimits）。
// IP を多く持つ人が、IP の数に比例して oauth_states と rate_limits の行を書かせられないこと
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  LOGIN_GLOBAL_RATE_LIMIT_KEY,
  LOGIN_RATE_LIMIT,
  LOGIN_RATE_LIMIT_GLOBAL,
  LOGIN_RATE_LIMIT_IPV6_SITE,
} from '../src/server/auth/rate-limit.ts';
import { commonDb } from '../src/server/db/index.ts';
import { RETURN_TO_MAX_LENGTH } from '../src/shared/return-to.ts';
import { createFakeGithub } from './auth/fake-github.ts';
import { createLoginApp, FakeBrowser, loginEnv, STATE_COOKIE } from './auth/browser.ts';
import { githubUser, organizationWithAdmin, stateRow } from './auth/helpers.ts';
import { createUser } from './factories.ts';

const github = createFakeGithub();
const app = createLoginApp(github);
const toGithub = /^https:\/\/github\.com\//;

// このファイルの中で IP が重ならないよう、203.0.113.0/24 から順に配る（browser.ts の既定の 198.51.100.0/24 とも別）
let ipCount = 0;
const newBrowser = () => new FakeBrowser(app, github, loginEnv, `203.0.113.${++ipCount}`);

async function rateLimitRow(key: string) {
  const db = commonDb(env);
  return db.first(db.statement((q) => q.selectFrom('rate_limits').selectAll().where('key', '=', key)));
}

async function setGlobal(count: number, windowStartAt: Date) {
  const db = commonDb(env);
  await db.batch([
    db.statement((q) =>
      q
        .insertInto('rate_limits')
        .values({ key: LOGIN_GLOBAL_RATE_LIMIT_KEY, window_start_at: windowStartAt.toISOString(), count })
        .onConflict((conflict) =>
          conflict.column('key').doUpdateSet({ window_start_at: windowStartAt.toISOString(), count }),
        ),
    ),
  ]);
}

async function oauthStateCount(): Promise<number> {
  const db = commonDb(env);
  const row = await db.first(
    db.statement((q) => q.selectFrom('oauth_states').select((eb) => eb.fn.countAll<number>().as('count'))),
  );
  return Number(row?.count ?? 0);
}

// ログに書いた start の outcome を、書いた順に返す
function startOutcomes(log: { mock: { calls: unknown[][] } }): string[] {
  return log.mock.calls
    .map((call) => JSON.parse(String(call[0])) as { step?: string; outcome?: string })
    .filter((entry) => entry.step === 'start')
    .map((entry) => entry.outcome ?? '');
}

beforeEach(async () => {
  // 全体の枠はファイルの中のテストで共有なので、テストごとに空から始める
  const db = commonDb(env);
  await db.batch([db.statement((q) => q.deleteFrom('rate_limits').where('key', '=', LOGIN_GLOBAL_RATE_LIMIT_KEY))]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ログインの開始の全体の枠', () => {
  test('1つの IP が使える全体の枠は、IP の枠の上限まで。IP の枠に断られた呼び出しは全体の枠を減らさない', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const browser = newBrowser();
    for (let i = 0; i < LOGIN_RATE_LIMIT.max + 10; i++) await browser.start('/aoba');
    // IP の枠に断られた呼び出しは、覗いただけで IP の行も書き換えない
    expect((await rateLimitRow(`login:${browser.ip}`))?.count).toBe(LOGIN_RATE_LIMIT.max);
    expect((await rateLimitRow(LOGIN_GLOBAL_RATE_LIMIT_KEY))?.count).toBe(LOGIN_RATE_LIMIT.max);
    // IP の枠に断られたものは、ログでも IP の枠として残る
    expect(startOutcomes(log).filter((outcome) => outcome === 'too_many')).toHaveLength(10);
    expect(startOutcomes(log)).not.toContain('too_many_global');
  });

  test('上限ちょうどまでは通り、超えたら別の IP からの開始も too_many で断る', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await setGlobal(LOGIN_RATE_LIMIT_GLOBAL.max - 1, new Date());
    expect((await newBrowser().start('/aoba')).response.headers.get('Location')).toMatch(toGithub);
    expect((await rateLimitRow(LOGIN_GLOBAL_RATE_LIMIT_KEY))?.count).toBe(LOGIN_RATE_LIMIT_GLOBAL.max);

    const blocked = await newBrowser().start('/aoba');
    expect(blocked.response.headers.get('Location')).toBe('/login?error=too_many&return_to=%2Faoba');
    expect(startOutcomes(log).at(-1)).toBe('too_many_global');
  });

  test('全体の枠が上限の間の開始は、rate_limits にも oauth_states にも書かない', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await setGlobal(LOGIN_RATE_LIMIT_GLOBAL.max, new Date());
    const before = await oauthStateCount();
    const browsers = Array.from({ length: 5 }, () => newBrowser());
    for (const browser of browsers) {
      const started = await browser.start('/aoba');
      expect(started.response.headers.get('Location')).toBe('/login?error=too_many&return_to=%2Faoba');
      expect(started.state).toBe('');
    }
    for (const browser of browsers) expect(await rateLimitRow(`login:${browser.ip}`)).toBeUndefined();
    // 覗くだけで断るので、全体の枠も増えない
    expect((await rateLimitRow(LOGIN_GLOBAL_RATE_LIMIT_KEY))?.count).toBe(LOGIN_RATE_LIMIT_GLOBAL.max);
    expect(await oauthStateCount()).toBe(before);
  });

  test('IPv6 の開始も、全体の枠が上限の間は /48 と /64 の行を書かない', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await setGlobal(LOGIN_RATE_LIMIT_GLOBAL.max, new Date());
    const browser = new FakeBrowser(app, github, loginEnv, '2001:db8:4a:1::1');
    expect((await browser.start()).response.headers.get('Location')).toBe('/login?error=too_many');
    expect(await rateLimitRow('login48:2001:db8:4a::/48')).toBeUndefined();
    expect(await rateLimitRow('login:2001:db8:4a:1::/64')).toBeUndefined();
  });

  test('窓を過ぎた全体の枠は数え直し、開始が通る', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await setGlobal(LOGIN_RATE_LIMIT_GLOBAL.max, new Date(Date.now() - LOGIN_RATE_LIMIT_GLOBAL.windowMs - 1000));
    expect((await newBrowser().start()).response.headers.get('Location')).toMatch(toGithub);
    expect((await rateLimitRow(LOGIN_GLOBAL_RATE_LIMIT_KEY))?.count).toBe(1);
  });

  test('1つの /48 が使える全体の枠は、/64 を変えても /48 の枠の上限まで', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const perNetwork = 10;
    const networks = Math.ceil(LOGIN_RATE_LIMIT_IPV6_SITE.max / perNetwork) + 2;
    for (let n = 1; n <= networks; n++) {
      const browser = new FakeBrowser(app, github, loginEnv, `2001:db8:4b:${n.toString(16)}::1`);
      for (let i = 0; i < perNetwork; i++) await browser.start();
    }
    expect(LOGIN_RATE_LIMIT_IPV6_SITE.max).toBeLessThan(LOGIN_RATE_LIMIT_GLOBAL.max);
    expect((await rateLimitRow(LOGIN_GLOBAL_RATE_LIMIT_KEY))?.count).toBe(LOGIN_RATE_LIMIT_IPV6_SITE.max);
    expect((await rateLimitRow('login48:2001:db8:4b::/48'))?.count).toBe(LOGIN_RATE_LIMIT_IPV6_SITE.max);
  });

  test('並行した開始でも、通るのは全体の枠の上限まで', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await setGlobal(LOGIN_RATE_LIMIT_GLOBAL.max - 1, new Date());
    const before = await oauthStateCount();
    const results = await Promise.all(Array.from({ length: 10 }, () => newBrowser().start('/aoba')));
    const passed = results.filter((result) => toGithub.test(result.response.headers.get('Location') ?? ''));
    expect(passed).toHaveLength(1);
    expect(await oauthStateCount()).toBe(before + 1);
    expect(startOutcomes(log).filter((outcome) => outcome === 'too_many_global')).toHaveLength(9);
  });

  test('行の無い state を Cookie と合わせて送った戻り先は、rate_limits に書かない', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await setGlobal(LOGIN_RATE_LIMIT_GLOBAL.max, new Date());
    for (const ip of ['203.0.113.201', '2001:db8:4c:1::1']) {
      const browser = new FakeBrowser(app, github, loginEnv, ip);
      // ブラウザ以外の相手は、Cookie を自由に付けられる
      const forged = 'F'.repeat(43);
      browser.cookies.set(STATE_COOKIE, forged);
      expect((await browser.callback({ code: 'x', state: forged })).location).toBe('/login?error=retry');
    }
    expect(await rateLimitRow('login:203.0.113.201')).toBeUndefined();
    expect(await rateLimitRow('login48:2001:db8:4c::/48')).toBeUndefined();
    expect(await rateLimitRow('login:2001:db8:4c:1::/64')).toBeUndefined();
  });

  test('全体の枠が上限でも、state の Cookie が合った戻り先は通り、全体の枠を数えない', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { organization } = await organizationWithAdmin();
    const user = githubUser('global-limit-callback');
    await createUser(organization, { login_provider: 'github', login_subject: String(user.id), is_admin: 1 });
    const browser = newBrowser();
    const started = await browser.start('/aoba');
    await setGlobal(LOGIN_RATE_LIMIT_GLOBAL.max, new Date());

    const code = github.issueCode(user, started.challenge);
    expect((await browser.callback({ code, state: started.state })).location).toBe('/aoba');
    expect((await rateLimitRow(LOGIN_GLOBAL_RATE_LIMIT_KEY))?.count).toBe(LOGIN_RATE_LIMIT_GLOBAL.max);
  });
});

describe('戻る画面のパスの長さ', () => {
  test(`${RETURN_TO_MAX_LENGTH}文字までは行に入り、超えたら / になる`, async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const longest = `/${'a'.repeat(RETURN_TO_MAX_LENGTH - 1)}`;
    const within = await newBrowser().start(longest);
    expect((await stateRow(within.state))?.return_to).toBe(longest);

    const tooLong = await newBrowser().start(`${longest}a`);
    expect((await stateRow(tooLong.state))?.return_to).toBe('/');
  });
});
