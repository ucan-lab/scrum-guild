// メールアドレスとパスワードでのログイン（POST /api/auth/password/login、src/server/auth/password-login.ts、Issue #256）。
// 検査の順は Origin（と Sec-Fetch-Site）→ 本文（JSON、4KiB）→ レート制限 → 照合 → completeLogin に合流。
// 違うパスワード、無いメールアドレス、そろえ方に合わない入力は、どれも同じ 401 invalid_credentials で、同じだけハッシュを回す。
// 入れる組織の有無は、パスワードが合った後にだけ 403 で伝える。パスワード、ハッシュ、メールアドレスはログにも応答にも出さない
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createApp } from '../src/server/app.ts';
import { hashPassword, PASSWORD_HASH_ITERATIONS, verifyPassword } from '../src/server/auth/password-hash.ts';
import { PASSWORD_LOGIN_RATE_LIMITS } from '../src/server/auth/rate-limit.ts';
import { hashSessionToken } from '../src/server/auth/session.ts';
import { commonDb } from '../src/server/db/index.ts';
import { sessionCookieName } from '../src/shared/session-cookie.ts';
import { normalizePassword } from '../src/shared/password.ts';
import { failUserWrites } from './auth/helpers.ts';
import { spyPbkdf2 } from './auth/pbkdf2-spy.ts';
import { AT, createOrganization, createUser } from './factories.ts';
import { testEnv } from './operations/world.ts';

const app = createApp();
const ORIGIN = new URL(testEnv.PUBLIC_ORIGIN).origin;
const SESSION_COOKIE = sessionCookieName(testEnv.PUBLIC_ORIGIN);
const PATH = '/api/auth/password/login';

// 架空の値
const PASSWORD = 'tsubame-hoshi-2026';
const WRONG_PASSWORD = 'tsubame-hoshi-2027';
const DISPLAY_NAME = '葉山 紬';

// このファイルの中で IP が重ならないよう、100.64.0.0/10 から順に配る（ほかのファイルの 192.0.2.0/24 などとも別）
let ipCount = 0;
const nextIp = () => `100.64.${Math.floor(++ipCount / 250)}.${(ipCount % 250) + 1}`;
const randomSite = () => `2001:db8:${(0x1000 + Math.floor(Math.random() * 0xefff)).toString(16)}`;

type PasswordPerson = {
  subject: string;
  email: string;
  password: string;
  storedHash: string;
};

type PersonOptions = {
  // 入れる組織の数。0 なら入れる組織が無い
  organizations?: number;
  // 停止した組織にだけ入れる
  suspended?: boolean;
  password?: string;
  iterations?: number;
};

let personCount = 0;

// password_credentials の行と、入れる組織の users の行（管理者）を作る。アカウントと account_logins はログインで作る
async function passwordPerson(options: PersonOptions = {}): Promise<PasswordPerson> {
  const subject = crypto.randomUUID();
  const email = `tsumugi-${++personCount}-${subject.slice(0, 8)}@example.test`;
  const password = options.password ?? PASSWORD;
  const storedHash = await hashPassword(password, options.iterations);
  const db = commonDb(env);
  await db.batch([
    db.statement((q) =>
      q.insertInto('password_credentials').values({
        login_subject: subject,
        email,
        password_hash: storedHash,
        display_name: DISPLAY_NAME,
        password_changed_at: AT,
        created_at: AT,
        updated_at: AT,
      }),
    ),
  ]);
  const count = options.organizations ?? 1;
  for (let i = 0; i < count; i++) {
    const organization = await createOrganization(options.suspended ? { suspended_at: AT } : {});
    await createUser(organization, {
      login_provider: 'password',
      login_subject: subject,
      name: DISPLAY_NAME,
      is_admin: 1,
    });
  }
  return { subject, email, password, storedHash };
}

type SendOptions = {
  ip?: string;
  headers?: Record<string, string | undefined>;
  rawBody?: string;
  env?: Env;
};

