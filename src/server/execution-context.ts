// Hono は ExecutionContext が無い呼び出し（テストの app.request）で、c.executionCtx の取得が例外になる。
// 有無の判定はここだけに置く。登録の関数の応答の後の書き込み（defer）と、ログインのトークンの取り消しが使う
import type { Context } from 'hono';
import type { AppEnv } from './app-env.ts';

export function executionContextOf(c: Context<AppEnv>): Context<AppEnv>['executionCtx'] | undefined {
  try {
    return c.executionCtx;
  } catch {
    return undefined;
  }
}
