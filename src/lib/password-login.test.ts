// ログインの画面のパスワードの送信（src/lib/password-login.ts）。応答から、移る先か出す文言を決める
import { describe, expect, test, vi } from 'vitest';
import { PASSWORD_LOGIN_PATH, passwordLoginErrorMessage, submitPasswordLogin } from './password-login.ts';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const INPUT = { email: 'tsumugi@example.test', password: 'tsubame-hoshi-2026', returnTo: '/aoba' };

describe('送り方', () => {
  test('同じオリジンの口へ、JSON で email、password、return_to を送る', async () => {
    const fetcher = vi.fn(async () => jsonResponse(200, { return_to: '/aoba' }));
    await submitPasswordLogin(INPUT, fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [path, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe(PASSWORD_LOGIN_PATH);
    expect(init.method).toBe('POST');
    expect(new Headers(init.headers).get('Content-Type')).toBe('application/json');
    expect(JSON.parse(init.body as string)).toEqual({
      email: INPUT.email,
      password: INPUT.password,
      return_to: '/aoba',
    });
  });
});

describe('成功', () => {
  test('応答の return_to へ移る', async () => {
    expect(await submitPasswordLogin(INPUT, async () => jsonResponse(200, { return_to: '/aoba/board' }))).toEqual({
      ok: true,
      returnTo: '/aoba/board',
    });
  });

  test('応答の return_to が自分のサイトのパスでなければ / へ移る', async () => {
    expect(await submitPasswordLogin(INPUT, async () => jsonResponse(200, { return_to: '//evil.example' }))).toEqual({
      ok: true,
      returnTo: '/',
    });
  });

  test('200 でも JSON でなければ unavailable', async () => {
    const res = new Response('<!doctype html>', { status: 200 });
    expect(await submitPasswordLogin(INPUT, async () => res)).toEqual({ ok: false, message: 'loginErrorUnavailable' });
  });
});

describe('失敗の文言', () => {
  test.each([
    [401, { code: 'invalid_credentials', message: 'x' }, 'loginErrorInvalidCredentials'],
    [403, { code: 'forbidden', message: 'x', details: { reason: 'denied' } }, 'loginErrorDeniedPassword'],
    [403, { code: 'forbidden', message: 'x', details: { reason: 'suspended' } }, 'loginErrorSuspended'],
    [403, { code: 'forbidden', message: 'x' }, 'loginErrorUnavailable'],
    [429, { code: 'rate_limited', message: 'x' }, 'loginErrorTooMany'],
    [400, { code: 'invalid_input', message: 'x' }, 'loginErrorUnavailable'],
    [500, { code: 'internal', message: 'x' }, 'loginErrorUnavailable'],
    [503, { code: 'unavailable', message: 'x' }, 'loginErrorUnavailable'],
  ] as const)('%i %o は %s', async (status, error, expected) => {
    expect(passwordLoginErrorMessage(status, error)).toBe(expected);
    expect(await submitPasswordLogin(INPUT, async () => jsonResponse(status, { error }))).toEqual({
      ok: false,
      message: expected,
    });
  });

  test('通信が切れたら unavailable', async () => {
    const fetcher = async () => {
      throw new TypeError('Failed to fetch');
    };
    expect(await submitPasswordLogin(INPUT, fetcher)).toEqual({ ok: false, message: 'loginErrorUnavailable' });
  });
});
