// パスワードでのログイン（POST /api/auth/password/login、Issue #256）
// 入れ物。中身は実装の書き手が書く
import { Hono } from 'hono';
import type { AppEnv } from '../app-env.ts';

export function passwordLoginRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.post('/login', () => {
    throw new Error('未実装');
  });
  return app;
}
