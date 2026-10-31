// パスワードのログイン（POST /api/auth/password/login、Issue #256）を崩しにかかるテスト。
// test/password-login.test.ts と test/password-hash.test.ts が確かめていない手口だけを置く
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createApp } from '../src/server/app.ts';
import { hashPassword, PASSWORD_HASH_ITERATIONS, verifyPassword } from '../src/server/auth/password-hash.ts';
import { hashSessionToken } from '../src/server/auth/session.ts';
import { commonDb } from '../src/server/db/index.ts';
import { envWithD1Hooks } from '../src/server/db/testing.ts';
import { normalizePassword } from '../src/shared/password.ts';
import { sessionCookieName } from '../src/shared/session-cookie.ts';
import { spyPbkdf2 } from './auth/pbkdf2-spy.ts';
import { AT, createOrganization, createUser } from './factories.ts';
import { testEnv } from './operations/world.ts';

const app = createApp(undefined, { passwordLogin: true });
const ORIGIN = new URL(testEnv.PUBLIC_ORIGIN).origin;
const SESSION_COOKIE = sessionCookieName(testEnv.PUBLIC_ORIGIN);
const PATH = '/api/auth/password/login';

// 架空の値
const PASSWORD = 'kawasemi-sora-2026';
const WRONG_PASSWORD = 'kawasemi-sora-2027';
const DISPLAY_NAME = '水城 灯';

// このファイルの中で IP が重ならないよう、100.96.0.0/12（100.64.0.0/10 の後半）から順に配る
let ipCount = 0;
const nextIp = () => `100.96.${Math.floor(++ipCount / 250)}.${(ipCount % 250) + 1}`;

type PasswordPerson = { subject: string; email: string; password: string; storedHash: string };

let personCount = 0;

async function passwordPerson(options: { password?: string; iterations?: number } = {}): Promise<PasswordPerson> {
  const subject = crypto.randomUUID();
  const email = `akari-${++personCount}-${subject.slice(0, 8)}@example.test`;
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
  const organization = await createOrganization();
  await createUser(organization, {
    login_provider: 'password',
    login_subject: subject,
    name: DISPLAY_NAME,
    is_admin: 1,
  });
  return { subject, email, password, storedHash };
}

type SendOptions = {
  ip?: string;
  // 同じ名前を重ねて送るときは配列で渡す（Headers.append）
  headers?: Record<string, string | string[] | undefined>;
  rawBody?: BodyInit;
  env?: Env;
};

async function send(body: unknown, options: SendOptions = {}): Promise<Response> {
  const headers = new Headers();
  const given: Record<string, string | string[] | undefined> = {
    Origin: ORIGIN,
    'Content-Type': 'application/json',
    'Sec-Fetch-Site': 'same-origin',
    'CF-Connecting-IP': options.ip ?? nextIp(),
    ...options.headers,
  };
  for (const [name, value] of Object.entries(given)) {
    if (value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) headers.append(name, item);
  }
  return app.request(
    PATH,
    { method: 'POST', headers, body: options.rawBody ?? JSON.stringify(body) },
    options.env ?? testEnv,
  );
}

function sessionTokenOf(res: Response): string | undefined {
  const line = res.headers.getSetCookie().find((entry) => entry.startsWith(`${SESSION_COOKIE}=`));
  return line?.slice(SESSION_COOKIE.length + 1).split(';')[0];
}

async function sessionExists(token: string): Promise<boolean> {
  const db = commonDb(env);
  const tokenHash = await hashSessionToken(token);
  const row = await db.first(
    db.statement((q) => q.selectFrom('sessions').select('token_hash').where('token_hash', '=', tokenHash)),
  );
  return row !== undefined;
}

async function storedHashOf(subject: string): Promise<string | undefined> {
  const db = commonDb(env);
  const row = await db.first(
    db.statement((q) =>
      q.selectFrom('password_credentials').select('password_hash').where('login_subject', '=', subject),
    ),
  );
  return row?.password_hash;
}

async function passwordRateLimitKeys(): Promise<string[]> {
  const db = commonDb(env);
  const rows = await db.rows(
    db.statement((q) => q.selectFrom('rate_limits').select('key').where('key', 'like', 'password%')),
  );
  return rows.map((row) => row.key).sort();
}

const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);

let logs: string[];

