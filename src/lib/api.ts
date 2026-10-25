import { isErrorBody, type ErrorBody } from '../shared/errors.ts';
import { isHealth, type Health } from '../shared/health.ts';
import {
  operationPath,
  type AnyOperationDefinition,
  type InputOf,
  type OutputOf,
  type OutsideOperationDefinition,
} from '../shared/operations/define.ts';

export type ApiResult<T> = { ok: true; data: T } | { ok: false; status: number; error: ErrorBody['error'] | null };

type CallOptions = { fetcher?: typeof fetch };

// 組織の中の操作は slug を要る。組織の外の操作は要らない
type CallArguments<D extends AnyOperationDefinition> = D extends OutsideOperationDefinition
  ? [options?: CallOptions]
  : [options: CallOptions & { slug: string }];

// 操作を呼ぶ。入力と出力の型は定義から決まる。出力が定義の形でなければ失敗として扱う（転送が効かず index.html が返ったときなど）
export async function callOperation<D extends AnyOperationDefinition>(
  definition: D,
  input: InputOf<D>,
  ...[options]: CallArguments<D>
): Promise<ApiResult<OutputOf<D>>> {
  const fetcher = options?.fetcher ?? fetch;
  const slug = options !== undefined && 'slug' in options ? options.slug : undefined;
  let res: Response;
  try {
    res = await fetcher(operationPath(definition, slug), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
  } catch {
    return { ok: false, status: 0, error: null };
  }
  const body: unknown = await res.json().catch(() => null);
  if (res.ok) {
    const parsed = definition.output.safeParse(body);
    if (parsed.success) return { ok: true, data: parsed.data as OutputOf<D> };
  }
  return { ok: false, status: res.status, error: isErrorBody(body) ? body.error : null };
}

export async function getHealth(fetcher: typeof fetch = fetch): Promise<ApiResult<Health>> {
  const res = await fetcher('/api/health');
  const body: unknown = await res.json().catch(() => null);
  // 200 でも形が違えば失敗として扱う（転送が効かず index.html が返ったときなど）
  if (res.ok && isHealth(body)) return { ok: true, data: body };
  return { ok: false, status: res.status, error: isErrorBody(body) ? body.error : null };
}