async function send(body: unknown, options: SendOptions = {}): Promise<Response> {
  const headers = new Headers();
  const given: Record<string, string | undefined> = {
    Origin: ORIGIN,
    'Content-Type': 'application/json',
    'Sec-Fetch-Site': 'same-origin',
    'CF-Connecting-IP': options.ip ?? nextIp(),
    ...options.headers,
  };
  for (const [name, value] of Object.entries(given)) if (value !== undefined) headers.set(name, value);
  return app.request(
    PATH,
    { method: 'POST', headers, body: options.rawBody ?? JSON.stringify(body) },
    options.env ?? testEnv,
  );
}

type ErrorJson = { error: { code: string; message: string; details?: unknown } };

async function errorOf(res: Response): Promise<ErrorJson['error']> {
  return ((await res.clone().json()) as ErrorJson).error;
}

function sessionTokenOf(res: Response): string | undefined {
  const line = res.headers.getSetCookie().find((entry) => entry.startsWith(`${SESSION_COOKIE}=`));
  return line?.slice(SESSION_COOKIE.length + 1).split(';')[0];
}

async function passwordLoginOf(subject: string) {
  const db = commonDb(env);
  return db.first(
    db.statement((q) =>
      q
        .selectFrom('account_logins')
        .selectAll()
        .where('login_provider', '=', 'password')
        .where('login_subject', '=', subject),
    ),
  );
}

async function credentialOf(subject: string) {
  const db = commonDb(env);
  return db.first(
    db.statement((q) => q.selectFrom('password_credentials').selectAll().where('login_subject', '=', subject)),
  );
}

async function rateLimitRow(key: string) {
  const db = commonDb(env);
  return db.first(db.statement((q) => q.selectFrom('rate_limits').selectAll().where('key', '=', key)));
}

async function setRateLimit(key: string, count: number, windowStartAt: Date) {
  const db = commonDb(env);
  await db.batch([
    db.statement((q) =>
      q
        .insertInto('rate_limits')
        .values({ key, window_start_at: windowStartAt.toISOString(), count })
        .onConflict((conflict) =>
          conflict.column('key').doUpdateSet({ window_start_at: windowStartAt.toISOString(), count }),
        ),
    ),
  ]);
}

async function passwordRateLimitKeys(): Promise<string[]> {
  const db = commonDb(env);
  const rows = await db.rows(
    db.statement((q) => q.selectFrom('rate_limits').select('key').where('key', 'like', 'password%')),
  );
  return rows.map((row) => row.key).sort();
}

// メールアドレスの枠の行を、窓の外へ動かす（窓が過ぎたことにする）
async function expireEmailWindows() {
  const past = new Date(Date.now() - PASSWORD_LOGIN_RATE_LIMITS.email.windowMs - 1000).toISOString();
  const db = commonDb(env);
  await db.batch([
    db.statement((q) =>
      q.updateTable('rate_limits').set({ window_start_at: past }).where('key', 'like', 'password-email:%'),
    ),
  ]);
}

// console に出したものを、すべてつないだ文字列にする
let logs: string[];

