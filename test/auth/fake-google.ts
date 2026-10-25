// Google への通信を差し替える fetch（ログインの結合テスト用）。持つのはトークンのエンドポイントだけ（userinfo も取り消しも呼ばない）。
// 本物と同じく、form-urlencoded の本文、client_secret、PKCE の code_verifier を確かめ、code は1回しか使えない。
// ID トークンは署名の無い JWT で、中身（claims）をテストごとに上書きできる。nonce は認可の URL の値を覚えて入れる

export const FAKE_GOOGLE_CLIENT_ID = 'test-google-client-id.apps.googleusercontent.com';
export const FAKE_GOOGLE_CLIENT_SECRET = 'test-google-client-secret';

export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

// 認可の画面を通った Google の人。実在の人に当たらないよう、架空の名前と sub にする
export type FakeGoogleUser = {
  // 数値に直すと桁が落ちる長さにできる。文字列のまま持つ
  sub: string;
  name?: string | null;
  picture?: string | null;
  email?: string;
  email_verified?: unknown;
};

// ID トークンの本文。値が undefined の項目は本文から外す
export type IdTokenClaims = Record<string, unknown>;

export type FakeGoogleCall = { method: string; url: string; contentType: string | null; form: Record<string, string> };

type IssuedCode = {
  user: FakeGoogleUser;
  challenge: string;
  nonce: string | null;
  redirectUri: string;
  claims: IdTokenClaims;
  used: boolean;
};

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
}

async function challengeOf(codeVerifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(codeVerifier));
  return base64url(new Uint8Array(digest));
}

// 署名の無い JWT（alg: none、署名は空）
export function unsignedJwt(claims: IdTokenClaims): string {
  const encode = (value: unknown) => base64url(new TextEncoder().encode(JSON.stringify(value)));
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode(claims)}.`;
}

export function createFakeGoogle() {
  const codes = new Map<string, IssuedCode>();
  const calls: FakeGoogleCall[] = [];
  // 渡した ID トークンとアクセストークン。ログに出ていないことを確かめるのに使う
  const idTokens: string[] = [];
  const accessTokens: string[] = [];
  let issued = 0;
  // 次のトークン交換の失敗。1回で戻る
  const failNext: { token?: 'server-error' | 'not-json' | 'no-id-token' } = {};

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const headers = new Headers(init?.headers);
    const form =
      typeof init?.body === 'string' ? Object.fromEntries(new URLSearchParams(init.body).entries()) : undefined;
    calls.push({ method, url, contentType: headers.get('Content-Type'), form: form ?? {} });

    if (url !== GOOGLE_TOKEN_URL) return new Response('unexpected request', { status: 599 });

    if (failNext.token === 'server-error') {
      delete failNext.token;
      return new Response('upstream', { status: 502 });
    }
    if (failNext.token === 'not-json') {
      delete failNext.token;
      return new Response('<html>', { status: 200 });
    }

    // 本物は form-urlencoded でない本文を invalid_request で断る
    if (
      method !== 'POST' ||
      headers.get('Content-Type') !== 'application/x-www-form-urlencoded' ||
      form === undefined
    ) {
      return json({ error: 'invalid_request' }, 400);
    }
    if (form.client_id !== FAKE_GOOGLE_CLIENT_ID || form.client_secret !== FAKE_GOOGLE_CLIENT_SECRET) {
      return json({ error: 'invalid_client' }, 401);
    }
    if (form.grant_type !== 'authorization_code') return json({ error: 'unsupported_grant_type' }, 400);

    const entry = codes.get(form.code ?? '');
    if (entry === undefined || entry.used) return json({ error: 'invalid_grant' }, 400);
    entry.used = true;
    if (form.redirect_uri !== entry.redirectUri) return json({ error: 'redirect_uri_mismatch' }, 400);
    if (form.code_verifier === undefined || (await challengeOf(form.code_verifier)) !== entry.challenge) {
      return json({ error: 'invalid_grant' }, 400);
    }

    const now = Math.floor(Date.now() / 1000);
    const claims: IdTokenClaims = {
      iss: 'https://accounts.google.com',
      azp: FAKE_GOOGLE_CLIENT_ID,
      aud: FAKE_GOOGLE_CLIENT_ID,
      sub: entry.user.sub,
      email: entry.user.email,
      email_verified: entry.user.email_verified ?? true,
      name: entry.user.name,
      picture: entry.user.picture,
      nonce: entry.nonce ?? undefined,
      iat: now,
      exp: now + 3600,
      ...entry.claims,
    };
    for (const [key, value] of Object.entries(claims)) {
      if (value === undefined) delete claims[key];
    }
    if (failNext.token === 'no-id-token') {
      delete failNext.token;
      return json({ access_token: 'ya29.fake-access-token', token_type: 'Bearer', expires_in: 3599 });
    }
    const idToken = unsignedJwt(claims);
    const accessToken = `ya29.fake-access-token-${++issued}`;
    idTokens.push(idToken);
    accessTokens.push(accessToken);
    return json({
      access_token: accessToken,
      expires_in: 3599,
      scope: 'openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile',
      token_type: 'Bearer',
      id_token: idToken,
    });
  };

  return {
    fetcher,
    calls,
    idTokens,
    accessTokens,
    failNext,
    // 認可の画面を通った人に渡す code（`4/0A...` の形で、`/` を含む）。認可の URL の code_challenge、nonce、redirect_uri を覚える。
    // claims で ID トークンの中身を上書きする（nonce も上書きでき、違う値や欠けた値にできる）
    issueCode(user: FakeGoogleUser, authorizationUrl: URL, claims: IdTokenClaims = {}): string {
      const code = `4/0AfakeCode-${++issued}`;
      codes.set(code, {
        user,
        challenge: authorizationUrl.searchParams.get('code_challenge') ?? '',
        nonce: authorizationUrl.searchParams.get('nonce'),
        redirectUri: authorizationUrl.searchParams.get('redirect_uri') ?? '',
        claims,
        used: false,
      });
      return code;
    },
  };
}

export type FakeGoogle = ReturnType<typeof createFakeGoogle>;
