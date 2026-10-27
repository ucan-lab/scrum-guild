// 画面のエラーを受ける口（POST /api/client-errors、Issue #376）を崩しにいくテスト。
// client-errors.test.ts と client-errors-format.test.ts が確かめていない手口だけを置く
import { describe, expect, test, vi } from 'vitest';
import { createApp } from '../src/server/app.ts';
import { CLIENT_ERROR_RATE_LIMITS } from '../src/server/auth/rate-limit.ts';
import { maskClientErrorMessage } from '../src/server/client-errors.ts';
import {
  CLIENT_ERROR_LOGGED_MESSAGE_LENGTH,
  CLIENT_ERROR_MAX_BODY_BYTES,
  CLIENT_ERROR_SENT_MESSAGE_LENGTH,
} from '../src/shared/client-error.ts';
import { testEnv } from './operations/world.ts';

const app = createApp();
const ORIGIN = new URL(testEnv.PUBLIC_ORIGIN).origin;

// ほかのファイル（192.0.2.0/24、198.51.100.0/24、203.0.113.0/24）と重ならないよう、IPv6 の文書用の範囲の別の /48 から配る
let ipCount = 0;
const nextIp = () => `2001:db8:376b:${(++ipCount).toString(16)}::1`;

function report(message: string): Record<string, unknown> {
  return {
    kind: 'error',
    name: 'SyntaxError',
    message,
    location: { file: '/_app/immutable/chunks/abc.js', line: 1, column: 2 },
    route: '/login',
    clientVersion: 'client-sha-376',
  };
}

async function send(rawBody: string, ip: string = nextIp()): Promise<Response> {
  return app.request(
    '/api/client-errors',
    {
      method: 'POST',
      headers: { Origin: ORIGIN, 'Content-Type': 'application/json', 'CF-Connecting-IP': ip },
      body: rawBody,
    },
    testEnv,
  );
}

// 1件送り、console.error に出た文字列を返す
async function logOf(message: string): Promise<string> {
  const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    expect((await send(JSON.stringify(report(message)))).status).toBe(204);
    expect(errorLog).toHaveBeenCalledTimes(1);
    return String(errorLog.mock.calls[0]?.[0]);
  } finally {
    errorLog.mockRestore();
  }
}

describe('メッセージの引用符の中身が伏せられずに残る手口', () => {
  // 根拠: 受け入れ条件「1行に本文、入力の値…が入らない」「メッセージの引用符の中…は伏せられる」。
  // V8 の JSON.parse は、読めなかった本文を "…" で囲んで message に入れる（src/server/app.ts の onError の注記も同じことを書く）。
  // 本文の中の " が囲みの " と組になり、本文の値（ここでは pw376）が引用符の外に出て、ログに残る
  test('JSON.parse の失敗（V8 は読めなかった本文を message に含める）で、本文の値がログに出ない', async () => {
    let message = '';
    try {
      JSON.parse('x{"p":"pw376"}');
    } catch (err) {
      message = (err as Error).message;
    }
    // 前提: ランタイムの message が本文を含む（Unexpected token 'x', "x{"p":"pw376"}" is not valid JSON）
    expect(message).toContain('pw376');
    expect(await logOf(message)).not.toContain('pw376');
  });

  // 根拠: 受け入れ条件「メッセージの引用符の中…は伏せられる」。英語の短縮形の ' が、後ろの '…' の開きの ' と組になり、
  // 引用符の中の値が外に出る（Firefox の "can't …" のように、ブラウザのメッセージにも短縮形が入る）
  test("短縮形の ' の後ろにある '…' の中身も伏せる", () => {
    const masked = maskClientErrorMessage("can't save 'secret-title-376' to the server");
    expect(masked).not.toContain('secret-title-376');
  });

  // 根拠: Issue の「着手前に詰めたこと」の「メッセージ」は、画面が 1,000 字に切って送り、サーバーが引用符の中身を伏せると決めた。
  // 画面の切り口が引用符の中にあると、サーバーには閉じていない引用符として届き、元は引用符の中だった値がログに出る
  // （受け入れ条件「メッセージの引用符の中…は伏せられる」に反する）。画面の切り方（slice）は src/lib/client-error-report.ts と同じ
  test('画面が 1,000 字で切ったために閉じなくなった引用符の中身も、ログに出ない', async () => {
    const original = `${'b'.repeat(150)}'${'secret'.repeat(200)}'`;
    const sent = original.slice(0, CLIENT_ERROR_SENT_MESSAGE_LENGTH);
    expect(await logOf(sent)).not.toContain('secret');
  });
});

describe('200字の切り口', () => {
  test('切り口でサロゲートペアを割らない（上位だけを残さない）', () => {
    const masked = maskClientErrorMessage(`${'a'.repeat(CLIENT_ERROR_LOGGED_MESSAGE_LENGTH - 1)}😀tail`);
    expect(masked).toBe('a'.repeat(CLIENT_ERROR_LOGGED_MESSAGE_LENGTH - 1));
    expect(maskClientErrorMessage(`${'a'.repeat(CLIENT_ERROR_LOGGED_MESSAGE_LENGTH - 2)}😀tail`)).toBe(
      `${'a'.repeat(CLIENT_ERROR_LOGGED_MESSAGE_LENGTH - 2)}😀`,
    );
  });
});

describe('大きさの上限の境目', () => {
  // 本文の末尾を空白で埋め、ちょうど n バイトにする
  const bodyOf = (bytes: number) => {
    const json = JSON.stringify(report('boom'));
    return json + ' '.repeat(bytes - new TextEncoder().encode(json).byteLength);
  };

  test('ちょうど 4KiB は受け、1バイト超えれば 413', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect((await send(bodyOf(CLIENT_ERROR_MAX_BODY_BYTES))).status).toBe(204);
      expect((await send(bodyOf(CLIENT_ERROR_MAX_BODY_BYTES + 1))).status).toBe(413);
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
          send(JSON.stringify(report('boom')), ip),
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
