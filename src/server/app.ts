import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { routePath } from 'hono/route';
import type { Health } from '../shared/health.ts';
import { apiCacheControl, apiCsp, fixedHeaders } from '../shared/security-headers.ts';
import { isAllowedPublicOrigin } from '../shared/session-cookie.ts';
import type { AppEnv } from './app-env.ts';
import { loginRoutes } from './auth/login-routes.ts';
import { operatorLoginIds } from './auth/operators.ts';
import { passwordLoginRoutes } from './auth/password-login.ts';
import { clientErrorRoutes } from './client-errors.ts';
import { DatabaseUnavailableError, pingDatabase } from './db/index.ts';
import { applyDevClock } from './dev-clock.ts';
import { errorBody, knownError } from './errors.ts';
import type { ImplementedOperation } from './operations/implement.ts';
import { implementedOperations } from './operations/index.ts';
import { operationsApp } from './operations/register.ts';

export type AppOptions = {
  // ログインの手段（GitHub）への通信。テストが差し替える
  fetcher?: typeof fetch;
};

// テストで例外を投げるルートや仮の操作を足せるよう、アプリを作る関数にしておく
export function createApp(
  operations: readonly ImplementedOperation[] = implementedOperations,
  options: AppOptions = {},
) {
  const app = new Hono<AppEnv>().basePath('/api');

  app.use(async (c, next) => {
    c.set('requestId', c.req.header('cf-ray') ?? crypto.randomUUID());
    await next();
  });

  // 404 と 500 の応答にも付くよう、next の後で付ける
  app.use(async (c, next) => {
    await next();
    // fetch() の応答などヘッダーを書き換えられない Response でも付けられるよう、作り直してから付ける
    c.res = new Response(c.res.body, c.res);
    for (const [name, value] of Object.entries(fixedHeaders)) {
      c.res.headers.set(name, value);
    }
    c.res.headers.set('Content-Security-Policy', apiCsp);
    c.res.headers.set('Cache-Control', apiCacheControl);
  });

  // 運用者の一覧に形の合わない項目があれば、すべてのリクエストを 500 にする。運用者でない人に運用者の権限を渡さないため、
  // 起動を止める代わりに、デプロイの煙のテスト（/api/health）で見つけさせる。値は出さず、項目の位置だけをログに出す
  app.use(async (c, next) => {
    const operators = operatorLoginIds(c.env);
    if (operators.ok) return next();
    console.error(
      JSON.stringify({
        level: 'error',
        code: 'internal',
        requestId: c.get('requestId'),
        reason: 'OPERATOR_LOGIN_IDS に形の合わない項目がある',
        invalidPositions: operators.invalidPositions,
      }),
    );
    return c.json(errorBody('internal', 'internal error'), 500);
  });

  // 公開する URL は、https か、手元のループバックのホストへの http だけ。ほかの http だと、Cookie の Secure と `__Host-` が
  // 黙って外れるので、すべてのリクエストを 500 にして、デプロイの煙のテスト（/api/health）で見つけさせる
  app.use(async (c, next) => {
    if (isAllowedPublicOrigin(c.env.PUBLIC_ORIGIN)) return next();
    console.error(
      JSON.stringify({
        level: 'error',
        code: 'internal',
        requestId: c.get('requestId'),
        reason: 'PUBLIC_ORIGIN が https でも、手元のホストへの http でもない',
      }),
    );
    return c.json(errorBody('internal', 'internal error'), 500);
  });

  // 開発用の時計（DEV_NOW）。ループバックへの http でない公開 URL（本番）に値があるか、値が解釈できなければ、
  // API のすべてのリクエストを 500 にして（画面の資産は Worker を通らない）、デプロイの煙のテスト（/api/health）で
  // 見つけて前の版へ戻させる。起動は止めない。値は出さない。
  // now() を使う処理より前に置く（時計を、このリクエストの env に合わせる）
  app.use(async (c, next) => {
    const clock = applyDevClock(c.env);
    if (clock.ok) return next();
    console.error(
      JSON.stringify({
        level: 'error',
        code: 'internal',
        requestId: c.get('requestId'),
        reason:
          clock.reason === 'not_local'
            ? 'DEV_NOW が、手元のホストへの http でない PUBLIC_ORIGIN で設定されている'
            : 'DEV_NOW が解釈できない',
      }),
    );
    return c.json(errorBody('internal', 'internal error'), 500);
  });

  // 煙のテスト（scripts/deploy.ts）が読む。D1 に届かないときは 503 にして、新しい版の失敗として拾わせる
  app.get('/health', async (c) => {
    try {
      await pingDatabase(c.env);
    } catch (err) {
      // 送るのに失敗したときだけ 503 にする。文の組み立ての誤りなどは握りつぶさず、onError の 500 にする
      if (!(err instanceof DatabaseUnavailableError)) throw err;
      // 中身は出さない。D1 の例外の message には SQL や接続の詳細が混ざりうる
      console.error(
        JSON.stringify({
          level: 'error',
          code: 'unavailable',
          requestId: c.get('requestId'),
          method: c.req.method,
          route: routePath(c),
          error: err.cause instanceof Error ? err.cause.name : typeof err.cause,
        }),
      );
      return c.json(errorBody('unavailable', 'database unavailable'), 503);
    }
    const body: Health = { status: 'ok', database: 'ok', version: c.env.APP_VERSION || 'dev' };
    return c.json(body);
  });

  // ログインの開始と戻り先。ブラウザの GET の移動と、招待の URL の画面のフォームの POST（POST /api/auth/google/start）なので、
  // 操作の定義の外に直に書く（/api/health と同じ例外）
  const fetcher = options.fetcher ?? ((input, init) => fetch(input, init));
  app.route('/auth/password', passwordLoginRoutes());
  app.route('/auth', loginRoutes({ fetcher }));

  // 画面で起きた JavaScript のエラーの送信。ログイン前の画面（ログイン、招待）のエラーも受けるので、操作の定義の外に直に書く
  app.route('/client-errors', clientErrorRoutes());

  // 操作の定義から登録するルート。ルートを直に書かない（/api/health、/api/auth/ の下の GET、POST /api/auth/google/start、
  // POST /api/client-errors だけが例外）
  app.route('/', operationsApp(operations, { fetcher }));

  app.notFound((c) => c.json(errorBody('not_found', 'not found'), 404));

  app.onError((err, c) => {
    const known = knownError(err);
    if (known) {
      // err.message は入力の一部を含みうるので返さない
      return c.json(
        errorBody(known.code, known.code.replaceAll('_', ' '), known.details),
        known.status as ContentfulStatusCode,
      );
    }
    // 中身は応答にもログにも出さない。例外の message と stack には入力の本文や認証情報が混ざりうる
    // （JSON.parse の失敗は入力の一部を message に含める）。パスも秘密を含みうるので、ルートの定義を出す
    console.error(
      JSON.stringify({
        level: 'error',
        code: 'internal',
        requestId: c.get('requestId'),
        method: c.req.method,
        route: routePath(c),
        error: err instanceof Error ? err.name : typeof err,
      }),
    );
    return c.json(errorBody('internal', 'internal error'), 500);
  });

  return app;
}
