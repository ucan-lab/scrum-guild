// GitHub の手段（src/server/auth/github.ts の createGithubLoginMethod）の通信の単体テスト。ルートや DB を通さず、手段だけを呼ぶ。
// Workers の fetch は redirect に follow と manual しか受け付けず、error は TypeError になる。fetcher の中で
// 渡された設定から Request を作り、Workers の実行環境が受け付けることと、リダイレクトを追わないことを確かめる。
// 3xx は res.ok が偽なので失敗になる（特に resolveInvitee の 302 を not_found にしない）
import { describe, expect, test } from 'vitest';
import { createGithubLoginMethod } from '../src/server/auth/github.ts';
import { LoginMethodError } from '../src/server/auth/login-method.ts';
import { FAKE_CLIENT_ID, FAKE_CLIENT_SECRET, quietGithubOptions } from './auth/fake-github.ts';

const credentials = { clientId: FAKE_CLIENT_ID, clientSecret: FAKE_CLIENT_SECRET };
const verification = { code: 'c', codeVerifier: 'v', redirectUri: 'https://example.test/cb', nonce: null };

const TOKEN_URL = 'https://github.com/login/oauth/access_token';
const USER_URL = 'https://api.github.com/user';
const USER_LOOKUP_URL = 'https://api.github.com/users/octo-cat';

const redirect = () =>
  new Response(JSON.stringify({ access_token: 'gho_should_not_be_read' }), {
    status: 302,
    headers: { Location: 'https://evil.example/next', 'Content-Type': 'application/json' },
  });
const tokenOk = () => new Response(JSON.stringify({ access_token: 'gho_fake' }), { status: 200 });

// 受け取った設定の Request を控える。応答は URL ごとに決める
function recordingFetcher(respond: (url: string) => Response) {
  const seen: Request[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    seen.push(request);
    return respond(request.url);
  };
  return { seen, fetcher };
}

async function failureOf(run: () => Promise<unknown>): Promise<unknown> {
  return run().then(
    (value) => value,
    (err: unknown) => err,
  );
}

describe('リダイレクトを追わない', () => {
  test('トークンの交換（verify）の 302 は unavailable', async () => {
    const { seen, fetcher } = recordingFetcher(redirect);
    const method = createGithubLoginMethod(credentials, fetcher, quietGithubOptions);
    const error = await failureOf(() => method.verify(verification));
    expect(seen.map((request) => request.url)).toEqual([TOKEN_URL]);
    expect(seen.every((request) => request.redirect === 'manual')).toBe(true);
    expect(error).toBeInstanceOf(LoginMethodError);
    expect((error as LoginMethodError).failure).toBe('unavailable');
    expect((error as LoginMethodError).message).toBe('GitHub のトークンのエンドポイントが 302 を返した');
  });

  test('ユーザーの API（verify の fetchProfile）の 302 は unavailable', async () => {
    const background: Promise<unknown>[] = [];
    const { seen, fetcher } = recordingFetcher((url) => (url === TOKEN_URL ? tokenOk() : redirect()));
    const method = createGithubLoginMethod(credentials, fetcher, {
      background: (work) => void background.push(work),
      warn: () => {},
    });
    const error = await failureOf(() => method.verify(verification));
    await Promise.all(background);
    // 取り消しの通信（DELETE）も同じ設定
    expect(seen.map((request) => request.url).slice(0, 2)).toEqual([TOKEN_URL, USER_URL]);
    expect(seen.every((request) => request.redirect === 'manual')).toBe(true);
    expect(error).toBeInstanceOf(LoginMethodError);
    expect((error as LoginMethodError).failure).toBe('unavailable');
    expect((error as LoginMethodError).message).toBe('GitHub のユーザーの API が 302 を返した');
  });

  test('ユーザー名の解決（resolveInvitee）の 302 は not_found にせず、unavailable', async () => {
    const { seen, fetcher } = recordingFetcher(redirect);
    const method = createGithubLoginMethod(credentials, fetcher, quietGithubOptions);
    const result = await failureOf(() => method.resolveInvitee('octo-cat'));
    expect(seen.map((request) => request.url)).toEqual([USER_LOOKUP_URL]);
    expect(seen[0]?.redirect).toBe('manual');
    expect(result).not.toEqual({ kind: 'not_found' });
    expect(result).toBeInstanceOf(LoginMethodError);
    expect((result as LoginMethodError).failure).toBe('unavailable');
    expect((result as LoginMethodError).message).toBe('GitHub のユーザーの API が 302 を返した');
  });
});
