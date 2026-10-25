// GitHub のログイン（docs/development.md の「GitHub のログインと取り込み」）。共通の1つの OAuth App で、スコープは read:user だけ。
// 認可コードのフローに state（login-routes.ts）と PKCE（S256）を付ける。
// 通信先は固定の URL にし、設定から読まない。人が差分を読む領域（docs/development.md の「マージの判定」）
import {
  LoginMethodError,
  type AuthorizationRequest,
  type InviteeResolution,
  type LoginMethod,
  type LoginProfile,
  type VerificationRequest,
} from './login-method.ts';

const AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';
const TOKEN_URL = 'https://github.com/login/oauth/access_token';
const USER_URL = 'https://api.github.com/user';
const USERS_URL = 'https://api.github.com/users/';
const APPLICATIONS_URL = 'https://api.github.com/applications/';

const SCOPE = 'read:user';
const REQUEST_TIMEOUT_MS = 10_000;
// GitHub の API は User-Agent を要る
const USER_AGENT = 'scrum-guild';
const API_VERSION = '2022-11-28';

// GitHub のユーザー名: 英数字とハイフンで、39文字まで。ハイフンは先頭、末尾、連続に置けない
const USERNAME_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
const LOGIN_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
const AVATAR_HOST = 'avatars.githubusercontent.com';
const MAX_DISPLAY_NAME_LENGTH = 200;
const MAX_AVATAR_URL_LENGTH = 500;

export type GithubCredentials = { clientId: string; clientSecret: string };

// シークレットは wrangler types が .dev.vars のあるときだけ型に出す。型に頼らず、値の有無を見る。
// 未設定か空のときは undefined（ログインを受け付けない状態）
export function githubCredentials(env: object): GithubCredentials | undefined {
  const clientId = 'GITHUB_CLIENT_ID' in env ? env.GITHUB_CLIENT_ID : undefined;
  const clientSecret = 'GITHUB_CLIENT_SECRET' in env ? env.GITHUB_CLIENT_SECRET : undefined;
  if (typeof clientId !== 'string' || clientId === '' || typeof clientSecret !== 'string' || clientSecret === '') {
    return undefined;
  }
  return { clientId, clientSecret };
}

// 読まない応答の本文を捨てる。本文を持ったままにすると、接続が解放されない
async function discard(res: Response): Promise<void> {
  await res.body?.cancel().catch(() => {});
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

// 想定と違う応答。失敗の理由は固定の文だけにし、応答の本文を入れない
function unexpected(what: string): LoginMethodError {
  return new LoginMethodError('unavailable', `GitHub の応答が想定と違う（${what}）`);
}

// GitHub のユーザー ID は正の整数。10進の文字列で持つ
function subjectOf(id: unknown): string {
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) throw unexpected('ユーザー ID');
  return String(id);
}

// GitHub が返すログイン名を、ユーザー名の形と長さで確かめる（`account_logins.login_name` に入り、画面に出る）。
// Enterprise Managed Users のログイン名は `_` と組織の短い名前を続けるので、`_` も通し、長さは余裕を見て 80 文字まで
function loginNameOf(value: unknown): string {
  // 理由は固定の文にする（ログに出る。値は出さない）
  if (typeof value !== 'string' || !LOGIN_NAME_PATTERN.test(value)) {
    throw new LoginMethodError('unavailable', 'GitHub のログイン名がユーザー名の形に合わない');
  }
  return value;
}

// アバターは GitHub のアバターのホストの https だけ。ほかのホストの画像を、画面から読ませない
function avatarUrlOf(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > MAX_AVATAR_URL_LENGTH) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === AVATAR_HOST ? value : null;
  } catch {
    return null;
  }
}

// 手段の側の名前。空白だけ、または文字列でなければ null
function displayNameOf(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim().slice(0, MAX_DISPLAY_NAME_LENGTH) : null;
}

export type GithubOptions = {
  // ログインの応答を待たせない仕事（トークンの取り消し）を走らせる。Workers では executionCtx.waitUntil
  background: (work: Promise<unknown>) => void;
  // 失敗を固定の文でログに出す。トークン、code、応答の本文を渡さない
  warn: (message: string) => void;
};