beforeEach(() => {
  logs = [];
  for (const method of ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      logs.push(args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '));
    });
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('列挙: 保存した回数が今と違う人', () => {
  // Issue #256 の受け入れ条件「違うパスワード、無いメールアドレス…は、応答の形と所要時間でも見分けられない」。
  // 回数の少ない保存値は「ログインの成功時に書き直す」（Issue の決めたこと）ので、書き直すまでの間は必ず残る状態。
  // 保存値の回数（ここでは 1,000）でしか回さないと、違うパスワードの応答が、無いメールアドレス（ダミーで 100,000 回）の
  // 約 1/100 の時間で返り、回数の古い人のメールアドレスが所要時間で見分けられる（崩しにかかった1周目で見つけて直した）
  test('回数の古い人に違うパスワードを送っても、無いメールアドレスと少なくとも同じだけ PBKDF2 を回す', async () => {
    const person = await passwordPerson({ iterations: 1000 });

    const missing = spyPbkdf2();
    expect((await send({ email: 'nobody-break-1@example.test', password: WRONG_PASSWORD })).status).toBe(401);
    const missingTotal = sum(missing.iterations());
    missing.restore();

    const old = spyPbkdf2();
    expect((await send({ email: person.email, password: WRONG_PASSWORD })).status).toBe(401);
    const oldTotal = sum(old.iterations());
    old.restore();

    expect(missingTotal).toBe(PASSWORD_HASH_ITERATIONS);
    expect(oldTotal).toBeGreaterThanOrEqual(missingTotal);
  });
});

describe('パスワードの照合は、送った文字列（NFC にそろえた後）の一致', () => {
  // 対になっていないサロゲート（JSON の "\ud800" で送れる）をそろえ方で通すと、deriveKey の TextEncoder が U+FFFD に
  // 置き換えて（ランタイムの UTF-8 の符号化の振る舞い）から PBKDF2 に渡すので、違う文字列（U+FFFD、U+D800、U+DC00 …）が
  // 同じパスワードとして通る。決めていない読み替えなので、整形式でない文字列（String.prototype.isWellFormed が偽）を
  // normalizePassword で断る（崩しにかかった1周目で見つけて直した。docs/requirements.md）
  test('U+FFFD を含むパスワードの人に、その位置を対になっていないサロゲートに変えたパスワードでは入れない', async () => {
    const registered = normalizePassword('�kawasemi-sora');
    expect(registered).toBeDefined();
    const person = await passwordPerson({ password: registered! });
    const loneSurrogate = '\uD800kawasemi-sora';
    expect(loneSurrogate).not.toBe(registered);
    const res = await send({ email: person.email, password: loneSurrogate });
    expect(res.status).toBe(401);
    expect(sessionTokenOf(res)).toBeUndefined();
  });
});

describe('セッションの差し替え（OAuth のログインと同じ）', () => {
  test('成功したら、送ってきた前のセッションを消し、新しいセッションを作る', async () => {
    const person = await passwordPerson();
    const first = await send({ email: person.email, password: person.password });
    expect(first.status).toBe(200);
    const before = sessionTokenOf(first)!;
    expect(await sessionExists(before)).toBe(true);

    const second = await send(
      { email: person.email, password: person.password },
      { headers: { Cookie: `${SESSION_COOKIE}=${before}` } },
    );
    expect(second.status).toBe(200);
    const after = sessionTokenOf(second)!;
    expect(after).not.toBe(before);
    expect(await sessionExists(before)).toBe(false);
    expect(await sessionExists(after)).toBe(true);
  });

  test('違うパスワードでは、送ってきたセッションを消さない（他人の Cookie を消させない）', async () => {
    const person = await passwordPerson();
    const first = await send({ email: person.email, password: person.password });
    const token = sessionTokenOf(first)!;
    const res = await send(
      { email: person.email, password: WRONG_PASSWORD },
      { headers: { Cookie: `${SESSION_COOKIE}=${token}` } },
    );
    expect(res.status).toBe(401);
    expect(await sessionExists(token)).toBe(true);
  });
});

describe('Origin と Sec-Fetch-Site の書き方の違い', () => {
  test.each([
    ['Origin に既定のポートを書いた', { Origin: `${ORIGIN}:443` }],
    ['Origin のポートが違う', { Origin: `${ORIGIN}:8443` }],
    ['Origin の末尾に /', { Origin: `${ORIGIN}/` }],
    ['Origin を2つ重ねた（正しい値と別のサイト）', { Origin: [ORIGIN, 'https://evil.example'] }],
    ['Origin を2つ重ねた（同じ値）', { Origin: [ORIGIN, ORIGIN] }],
    ['Sec-Fetch-Site を2つ重ねた', { 'Sec-Fetch-Site': ['same-origin', 'cross-site'] }],
  ])('%sなら、正しいパスワードでも 403 forbidden で、数えずハッシュも回さない', async (_label, headers) => {
    const person = await passwordPerson();
    const before = await passwordRateLimitKeys();
    const spy = spyPbkdf2();
    const res = await send({ email: person.email, password: person.password }, { headers });
    expect(res.status).toBe(403);
    expect(res.headers.getSetCookie()).toEqual([]);
    expect(spy.iterations()).toEqual([]);
    expect(await passwordRateLimitKeys()).toEqual(before);
  });
});

describe('本文', () => {
  test('Content-Length の無い（流して送る）本文も 4KiB で止め、400 で、数えずハッシュも回さない', async () => {
    const person = await passwordPerson();
    const json = JSON.stringify({ email: person.email, password: person.password });
    const padded = new TextEncoder().encode(json + ' '.repeat(5000));
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let offset = 0; offset < padded.byteLength; offset += 512) {
          controller.enqueue(padded.slice(offset, offset + 512));
        }
        controller.close();
      },
    });
    const before = await passwordRateLimitKeys();
    const spy = spyPbkdf2();
    const res = await send(undefined, { rawBody: stream });
    expect(res.status).toBe(400);
    expect(sessionTokenOf(res)).toBeUndefined();
    expect(spy.iterations()).toEqual([]);
    expect(await passwordRateLimitKeys()).toEqual(before);
  });

  test('__proto__ のキーを足した本文は 400（未知のキーとして断る）', async () => {
    const person = await passwordPerson();
    const rawBody = `{"email":${JSON.stringify(person.email)},"password":${JSON.stringify(person.password)},"__proto__":{"return_to":"//evil.example"}}`;
    const res = await send(undefined, { rawBody });
    expect(res.status).toBe(400);
    expect(sessionTokenOf(res)).toBeUndefined();
  });
});

