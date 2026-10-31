// パスワードのログイン（POST /api/auth/password/login、Issue #256）を崩しにかかるテスト（2周目）。
// test/password-login.test.ts、test/password-hash.test.ts、test/password-rate-limit.test.ts、test/password-login-break-1.test.ts が
// 確かめていない手口だけを置く
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createApp } from '../src/server/app.ts';
import { hashPassword, PASSWORD_HASH_ITERATIONS, verifyPassword } from '../src/server/auth/password-hash.ts';
import { PASSWORD_LOGIN_RATE_LIMITS } from '../src/server/auth/rate-limit.ts';
import { hashSessionToken } from '../src/server/auth/session.ts';
import { commonDb } from '../src/server/db/index.ts';
import { normalizePassword, PASSWORD_MAX_LENGTH } from '../src/shared/password.ts';
import { sessionCookieName } from '../src/shared/session-cookie.ts';
import { failUserWrites } from './auth/helpers.ts';
import { spyPbkdf2 } from './auth/pbkdf2-spy.ts';
import { AT, createInvitation, createOrganization, createUser, createWorkspace } from './factories.ts';
import { testEnv } from './operations/world.ts';

const app = createApp(undefined, { passwordLogin: true });
const ORIGIN = new URL(testEnv.PUBLIC_ORIGIN).origin;
const SESSION_COOKIE = sessionCookieName(testEnv.PUBLIC_ORIGIN);
const PATH = '/api/auth/password/login';

// 架空の値
const PASSWORD = 'hibari-kumo-2026';
const WRONG_PASSWORD = 'hibari-kumo-2027';
const DISPLAY_NAME = '朝倉 凪';

// このファイルの中で IP が重ならないよう、100.112.0.0/12（100.64.0.0/10 の後ろのほう。ほかのファイルの 100.64、100.96 と別）から配る
let ipCount = 0;
const nextIp = () => `100.112.${Math.floor(++ipCount / 250)}.${(ipCount % 250) + 1}`;

type PasswordPerson = { subject: string; email: string; password: string; storedHash: string };

type PersonOptions = {
  // 'admin': 管理者の行が1つ。'none': 入れる組織が無い。'disabled': 無効にした管理者の行だけ。'invited': 招待だけ
  // 'suspended': 停止した組織の管理者の行だけ
  access?: 'admin' | 'none' | 'disabled' | 'invited' | 'suspended';
  password?: string;
  iterations?: number;
};

let personCount = 0;

async function passwordPerson(options: PersonOptions = {}): Promise<PasswordPerson> {
  const subject = crypto.randomUUID();
  const email = `nagi-${++personCount}-${subject.slice(0, 8)}@example.test`;
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
  const access = options.access ?? 'admin';
  if (access === 'admin' || access === 'disabled' || access === 'suspended') {
    const organization = await createOrganization(access === 'suspended' ? { suspended_at: AT } : {});
    await createUser(organization, {
      login_provider: 'password',
      login_subject: subject,
      name: DISPLAY_NAME,
      is_admin: 1,
      disabled_at: access === 'disabled' ? AT : null,
    });
  }
  if (access === 'invited') {
    const organization = await createOrganization();
    const leader = await createUser(organization, { is_admin: 1 });
    const workspace = await createWorkspace(organization, leader.id);
    await createInvitation(organization, workspace.id, leader.id, { provider: 'password', subject });
  }
  return { subject, email, password, storedHash };
}

