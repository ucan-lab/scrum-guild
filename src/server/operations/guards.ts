// 登録の関数が操作の前に行う検査のうち、DB を引かないもの
import type { Context } from 'hono';
import type { z } from 'zod';
import { ApiError } from '../errors.ts';
import type { AppEnv } from '../app-env.ts';

const MAX_BODY_BYTES = 1024 * 1024;

// Origin が公開する URL と違う呼び出しを断る。すべての操作に掛ける。Origin の無い呼び出しも断る
// （ブラウザは POST に必ず Origin を付けるので、付いていないのは画面からの呼び出しではない）
export function requireOrigin(c: Context<AppEnv>): void {
  // 設定の誤りは握りつぶさず、new URL() の例外から 500 にする
  const allowed = new URL(c.env.PUBLIC_ORIGIN).origin;
  if (c.req.header('Origin') !== allowed) throw new ApiError(403, 'forbidden');
}

// 本文を上限まで読む。Content-Length が無い（chunked の）本文も、読んだ分を数えて上限で止める
async function readBodyText(c: Context<AppEnv>): Promise<string> {
  const declared = c.req.header('Content-Length');
  if (declared !== undefined && Number(declared) > MAX_BODY_BYTES) throw new ApiError(413, 'invalid_input');
  const body = c.req.raw.body;
  if (body === null) return '';
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new ApiError(413, 'invalid_input');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

// 入力は JSON の本文だけ。URL のクエリは読まない。Origin とセッションの検査の後に呼ぶ（未ログインの呼び出しに本文を読ませない）
export async function readInput<Schema extends z.ZodType>(
  c: Context<AppEnv>,
  schema: Schema,
): Promise<z.output<Schema>> {
  const contentType = c.req.header('Content-Type')?.split(';')[0]?.trim().toLowerCase();
  if (contentType !== 'application/json') throw new ApiError(400, 'invalid_input');
  let body: unknown;
  try {
    body = JSON.parse(await readBodyText(c));
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw new ApiError(400, 'invalid_input');
  }
  const parsed = schema.safeParse(body);
  if (parsed.success) return parsed.data;
  // 項目ごとの結果。message は zod の文で、入力の値は含めないが、入力のキーの名前は含みうる（未知のキーの指摘など）
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
