import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { loggedOutPath, logoutOutcome, type LogoutResult } from '../src/lib/logout.ts';

const failed = (status: number, code: string | null): LogoutResult => ({
  ok: false,
  status,
  error: code === null ? null : { code },
});

describe('ログアウトの結果の振り分け', () => {
  test('成功は移る', () => {
    assert.equal(logoutOutcome({ ok: true }), 'leave');
  });

  test('401 の unauthenticated（もうセッションが無い）は、成功と同じく移る', () => {
    assert.equal(logoutOutcome(failed(401, 'unauthenticated')), 'leave');
  });

  test('通信の失敗（status 0）は留まる', () => {
    assert.equal(logoutOutcome(failed(0, null)), 'stay');
  });

  test('5xx は留まる', () => {
    for (const status of [500, 502, 503]) {
      assert.equal(logoutOutcome(failed(status, 'internal')), 'stay', String(status));
      assert.equal(logoutOutcome(failed(status, null)), 'stay', `${status}（本文が JSON でない）`);
    }
  });

  test('401 でも code が違うか本文が無いものは留まる', () => {
    assert.equal(logoutOutcome(failed(401, 'forbidden')), 'stay');
    assert.equal(logoutOutcome(failed(401, null)), 'stay');
  });

  test('そのほかの 4xx は留まる（unauthenticated の code でも 401 でなければ）', () => {
    for (const [status, code] of [
      [400, 'invalid_input'],
      [403, 'forbidden'],
      [404, 'not_found'],
      [429, 'rate_limited'],
      [403, 'unauthenticated'],
    ] as const) {
      assert.equal(logoutOutcome(failed(status, code)), 'stay', `${status} ${code}`);
    }
  });

  test('移り先は return_to を付けないログアウト後の表示', () => {
    assert.equal(loggedOutPath, '/login?logged_out=1');
  });
});