describe('OAuth の道に password を通さない', () => {
  test.each([
    ['GET', '/api/auth/password/start'],
    ['GET', '/api/auth/password/callback?code=x&state=y'],
    ['POST', '/api/auth/password/start'],
    ['GET', PATH],
  ])('%s %s は 404', async (method, path) => {
    const res = await app.request(
      path,
      { method, headers: { Origin: ORIGIN, 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'navigate' } },
      testEnv,
    );
    expect(res.status).toBe(404);
    expect(res.headers.getSetCookie()).toEqual([]);
  });
});

describe('ハッシュの書き直し', () => {
  test('回数の古い人が並行して2回入っても、両方入れ、今の回数の値が1つ残って照合できる', async () => {
    const person = await passwordPerson({ iterations: 1000 });
    const results = await Promise.all([
      send({ email: person.email, password: person.password }),
      send({ email: person.email, password: person.password }),
    ]);
    expect(results.map((res) => res.status)).toEqual([200, 200]);
    const stored = (await storedHashOf(person.subject))!;
    expect(stored.startsWith(`pbkdf2-sha256$${PASSWORD_HASH_ITERATIONS}$`)).toBe(true);
    expect(await verifyPassword(person.password, stored)).toBe(true);
  });

  test('照合の後、書き直す前にパスワードが変わったら、変わった値を古いパスワードで上書きしない', async () => {
    const person = await passwordPerson({ iterations: 1000 });
    const changed = await hashPassword('kawasemi-kumo-2026', 1000);
    const original = crypto.subtle.deriveBits.bind(crypto.subtle);
    let first = true;
    vi.spyOn(crypto.subtle, 'deriveBits').mockImplementation(
      async (...args: Parameters<SubtleCrypto['deriveBits']>) => {
        const bits = await original(...args);
        if (first) {
          first = false;
          // 照合（1回目の PBKDF2）が終わった直後に、別の口でパスワードが変わったことにする
          const db = commonDb(env);
          await db.batch([
            db.statement((q) =>
              q
                .updateTable('password_credentials')
                .set({ password_hash: changed })
                .where('login_subject', '=', person.subject),
            ),
          ]);
        }
        return bits;
      },
    );
    const res = await send({ email: person.email, password: person.password });
    expect(res.status).toBe(200);
    expect(await storedHashOf(person.subject)).toBe(changed);
  });

  test('書き直しの書き込みが失敗しても入れ、例外の message にあるパスワードやメールアドレスをログに出さない', async () => {
    const person = await passwordPerson({ iterations: 1000 });
    const failing = envWithD1Hooks(testEnv, {
      beforeBatch: (sqls) => {
        if (sqls.some((sql) => sql.startsWith('update "password_credentials"'))) {
          throw new Error(`boom ${person.password} ${person.email} ${person.storedHash}`);
        }
      },
    });
    const res = await send({ email: person.email, password: person.password }, { env: failing });
    expect(res.status).toBe(200);
    expect(sessionTokenOf(res)).toBeDefined();
    expect(await storedHashOf(person.subject)).toBe(person.storedHash);
    expect(logs.some((line) => line.includes('"level":"error"'))).toBe(true);
    const [, , salt, key] = person.storedHash.split('$') as [string, string, string, string];
    for (const line of logs) {
      for (const secret of [person.password, person.email, person.storedHash, salt, key]) {
        expect(line).not.toContain(secret);
      }
    }
  });
});