export function createGithubLoginMethod(
  credentials: GithubCredentials,
  fetcher: typeof fetch,
  options: GithubOptions,
): LoginMethod {
  async function send(url: string, init: RequestInit): Promise<Response> {
    try {
      return await fetcher(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch (err) {
      // 例外の message に URL や接続の詳細が混ざりうるので、名前だけを残す
      throw new LoginMethodError(
        'unavailable',
        `GitHub に届かなかった（${err instanceof Error ? err.name : 'error'}）`,
      );
    }
  }

  async function readJson(res: Response): Promise<unknown> {
    return res.json().catch(() => {
      throw unexpected('JSON ではない');
    });
  }

  async function exchangeCode(request: VerificationRequest): Promise<string> {
    const res = await send(TOKEN_URL, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
      body: JSON.stringify({
        client_id: credentials.clientId,
        client_secret: credentials.clientSecret,
        code: request.code,
        redirect_uri: request.redirectUri,
        code_verifier: request.codeVerifier,
      }),
    });
    if (!res.ok) {
      await discard(res);
      throw new LoginMethodError('unavailable', `GitHub のトークンのエンドポイントが ${res.status} を返した`);
    }
    const body = await readJson(res);
    if (!isRecord(body)) throw unexpected('トークンの応答');
    // 失敗も 200 で返る。code が使えないときだけ人のやり直しで通り、ほかはこちらの設定の誤り（クライアントの資格情報など）
    if (typeof body.error === 'string') {
      if (body.error === 'bad_verification_code') {
        throw new LoginMethodError('rejected', 'GitHub が code を受け付けなかった');
      }
      throw new LoginMethodError('unavailable', 'GitHub がトークンを渡さなかった');
    }
    if (typeof body.access_token !== 'string' || body.access_token === '') throw unexpected('access_token');
    return body.access_token;
  }

  async function fetchProfile(accessToken: string): Promise<LoginProfile> {
    const res = await send(USER_URL, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${accessToken}`,
        'User-Agent': USER_AGENT,
        'X-GitHub-Api-Version': API_VERSION,
      },
    });
    if (res.status === 401) {
      await discard(res);
      throw new LoginMethodError('rejected', 'GitHub のユーザーの API がトークンを受け付けなかった');
    }
    if (!res.ok) {
      await discard(res);
      throw new LoginMethodError('unavailable', `GitHub のユーザーの API が ${res.status} を返した`);
    }
    const body = await readJson(res);
    if (!isRecord(body)) throw unexpected('ユーザーの応答');
    return {
      subject: subjectOf(body.id),
      loginName: loginNameOf(body.login),
      displayName: displayNameOf(body.name),
      avatarUrl: avatarUrlOf(body.avatar_url),
    };
  }

  // 使い終わったトークンを GitHub 側でも取り消す。read:user のトークンは期限が無いので、持ち続けさせない。
  // 失敗してもログインは続け、失敗は固定の文でログに残す（トークンも、応答の本文も出さない）。投げない
  async function revoke(accessToken: string): Promise<void> {
    try {
      const res = await send(`${APPLICATIONS_URL}${encodeURIComponent(credentials.clientId)}/token`, {
        method: 'DELETE',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Basic ${btoa(`${credentials.clientId}:${credentials.clientSecret}`)}`,
          'Content-Type': 'application/json',
          'User-Agent': USER_AGENT,
          'X-GitHub-Api-Version': API_VERSION,
        },
        body: JSON.stringify({ access_token: accessToken }),
      });
      if (!res.ok) options.warn(`GitHub のトークンの取り消しが ${res.status} を返した`);
      // 本文は読まない。読まないまま持たず、接続を解放する
      await discard(res);
    } catch (err) {
      options.warn(err instanceof LoginMethodError ? err.message : 'GitHub のトークンの取り消しに失敗した');
    }
  }

  return {
    provider: 'github',

    authorizeUrl(request: AuthorizationRequest): string {
      const url = new URL(AUTHORIZE_URL);
      url.searchParams.set('client_id', credentials.clientId);
      url.searchParams.set('redirect_uri', request.redirectUri);
      url.searchParams.set('scope', SCOPE);
      url.searchParams.set('state', request.state);
      url.searchParams.set('code_challenge', request.codeChallenge);
      url.searchParams.set('code_challenge_method', 'S256');
      return url.toString();
    },

    async verify(request: VerificationRequest): Promise<LoginProfile> {
      const accessToken = await exchangeCode(request);
      try {
        return await fetchProfile(accessToken);
      } finally {
        // ログインの応答を待たせない
        options.background(revoke(accessToken));
      }
    },

    // ユーザー名は変えられるので、招待のときにユーザー ID に解決して突き合わせる。クライアントの資格情報で呼び、
    // 認証なしの呼び出しの上限（IP ごと、1時間に60回）に Workers の共有の IP が当たらないようにする
    async resolveInvitee(reference: string): Promise<InviteeResolution> {
      if (!USERNAME_PATTERN.test(reference)) return { kind: 'not_found' };
      const res = await send(`${USERS_URL}${encodeURIComponent(reference)}`, {
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Basic ${btoa(`${credentials.clientId}:${credentials.clientSecret}`)}`,
          'User-Agent': USER_AGENT,
          'X-GitHub-Api-Version': API_VERSION,
        },
      });
      if (res.status === 404) {
        await discard(res);
        return { kind: 'not_found' };
      }
      if (!res.ok) {
        await discard(res);
        throw new LoginMethodError('unavailable', `GitHub のユーザーの API が ${res.status} を返した`);
      }
      const body = await readJson(res);
      if (!isRecord(body)) throw unexpected('ユーザーの応答');
      // type は User（個人）、Organization（組織）、Bot など。個人以外はログインできず、管理者や招待の相手にすると誰も入れない
      if (typeof body.type !== 'string') throw unexpected('アカウントの種類');
      if (body.type !== 'User') return { kind: 'not_a_user' };
      return {
        kind: 'found',
        invitee: {
          subject: subjectOf(body.id),
          loginName: loginNameOf(body.login),
          displayName: displayNameOf(body.name),
          avatarUrl: avatarUrlOf(body.avatar_url),
        },
      };
    },
  };
}
