// ログインの開始と戻り先。ブラウザの GET の移動（リダイレクト）なので、操作の定義の外に直に書く例外
// （docs/development.md の「操作の定義」。/api/health と同じ）。
//   GET /api/auth/<手段>/start?return_to=<自分のサイトのパス>
//   GET /api/auth/<手段>/callback?code=...&state=...
// どちらも失敗はログインの画面（/login?error=...）へ移す。ブラウザが見る応答に JSON のエラーを返さないため。
// Origin の検査は掛からない（ほかのサイトからの移動で呼ばれる）。ログインの CSRF は state の Cookie で止める（oauth-state.ts）。
// ほかのサイトのページが `<img>` などで読ませて、被害者の IP のレート制限の枠を使い切らせたり、行を書かせたりできないよう、
// 開始はブラウザの移動（Sec-Fetch）だけを数え、戻り先は state の Cookie が合い、DB の state の行を使い切れたものだけを数える。
// 人が差分を読む領域（docs/development.md の「マージの判定」）
import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { resolvedReturnTo, safeReturnTo } from '../../shared/return-to.ts';
import { sessionCookieName, sessionCookieOptions } from '../../shared/session-cookie.ts';
import type { AppEnv } from '../app-env.ts';
import { executionContextOf } from '../execution-context.ts';
import { createGithubLoginMethod, githubCredentials } from './github.ts';
import { createGoogleLoginMethod, googleCredentials } from './google.ts';
import { completeLogin } from './login.ts';
import { LoginMethodError, type InviteeResolver, type LoginMethod } from './login-method.ts';
import {
  consumeOAuthState,
  OAUTH_STATE_PATTERN,
  oauthStateCookieClearOptions,
  oauthStateCookieName,
  oauthStateCookieOptions,
  startOAuthState,
} from './oauth-state.ts';
import { consumeLoginRateLimits, consumeLoginStartRateLimits, type LoginStartRateLimit } from './rate-limit.ts';
import { timingSafeEqualStrings } from './tokens.ts';

// ログインの画面（/login?error=）が扱う失敗。画面は文言を辞書から出す（src/routes/login/）
export type LoginError = 'denied' | 'retry' | 'too_many' | 'unavailable';

// 戻り先の code の形。GitHub の code は短い英数字で、Google の code は `4/0A...` のように `/` を含む。長さと文字で弾いてから送る
const CODE_PATTERN = /^[A-Za-z0-9._~/-]{1,512}$/;

export type LoginRoutesOptions = {
  fetcher: typeof fetch;
};

// URL に出せる手段
const PROVIDERS: ReadonlySet<string> = new Set(['github', 'google']);

// 資格情報が未設定の手段は undefined（その手段のログインを受け付けない）。
// トークンの取り消しは応答を待たせずに走らせ（waitUntil）、失敗は固定の文でログに出す
export function githubMethod(c: Context<AppEnv>, fetcher: typeof fetch): (LoginMethod & InviteeResolver) | undefined {
  const credentials = githubCredentials(c.env);
  if (credentials === undefined) return undefined;
  return createGithubLoginMethod(credentials, fetcher, {
    background: (work) => {
      const executionContext = executionContextOf(c);
      // 実行の文脈が無い（テストの直の呼び出し）ときは、待たずに走らせる
      if (executionContext === undefined) void work;
      else executionContext.waitUntil(work);
    },
    warn: (message) => {
      console.warn(
        JSON.stringify({
          level: 'warn',
          requestId: c.get('requestId'),
          route: 'auth',
          provider: 'github',
          reason: message,
        }),
      );
    },
  });
}

// 資格情報が未設定なら undefined。Google はトークンを取り消さないので、背景の仕事を持たない
export function googleMethod(c: Context<AppEnv>, fetcher: typeof fetch): LoginMethod | undefined {
  const credentials = googleCredentials(c.env);
  if (credentials === undefined) return undefined;
  return createGoogleLoginMethod(credentials, fetcher);
}

function methodOf(c: Context<AppEnv>, provider: string, fetcher: typeof fetch): LoginMethod | undefined {
  return provider === 'google' ? googleMethod(c, fetcher) : githubMethod(c, fetcher);
}

function callbackUrl(env: Env, provider: string): string {
  return `${new URL(env.PUBLIC_ORIGIN).origin}/api/auth/${provider}/callback`;
}

// ログの1行。code、state、トークン、Cookie の値は出さない（docs/development.md の「API のエラーとログ」）
function log(
  c: Context<AppEnv>,
  entry: { step: 'start' | 'callback'; provider: string; outcome: string; accountId?: string },
): void {
  console.log(JSON.stringify({ level: 'info', requestId: c.get('requestId'), route: 'auth', ...entry }));
}

