// 招待の URL の秘密を、ログインを始めるフォームの POST の本文から読む（docs/data-model.md の「メールアドレスで待つ指名と招待」の 3）。
// 秘密は URL のフラグメントにだけ置くもので、サーバーに届くのはこの本文だけ。URL のクエリでは受けない
import { CLAIM_TOKEN_FIELD, CLAIM_TOKEN_PATTERN } from '../../shared/claim-token.ts';

// 欄は1つ（`claim_token=` と43文字）で57バイト。これを大きく超える本文は読まずに断る
const MAX_FORM_BYTES = 1024;

async function readLimitedText(request: Request): Promise<string | undefined> {
  const declared = request.headers.get('Content-Length');
  if (declared !== null && Number(declared) > MAX_FORM_BYTES) return undefined;
  const body = request.body;
  if (body === null) return undefined;
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > MAX_FORM_BYTES) {
      await reader.cancel();
      return undefined;
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

// 決まった形（base64url の43文字）の秘密だけを返す。形が違う、欄が無い・複数ある、本文が
// application/x-www-form-urlencoded でない、大きすぎるときは undefined。呼び出し側は、ハッシュも DB の問い合わせもせずに断る
export async function readClaimToken(request: Request): Promise<string | undefined> {
  const contentType = request.headers.get('Content-Type')?.split(';')[0]?.trim().toLowerCase();
  if (contentType !== 'application/x-www-form-urlencoded') return undefined;
  const text = await readLimitedText(request);
  if (text === undefined) return undefined;
  const values = new URLSearchParams(text).getAll(CLAIM_TOKEN_FIELD);
  const [value] = values;
  return values.length === 1 && value !== undefined && CLAIM_TOKEN_PATTERN.test(value) ? value : undefined;
}
