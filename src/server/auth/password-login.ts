// メールアドレスとパスワードでのログイン（POST /api/auth/password/login、Issue #256）。
// 未ログインの人が呼ぶ口なので、操作の定義（ログインした人向け）の外に直に書く例外（docs/development.md の「操作の定義」。
// POST /api/client-errors と同じ扱い）。OAuth の道（login-routes.ts）の外に置き、成功したら同じ completeLogin に合流する。
// 検査の順:
//   1. Origin が公開する URL と一致し、Sec-Fetch-Site があれば same-origin → 違えば 403 forbidden（数えず、本文も読まない）
//   2. Content-Type が JSON、本文が 4KiB まで、形が { email, password, return_to? } → 違えば 400 invalid_input（数えない）
//   3. レート制限（IP の枠と、そろえたメールアドレスの SHA-256 の枠）→ 上限なら 429 rate_limited（ハッシュを回さない）
//   4. 照合。違うパスワード、無いメールアドレス、そろえ方に合わない入力は、どれも同じ 401 invalid_credentials で、
//      どれもハッシュを今の回数で1回回す（無いときはダミーの値で）。応答の形と所要時間でメールアドレスの有無を見分けさせない
//   5. completeLogin。アカウントが無く、入れる組織も招待も無いことは、パスワードが合った後にだけ 403 forbidden の details.reason（denied）で
//      伝える。結ぶ書き込みの失敗は 503 unavailable。成功は 200 { return_to } とセッションの Cookie
// パスワード、ハッシュ、メールアドレスはログにも応答にも出さない。
// 人が差分を読む領域（docs/development.md の「マージの判定」）
import { Hono, type Context } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { z } from 'zod';
import { normalizeEmail } from '../../shared/email.ts';
import { normalizePassword } from '../../shared/password.ts';
import { resolvedReturnTo, safeReturnTo } from '../../shared/return-to.ts';
import { sessionCookieName, sessionCookieOptions } from '../../shared/session-cookie.ts';
import type { AppEnv } from '../app-env.ts';
import { commonDb } from '../db/index.ts';
import { ApiError } from '../errors.ts';
import { readBodyText, requireOrigin } from '../operations/guards.ts';
import { completeLogin } from './login.ts';
import { hashPassword, passwordHashNeedsUpgrade, verifyDummyPassword, verifyPassword } from './password-hash.ts';
import { consumePasswordLoginRateLimits } from './rate-limit.ts';
import { sha256Hex } from './tokens.ts';

export const PASSWORD_LOGIN_MAX_BODY_BYTES = 4096;

const PROVIDER = 'password';

// 値の長さは本文の上限で抑える。そろえ方（メールアドレスとパスワード）に合わない値は 400 にせず、照合で 401 にする
const loginBodySchema = z
  .object({
    email: z.string(),
    password: z.string(),
    return_to: z.string().optional(),
  })
  .strict();

// ログの1行。login-routes.ts の log と同じ形。パスワード、ハッシュ、メールアドレスは出さない
function log(c: Context<AppEnv>, entry: { outcome: string; accountId?: string }): void {
  console.log(
    JSON.stringify({
      level: 'info',
      requestId: c.get('requestId'),
      route: 'auth',
      step: 'login',
      provider: PROVIDER,
      ...entry,
    }),
  );
}

// Origin が公開する URL と一致し、Sec-Fetch-Site があれば same-origin だけ（none のアドレス欄やほかのサイトからの送信を断る）
function requireSameOrigin(c: Context<AppEnv>): void {
  requireOrigin(c);
  const site = c.req.header('Sec-Fetch-Site');
  if (site !== undefined && site !== 'same-origin') throw new ApiError(403, 'forbidden');
}

async function readLoginBody(c: Context<AppEnv>): Promise<z.output<typeof loginBodySchema>> {
  const contentType = c.req.header('Content-Type')?.split(';')[0]?.trim().toLowerCase();
  if (contentType !== 'application/json') throw new ApiError(400, 'invalid_input');
  let body: unknown;
  try {
    body = JSON.parse(await readBodyText(c, PASSWORD_LOGIN_MAX_BODY_BYTES));
  } catch {
    // 大きすぎる本文（readBodyText の 413）も、壊れた JSON も、同じ 400 にする
    throw new ApiError(400, 'invalid_input');
  }
  const parsed = loginBodySchema.safeParse(body);
  // 誰でも呼べる口なので、どの項目が合わないか（details）は返さない
  if (!parsed.success) throw new ApiError(400, 'invalid_input');
  return parsed.data;
}