function logError(c: Context<AppEnv>, reason: string, err: unknown): void {
  console.error(
    JSON.stringify({
      level: 'error',
      code: 'internal',
      requestId: c.get('requestId'),
      route: 'auth',
      reason,
      // 例外の message に URL、SQL、応答の詳細が混ざりうる。LoginMethodError だけは固定の文なので添える
      error: err instanceof Error ? err.name : typeof err,
      ...(err instanceof LoginMethodError ? { detail: err.message } : {}),
    }),
  );
}

// ログインの画面へ移す。戻り先が分かっているときは付ける（やり直しても同じ画面に戻れる）。理由が無いときは、ただ画面へ戻す
function toLoginPage(c: Context<AppEnv>, error?: LoginError, returnTo?: string): Response {
  const params = new URLSearchParams();
  if (error !== undefined) params.set('error', error);
  if (returnTo !== undefined && returnTo !== '/') params.set('return_to', returnTo);
  const query = params.toString();
  return c.redirect(query === '' ? '/login' : `/login?${query}`, 302);
}

// 利用者が自分のサイトの画面（ログインの画面）から、またはアドレス欄から始めた画面の移動か。
//   - Sec-Fetch-Mode と Sec-Fetch-Dest: `<img>`、`<script>`、`fetch()`、`<iframe>` からの読み込みは navigate と document でない
//   - Sec-Fetch-Site: same-origin（ログインの画面のボタン）か none（アドレス欄、ブックマーク）だけ。別のサイト（cross-site）や
//     同じサイトの別のオリジン（same-site）のページからのリンクや読み込みは、数えず、行も書かない
//   - Sec-Purpose: prefetch や prerender（先読み）は、利用者が開いたのではないので同じ扱い
// どのヘッダーも、無ければ通す（送らない古いブラウザ。ブラウザ以外のクライアントは枠を使い切らせる相手にならない）
function isUserNavigation(c: Context<AppEnv>): boolean {
  const mode = c.req.header('Sec-Fetch-Mode');
  const dest = c.req.header('Sec-Fetch-Dest');
  const site = c.req.header('Sec-Fetch-Site');
  const purpose = c.req.header('Sec-Purpose')?.toLowerCase();
  return (
    (mode === undefined || mode === 'navigate') &&
    (dest === undefined || dest === 'document') &&
    (site === undefined || site === 'same-origin' || site === 'none') &&
    (purpose === undefined || !(purpose.includes('prefetch') || purpose.includes('prerender')))
  );
}

// 開始は IP の枠と全体の枠、戻り先は IP の枠だけを数える。戻り先は state の行を使い切れたものだけを数え、行は開始が
// 書いたものしか無いので、開始の全体の枠で間接的に絞られる。GitHub から戻った人を全体の枠で断らない
async function consumeStartRateLimit(c: Context<AppEnv>): Promise<LoginStartRateLimit> {
  return consumeLoginStartRateLimits(c.env, c.req.header('CF-Connecting-IP'), new Date());
}

async function consumeCallbackRateLimit(c: Context<AppEnv>): Promise<boolean> {
  return consumeLoginRateLimits(c.env, c.req.header('CF-Connecting-IP'), new Date());
}