type SendOptions = {
  ip?: string;
  headers?: Record<string, string | undefined>;
  rawBody?: BodyInit;
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

function sessionTokenOf(res: Response): string | undefined {
  const line = res.headers.getSetCookie().find((entry) => entry.startsWith(`${SESSION_COOKIE}=`));
  return line?.slice(SESSION_COOKIE.length + 1).split(';')[0];
}

async function credentialOf(subject: string) {
  const db = commonDb(env);
  return db.first(
    db.statement((q) => q.selectFrom('password_credentials').selectAll().where('login_subject', '=', subject)),
  );
}

async function sessionExists(token: string): Promise<boolean> {
  const db = commonDb(env);
  const tokenHash = await hashSessionToken(token);
  const row = await db.first(
    db.statement((q) => q.selectFrom('sessions').select('token_hash').where('token_hash', '=', tokenHash)),
  );
  return row !== undefined;
}

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

describe('Origin で断るときは本文を読まない（docs/development.md の「パスワードのログイン」の 1）', () => {
  test('別のサイトからの POST は、本文の流れを1度も引かずに 403', async () => {
    const person = await passwordPerson();
    const json = new TextEncoder().encode(JSON.stringify({ email: person.email, password: person.password }));
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulls += 1;
          controller.enqueue(json);
          controller.close();
        },
      },
      { highWaterMark: 0 },
    );
    const res = await send(undefined, { rawBody: stream, headers: { Origin: 'https://evil.example' } });
    expect(res.status).toBe(403);
    expect(pulls).toBe(0);
  });
});

describe('ハッシュの書き直し（docs/data-model.md の password_credentials）', () => {
  test('書き直しは password_hash と updated_at だけを変え、password_changed_at は変えない', async () => {
    const person = await passwordPerson({ iterations: 1000 });
    const before = await credentialOf(person.subject);
    const res = await send({ email: person.email, password: person.password });
    expect(res.status).toBe(200);
    const after = await credentialOf(person.subject);
    expect(after!.password_hash).not.toBe(before!.password_hash);
    expect(after!.password_changed_at).toBe(before!.password_changed_at);
    expect(after!.created_at).toBe(before!.created_at);
    expect(after!.email).toBe(before!.email);
    expect(after!.display_name).toBe(before!.display_name);
    expect(after!.updated_at).not.toBe(before!.updated_at);
  });

  test('パスワードが合っても入れる組織が無ければ（403 denied）、ログインの成功ではないので書き直さず、前のセッションも消さない', async () => {
    const person = await passwordPerson({ access: 'none', iterations: 1000 });
    const owner = await passwordPerson();
    const first = await send({ email: owner.email, password: owner.password });
    const previous = sessionTokenOf(first)!;
    const res = await send(
      { email: person.email, password: person.password },
      { headers: { Cookie: `${SESSION_COOKIE}=${previous}` } },
    );
    expect(res.status).toBe(403);
    expect(res.headers.getSetCookie()).toEqual([]);
    expect((await credentialOf(person.subject))!.password_hash).toBe(person.storedHash);
    expect(await sessionExists(previous)).toBe(true);
  });

  test('結ぶ書き込みが失敗した（503）ときも、ログインの成功ではないので書き直さない', async () => {
    const person = await passwordPerson({ iterations: 1000 });
    const res = await send({ email: person.email, password: person.password }, { env: failUserWrites(testEnv) });
    expect(res.status).toBe(503);
    expect((await credentialOf(person.subject))!.password_hash).toBe(person.storedHash);
  });
});

describe('入れる組織の判定（docs/requirements.md の「メンバーと権限」）', () => {
  test('組織に入っていなくても、手段 password の招待が届いていれば入れる', async () => {
    const person = await passwordPerson({ access: 'invited' });
    const res = await send({ email: person.email, password: person.password });
    expect(res.status).toBe(200);
    expect(sessionTokenOf(res)).toBeDefined();
  });

  test('無効にした行だけの人は、パスワードが合っても 403 で、セッションを作らない', async () => {
    const person = await passwordPerson({ access: 'disabled' });
    const res = await send({ email: person.email, password: person.password });
    expect(res.status).toBe(403);
    expect(res.headers.getSetCookie()).toEqual([]);
  });
});