type Credential = { login_subject: string; password_hash: string; display_name: string };

async function findCredential(env: Env, email: string): Promise<Credential | undefined> {
  const db = commonDb(env);
  return db.first(
    db.statement((q) =>
      q
        .selectFrom('password_credentials')
        .select(['login_subject', 'password_hash', 'display_name'])
        .where('email', '=', email),
    ),
  );
}

// 照合する。合えば資格情報の行を返す。合わないとき、照合する相手が無いときは undefined。どの道もハッシュを1回回す
async function verifyCredential(
  env: Env,
  email: string | undefined,
  password: string | undefined,
  rawPassword: string,
): Promise<Credential | undefined> {
  const credential = email === undefined ? undefined : await findCredential(env, email);
  if (credential === undefined || password === undefined) {
    await verifyDummyPassword(password ?? rawPassword);
    return undefined;
  }
  return (await verifyPassword(password, credential.password_hash)) ? credential : undefined;
}

// 保存した回数が今の回数より少なければ、今の回数で書き直す。失敗してもログインは止めない（次のログインでまた書き直す）。
// 照合の後に別のログインやパスワードの変更が書き直していれば、上書きしない
async function upgradeHashIfNeeded(c: Context<AppEnv>, credential: Credential, password: string, now: Date) {
  if (!passwordHashNeedsUpgrade(credential.password_hash)) return;
  try {
    const upgraded = await hashPassword(password);
    const db = commonDb(c.env);
    await db.batch([
      db.statement((q) =>
        q
          .updateTable('password_credentials')
          .set({ password_hash: upgraded, updated_at: now.toISOString() })
          .where('login_subject', '=', credential.login_subject)
          .where('password_hash', '=', credential.password_hash),
      ),
    ]);
  } catch (err) {
    // 例外の message に SQL や値が混ざりうるので、名前だけを残す
    console.error(
      JSON.stringify({
        level: 'error',
        code: 'internal',
        requestId: c.get('requestId'),
        route: 'auth',
        provider: PROVIDER,
        reason: 'パスワードのハッシュを今の回数で書き直せなかった',
        error: err instanceof Error ? err.name : typeof err,
      }),
    );
  }
}

export function passwordLoginRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.post('/login', async (c) => {
    try {
      requireSameOrigin(c);
    } catch (err) {
      log(c, { outcome: 'forbidden_origin' });
      throw err;
    }
    const body = await readLoginBody(c);

    const email = normalizeEmail(body.email);
    const emailHash = email === undefined ? undefined : await sha256Hex(email);
    if (!(await consumePasswordLoginRateLimits(c.env, c.req.header('CF-Connecting-IP'), emailHash, new Date()))) {
      log(c, { outcome: 'too_many' });
      throw new ApiError(429, 'rate_limited');
    }

    const password = normalizePassword(body.password);
    const credential = await verifyCredential(c.env, email, password, body.password);
    if (credential === undefined || password === undefined) {
      log(c, { outcome: 'invalid_credentials' });
      throw new ApiError(401, 'invalid_credentials');
    }

    const now = new Date();
    const sessionCookie = sessionCookieName(c.env.PUBLIC_ORIGIN);
    const outcome = await completeLogin(c.env, {
      provider: PROVIDER,
      profile: {
        subject: credential.login_subject,
        loginName: credential.display_name,
        displayName: credential.display_name,
        avatarUrl: null,
      },
      now,
      replacedSessionToken: getCookie(c, sessionCookie),
      requestId: c.get('requestId'),
    });
    if (!outcome.ok) {
      log(c, { outcome: outcome.reason });
      if (outcome.reason === 'denied') {
        throw new ApiError(403, 'forbidden', { reason: outcome.reason });
      }
      throw new ApiError(503, 'unavailable');
    }
    await upgradeHashIfNeeded(c, credential, password, now);
    setCookie(c, sessionCookie, outcome.sessionToken, sessionCookieOptions(c.env.PUBLIC_ORIGIN));
    log(c, { outcome: 'ok', accountId: outcome.accountId });
    // 戻る先は、自分のオリジンのパスであることを URL の解決の後でもう一度確かめてから返す。画面はこの値へ移る
    return c.json({
      return_to: resolvedReturnTo(safeReturnTo(body.return_to), new URL(c.env.PUBLIC_ORIGIN).origin),
    });
  });

  return app;
}
