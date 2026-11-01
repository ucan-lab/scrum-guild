// OAuth の state（docs/data-model.md の `oauth_states`）。開始で DB に行を入れて同じ値を HttpOnly の Cookie にも置き、
// 戻り先で DB の行と Cookie の両方と比べる。DB の行だけで確かめると、攻撃者が自分で始めたログインの code と state を
// 付けた戻り先の URL を踏ませて、被害者のブラウザを攻撃者のアカウントでログインさせられる（ログインの CSRF）
import { isSecureOrigin } from '../../shared/session-cookie.ts';
import { commonDb } from '../db/index.ts';
import { codeChallenge, randomToken } from './tokens.ts';

// 作ってから10分で切れる
export const OAUTH_STATE_LIFETIME_MS = 10 * 60 * 1000;

// state と code_verifier の形（32 バイトの乱数の base64url、43文字）。DB を引く前に形で弾く
export const OAUTH_STATE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

// Secure は https の公開 URL だけに付ける（セッションの Cookie と同じ。isSecureOrigin を参照）
export function oauthStateCookieOptions(publicOrigin: string) {
  return {
    httpOnly: true,
    secure: isSecureOrigin(publicOrigin),
    // 手段からの戻りは別のサイトからの GET の移動。Lax はこれに Cookie を付ける
    sameSite: 'Lax',
    path: '/',
    maxAge: OAUTH_STATE_LIFETIME_MS / 1000,
  } as const;
}

export function oauthStateCookieClearOptions(publicOrigin: string) {
  return { secure: isSecureOrigin(publicOrigin), path: '/' } as const;
}

// セッションの Cookie と同じく、https の公開 URL では `__Host-` を付ける（session-cookie.ts の sessionCookieName を参照）
export function oauthStateCookieName(publicOrigin: string): string {
  return isSecureOrigin(publicOrigin) ? '__Host-sg_oauth_state' : 'sg_oauth_state';
}

export type StartedLogin = { state: string; codeChallenge: string; nonce: string | null };

// state の行を入れる。returnTo は検査済みの自分のサイトのパス。withNonce が真の手段（LoginMethod.usesNonce）には nonce も作って入れる。
// claimTokenHash は招待の URL から始めたログインの、その URL の秘密の SHA-256（秘密そのものは受け取らない）。
// signup は会員登録の画面から始めた往復の印（oauth_states.is_signup）。戻り先が読み、アカウントを作ってよいかを決める
export async function startOAuthState(
  env: Env,
  provider: string,
  returnTo: string,
  now: Date,
  withNonce: boolean,
  claimTokenHash: string | null = null,
  signup = false,
): Promise<StartedLogin> {
  const state = randomToken();
  const codeVerifier = randomToken();
  const nonce = withNonce ? randomToken() : null;
  const db = commonDb(env);
  await db.batch([
    db.statement((q) =>
      q.insertInto('oauth_states').values({
        state,
        login_provider: provider,
        code_verifier: codeVerifier,
        nonce,
        claim_token_hash: claimTokenHash,
        is_signup: signup ? 1 : 0,
        return_to: returnTo,
        expires_at: new Date(now.getTime() + OAUTH_STATE_LIFETIME_MS).toISOString(),
      }),
    ),
  ]);
  return { state, codeChallenge: await codeChallenge(codeVerifier), nonce };
}

export type ConsumedOAuthState = {
  codeVerifier: string;
  nonce: string | null;
  returnTo: string | null;
  // 招待の URL から始めたログインの、その URL の秘密の SHA-256。通常のログインは null
  claimTokenHash: string | null;
  // 会員登録の画面から始めた往復か。通常のログインは false
  signup: boolean;
};

// state の行を消して返す。1回の DELETE ... RETURNING なので、同じ state の戻りが並行しても1回しか通らない（使い回させない）。
// 書き込みなので batch() で送る。無い、使い済み、別の手段の行、10分を過ぎた行は undefined（過ぎた行も消える）
export async function consumeOAuthState(
  env: Env,
  provider: string,
  state: string,
  now: Date,
): Promise<ConsumedOAuthState | undefined> {
  const db = commonDb(env);
  const [result] = await db.batch([
    db.statement((q) =>
      q
        .deleteFrom('oauth_states')
        .where('state', '=', state)
        .returning([
          'login_provider',
          'code_verifier',
          'nonce',
          'claim_token_hash',
          'is_signup',
          'return_to',
          'expires_at',
        ]),
    ),
  ]);
  const row = result.rows[0];
  if (row === undefined || row.login_provider !== provider || row.expires_at <= now.toISOString()) return undefined;
  return {
    codeVerifier: row.code_verifier,
    nonce: row.nonce,
    returnTo: row.return_to,
    claimTokenHash: row.claim_token_hash,
    signup: row.is_signup === 1,
  };
}
