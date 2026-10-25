import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { HTTPException } from 'hono/http-exception';
import { routePath } from 'hono/route';
import type { ErrorBody, ErrorCode } from '../shared/errors.ts';
import type { Health } from '../shared/health.ts';
import { apiCacheControl, apiCsp, fixedHeaders } from '../shared/security-headers.ts';

export type AppEnv = { Bindings: Env };

function errorBody(code: ErrorCode, message: string): ErrorBody {
  return { error: { code, message } };
}

// Hono の組み込みの処理（壊れた JSON の c.req.json()、バリデーター、bodyLimit など）が投げる HTTPException を、
// 決まった code に写す。ここに無い状態は想定外として 500 の internal にする
const httpExceptionCodes: Partial<Record<number, ErrorCode>> = {
  400: 'invalid_input',
  401: 'forbidden',
  403: 'forbidden',
  404: 'not_found',
  409: 'conflict',
  413: 'invalid_input',
  415: 'invalid_input',
  422: 'invalid_input',
};

// テストで例外を投げるルートを足せるよう、アプリを作る関数にしておく
export function createApp() {
  const app = new Hono<AppEnv>().basePath('/api');

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

  app.get('/health', (c) => {
    // rollback の実地の試し（#20 の手順6）。版をずらして本番の煙のテストを落とす。revert の PR で戻す
    const body: Health = { status: 'ok', version: `${c.env.APP_VERSION || 'dev'}-rollback-test` };
    return c.json(body);
  });

  app.notFound((c) => c.json(errorBody('not_found', 'not found'), 404));

  app.onError((err, c) => {
    const code = err instanceof HTTPException ? httpExceptionCodes[err.status] : undefined;
    if (code && err instanceof HTTPException) {
      // err.message は入力の一部を含みうるので返さない
      return c.json(errorBody(code, code.replaceAll('_', ' ')), err.status as ContentfulStatusCode);
    }
    // 中身は応答にもログにも出さない。例外の message と stack には入力の本文や認証情報が混ざりうる
    // （JSON.parse の失敗は入力の一部を message に含める）。パスも秘密を含みうるので、ルートの定義を出す
    console.error(
      JSON.stringify({
        level: 'error',
        code: 'internal',
        requestId: c.req.header('cf-ray') ?? null,
        method: c.req.method,
        route: routePath(c),
        error: err instanceof Error ? err.name : typeof err,
      }),
    );
    return c.json(errorBody('internal', 'internal error'), 500);
  });

  return app;
}