describe('ログインの後の API の応答にも、メールアドレスとハッシュを出さない', () => {
  test('me は手段 password と表示名を返し、メールアドレス、ハッシュ、資格情報の ID を返さない', async () => {
    const person = await passwordPerson();
    const login = await send({ email: person.email, password: person.password });
    const token = sessionTokenOf(login)!;
    const res = await app.request(
      '/api/me',
      {
        method: 'POST',
        headers: {
          Origin: ORIGIN,
          'Content-Type': 'application/json',
          Cookie: `${SESSION_COOKIE}=${token}`,
        },
        body: '{}',
      },
      testEnv,
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text)).toMatchObject({
      login_provider: 'password',
      login_name: DISPLAY_NAME,
      display_name: DISPLAY_NAME,
      avatar_url: null,
    });
    const [, , salt, key] = person.storedHash.split('$') as [string, string, string, string];
    for (const secret of [person.email, person.password, person.storedHash, salt, key]) {
      expect(text).not.toContain(secret);
    }
  });
});

describe('ログの1行（docs/development.md の「パスワードのログイン」のログ）', () => {
  type LoginLog = { route?: string; step?: string; provider?: string; outcome?: string; accountId?: string };

  function loginLogs(): LoginLog[] {
    return logs.flatMap((line) => {
      try {
        const parsed = JSON.parse(line) as LoginLog;
        return parsed.route === 'auth' && parsed.step === 'login' && parsed.provider === 'password' ? [parsed] : [];
      } catch {
        return [];
      }
    });
  }

  test('どの道も、決めた outcome の行をちょうど1行出す', async () => {
    const person = await passwordPerson();
    const nowhere = await passwordPerson({ access: 'none' });
    // 結ぶ書き込みは、まだ結んでいない人だけが行う（person は最初の ok の場面で結ぶ）
    const unlinked = await passwordPerson();
    const paused = await passwordPerson({ access: 'suspended' });
    const limitedIp = nextIp();
    const db = commonDb(env);
    await db.batch([
      db.statement((q) =>
        q.insertInto('rate_limits').values({
          key: `password:${limitedIp}`,
          window_start_at: new Date().toISOString(),
          count: PASSWORD_LOGIN_RATE_LIMITS.network.max,
        }),
      ),
    ]);
    const cases: [string, () => Promise<Response>][] = [
      ['ok', () => send({ email: person.email, password: person.password })],
      ['invalid_credentials', () => send({ email: person.email, password: WRONG_PASSWORD })],
      ['invalid_credentials', () => send({ email: 'nobody-break-2@example.test', password: PASSWORD })],
      ['invalid_credentials', () => send({ email: person.email, password: 'short' })],
      ['denied', () => send({ email: nowhere.email, password: nowhere.password })],
      ['suspended', () => send({ email: paused.email, password: paused.password })],
      ['too_many', () => send({ email: person.email, password: person.password }, { ip: limitedIp })],
      ['retry', () => send({ email: unlinked.email, password: unlinked.password }, { env: failUserWrites(testEnv) })],
      [
        'forbidden_origin',
        () => send({ email: person.email, password: person.password }, { headers: { Origin: 'https://evil.example' } }),
      ],
    ];
    for (const [outcome, run] of cases) {
      logs.length = 0;
      await run();
      expect(
        loginLogs().map((entry) => entry.outcome),
        outcome,
      ).toEqual([outcome]);
    }
  });
});

describe('長さの早い打ち切り（入力が 128×4 単位を超えたら NFC にそろえずに断る）', () => {
  // U+1FAF（ᾯ）は NFD で4つのコードポイント（Ω、U+0314、U+0342、U+0345）に分かれ、NFC で1文字に戻る
  const composed = 'ᾯ'.repeat(PASSWORD_MAX_LENGTH);
  const decomposed = composed.normalize('NFD');

  test('分解して 512 単位になる 128 文字のパスワードも、そろえて 128 文字なので通る', async () => {
    expect(decomposed.length).toBe(PASSWORD_MAX_LENGTH * 4);
    expect(normalizePassword(decomposed)).toBe(composed);
    const person = await passwordPerson({ password: composed });
    const spy = spyPbkdf2();
    const res = await send({ email: person.email, password: decomposed });
    expect(res.status).toBe(200);
    expect(spy.iterations()).toEqual([PASSWORD_HASH_ITERATIONS]);
    expect(await verifyPassword(composed, person.storedHash)).toBe(true);
  });
});