beforeEach(() => {
  logs = [];
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      logs.push(args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '));
    });
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('入れる', () => {
  test('正しいメールアドレスとパスワードで 200 の { return_to } とセッションの Cookie を返す', async () => {
    const person = await passwordPerson();
    const res = await send({ email: person.email, password: person.password });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ return_to: '/' });
    const token = sessionTokenOf(res);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const cookieLine = res.headers.getSetCookie().find((line) => line.startsWith(`${SESSION_COOKIE}=`))!;
    for (const attribute of ['HttpOnly', 'Secure', 'Path=/']) expect(cookieLine).toContain(attribute);

    const login = await passwordLoginOf(person.subject);
    expect(login).toMatchObject({
      login_provider: 'password',
      login_subject: person.subject,
      login_name: DISPLAY_NAME,
      display_name: DISPLAY_NAME,
      avatar_url: null,
    });
    const db = commonDb(env);
    const tokenHash = await hashSessionToken(token!);
    const session = await db.first(
      db.statement((q) => q.selectFrom('sessions').selectAll().where('token_hash', '=', tokenHash)),
    );
    expect(session?.account_id).toBe(login!.account_id);
  });

  test('2回目のログインは、同じアカウントに新しいセッションを作る', async () => {
    const person = await passwordPerson();
    const first = await send({ email: person.email, password: person.password });
    expect(first.status).toBe(200);
    const accountId = (await passwordLoginOf(person.subject))!.account_id;
    const second = await send({ email: person.email, password: person.password });
    expect(second.status).toBe(200);
    expect((await passwordLoginOf(person.subject))!.account_id).toBe(accountId);
    expect(sessionTokenOf(second)).not.toBe(sessionTokenOf(first));
  });

  test('入れる組織が2つでも入れる（画面は / の組織の選択へ進む）', async () => {
    const person = await passwordPerson({ organizations: 2 });
    const res = await send({ email: person.email, password: person.password });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ return_to: '/' });
    expect(sessionTokenOf(res)).toBeDefined();
  });

  test('メールアドレスは既存のそろえ方（前後の空白、英大文字）で引く', async () => {
    const person = await passwordPerson();
    const res = await send({ email: `  ${person.email.toUpperCase()} `, password: person.password });
    expect(res.status).toBe(200);
  });

  test('パスワードは NFC にそろえて照合する（分解した「が」でも、合成済みで登録した人が入れる）', async () => {
    const composed = normalizePassword(`${'が'.repeat(6)}kumo-2026`)!;
    const person = await passwordPerson({ password: composed });
    const res = await send({ email: person.email, password: `${'が'.repeat(6)}kumo-2026` });
    expect(res.status).toBe(200);
  });

  test.each([
    ['自分のサイトのパス', '/aoba/board?tab=1', '/aoba/board?tab=1'],
    ['別のオリジンの URL', 'https://evil.example/steal', '/'],
    ['プロトコル相対の URL', '//evil.example', '/'],
    ['バックスラッシュで始まる', '/\\evil.example', '/'],
    ['パスで始まらない', 'aoba/board', '/'],
  ])('戻る画面（return_to）が%sなら %s → %s', async (_label, returnTo, expected) => {
    const person = await passwordPerson();
    const res = await send({ email: person.email, password: person.password, return_to: returnTo });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ return_to: expected });
  });

  test('回数の少ない古いハッシュで入れたら、今の回数で書き直す', async () => {
    const person = await passwordPerson({ iterations: 1000 });
    const res = await send({ email: person.email, password: person.password });
    expect(res.status).toBe(200);
    const row = await credentialOf(person.subject);
    expect(row!.password_hash).not.toBe(person.storedHash);
    expect(row!.password_hash.startsWith(`pbkdf2-sha256$${PASSWORD_HASH_ITERATIONS}$`)).toBe(true);
    expect(await verifyPassword(person.password, row!.password_hash)).toBe(true);
  });

  test('今の回数のハッシュは書き直さない', async () => {
    const person = await passwordPerson();
    expect((await send({ email: person.email, password: person.password })).status).toBe(200);
    expect((await credentialOf(person.subject))!.password_hash).toBe(person.storedHash);
  });

  test('違うパスワードでは、古いハッシュを書き直さない', async () => {
    const person = await passwordPerson({ iterations: 1000 });
    expect((await send({ email: person.email, password: WRONG_PASSWORD })).status).toBe(401);
    expect((await credentialOf(person.subject))!.password_hash).toBe(person.storedHash);
  });
});

