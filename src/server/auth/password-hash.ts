// パスワードのハッシュ（Issue #256）。PBKDF2-HMAC-SHA256、16 バイトの塩、32 バイトの鍵。
// 文字列は `pbkdf2-sha256$<反復回数>$<塩の base64url>$<鍵の base64url>`
// 入れ物。中身は実装の書き手が書く
/* eslint-disable @typescript-eslint/no-unused-vars -- 入れ物の間だけ。実装で外す */

export const PASSWORD_HASH_ITERATIONS = 100_000;

export function hashPassword(_password: string, _iterations: number = PASSWORD_HASH_ITERATIONS): Promise<string> {
  throw new Error('未実装');
}

export function verifyPassword(_password: string, _stored: string): Promise<boolean> {
  throw new Error('未実装');
}

export function verifyDummyPassword(_password: string): Promise<false> {
  throw new Error('未実装');
}

export function passwordHashNeedsUpgrade(_stored: string): boolean {
  throw new Error('未実装');
}
