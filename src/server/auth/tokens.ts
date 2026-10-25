// ログインで使う乱数の秘密（セッションのトークン、OAuth の state、PKCE の code_verifier）。
// どれも 32 バイトの乱数を base64url にした 43 文字。Cookie と DB に入れる形は docs/data-model.md の `sessions` と `oauth_states`

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
}

export function randomToken(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

// 秘密の値の比較。時間が一致の長さに依らない。長さが違えば、中身を比べずに false（長さは秘密ではない）
export function timingSafeEqualStrings(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  return left.byteLength === right.byteLength && crypto.subtle.timingSafeEqual(left, right);
}

// SHA-256 の小文字の16進（64文字）。DB に持つ秘密の写し（sessions.token_hash と同じ形）。招待の URL の秘密は claim_token_hash に入れる
export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

// PKCE（S256）の code_challenge。code_verifier の SHA-256 を base64url にしたもの
export async function codeChallenge(codeVerifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(codeVerifier));
  return base64url(new Uint8Array(digest));
}