export function loginRoutes(options: LoginRoutesOptions): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get('/:provider/start', async (c) => {
    const provider = c.req.param('provider');
    if (!PROVIDERS.has(provider)) return c.notFound();
    const returnTo = safeReturnTo(c.req.query('return_to'));
    try {
      // 利用者が始めた画面の移動でない読み込みは、数えず、行も書かず、ログインの画面へ戻す
      if (!isUserNavigation(c)) {
        log(c, { step: 'start', provider, outcome: 'not_navigation' });
        return toLoginPage(c, undefined, returnTo);
      }
      const limit = await consumeStartRateLimit(c);
      if (!limit.allowed) {
        // 画面は同じ too_many。ログでは、全体の枠に当たったのかを IP の枠と見分ける
        log(c, { step: 'start', provider, outcome: limit.limitedBy === 'global' ? 'too_many_global' : 'too_many' });
        return toLoginPage(c, 'too_many', returnTo);
      }
      const method = methodOf(c, provider, options.fetcher);
      if (method === undefined) {
        log(c, { step: 'start', provider, outcome: 'unavailable' });
        return toLoginPage(c, 'unavailable', returnTo);
      }
      const started = await startOAuthState(c.env, provider, returnTo, new Date(), method.usesNonce);
      setCookie(
        c,
        oauthStateCookieName(c.env.PUBLIC_ORIGIN),
        started.state,
        oauthStateCookieOptions(c.env.PUBLIC_ORIGIN),
      );
      log(c, { step: 'start', provider, outcome: 'redirected' });
      return c.redirect(
        method.authorizeUrl({
          state: started.state,
          codeChallenge: started.codeChallenge,
          redirectUri: callbackUrl(c.env, provider),
          nonce: started.nonce,
        }),
        302,
      );
    } catch (err) {
      logError(c, 'ログインを始められなかった', err);
      return toLoginPage(c, 'unavailable', returnTo);
    }
  });

  app.get('/:provider/callback', async (c) => {
    const provider = c.req.param('provider');
    if (!PROVIDERS.has(provider)) return c.notFound();
    const stateCookie = oauthStateCookieName(c.env.PUBLIC_ORIGIN);
    try {
      const method = methodOf(c, provider, options.fetcher);
      if (method === undefined) {
        log(c, { step: 'callback', provider, outcome: 'unavailable' });
        return toLoginPage(c, 'unavailable');
      }

      // state のクエリと Cookie の両方が揃い、形が合い、値が一致したものだけを先へ進める。
      // 合わないものは、数えず、DB の行にも Cookie にも触れずに断る（ほかのサイトからの読み込みで枠を使い切らせたり、
      // 他人が始めたログインの state を別のブラウザから使い切らせたりできない）
      const state = c.req.query('state');
      const cookieState = getCookie(c, stateCookie);
      if (
        state === undefined ||
        cookieState === undefined ||
        !OAUTH_STATE_PATTERN.test(state) ||
        !timingSafeEqualStrings(state, cookieState)
      ) {
        log(c, { step: 'callback', provider, outcome: 'state_mismatch' });
        return toLoginPage(c, 'retry');
      }
      // 照合に通った戻りで、state の Cookie を使い切る。以降は成功でも失敗でも消す
      deleteCookie(c, stateCookie, oauthStateCookieClearOptions(c.env.PUBLIC_ORIGIN));

      // 行を使い切ってから数える。Cookie はブラウザ以外なら自由に付けられるので、照合に通っただけでは数えない
      // （行の無い state を IP ごとに送って、開始の全体の枠を通らずに rate_limits の行を書かせられないため）
      const consumed = await consumeOAuthState(c.env, provider, state, new Date());
      if (consumed === undefined) {
        log(c, { step: 'callback', provider, outcome: 'state_invalid' });
        return toLoginPage(c, 'retry');
      }
      if (!(await consumeCallbackRateLimit(c))) {
        log(c, { step: 'callback', provider, outcome: 'too_many' });
        return toLoginPage(c, 'too_many');
      }
      const returnTo = safeReturnTo(consumed.returnTo);

      const code = c.req.query('code');
      // 手段の側で拒否された（error=access_denied など）か、code が無いときは、ログインを完了できない
      if (c.req.query('error') !== undefined || code === undefined || !CODE_PATTERN.test(code)) {
        log(c, { step: 'callback', provider, outcome: 'no_code' });
        return toLoginPage(c, 'retry', returnTo);
      }

      let profile;
      try {
        profile = await method.verify({
          code,
          codeVerifier: consumed.codeVerifier,
          redirectUri: callbackUrl(c.env, provider),
          nonce: consumed.nonce,
        });
      } catch (err) {
        logError(c, '本人を確かめられなかった', err);
        const rejected = err instanceof LoginMethodError && err.failure === 'rejected';
        return toLoginPage(c, rejected ? 'retry' : 'unavailable', returnTo);
      }

      const sessionCookie = sessionCookieName(c.env.PUBLIC_ORIGIN);
      const outcome = await completeLogin(c.env, {
        provider,
        profile,
        now: new Date(),
        replacedSessionToken: getCookie(c, sessionCookie),
        requestId: c.get('requestId'),
      });
      if (!outcome.ok) {
        log(c, { step: 'callback', provider, outcome: outcome.reason });
        return toLoginPage(c, outcome.reason, outcome.reason === 'retry' ? returnTo : undefined);
      }
      setCookie(c, sessionCookie, outcome.sessionToken, sessionCookieOptions(c.env.PUBLIC_ORIGIN));
      log(c, { step: 'callback', provider, outcome: 'ok', accountId: outcome.accountId });
      // 戻る先は、自分のオリジンのパスであることを URL の解決の後でもう一度確かめてから使う
      return c.redirect(resolvedReturnTo(returnTo, new URL(c.env.PUBLIC_ORIGIN).origin), 302);
    } catch (err) {
      logError(c, 'ログインを完了できなかった', err);
      return toLoginPage(c, 'retry');
    }
  });

  return app;
}
