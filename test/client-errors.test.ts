// 画面で起きた JavaScript のエラーを受ける口（POST /api/client-errors、src/server/client-errors.ts、Issue #376）。
// 受けたら Workers Logs に JSON の1行（console.error）を残して 204。検査の順は Origin → 回数の上限 → 本文（4KiB）→ 形。
// 断ったときはどれもログを出さない
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, test, vi, type MockInstance } from 'vitest';
import { createApp } from '../src/server/app.ts';
import {
  CLIENT_ERROR_RATE_LIMITS,
  LOGIN_GLOBAL_RATE_LIMIT_KEY,
  LOGIN_RATE_LIMIT,
  LOGIN_RATE_LIMIT_GLOBAL,
} from '../src/server/auth/rate-limit.ts';
import { commonDb } from '../src/server/db/index.ts';
import { CLIENT_ERROR_MAX_BODY_BYTES } from '../src/shared/client-error.ts';
import { testEnv } from './operations/world.ts';

const app = createApp();
const clientErrorEnv: Env = Object.assign({}, testEnv, { APP_VERSION: 'worker-sha-376' });
const ORIGIN = new URL(testEnv.PUBLIC_ORIGIN).origin;
const GLOBAL_KEY = 'client-error:global';

const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

// このファイルの中で IP が重ならないよう、192.0.2.0/24 から順に配る（ほかのファイルの 198.51.100.0/24、203.0.113.0/24 とも別）
let ipCount = 0;
const nextIp = () => `192.0.2.${++ipCount}`;

type Report = {
  kind: string;
  name: string;
  message: string;
  location: { file: string; line: number; column: number } | null;
  route: string | null;
  clientVersion: string;
};

function report(overrides: Partial<Report> & Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'error',
    name: 'TypeError',
    message: "Cannot read properties of undefined (reading 'title')",
    location: { file: '/_app/immutable/chunks/abc.js', line: 1, column: 2345 },
    route: '/[slug]/w/[id]/plan',
    clientVersion: 'client-sha-376',
    ...overrides,
  };
}

type SendOptions = {
  ip?: string;
  headers?: Record<string, string | undefined>;
  // 文字列か stream をそのまま本文にする。無ければ body を JSON にする
  rawBody?: string | ReadableStream<Uint8Array>;
  path?: string;
};

async function send(body: unknown, options: SendOptions = {}): Promise<Response> {
  const headers = new Headers();
  const given: Record<string, string | undefined> = {
    Origin: ORIGIN,
    'Content-Type': 'application/json',
    'CF-Connecting-IP': options.ip ?? nextIp(),
    'User-Agent': CHROME_UA,
    ...options.headers,
  };
  for (const [name, value] of Object.entries(given)) if (value !== undefined) headers.set(name, value);
  const raw = options.rawBody ?? JSON.stringify(body);
  return app.request(
    options.path ?? '/api/client-errors',
    { method: 'POST', headers, body: raw, ...(typeof raw === 'string' ? {} : { duplex: 'half' }) } as RequestInit,
    clientErrorEnv,
  );
}

