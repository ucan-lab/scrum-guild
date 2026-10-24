import { Hono } from 'hono';
import type { ErrorBody, ErrorCode } from '../shared/errors.ts';
import type { Health } from '../shared/health.ts';
import { apiCacheControl, apiCsp, fixedHeaders } from '../shared/security-headers.ts';

export type AppEnv = { Bindings: Env };

function errorBody(code: ErrorCode, message: string): ErrorBody {
  return { error: { code, message } };
}

// テストで例外を投げるルートを足せるよう、アプリを作る関数にしておく
export function createApp() {
  const app = new Hono<AppEnv>().basePath('/api');

  // 404 と 500 の応答にも付くよう、next の後で付ける
  app.use(async (c, next) => {
    await next();
    for (const [name, value] of Object.entries(fixedHeaders)) {
      c.res.headers.set(name, value);
    }
    c.res.headers.set('Content-Security-Policy', apiCsp);
    c.res.headers.set('Cache-Control', apiCacheControl);
  });

  app.get('/health', (c) => {
    const body: Health = { status: 'ok', version: c.env.APP_VERSION || 'dev' };
    return c.json(body);
  });

  app.notFound((c) => c.json(errorBody('not_found', 'not found'), 404));

  app.onError((err, c) => {
    // 中身は応答に出さず、ログにだけ出す
    console.error(
      JSON.stringify({
        level: 'error',
        code: 'internal',
        requestId: c.req.header('cf-ray') ?? null,
        method: c.req.method,
        path: c.req.path,
        error: err instanceof Error ? { name: err.name, message: err.message, stack: err.stack } : String(err),
      }),
    );
    return c.json(errorBody('internal', 'internal error'), 500);
  });

  return app;
}
