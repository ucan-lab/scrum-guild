// GitHub への通信を差し替える fetch（ログインの結合テスト用）。トークンのエンドポイント、ユーザーの API、
// トークンの取り消し、ユーザー名の解決だけを持つ。本物と同じく、PKCE の code_verifier を認可のときの code_challenge と突き合わせ、
// code は1回しか使えない
import type { GithubOptions } from '../../src/server/auth/github.ts';

// type は GitHub のアカウントの種類。省略は個人（User）。組織のアカウントは Organization
export type FakeGithubUser = {
  id: number;
  login: string;
  name?: string | null;
  avatar_url?: string | null;
  type?: string;
};

// createGithubLoginMethod に渡す、何もしない既定の仕事の渡し先（取り消しは待たずに走らせ、ログは出さない）
export const quietGithubOptions: GithubOptions = { background: (work) => void work, warn: () => {} };

export const FAKE_CLIENT_ID = 'test-client-id';
export const FAKE_CLIENT_SECRET = 'test-client-secret';

export type FakeCall = { method: string; url: string; authorization: string | null; body: unknown };

async function challengeOf(codeVerifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(codeVerifier));
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
}

export function createFakeGithub() {
  const codes = new Map<string, { user: FakeGithubUser; challenge: string; used: boolean }>();
  const tokens = new Map<string, FakeGithubUser>();
  const directory = new Map<string, FakeGithubUser>();
  const calls: FakeCall[] = [];
  const revoked: string[] = [];
  let issued = 0;
  // 次のトークン交換とユーザーの API の失敗。1回で戻る
  const failNext: {
    token?: 'server-error' | 'not-json' | 'wrong-shape';
    user?: 'server-error' | 'unauthorized';
    revoke?: 'server-error' | 'network';
    lookup?: 'server-error' | 'rate-limited';
  } = {};

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const headers = new Headers(init?.headers);
    const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ method, url, authorization: headers.get('Authorization'), body });

    if (url === 'https://github.com/login/oauth/access_token') {
      if (failNext.token === 'server-error') {
        delete failNext.token;
        return new Response('upstream', { status: 502 });
      }
      if (failNext.token === 'not-json') {
        delete failNext.token;
        return new Response('<html>', { status: 200 });
      }
      if (failNext.token === 'wrong-shape') {
        delete failNext.token;
        return json({ token_type: 'bearer' });
      }
      const request = body as {
        client_id: string;
        client_secret: string;
        code: string;
        redirect_uri: string;
        code_verifier: string;
      };
      if (request.client_id !== FAKE_CLIENT_ID || request.client_secret !== FAKE_CLIENT_SECRET) {
        return json({ error: 'incorrect_client_credentials' });
      }
      const entry = codes.get(request.code);
      if (entry === undefined || entry.used) return json({ error: 'bad_verification_code' });
      entry.used = true;
      if ((await challengeOf(request.code_verifier)) !== entry.challenge)
        return json({ error: 'bad_verification_code' });
      const accessToken = `gho_fake_token_${++issued}`;
      tokens.set(accessToken, entry.user);
      return json({ access_token: accessToken, token_type: 'bearer', scope: 'read:user' });
    }

    if (url === 'https://api.github.com/user') {
      if (failNext.user === 'server-error') {
        delete failNext.user;
        return new Response('upstream', { status: 503 });
      }
      if (failNext.user === 'unauthorized') {
        delete failNext.user;
        return json({ message: 'Bad credentials' }, 401);
      }
      const user = tokens.get((headers.get('Authorization') ?? '').replace('Bearer ', ''));
      return user === undefined ? json({ message: 'Bad credentials' }, 401) : json(user);
    }

    const revoke = /^https:\/\/api\.github\.com\/applications\/([^/]+)\/token$/.exec(url);
    if (revoke !== null && method === 'DELETE') {
      if (failNext.revoke === 'server-error') {
        delete failNext.revoke;
        return new Response('upstream', { status: 500 });
      }
      if (failNext.revoke === 'network') {
        delete failNext.revoke;
        throw new Error('connection reset secret-detail');
      }
      const accessToken = (body as { access_token: string }).access_token;
      revoked.push(accessToken);
      tokens.delete(accessToken);
      return new Response(null, { status: 204 });
    }

    const lookup = /^https:\/\/api\.github\.com\/users\/([^/]+)$/.exec(url);
    if (lookup !== null) {
      // 認証なしの呼び出しの上限（403 や 429）や障害
      if (failNext.lookup !== undefined) {
        const status = failNext.lookup === 'rate-limited' ? 403 : 502;
        delete failNext.lookup;
        return json({ message: 'API rate limit exceeded' }, status);
      }
      const user = directory.get(decodeURIComponent(lookup[1]!).toLowerCase());
      return user === undefined ? json({ message: 'Not Found' }, 404) : json({ type: 'User', ...user });
    }

    return new Response('unexpected request', { status: 599 });
  };

  return {
    fetcher,
    calls,
    revoked,
    failNext,
    // 認可の画面を通った人に渡す code。認可の URL の code_challenge を結んでおく
    issueCode(user: FakeGithubUser, challenge: string): string {
      const code = `fake-code-${++issued}`;
      codes.set(code, { user, challenge, used: false });
      return code;
    },
    // ユーザー名の解決（/users/<名前>）で引ける人。名前（key）と、応答の login が違う人も作れる
    addUser(user: FakeGithubUser, key: string = user.login): void {
      directory.set(key.toLowerCase(), user);
    },
  };
}

export type FakeGithub = ReturnType<typeof createFakeGithub>;
