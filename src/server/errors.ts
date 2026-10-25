// 応答にする失敗。操作の処理と登録の関数が投げ、app.onError が決まった形の応答にする（docs/development.md の「API のエラーとログ」）
import { HTTPException } from 'hono/http-exception';
import type { ErrorBody, ErrorCode } from '../shared/errors.ts';

export type ErrorStatus = 400 | 401 | 403 | 404 | 409 | 413 | 429;

// message は応答にそのまま出す値を持たない。code から作る
export class ApiError extends Error {
  readonly status: ErrorStatus;
  readonly code: ErrorCode;
  // 入力の誤りの項目ごとの結果など。応答の details になる
  readonly details?: unknown;

  constructor(status: ErrorStatus, code: ErrorCode, details?: unknown) {
    super(code);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function errorBody(code: ErrorCode, message: string, details?: unknown): ErrorBody {
  return { error: { code, message, ...(details === undefined ? {} : { details }) } };
}

// Hono の組み込みの処理（壊れた JSON の c.req.json()、バリデーター、bodyLimit など）が投げる HTTPException を、
// 決まった code に写す。ここに無い状態は想定外として 500 の internal にする
const httpExceptionCodes: Partial<Record<number, ErrorCode>> = {
  400: 'invalid_input',
  401: 'unauthenticated',
  403: 'forbidden',
  404: 'not_found',
  409: 'conflict',
  413: 'invalid_input',
  415: 'invalid_input',
  422: 'invalid_input',
  429: 'rate_limited',
};

export type KnownError = { status: number; code: ErrorCode; details?: unknown };

// 応答にしてよい失敗なら、その status と code を返す。それ以外（想定外の例外）は undefined
export function knownError(err: unknown): KnownError | undefined {
  if (err instanceof ApiError) return { status: err.status, code: err.code, details: err.details };
  if (err instanceof HTTPException) {
    const code = httpExceptionCodes[err.status];
    return code === undefined ? undefined : { status: err.status, code };
  }
  return undefined;
}
