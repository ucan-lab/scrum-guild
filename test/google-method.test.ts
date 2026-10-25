// Google の手段（src/server/auth/google.ts の createGoogleLoginMethod）の単体テスト。ルートや DB を通さず、手段だけを呼ぶ
import { describe, expect, test } from 'vitest';
import { createGoogleLoginMethod, googleCredentials } from '../src/server/auth/google.ts';
import { LoginMethodError } from '../src/server/auth/login-method.ts';
import { FAKE_GOOGLE_CLIENT_ID, FAKE_GOOGLE_CLIENT_SECRET, GOOGLE_TOKEN_URL, unsignedJwt } from './auth/fake-google.ts';

const credentials = { clientId: FAKE_GOOGLE_CLIENT_ID, clientSecret: FAKE_GOOGLE_CLIENT_SECRET };
const request = { state: 's', codeChallenge: 'c', redirectUri: 'https://example.test/cb' };

describe('authorizeUrl', () => {
  const method = createGoogleLoginMethod(credentials, fetch);

  test('nonce を認可の URL に付ける', () => {
    const url = new URL(method.authorizeUrl({ ...request, nonce: 'n'.repeat(43) }));
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('nonce')).toBe('n'.repeat(43));
  });

  test.each([null, ''])('nonce が %j なら、固定の文で unavailable を投げる', (nonce) => {
    let error: unknown;
    try {
      method.authorizeUrl({ ...request, nonce });
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(LoginMethodError);
    expect((error as LoginMethodError).failure).toBe('unavailable');
    expect((error as LoginMethodError).message).toContain('nonce');
  });
});

describe('通信', () => {
  // Workers の fetch は redirect に follow と manual しか受け付けず、error は TypeError になる。
  // 渡した設定で Request を作り、Workers の実行環境が受け付けることまで確かめる
  test('トークンのエンドポイントへの通信は、リダイレクトを追わず、3xx を unavailable にする', async () => {
    const seen: Request[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      seen.push(new Request(input, init));
      // 3xx の本文に有効な形の id_token があっても、成功として読まない
      const idToken = unsignedJwt({ iss: 'https://accounts.google.com', aud: FAKE_GOOGLE_CLIENT_ID });
      return new Response(JSON.stringify({ id_token: idToken }), {
        status: 302,
        headers: { Location: 'https://evil.example/token', 'Content-Type': 'application/json' },
      });
    };
    const method = createGoogleLoginMethod(credentials, fetcher);
    const error = await method
      .verify({ code: '4/x', codeVerifier: 'v', redirectUri: 'https://example.test/cb', nonce: 'n' })
      .catch((err: unknown) => err);
    expect(seen.map((entry) => entry.url)).toEqual([GOOGLE_TOKEN_URL]);
    expect(seen[0]?.redirect).toBe('manual');
    expect(error).toBeInstanceOf(LoginMethodError);
    expect((error as LoginMethodError).failure).toBe('unavailable');
    // `!res.ok` の分岐の固定の文（status を含む）。本文の id_token には進まない
    expect((error as LoginMethodError).message).toBe('Google のトークンのエンドポイントが 302 を返した');
  });

  test('fetch が投げたときは、名前だけを残した unavailable にする', async () => {
    // fetcher の中の expect は send() の catch に握りつぶされるので、URL は控えて await の後で確かめる
    const seen: string[] = [];
    const fetcher: typeof fetch = async (input) => {
      seen.push(String(input));
      throw new TypeError('network connection lost: https://evil.example/secret');
    };
    const method = createGoogleLoginMethod(credentials, fetcher);
    const error = await method
      .verify({ code: '4/x', codeVerifier: 'v', redirectUri: 'https://example.test/cb', nonce: 'n' })
      .catch((err: unknown) => err);
    expect(seen).toEqual([GOOGLE_TOKEN_URL]);
    expect(error).toBeInstanceOf(LoginMethodError);
    expect((error as LoginMethodError).failure).toBe('unavailable');
    expect((error as LoginMethodError).message).not.toContain('evil.example');
  });
});

describe('googleCredentials', () => {
  test('ID と秘密がそろっているときだけ返す', () => {
    expect(googleCredentials({ GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'secret' })).toEqual({
      clientId: 'id',
      clientSecret: 'secret',
    });
    expect(googleCredentials({ GOOGLE_CLIENT_ID: 'id' })).toBeUndefined();
    expect(googleCredentials({ GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: 'secret' })).toBeUndefined();
    expect(googleCredentials({})).toBeUndefined();
  });
});
