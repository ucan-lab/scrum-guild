import type { ErrorBody } from '../shared/errors.ts';
import { isErrorBody } from '../shared/errors.ts';
import type { Health } from '../shared/health.ts';

export type ApiResult<T> = { ok: true; data: T } | { ok: false; status: number; error: ErrorBody['error'] | null };

export async function getHealth(fetcher: typeof fetch = fetch): Promise<ApiResult<Health>> {
  const res = await fetcher('/api/health');
  const body: unknown = await res.json().catch(() => null);
  if (res.ok) return { ok: true, data: body as Health };
  return { ok: false, status: res.status, error: isErrorBody(body) ? body.error : null };
}
