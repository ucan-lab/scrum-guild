// 画面のエラーを受ける口（POST /api/client-errors、Issue #376）を崩しにいくテストの2周目。
// client-errors.test.ts、client-errors-format.test.ts、client-errors-break.test.ts が確かめていない手口だけを置く
import { env } from 'cloudflare:workers';
import { describe, expect, test, vi } from 'vitest';
import { createApp } from '../src/server/app.ts';
import { CLIENT_ERROR_RATE_LIMITS, consumeClientErrorRateLimits } from '../src/server/auth/rate-limit.ts';
import { browserOf } from '../src/server/client-errors.ts';
import { commonDb } from '../src/server/db/index.ts';
import { cleanupExpired } from '../src/server/scheduled/cleanup-expired.ts';
import { testEnv } from './operations/world.ts';

const app = createApp();
const ORIGIN = new URL(testEnv.PUBLIC_ORIGIN).origin;

// ほかのファイル（192.0.2.0/24、198.51.100.0/24、203.0.113.0/24、2001:db8:376b::/48）と重ならない /48 から配る
let ipCount = 0;
const nextIp = () => `2001:db8:376c:${(++ipCount).toString(16)}::1`;

function report(name: string, message: string): Record<string, unknown> {
  return {
    kind: 'unhandledrejection',
    name,
    message,
    location: { file: '/_app/immutable/chunks/abc.js', line: 1, column: 2 },
    route: '/[slug]/w/[id]/plan',
    clientVersion: 'client-sha-376',
  };
}

// ip が null なら CF-Connecting-IP を付けない（手元の開発と同じ、IP の無いリクエスト）
async function send(body: unknown, ip: string | null = nextIp()): Promise<Response> {
  const headers: Record<string, string> = { Origin: ORIGIN, 'Content-Type': 'application/json' };
  if (ip !== null) headers['CF-Connecting-IP'] = ip;
  return app.request('/api/client-errors', { method: 'POST', headers, body: JSON.stringify(body) }, testEnv);
}

// 1件送り、console.error に出た1行の message を返す
async function loggedMessageOf(name: string, message: string): Promise<string> {
  const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    expect((await send(report(name, message))).status).toBe(204);
    expect(errorLog).toHaveBeenCalledTimes(1);
    return (JSON.parse(String(errorLog.mock.calls[0]?.[0])) as { message: string }).message;
  } finally {
    errorLog.mockRestore();
  }
}

// 根拠: 受け入れ条件「1行に…URL のクエリ…トークンが入らない」。ブラウザは、URL を解釈できなかったときや、資格情報の入った URL を
// fetch したときに、その URL を引用符で囲まずに message へ入れる。伏せ方は引用符の範囲と UUID だけなので、引用符の外にある
// URL のクエリ（token=…）と、URL の資格情報（user:pass@）がそのままログに出る
describe('引用符の外にある URL のクエリと資格情報', () => {
  test.each([
    [
      // Firefox（Gecko）の new URL の失敗。入力をそのまま message に入れる
      'Firefox の new URL',
      'TypeError',
      'URL constructor: https://exa mple.test/cb?token=tok-secret-376 is not a valid URL.',
      'tok-secret-376',
    ],
    [
      // Chrome（Blink）の fetch の失敗。'fetch' と 'Window' は引用符の中だが、URL はその後ろ（最後の ' の外）に出る
      'Chrome の fetch（URL を解釈できない）',
      'TypeError',
      "Failed to execute 'fetch' on 'Window': Failed to parse URL from https://exa mple.test/cb?token=tok-secret-376",
      'tok-secret-376',
    ],
    [
      'Chrome の fetch（資格情報の入った URL）',
      'TypeError',
      "Failed to execute 'fetch' on 'Window': Request cannot be constructed from a URL that includes credentials: https://user:pass-secret-376@example.test/",
      'pass-secret-376',
    ],
    [
      'Firefox の fetch（資格情報の入った URL）',
      'TypeError',
      'Window.fetch: https://user:pass-secret-376@example.test/ is an url with embedded credentials.',
      'pass-secret-376',
    ],
  ])('%s の message から、クエリと資格情報がログに出ない', async (_label, name, message, secret) => {
    expect(await loggedMessageOf(name, message)).not.toContain(secret);
  });
});