describe('断る（列挙を防ぐ）', () => {
  test('違うパスワードは 401 invalid_credentials で、Cookie もアカウントも作らない', async () => {
    const person = await passwordPerson();
    const res = await send({ email: person.email, password: WRONG_PASSWORD });
    expect(res.status).toBe(401);
    expect((await errorOf(res)).code).toBe('invalid_credentials');
    expect(res.headers.getSetCookie()).toEqual([]);
    expect(await passwordLoginOf(person.subject)).toBeUndefined();
  });

  test('無いメールアドレスは 401 invalid_credentials', async () => {
    const res = await send({ email: 'nobody-256@example.test', password: PASSWORD });
    expect(res.status).toBe(401);
    expect((await errorOf(res)).code).toBe('invalid_credentials');
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  test.each([
    ['短すぎる（11文字）', 'p'.repeat(11)],
    ['長すぎる（129文字）', 'p'.repeat(129)],
    ['空', ''],
  ])('パスワードがそろえ方に合わない（%s）は 401 invalid_credentials（400 にしない）', async (_label, password) => {
    const person = await passwordPerson();
    const res = await send({ email: person.email, password });
    expect(res.status).toBe(401);
    expect((await errorOf(res)).code).toBe('invalid_credentials');
  });

  test.each([
    ['@ が無い', 'tsumugi.example.test'],
    ['ASCII の外の文字', 'つむぎ@example.test'],
    ['空', ''],
  ])('メールアドレスがそろえ方に合わない（%s）は 401 invalid_credentials（400 にしない）', async (_label, email) => {
    const res = await send({ email, password: PASSWORD });
    expect(res.status).toBe(401);
    expect((await errorOf(res)).code).toBe('invalid_credentials');
  });

  test('違うパスワード、無いメールアドレス、そろえ方に合わない入力は、状態もヘッダーも本文もまったく同じ', async () => {
    const person = await passwordPerson();
    const responses = [
      await send({ email: person.email, password: WRONG_PASSWORD }),
      await send({ email: 'nobody-256-same@example.test', password: PASSWORD }),
      await send({ email: person.email, password: 'short' }),
      await send({ email: 'not-an-address', password: PASSWORD }),
    ];
    const shapes = await Promise.all(
      responses.map(async (res) => ({
        status: res.status,
        headers: [...res.headers.entries()].sort(([a], [b]) => (a < b ? -1 : 1)),
        body: await res.text(),
      })),
    );
    for (const shape of shapes.slice(1)) expect(shape).toEqual(shapes[0]);
    expect(shapes[0]!.headers.some(([name]) => name.toLowerCase() === 'set-cookie')).toBe(false);
  });

  test('無いメールアドレスでも、違うパスワードと同じだけ（今の回数で1回）ハッシュを回す', async () => {
    const person = await passwordPerson();

    const wrong = spyPbkdf2();
    expect((await send({ email: person.email, password: WRONG_PASSWORD })).status).toBe(401);
    const wrongIterations = wrong.iterations();
    wrong.restore();

    const missing = spyPbkdf2();
    expect((await send({ email: 'nobody-256-time@example.test', password: PASSWORD })).status).toBe(401);
    const missingIterations = missing.iterations();
    missing.restore();

    expect(wrongIterations).toEqual([PASSWORD_HASH_ITERATIONS]);
    expect(missingIterations).toEqual(wrongIterations);
  });

  test.each([
    ['短すぎるパスワード', (email: string) => ({ email, password: 'short' })],
    ['そろえられないメールアドレス', () => ({ email: 'not-an-address', password: PASSWORD })],
  ])('%sでも、今の回数で1回ハッシュを回す', async (_label, body) => {
    const person = await passwordPerson();
    const spy = spyPbkdf2();
    expect((await send(body(person.email))).status).toBe(401);
    expect(spy.iterations()).toEqual([PASSWORD_HASH_ITERATIONS]);
  });

  test('パスワードが合い、入れる組織が無ければ 403 forbidden の denied。アカウントもセッションも作らない', async () => {
    const person = await passwordPerson({ organizations: 0 });
    const res = await send({ email: person.email, password: person.password });
    expect(res.status).toBe(403);
    const error = await errorOf(res);
    expect(error.code).toBe('forbidden');
    expect(error.details).toMatchObject({ reason: 'denied' });
    expect(res.headers.getSetCookie()).toEqual([]);
    expect(await passwordLoginOf(person.subject)).toBeUndefined();
  });

  test('パスワードが合い、停止した組織にだけ入れるなら 403 forbidden の suspended', async () => {
    const person = await passwordPerson({ suspended: true });
    const res = await send({ email: person.email, password: person.password });
    expect(res.status).toBe(403);
    const error = await errorOf(res);
    expect(error.code).toBe('forbidden');
    expect(error.details).toMatchObject({ reason: 'suspended' });
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  test('入れる組織が無い人も、パスワードが違えば 401 invalid_credentials（組織の有無を漏らさない）', async () => {
    const nowhere = await passwordPerson({ organizations: 0 });
    const suspended = await passwordPerson({ suspended: true });
    const member = await passwordPerson();
    const bodies = await Promise.all(
      [nowhere, suspended, member].map(async (person) => {
        const res = await send({ email: person.email, password: WRONG_PASSWORD });
        expect(res.status).toBe(401);
        return res.text();
      }),
    );
    expect(new Set(bodies).size).toBe(1);
    expect(JSON.parse(bodies[0]!).error.code).toBe('invalid_credentials');
  });

  test('ユーザーの行を結ぶ書き込みが失敗したら 503 unavailable で、セッションを作らない', async () => {
    const person = await passwordPerson();
    const res = await send({ email: person.email, password: person.password }, { env: failUserWrites(testEnv) });
    expect(res.status).toBe(503);
    expect((await errorOf(res)).code).toBe('unavailable');
    expect(sessionTokenOf(res)).toBeUndefined();
  });
});

describe('Origin と Sec-Fetch-Site', () => {
  test.each([
    ['Origin が無い', { Origin: undefined }],
    ['Origin が別のサイト', { Origin: 'https://evil.example' }],
    ['Origin が null', { Origin: 'null' }],
    ['Origin がスキームだけ違う', { Origin: ORIGIN.replace('https:', 'http:') }],
    ['Sec-Fetch-Site が cross-site', { 'Sec-Fetch-Site': 'cross-site' }],
    ['Sec-Fetch-Site が same-site', { 'Sec-Fetch-Site': 'same-site' }],
    ['Sec-Fetch-Site が none', { 'Sec-Fetch-Site': 'none' }],
  ])('%sなら、正しいパスワードでも 403 forbidden で、セッションを作らない', async (_label, headers) => {
    const person = await passwordPerson();
    const res = await send({ email: person.email, password: person.password }, { headers });
    expect(res.status).toBe(403);
    expect((await errorOf(res)).code).toBe('forbidden');
    expect(res.headers.getSetCookie()).toEqual([]);
    expect(await passwordLoginOf(person.subject)).toBeUndefined();
  });

  test('Sec-Fetch-Site が無くても、Origin が合えば通る', async () => {
    const person = await passwordPerson();
    const res = await send(
      { email: person.email, password: person.password },
      { headers: { 'Sec-Fetch-Site': undefined } },
    );
    expect(res.status).toBe(200);
  });

  test('Origin で断った呼び出しは、レート制限の行を書かず、ハッシュも回さない', async () => {
    const person = await passwordPerson();
    const ip = nextIp();
    const before = await passwordRateLimitKeys();
    const spy = spyPbkdf2();
    const res = await send(
      { email: person.email, password: person.password },
      { ip, headers: { Origin: 'https://evil.example' } },
    );
    expect(res.status).toBe(403);
    expect(await passwordRateLimitKeys()).toEqual(before);
    expect(spy.iterations()).toEqual([]);
  });
});

describe('本文', () => {
  test.each([
    ['text/plain', 'text/plain'],
    ['フォームの送信', 'application/x-www-form-urlencoded'],
  ])('Content-Type が %s なら 400 invalid_input', async (_label, contentType) => {
    const person = await passwordPerson();
    const res = await send(
      { email: person.email, password: person.password },
      { headers: { 'Content-Type': contentType } },
    );
    expect(res.status).toBe(400);
    expect((await errorOf(res)).code).toBe('invalid_input');
  });

  test('Content-Type が無ければ 400 invalid_input', async () => {
    const person = await passwordPerson();
    const res = await send(
      { email: person.email, password: person.password },
      { headers: { 'Content-Type': undefined } },
    );
    expect(res.status).toBe(400);
  });

  test('Content-Type に charset が付いた JSON は受ける', async () => {
    const person = await passwordPerson();
    const res = await send(
      { email: person.email, password: person.password },
      { headers: { 'Content-Type': 'application/json; charset=utf-8' } },
    );
    expect(res.status).toBe(200);
  });

  test.each([
    ['JSON でない', 'email=a&password=b'],
    ['配列', '[]'],
    ['null', 'null'],
    ['email が無い', JSON.stringify({ password: PASSWORD })],
    ['password が無い', JSON.stringify({ email: 'a@example.test' })],
    ['email が文字列でない', JSON.stringify({ email: 1, password: PASSWORD })],
    ['password が文字列でない', JSON.stringify({ email: 'a@example.test', password: 123456789012 })],
    ['return_to が文字列でない', JSON.stringify({ email: 'a@example.test', password: PASSWORD, return_to: 1 })],
  ])('形が違う（%s）なら 400 invalid_input', async (_label, rawBody) => {
    const res = await send(undefined, { rawBody });
    expect(res.status).toBe(400);
    expect((await errorOf(res)).code).toBe('invalid_input');
  });

  test('本文がちょうど 4KiB なら読む', async () => {
    const person = await passwordPerson();
    const json = JSON.stringify({ email: person.email, password: person.password });
    const rawBody = json + ' '.repeat(4096 - new TextEncoder().encode(json).byteLength);
    expect(new TextEncoder().encode(rawBody).byteLength).toBe(4096);
    const res = await send(undefined, { rawBody });
    expect(res.status).toBe(200);
  });

  test('本文が 4KiB を超えたら 400 invalid_input', async () => {
    const person = await passwordPerson();
    const json = JSON.stringify({ email: person.email, password: person.password });
    const rawBody = json + ' '.repeat(4097 - new TextEncoder().encode(json).byteLength);
    const res = await send(undefined, { rawBody });
    expect(res.status).toBe(400);
    expect((await errorOf(res)).code).toBe('invalid_input');
    expect(sessionTokenOf(res)).toBeUndefined();
  });

  test('本文で断った呼び出しは、レート制限の行を書かず、ハッシュも回さない', async () => {
    const before = await passwordRateLimitKeys();
    const spy = spyPbkdf2();
    const res = await send(undefined, { rawBody: JSON.stringify({ email: 'a@example.test' }) });
    expect(res.status).toBe(400);
    expect(await passwordRateLimitKeys()).toEqual(before);
    expect(spy.iterations()).toEqual([]);
  });
});

describe('レート制限', () => {
  test('同じ IP の枠が上限なら、正しいパスワードでも 429 rate_limited で、ハッシュを回さない', async () => {
    const person = await passwordPerson();
    const ip = nextIp();
    await setRateLimit(`password:${ip}`, PASSWORD_LOGIN_RATE_LIMITS.network.max, new Date());
    const spy = spyPbkdf2();
    const res = await send({ email: person.email, password: person.password }, { ip });
    expect(res.status).toBe(429);
    expect((await errorOf(res)).code).toBe('rate_limited');
    expect(sessionTokenOf(res)).toBeUndefined();
    expect(spy.iterations()).toEqual([]);
  });

  test('同じ IP の枠の上限の1つ手前なら通る', async () => {
    const person = await passwordPerson();
    const ip = nextIp();
    await setRateLimit(`password:${ip}`, PASSWORD_LOGIN_RATE_LIMITS.network.max - 1, new Date());
    expect((await send({ email: person.email, password: person.password }, { ip })).status).toBe(200);
  });

  test('同じ IP から30回試すと、31回目は別のメールアドレスでも 429', async () => {
    const ip = nextIp();
    for (let i = 0; i < PASSWORD_LOGIN_RATE_LIMITS.network.max; i++) {
      const res = await send({ email: `nobody-ip-${i}@example.test`, password: PASSWORD }, { ip });
      expect(res.status).toBe(401);
    }
    const person = await passwordPerson();
    const res = await send({ email: person.email, password: person.password }, { ip });
    expect(res.status).toBe(429);
  });

  test('IPv6 の /48 の枠が上限なら、同じ /48 の別の /64 からも 429', async () => {
    const person = await passwordPerson();
    const site = randomSite();
    await setRateLimit(`password48:${site}::/48`, PASSWORD_LOGIN_RATE_LIMITS.ipv6Site.max, new Date());
    const res = await send({ email: person.email, password: person.password }, { ip: `${site}:7::1` });
    expect(res.status).toBe(429);
  });

  test('別の IP から同じメールアドレスに10回試すと、11回目は正しいパスワードでも 429', async () => {
    const person = await passwordPerson();
    for (let i = 0; i < PASSWORD_LOGIN_RATE_LIMITS.email.max; i++) {
      expect((await send({ email: person.email, password: WRONG_PASSWORD })).status).toBe(401);
    }
    const res = await send({ email: person.email, password: person.password });
    expect(res.status).toBe(429);
    expect((await errorOf(res)).code).toBe('rate_limited');
    expect(sessionTokenOf(res)).toBeUndefined();
  });

  test('メールアドレスの枠はそろえた後のアドレスで数える（大文字に変えても同じ枠）', async () => {
    const person = await passwordPerson();
    for (let i = 0; i < PASSWORD_LOGIN_RATE_LIMITS.email.max; i++) {
      const email = i % 2 === 0 ? person.email : ` ${person.email.toUpperCase()}`;
      expect((await send({ email, password: WRONG_PASSWORD })).status).toBe(401);
    }
    expect((await send({ email: person.email, password: person.password })).status).toBe(429);
  });

  test('成功したログインも数える', async () => {
    const person = await passwordPerson();
    for (let i = 0; i < PASSWORD_LOGIN_RATE_LIMITS.email.max; i++) {
      expect((await send({ email: person.email, password: person.password })).status).toBe(200);
    }
    expect((await send({ email: person.email, password: person.password })).status).toBe(429);
  });

  test('無いメールアドレスも、ある人と同じくメールアドレスの枠で数える', async () => {
    const email = `nobody-limit-${crypto.randomUUID().slice(0, 8)}@example.test`;
    for (let i = 0; i < PASSWORD_LOGIN_RATE_LIMITS.email.max; i++) {
      expect((await send({ email, password: PASSWORD })).status).toBe(401);
    }
    expect((await send({ email, password: PASSWORD })).status).toBe(429);
  });

  test('あるメールアドレスが上限でも、別のメールアドレスの人は入れる', async () => {
    const locked = await passwordPerson();
    for (let i = 0; i < PASSWORD_LOGIN_RATE_LIMITS.email.max; i++) {
      await send({ email: locked.email, password: WRONG_PASSWORD });
    }
    const other = await passwordPerson();
    expect((await send({ email: other.email, password: other.password })).status).toBe(200);
  });

  test('そろえられないメールアドレスは、メールアドレスの枠の行を作らない（IP の枠だけ数える）', async () => {
    const ip = nextIp();
    const before = (await passwordRateLimitKeys()).filter((key) => key.startsWith('password-email:'));
    expect((await send({ email: 'not-an-address', password: PASSWORD }, { ip })).status).toBe(401);
    const after = (await passwordRateLimitKeys()).filter((key) => key.startsWith('password-email:'));
    expect(after).toEqual(before);
    expect((await rateLimitRow(`password:${ip}`))?.count).toBe(1);
  });

  test('429 で断った呼び出しは、メールアドレスの枠を数え増さない（覗いて断る）', async () => {
    const person = await passwordPerson();
    for (let i = 0; i < PASSWORD_LOGIN_RATE_LIMITS.email.max; i++) {
      await send({ email: person.email, password: WRONG_PASSWORD });
    }
    const keysBefore = (await passwordRateLimitKeys()).filter((key) => key.startsWith('password-email:'));
    const counts = async () =>
      Promise.all(keysBefore.map(async (key) => [key, (await rateLimitRow(key))?.count] as const));
    const countsBefore = await counts();
    const ip = nextIp();
    expect((await send({ email: person.email, password: person.password }, { ip })).status).toBe(429);
    expect(await counts()).toEqual(countsBefore);
    // 断った IP の行も作らない
    expect(await rateLimitRow(`password:${ip}`)).toBeUndefined();
  });

  test('アカウントは締め出さない: 窓が過ぎたら、正しいパスワードで入れる', async () => {
    const person = await passwordPerson();
    for (let i = 0; i < PASSWORD_LOGIN_RATE_LIMITS.email.max; i++) {
      await send({ email: person.email, password: WRONG_PASSWORD });
    }
    expect((await send({ email: person.email, password: person.password })).status).toBe(429);
    await expireEmailWindows();
    const res = await send({ email: person.email, password: person.password });
    expect(res.status).toBe(200);
    expect(sessionTokenOf(res)).toBeDefined();
  });

  test('IP の枠も、窓が過ぎたら通る', async () => {
    const person = await passwordPerson();
    const ip = nextIp();
    const past = new Date(Date.now() - PASSWORD_LOGIN_RATE_LIMITS.network.windowMs - 1000);
    await setRateLimit(`password:${ip}`, PASSWORD_LOGIN_RATE_LIMITS.network.max, past);
    expect((await send({ email: person.email, password: person.password }, { ip })).status).toBe(200);
  });

  test('OAuth のログインの枠（login:<IP>）が上限でも、パスワードのログインは通る', async () => {
    const person = await passwordPerson();
    const ip = nextIp();
    await setRateLimit(`login:${ip}`, 10_000, new Date());
    expect((await send({ email: person.email, password: person.password }, { ip })).status).toBe(200);
  });
});

describe('ログと応答に出さない', () => {
  function secretsOf(person: PasswordPerson): string[] {
    const [, , salt, key] = person.storedHash.split('$') as [string, string, string, string];
    return [person.password, WRONG_PASSWORD, person.email, person.storedHash, salt, key];
  }

  function expectClean(texts: string[], secrets: string[]) {
    for (const text of texts) {
      for (const secret of secrets) expect(text).not.toContain(secret);
    }
  }

  test('成功、違うパスワード、無いメールアドレス、入れる組織が無い、429、Origin、形の誤りで、パスワードとハッシュとメールアドレスを出さない', async () => {
    const person = await passwordPerson();
    const nowhere = await passwordPerson({ organizations: 0 });
    const missingEmail = 'nobody-256-log@example.test';
    const limitedIp = nextIp();
    await setRateLimit(`password:${limitedIp}`, PASSWORD_LOGIN_RATE_LIMITS.network.max, new Date());

    const responses = [
      await send({ email: person.email, password: person.password }),
      await send({ email: person.email, password: WRONG_PASSWORD }),
      await send({ email: missingEmail, password: person.password }),
      await send({ email: nowhere.email, password: nowhere.password }),
      await send({ email: person.email, password: person.password }, { ip: limitedIp }),
      await send({ email: person.email, password: person.password }, { headers: { Origin: 'https://evil.example' } }),
      await send(undefined, { rawBody: `{"email":"${person.email}","password":"${person.password}"` }),
      await send({ email: person.email, password: person.password, return_to: 1 }),
      await send({ email: person.email, password: person.password }, { env: failUserWrites(testEnv) }),
    ];
    const bodies = await Promise.all(responses.map((res) => res.text()));
    const headers = responses.map((res) => [...res.headers.entries()].map(([k, v]) => `${k}: ${v}`).join('\n'));

    const secrets = [...secretsOf(person), ...secretsOf(nowhere), missingEmail];
    expectClean(bodies, secrets);
    expectClean(headers, secrets);
    expectClean(logs, secrets);
  });

  test('ハッシュの関数が例外を投げても、パスワードをログに出さず 500 の決まった形で返す', async () => {
    const person = await passwordPerson();
    vi.spyOn(crypto.subtle, 'deriveBits').mockRejectedValue(new Error(`boom ${person.password}`));
    vi.spyOn(crypto.subtle, 'deriveKey').mockRejectedValue(new Error(`boom ${person.password}`));
    const res = await send({ email: person.email, password: person.password });
    expect(res.status).toBe(500);
    expect((await errorOf(res)).code).toBe('internal');
    expectClean([await res.text(), ...logs], secretsOf(person));
  });
});