async function errorBodyOf(res: Response): Promise<{ code: string; details?: unknown }> {
  return ((await res.json()) as { error: { code: string; details?: unknown } }).error;
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

let errorLog: MockInstance<typeof console.error>;

// console.error に出した1行を、出した順に返す
function loggedLines(): Record<string, unknown>[] {
  return errorLog.mock.calls.map((call) => JSON.parse(String(call[0])) as Record<string, unknown>);
}

function onlyLine(): Record<string, unknown> {
  const lines = loggedLines();
  expect(lines).toHaveLength(1);
  return lines[0]!;
}

beforeEach(async () => {
  errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
  // 全体の枠はファイルの中のテストで共有なので、テストごとに空から始める
  const db = commonDb(env);
  await db.batch([db.statement((q) => q.deleteFrom('rate_limits').where('key', '=', GLOBAL_KEY))]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('受ける', () => {
  test('ログイン前（Cookie なし）の送信を受けて 204 を返し、決まった項目だけの1行を console.error に出す', async () => {
    const res = await send(report(), { headers: { 'cf-ray': 'ray-376-a' } });
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
    const line = onlyLine();
    expect(line).toEqual({
      level: 'error',
      source: 'client',
      requestId: 'ray-376-a',
      kind: 'error',
      name: 'TypeError',
      message: "Cannot read properties of undefined (reading '…')",
      location: { file: '/_app/immutable/chunks/abc.js', line: 1, column: 2345 },
      route: '/[slug]/w/[id]/plan',
      clientVersion: 'client-sha-376',
      version: 'worker-sha-376',
      browser: { family: 'chrome', major: 141, mobile: false },
    });
  });

  test('Promise の拒否（unhandledrejection）も、場所の無い（location が null の）送信も受ける', async () => {
    const res = await send(report({ kind: 'unhandledrejection', location: null, name: 'Error', message: 'boom' }));
    expect(res.status).toBe(204);
    expect(onlyLine()).toMatchObject({ kind: 'unhandledrejection', location: null, name: 'Error', message: 'boom' });
  });

  test('Content-Type に charset が付いていても受ける', async () => {
    const res = await send(report(), { headers: { 'Content-Type': 'application/json; charset=utf-8' } });
    expect(res.status).toBe(204);
    expect(loggedLines()).toHaveLength(1);
  });

  test.each(['/login', '/invite'])('ログイン前の画面（%s）で起きたエラーも1行残る', async (route) => {
    const res = await send(report({ route }));
    expect(res.status).toBe(204);
    expect(onlyLine()).toMatchObject({ level: 'error', source: 'client', route });
  });

  test('Cookie、URL のクエリ、User-Agent の生の文字列、IP はログに出ない。ログイン中でも誰のエラーかを残さない', async () => {
    const ip = nextIp();
    const res = await send(report(), {
      ip,
      path: '/api/client-errors?token=query-secret-376',
      headers: { Cookie: '__Host-sg_session=cookie-secret-376' },
    });
    expect(res.status).toBe(204);
    const raw = String(errorLog.mock.calls[0]?.[0]);
    expect(raw).not.toContain('query-secret-376');
    expect(raw).not.toContain('cookie-secret-376');
    expect(raw).not.toContain('Windows NT');
    expect(raw).not.toContain('Mozilla');
    expect(raw).not.toContain(ip);
    expect(Object.keys(onlyLine()).sort()).toEqual(
      [
        'browser',
        'clientVersion',
        'kind',
        'level',
        'location',
        'message',
        'name',
        'requestId',
        'route',
        'source',
        'version',
      ].sort(),
    );
  });

  test('cf-ray が無ければ requestId に乱数を振る', async () => {
    expect((await send(report())).status).toBe(204);
    expect(typeof onlyLine().requestId).toBe('string');
    expect(onlyLine().requestId).not.toBe('');
  });
});

describe('ログに出す前に伏せて置き換える', () => {
  test('メッセージの引用符3種の中身と UUID を … にする', async () => {
    const message =
      'Failed "secret-dq" and `secret-bt` and \'secret-sq\' at 0192f0aa-1b2c-7d3e-8f40-123456789abc for C0A80001-ABCD-4EF0-9123-0123456789AB';
    expect((await send(report({ message }))).status).toBe(204);
    const logged = String(onlyLine().message);
    expect(logged).toBe('Failed "…" and `…` and \'…\' at … for …');
  });

  test('伏せた後の先頭200字にする。伏せる前に切らないので、長い引用符の中身も漏れない', async () => {
    const long = 'a'.repeat(300);
    expect((await send(report({ message: long }))).status).toBe(204);
    expect(onlyLine().message).toBe('a'.repeat(200));

    errorLog.mockClear();
    const secret = 'z'.repeat(500);
    const message = `${'b'.repeat(190)}'${secret}'`;
    expect((await send(report({ message }))).status).toBe(204);
    expect(onlyLine().message).toBe(`${'b'.repeat(190)}'…'`);
  });

  test('name は英字40字までに合わなければ Error にする', async () => {
    expect((await send(report({ name: 'Type Error <script>' }))).status).toBe(204);
    expect(onlyLine().name).toBe('Error');
  });

  test('file は同じオリジンの /_app/ の下でなければ external にする', async () => {
    const location = { file: 'https://cdn.example.test/evil.js', line: 3, column: 4 };
    expect((await send(report({ location }))).status).toBe(204);
    expect(onlyLine().location).toEqual({ file: 'external', line: 3, column: 4 });
  });

  test('route は画面の route.id の一覧に無ければ null にする（slug、ID、クエリ、招待の秘密を残さない）', async () => {
    for (const route of [
      '/aoba/w/0192f0aa-1b2c-7d3e-8f40-123456789abc/plan',
      '/invite?token=invite-secret',
      '/unknown',
    ]) {
      errorLog.mockClear();
      expect((await send(report({ route }))).status).toBe(204);
      expect(onlyLine().route).toBeNull();
    }
  });

  test('route が null の送信は null のまま残す', async () => {
    expect((await send(report({ route: null }))).status).toBe(204);
    expect(onlyLine().route).toBeNull();
  });

  test('User-Agent が無ければ browser は other', async () => {
    expect((await send(report(), { headers: { 'User-Agent': undefined } })).status).toBe(204);
    expect(onlyLine().browser).toEqual({ family: 'other', major: null, mobile: false });
  });
});

describe('Origin', () => {
  test.each([
    ['違う', 'https://evil.example.test'],
    ['無い', undefined],
  ])('Origin が%s送信は 403 forbidden で、数えず、ログを出さない', async (_label, origin) => {
    const ip = nextIp();
    const res = await send(report(), { ip, headers: { Origin: origin } });
    expect(res.status).toBe(403);
    expect((await errorBodyOf(res)).code).toBe('forbidden');
    expect(errorLog).not.toHaveBeenCalled();
    // 回数の上限より先に断るので、枠の行を作らない
    expect(await rateLimitRow(`client-error:${ip}`)).toBeUndefined();
  });
});

describe('形の合わない本文', () => {
  const invalid: [string, SendOptions & { body?: unknown }][] = [
    ['Content-Type が JSON でない', { headers: { 'Content-Type': 'text/plain' }, body: report() }],
    ['Content-Type が無い', { headers: { 'Content-Type': undefined }, body: report() }],
    ['JSON として読めない', { rawBody: '{"kind":"error",' }],
    ['未知のキーがある', { body: report({ stack: 'at secret (https://x/y.js:1:2)' }) }],
    [
      'location に未知のキーがある',
      { body: { ...report(), location: { file: '/_app/a.js', line: 1, column: 1, fn: 'x' } } },
    ],
    ['kind が error でも unhandledrejection でもない', { body: report({ kind: 'warning' }) }],
    ['name が空', { body: report({ name: '' }) }],
    ['name が200字を超える', { body: report({ name: 'A'.repeat(201) }) }],
    ['message が1,000字を超える', { body: report({ message: 'm'.repeat(1001) }) }],
    ['file が500字を超える', { body: report({ location: { file: `/_app/${'f'.repeat(500)}`, line: 1, column: 1 } }) }],
    ['line が負', { body: report({ location: { file: '/_app/a.js', line: -1, column: 1 } }) }],
    ['column が整数でない', { body: report({ location: { file: '/_app/a.js', line: 1, column: 1.5 } }) }],
    ['route が200字を超える', { body: report({ route: `/${'r'.repeat(200)}` }) }],
    ['clientVersion が64字を超える', { body: report({ clientVersion: 'v'.repeat(65) }) }],
    ['clientVersion が無い', { body: { ...report(), clientVersion: undefined } }],
    ['配列', { body: [report()] }],
  ];

  test.each(invalid)('%s本文は 400 invalid_input（details なし）で、ログを出さない', async (_label, options) => {
    const res = await send(options.body, options);
    expect(res.status).toBe(400);
    const error = await errorBodyOf(res);
    expect(error.code).toBe('invalid_input');
    expect(error.details).toBeUndefined();
    expect(errorLog).not.toHaveBeenCalled();
  });

  test('形の合わない本文も回数の上限で数える（本文を読む前に数える）', async () => {
    const ip = nextIp();
    expect((await send(report({ kind: 'warning' }), { ip })).status).toBe(400);
    expect((await rateLimitRow(`client-error:${ip}`))?.count).toBe(1);
  });
});

describe('大きさの上限（4KiB）', () => {
  test('Content-Length が 4KiB を超える本文は 413 invalid_input で、ログを出さない', async () => {
    const body = JSON.stringify(report({ message: 'あ'.repeat(1000), name: 'N'.repeat(200) })) + ' '.repeat(1200);
    const bytes = new TextEncoder().encode(body).byteLength;
    expect(bytes).toBeGreaterThan(CLIENT_ERROR_MAX_BODY_BYTES);
    const res = await send(undefined, { rawBody: body, headers: { 'Content-Length': String(bytes) } });
    expect(res.status).toBe(413);
    expect((await errorBodyOf(res)).code).toBe('invalid_input');
    expect(errorLog).not.toHaveBeenCalled();
  });

  test('形に合っていても、バイト数で 4KiB を超えれば 413（文字数でなくバイトで数える）', async () => {
    const body = JSON.stringify(
      report({
        // 制御文字は JSON で \u0001 の6バイトになる。1,000字の上限には収まる
        message: '\u0001'.repeat(1000),
      }),
    );
    expect(new TextEncoder().encode(body).byteLength).toBeGreaterThan(CLIENT_ERROR_MAX_BODY_BYTES);
    const res = await send(undefined, { rawBody: body });
    expect(res.status).toBe(413);
    expect(errorLog).not.toHaveBeenCalled();
  });

  test('Content-Length の無い（chunked の）本文も、読んだ分を数えて 4KiB で止める', async () => {
    const chunk = new Uint8Array(1024).fill(0x20);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < 5; i++) controller.enqueue(chunk);
        controller.close();
      },
    });
    const res = await send(undefined, { rawBody: stream });
    expect(res.status).toBe(413);
    expect((await errorBodyOf(res)).code).toBe('invalid_input');
    expect(errorLog).not.toHaveBeenCalled();
  });

  test('4KiB に収まる本文は、マルチバイトの文字を含んでも受ける', async () => {
    const body = JSON.stringify(report({ message: 'あ'.repeat(1000) }));
    const bytes = new TextEncoder().encode(body).byteLength;
    expect(bytes).toBeLessThanOrEqual(CLIENT_ERROR_MAX_BODY_BYTES);
    expect(bytes).toBeGreaterThan(3000);
    expect((await send(undefined, { rawBody: body })).status).toBe(204);
    expect(loggedLines()).toHaveLength(1);
  });
});

