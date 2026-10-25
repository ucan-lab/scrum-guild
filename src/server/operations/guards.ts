// 登録の関数が操作の前に行う検査のうち、DB を引かないもの
import type { Context } from 'hono';
import type { z } from 'zod';
import { ApiError } from '../errors.ts';
import type { AppEnv } from '../app-env.ts';

// Origin が公開する URL と違う呼び出しを断る。すべての操作に掛ける。Origin の無い呼び出しも断る
// （ブラウザは POST に必ず Origin を付けるので、付いていないのは画面からの呼び出しではない）
export function requireOrigin(c: Context<AppEnv>): void {
  // 設定の誤りは握りつぶさず、new URL() の例外から 500 にする
  const allowed = new URL(c.env.PUBLIC_ORIGIN).origin;
  if (c.req.header('Origin') !== allowed) throw new ApiError(403, 'forbidden');
}

// 入力は JSON の本文だけ。URL のクエリは読まない
export async function readInput<Schema extends z.ZodType>(
  c: Context<AppEnv>,
  schema: Schema,
): Promise<z.output<Schema>> {
  const contentType = c.req.header('Content-Type')?.split(';')[0]?.trim().toLowerCase();
  if (contentType !== 'application/json') throw new ApiError(400, 'invalid_input');
  let body: unknown;
  try {
    body = JSON.parse(await c.req.text());
  } catch {
    throw new ApiError(400, 'invalid_input');
  }
  const parsed = schema.safeParse(body);
  if (parsed.success) return parsed.data;
  // 項目ごとの結果。message は zod の文で、入力の値は含めない
  throw new ApiError(
    400,
    'invalid_input',
    parsed.error.issues.map((issue) => ({
      path: issue.path.map(String).join('.'),
      code: issue.code,
      message: issue.message,
    })),
  );
}
