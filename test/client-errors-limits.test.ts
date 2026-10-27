// 画面のエラーを受ける口（POST /api/client-errors、Issue #376）の大きさと回数の上限の境目。
// 上限そのものの振る舞いは client-errors.test.ts
import { env } from 'cloudflare:workers';
import { describe, expect, test, vi } from 'vitest';
import { createApp } from '../src/server/app.ts';
import { CLIENT_ERROR_RATE_LIMITS, consumeClientErrorRateLimits } from '../src/server/auth/rate-limit.ts';
import { commonDb } from '../src/server/db/index.ts';
import { cleanupExpired } from '../src/server/scheduled/cleanup-expired.ts';
import { CLIENT_ERROR_MAX_BODY_BYTES } from '../src/shared/client-error.ts';
import { testEnv } from './operations/world.ts';

const app = createApp();
const ORIGIN = new URL(testEnv.PUBLIC_ORIGIN).origin;

// ほかのファイル（192.0.2.0/24、198.51.100.0/24、203.0.113.0/24、2001:db8:376d::/48）と重ならない /48 から配る
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
  return sendRaw(JSON.stringify(body), ip);
}

// 文字列をそのまま本文にして送る
async function sendRaw(rawBody: string, ip: string | null = nextIp()): Promise<Response> {
  const headers: Record<string, string> = { Origin: ORIGIN, 'Content-Type': 'application/json' };
  if (ip !== null) headers['CF-Connecting-IP'] = ip;
  return app.request('/api/client-errors', { method: 'POST', headers, body: rawBody }, testEnv);
}

describe('大きさの上限の境目', () => {
  // 本文の末尾を空白で埋め、ちょうど n バイトにする
  const bodyOf = (bytes: number) => {
    const json = JSON.stringify(report('SyntaxError', 'boom'));
    return json + ' '.repeat(bytes - new TextEncoder().encode(json).byteLength);
  };

  test('ちょうど 4KiB は受け、1バイト超えれば 413', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect((await sendRaw(bodyOf(CLIENT_ERROR_MAX_BODY_BYTES))).status).toBe(204);
      expect((await sendRaw(bodyOf(CLIENT_ERROR_MAX_BODY_BYTES + 1))).status).toBe(413);
      expect(errorLog).toHaveBeenCalledTimes(1);
    } finally {
      errorLog.mockRestore();
    }
  });
});

describe('並行した呼び出し', () => {
  test('同じ IP から並べて送っても、通ってログに出るのは IP の上限（20）まで', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const ip = nextIp();
      const responses = await Promise.all(
        Array.from({ length: CLIENT_ERROR_RATE_LIMITS.network.max + 10 }, () =>
          send(report('SyntaxError', 'boom'), ip),
        ),
      );
      const accepted = responses.filter((res) => res.status === 204).length;
      expect(accepted).toBeLessThanOrEqual(CLIENT_ERROR_RATE_LIMITS.network.max);
      expect(responses.every((res) => res.status === 204 || res.status === 429)).toBe(true);
      expect(errorLog).toHaveBeenCalledTimes(accepted);
    } finally {
      errorLog.mockRestore();
    }
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