// 根拠: 受け入れ条件「1行に本文、入力の値…が入らない」。V8 の RegExp は、作れなかった正規表現の元の文字列を /…/ で囲んで
// message に入れる（Firefox と Safari は入れない）。入力から正規表現を作ったときの失敗で、入力の値が引用符の外に出て、ログに残る。
// 今の画面に入力から正規表現を作るコードは無いが、サーバーは画面を信じない（Issue の「メッセージ」）ので、届いた message で確かめる
describe('引用符でない区切りで囲まれた入力の値', () => {
  test('V8 の RegExp の失敗（/入力/ を message に含める）で、入力の値がログに出ない', async () => {
    // 入力として届いた値（検索の欄などに打たれた文字列）
    const input: string = ['input-secret-376', '('].join('');
    let message = '';
    try {
      new RegExp(input);
    } catch (err) {
      message = (err as Error).message;
    }
    // 前提: ランタイムの message が入力を含む（Invalid regular expression: /input-secret-376(/: Unterminated group）
    expect(message).toContain('input-secret-376');
    expect(await loggedMessageOf('SyntaxError', message)).not.toContain('input-secret-376');
  });
});

describe('browserOf が、それぞれの種類にまとめると決めた UA', () => {
  test.each([
    [
      'Chrome の iOS 版（CriOS）',
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0.7390.96 Mobile/15E148 Safari/604.1',
      { family: 'chrome', major: 141, mobile: true },
    ],
    [
      'Firefox の iOS 版（FxiOS）',
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/144.0 Mobile/15E148 Safari/605.1.15',
      { family: 'firefox', major: 144, mobile: true },
    ],
    [
      'Edge の iOS 版（EdgiOS。Version/ と Safari/ を含み、Safari にも当たりうる）',
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 EdgiOS/141.3537.57 Mobile/15E148 Safari/605.1.15',
      { family: 'edge', major: 141, mobile: true },
    ],
    [
      'Edge の Android 版（EdgA。Chrome/ を含み、Chrome にも当たりうる）',
      'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36 EdgA/141.0.3537.57',
      { family: 'edge', major: 141, mobile: true },
    ],
    [
      '旧 Edge（Edge/）',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/70.0.3538.102 Safari/537.36 Edge/18.19045',
      { family: 'edge', major: 18, mobile: false },
    ],
  ])('%s', (_label, userAgent, expected) => {
    expect(browserOf(userAgent)).toEqual(expected);
  });
});

describe('回数の上限の枠', () => {
  async function rateLimitRow(key: string) {
    const db = commonDb(env);
    return db.first(db.statement((q) => q.selectFrom('rate_limits').selectAll().where('key', '=', key)));
  }

  test('IP の無い送信は client-error:unknown で数え、ログインの login:unknown は書かない', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      for (let i = 0; i < CLIENT_ERROR_RATE_LIMITS.network.max; i++) {
        expect((await send(report('TypeError', 'boom'), null)).status).toBe(204);
      }
      expect((await send(report('TypeError', 'boom'), null)).status).toBe(429);
      expect(errorLog).toHaveBeenCalledTimes(CLIENT_ERROR_RATE_LIMITS.network.max);
      expect((await rateLimitRow('client-error:unknown'))?.count).toBe(CLIENT_ERROR_RATE_LIMITS.network.max);
      expect(await rateLimitRow('login:unknown')).toBeUndefined();
    } finally {
      errorLog.mockRestore();
    }
  });

  // 掃除（cleanup-expired）が、窓（10分）の途中の client-error の行を消すと、上限に届いた IP が窓の途中から数え直せる
  test('掃除は、窓の途中の client-error の行を消さない。上限に届いた IP は掃除の後も窓の終わりまで断る', async () => {
    // 送信のテストが使う /48（2001:db8:376c::/48）の枠と重ならない IPv4
    const ip = '198.18.37.6';
    const start = new Date('2026-10-27T03:00:00.000Z');
    for (let i = 0; i < CLIENT_ERROR_RATE_LIMITS.network.max; i++) {
      expect(await consumeClientErrorRateLimits(env, ip, start)).toBe(true);
    }
    const almostEnd = new Date(start.getTime() + CLIENT_ERROR_RATE_LIMITS.network.windowMs - 1000);
    await cleanupExpired(env, almostEnd);
    expect(await consumeClientErrorRateLimits(env, ip, almostEnd)).toBe(false);
  });
});
