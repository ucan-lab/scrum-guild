import { isErrorBody, type ErrorBody } from '../shared/errors.ts';
import { isHealth, type Health } from '../shared/health.ts';

export type ApiResult<T> = { ok: true; data: T } | { ok: false; status: number; error: ErrorBody['error'] | null };

export async function getHealth(fetcher: typeof fetch = fetch): Promise<ApiResult<Health>> {
  const res = await fetcher('/api/health');
  const body: unknown = await res.json().catch(() => null);
  // 200 でも形が違えば失敗として扱う（転送が効かず index.html が返ったときなど）
  if (res.ok && isHealth(body)) return { ok: true, data: body };
  return { ok: false, status: res.status, error: isErrorBody(body) ? body.error : null };
}
