// Google のログイン（docs/development.md の「Google のログイン」）。OpenID Connect の認可コードのフローで、
// スコープは openid email profile だけ。state（login-routes.ts）と PKCE（S256）と nonce を付ける。
// ID トークンは、固定のトークンのエンドポイントに Worker から送った応答のものだけを受け取るので、署名は検証しない。
// 通信先は固定の URL にし、発見の文書や設定から読まない。応答の access_token は読まずに捨て、取り消さない
// （Google の取り消しは許可ごと消し、ログインのたびに同意画面が出直す。トークンは1時間で切れる）。userinfo は呼ばない。
// 人が差分を読む領域（docs/development.md の「マージの判定」）
import {
  LoginMethodError,
  type AuthorizationRequest,
  type LoginMethod,
  type LoginProfile,
  type VerificationRequest,
} from './login-method.ts';
import { avatarUrlOf, displayNameOf } from './profile-fields.ts';
import { timingSafeEqualStrings } from './tokens.ts';

const AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

const SCOPE = 'openid email profile';
const REQUEST_TIMEOUT_MS = 10_000;

const ISSUERS: readonly string[] = ['https://accounts.google.com', 'accounts.google.com'];
const AVATAR_HOST = 'lh3.googleusercontent.com';
// プロフィールに名前が無い人の login_name（docs/data-model.md の `account_logins`）
const FALLBACK_LOGIN_NAME = 'Google ユーザー';
// Google の sub は最大 255 文字の ASCII。それを超える値は想定外として断る
const MAX_SUBJECT_LENGTH = 255;

export type GoogleCredentials = { clientId: string; clientSecret: string };

// シークレットは wrangler types が .dev.vars のあるときだけ型に出す。型に頼らず、値の有無を見る。
// 未設定か空のときは undefined（ログインを受け付けない状態）
export function googleCredentials(env: object): GoogleCredentials | undefined {
  const clientId = 'GOOGLE_CLIENT_ID' in env ? env.GOOGLE_CLIENT_ID : undefined;
  const clientSecret = 'GOOGLE_CLIENT_SECRET' in env ? env.GOOGLE_CLIENT_SECRET : undefined;
  if (typeof clientId !== 'string' || clientId === '' || typeof clientSecret !== 'string' || clientSecret === '') {
    return undefined;
  }
  return { clientId, clientSecret };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

// 読まない応答の本文を捨てる。本文を持ったままにすると、接続が解放されない
async function discard(res: Response): Promise<void> {
  await res.body?.cancel().catch(() => {});
}

// 想定と違う応答。失敗の理由は固定の文だけにし、ID トークンや応答の本文、メールアドレスを入れない
function unexpected(what: string): LoginMethodError {
  return new LoginMethodError('unavailable', `Google の応答が想定と違う（${what}）`);
}

// JWT の本文（ペイロード）を読む。署名は検証しない（トークンのエンドポイントから直に受け取ったものだけを渡す）
function payloadOf(idToken: string): Record<string, unknown> {
  const parts = idToken.split('.');
  if (parts.length !== 3) throw unexpected('ID トークンの形');
  try {
    const base64 = parts[1]!.replaceAll('-', '+').replaceAll('_', '/');
    const bytes = Uint8Array.from(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')), (c) => c.charCodeAt(0));
    const payload: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes));
    if (!isRecord(payload) || Array.isArray(payload)) throw new Error('not an object');
    return payload;
  } catch {
    throw unexpected('ID トークンの本文');
  }
}

export type GoogleIdTokenExpectation = {
  // 自分の OAuth クライアントの ID。aud（配列なら azp も）と完全に一致させる
  clientId: string;
  // oauth_states に入れた nonce
  nonce: string;
  now: Date;
};

export type GoogleIdentity = {
  profile: LoginProfile;
  // email_verified が真偽値の true のときだけ、ID トークンのメールアドレス。それ以外は null（断らない）。
  // LoginProfile には載せず、ログにも DB にも出さない
  email: string | null;
};