describe('回数の上限', () => {
  test('枠は IP ごとに20、IPv6 の /48 は40、全体は300、窓はどれも10分', () => {
    expect(CLIENT_ERROR_RATE_LIMITS).toEqual({
      network: { max: 20, windowMs: 10 * 60 * 1000 },
      ipv6Site: { max: 40, windowMs: 10 * 60 * 1000 },
      global: { max: 300, windowMs: 10 * 60 * 1000 },
    });
  });

  test('同じ IPv4 から20回までは通り、21回目からは 429 rate_limited で、ログも枠の行も増えない', async () => {
    const ip = nextIp();
    for (let i = 0; i < CLIENT_ERROR_RATE_LIMITS.network.max; i++) {
      expect((await send(report(), { ip })).status).toBe(204);
    }
    expect(loggedLines()).toHaveLength(20);
    for (let i = 0; i < 3; i++) {
      const res = await send(report(), { ip });
      expect(res.status).toBe(429);
      expect((await errorBodyOf(res)).code).toBe('rate_limited');
    }
    expect(loggedLines()).toHaveLength(20);
    // 上限に届いた枠は覗いて断り、数えない
    expect((await rateLimitRow(`client-error:${ip}`))?.count).toBe(20);
    // IP の枠に断られた呼び出しは、全体の枠を減らさない
    expect((await rateLimitRow(GLOBAL_KEY))?.count).toBe(20);
  });

  test('別の IP は別に数える', async () => {
    const limited = nextIp();
    await setRateLimit(`client-error:${limited}`, CLIENT_ERROR_RATE_LIMITS.network.max, new Date());
    expect((await send(report(), { ip: limited })).status).toBe(429);
    expect((await send(report(), { ip: nextIp() })).status).toBe(204);
  });

  test('上限に届いた後の送信は、本文が大きすぎても形が合わなくても 429（本文を読む前に断る）', async () => {
    const ip = nextIp();
    await setRateLimit(`client-error:${ip}`, CLIENT_ERROR_RATE_LIMITS.network.max, new Date());
    expect((await send(undefined, { ip, rawBody: 'x'.repeat(8000) })).status).toBe(429);
    expect((await send(report({ kind: 'warning' }), { ip })).status).toBe(429);
    expect(errorLog).not.toHaveBeenCalled();
  });

  test('IPv6 は /64 で数える。/64 の中でアドレスを変えても同じ枠', async () => {
    const res = await send(report(), { ip: '2001:db8:c1:1::1' });
    expect(res.status).toBe(204);
    expect((await rateLimitRow('client-error:2001:db8:c1:1::/64'))?.count).toBe(1);
    expect((await rateLimitRow('client-error48:2001:db8:c1::/48'))?.count).toBe(1);

    await setRateLimit('client-error:2001:db8:c1:1::/64', CLIENT_ERROR_RATE_LIMITS.network.max, new Date());
    expect((await send(report(), { ip: '2001:db8:c1:1::ffff' })).status).toBe(429);
    // 同じ /48 でも別の /64 は通る
    expect((await send(report(), { ip: '2001:db8:c1:2::1' })).status).toBe(204);
  });

  test('IPv6 の /48 は40回まで。/64 を変えても /48 の上限で断り、/64 の行を作らない', async () => {
    await setRateLimit('client-error48:2001:db8:c2::/48', CLIENT_ERROR_RATE_LIMITS.ipv6Site.max - 1, new Date());
    expect((await send(report(), { ip: '2001:db8:c2:1::1' })).status).toBe(204);
    expect((await rateLimitRow('client-error48:2001:db8:c2::/48'))?.count).toBe(40);
    const res = await send(report(), { ip: '2001:db8:c2:2::1' });
    expect(res.status).toBe(429);
    expect((await errorBodyOf(res)).code).toBe('rate_limited');
    expect(await rateLimitRow('client-error:2001:db8:c2:2::/64')).toBeUndefined();
    expect((await rateLimitRow('client-error48:2001:db8:c2::/48'))?.count).toBe(40);
    expect(loggedLines()).toHaveLength(1);
  });

  test('全体の枠は300回まで。上限に届いたら別の IP からも断り、IP の行も全体の行も書かない', async () => {
    await setRateLimit(GLOBAL_KEY, CLIENT_ERROR_RATE_LIMITS.global.max - 1, new Date());
    expect((await send(report(), { ip: nextIp() })).status).toBe(204);
    expect((await rateLimitRow(GLOBAL_KEY))?.count).toBe(300);

    const ip = nextIp();
    const res = await send(report(), { ip });
    expect(res.status).toBe(429);
    expect((await errorBodyOf(res)).code).toBe('rate_limited');
    expect(await rateLimitRow(`client-error:${ip}`)).toBeUndefined();
    expect((await rateLimitRow(GLOBAL_KEY))?.count).toBe(300);
    expect(loggedLines()).toHaveLength(1);
  });

  test('窓（10分）を過ぎた枠は数え直し、通る', async () => {
    const ip = nextIp();
    const past = new Date(Date.now() - CLIENT_ERROR_RATE_LIMITS.network.windowMs - 1000);
    await setRateLimit(`client-error:${ip}`, CLIENT_ERROR_RATE_LIMITS.network.max, past);
    await setRateLimit(GLOBAL_KEY, CLIENT_ERROR_RATE_LIMITS.global.max, past);
    expect((await send(report(), { ip })).status).toBe(204);
    expect((await rateLimitRow(`client-error:${ip}`))?.count).toBe(1);
    expect((await rateLimitRow(GLOBAL_KEY))?.count).toBe(1);
  });

  test('窓の中なら、10分の手前の枠はまだ断る', async () => {
    const ip = nextIp();
    const recent = new Date(Date.now() - CLIENT_ERROR_RATE_LIMITS.network.windowMs + 60 * 1000);
    await setRateLimit(`client-error:${ip}`, CLIENT_ERROR_RATE_LIMITS.network.max, recent);
    expect((await send(report(), { ip })).status).toBe(429);
  });

  test('ログインの枠とは別に数える。ログインの枠を使い切っても通り、ログインの行を書き換えない', async () => {
    const ip = nextIp();
    const now = new Date();
    await setRateLimit(`login:${ip}`, LOGIN_RATE_LIMIT.max, now);
    // ログインの全体の枠も使い切った状態にする（client-errors の全体の枠とは別）
    await setRateLimit(LOGIN_GLOBAL_RATE_LIMIT_KEY, LOGIN_RATE_LIMIT_GLOBAL.max, now);
    try {
      expect((await send(report(), { ip })).status).toBe(204);
      expect((await rateLimitRow(`login:${ip}`))?.count).toBe(LOGIN_RATE_LIMIT.max);
      expect((await rateLimitRow(LOGIN_GLOBAL_RATE_LIMIT_KEY))?.count).toBe(LOGIN_RATE_LIMIT_GLOBAL.max);
      expect((await rateLimitRow(`client-error:${ip}`))?.count).toBe(1);
      expect((await rateLimitRow(GLOBAL_KEY))?.count).toBe(1);
    } finally {
      const db = commonDb(env);
      await db.batch([db.statement((q) => q.deleteFrom('rate_limits').where('key', '=', LOGIN_GLOBAL_RATE_LIMIT_KEY))]);
    }
  });

  test('client-errors の枠を使い切っても、ログインの枠は減らない', async () => {
    const ip = nextIp();
    await setRateLimit(`client-error:${ip}`, CLIENT_ERROR_RATE_LIMITS.network.max, new Date());
    expect((await send(report(), { ip })).status).toBe(429);
    expect(await rateLimitRow(`login:${ip}`)).toBeUndefined();
  });
});

describe('画面の版（clientVersion）', () => {
  // 画面の版は build のコミットの SHA（e2e は `<SHA>-e2e-<時刻>`、手元は dev）。形の合わない値は、誰でも送れる文字列なので出さない
  test.each(['client-sha-376', 'dev', '0123456789abcdef0123456789abcdef01234567-e2e-mvr3jlgh', 'v'.repeat(64)])(
    '英数字と . _ - の64字まで（%s）はそのまま出す',
    async (clientVersion) => {
      expect((await send(report({ clientVersion }))).status).toBe(204);
      expect(onlyLine().clientVersion).toBe(clientVersion);
    },
  );

  test.each(['secret token-376', 'a/b', '<script>', 'バージョン', 'user@example.test'])(
    '形の合わない値（%s）は invalid にする',
    async (clientVersion) => {
      expect((await send(report({ clientVersion }))).status).toBe(204);
      expect(onlyLine().clientVersion).toBe('invalid');
    },
  );
});