// ID トークンの検査（純粋な関数）。確かめるのは5つ:
//   1. iss が https://accounts.google.com か accounts.google.com に完全一致
//   2. aud がクライアント ID に完全一致（配列なら含み、azp も一致）
//   3. exp が過ぎていない（猶予なし）
//   4. nonce が oauth_states の値に一致
//   5. email_verified が真偽値の true（メールアドレスを返すかどうか。断らない）
// 失敗は LoginMethodError。message は固定の文だけ
export function checkGoogleIdToken(idToken: string, expected: GoogleIdTokenExpectation): GoogleIdentity {
  const claims = payloadOf(idToken);

  if (typeof claims.iss !== 'string' || !ISSUERS.includes(claims.iss)) {
    throw new LoginMethodError('unavailable', 'Google の ID トークンの iss が違う');
  }

  const { aud, azp } = claims;
  const audienceMatches = Array.isArray(aud)
    ? aud.includes(expected.clientId) && azp === expected.clientId
    : aud === expected.clientId;
  if (!audienceMatches) {
    throw new LoginMethodError('unavailable', 'Google の ID トークンの aud が違う');
  }

  if (typeof claims.exp !== 'number' || !Number.isFinite(claims.exp) || claims.exp * 1000 <= expected.now.getTime()) {
    throw new LoginMethodError('rejected', 'Google の ID トークンの期限が切れている');
  }

  if (
    expected.nonce === '' ||
    typeof claims.nonce !== 'string' ||
    !timingSafeEqualStrings(claims.nonce, expected.nonce)
  ) {
    throw new LoginMethodError('rejected', 'Google の ID トークンの nonce が違う');
  }

  // sub は数値に直さない（桁が落ちる）。受け取った文字列のまま持つ
  const { sub } = claims;
  if (typeof sub !== 'string' || sub === '' || sub.length > MAX_SUBJECT_LENGTH) throw unexpected('sub');

  const displayName = displayNameOf(claims.name);
  return {
    profile: {
      subject: sub,
      loginName: displayName ?? FALLBACK_LOGIN_NAME,
      displayName,
      avatarUrl: avatarUrlOf(claims.picture, AVATAR_HOST),
    },
    email: claims.email_verified === true && typeof claims.email === 'string' ? claims.email : null,
  };
}

export function createGoogleLoginMethod(credentials: GoogleCredentials, fetcher: typeof fetch): LoginMethod {
  async function send(url: string, init: RequestInit): Promise<Response> {
    try {
      return await fetcher(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch (err) {
      // 例外の message に URL や接続の詳細が混ざりうるので、名前だけを残す
      throw new LoginMethodError(
        'unavailable',
        `Google に届かなかった（${err instanceof Error ? err.name : 'error'}）`,
      );
    }
  }

  // code を ID トークンに替える。応答から取り出すのは id_token だけ（access_token は読まない）
  async function exchangeCode(request: VerificationRequest): Promise<string> {
    const res = await send(TOKEN_URL, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: request.code,
        client_id: credentials.clientId,
        client_secret: credentials.clientSecret,
        redirect_uri: request.redirectUri,
        grant_type: 'authorization_code',
        code_verifier: request.codeVerifier,
      }).toString(),
    });
    if (!res.ok) {
      // code が使えない（使い済み、期限切れ、違う）ときだけ人のやり直しで通る。ほかはこちらの設定の誤りか Google の障害
      const body: unknown = res.status === 400 ? await res.json().catch(() => undefined) : await discard(res);
      if (isRecord(body) && body.error === 'invalid_grant') {
        throw new LoginMethodError('rejected', 'Google が code を受け付けなかった');
      }
      throw new LoginMethodError('unavailable', `Google のトークンのエンドポイントが ${res.status} を返した`);
    }
    const body: unknown = await res.json().catch(() => {
      throw unexpected('JSON ではない');
    });
    if (!isRecord(body)) throw unexpected('トークンの応答');
    if (typeof body.id_token !== 'string' || body.id_token === '') throw unexpected('id_token');
    return body.id_token;
  }

  return {
    provider: 'google',
    usesNonce: true,

    authorizeUrl(request: AuthorizationRequest): string {
      const url = new URL(AUTHORIZE_URL);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('client_id', credentials.clientId);
      url.searchParams.set('redirect_uri', request.redirectUri);
      url.searchParams.set('scope', SCOPE);
      url.searchParams.set('state', request.state);
      url.searchParams.set('code_challenge', request.codeChallenge);
      url.searchParams.set('code_challenge_method', 'S256');
      if (request.nonce !== null) url.searchParams.set('nonce', request.nonce);
      url.searchParams.set('prompt', 'select_account');
      return url.toString();
    },

    async verify(request: VerificationRequest): Promise<LoginProfile> {
      // nonce の無い state の行（Google で作られていない行）は、通信の前に断る
      if (request.nonce === null || request.nonce === '') {
        throw new LoginMethodError('rejected', 'Google のログインの state に nonce が無い');
      }
      const idToken = await exchangeCode(request);
      return checkGoogleIdToken(idToken, {
        clientId: credentials.clientId,
        nonce: request.nonce,
        now: new Date(),
      }).profile;
    },
  };
}
