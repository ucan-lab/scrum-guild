// セッションの Cookie（docs/data-model.md の `sessions`）。読むのは src/server/operations/、発行するのは src/server/auth/ のログインの処理。
// 発行と、使うたびの有効期限の延ばしが同じ名前と属性になるよう、ここに1つだけ持つ

// セッションが切れるまでの日数（最後に使ってから）
export const SESSION_LIFETIME_DAYS = 30;

const SECONDS_PER_DAY = 24 * 60 * 60;

// 公開する URL（PUBLIC_ORIGIN）が https か。http は手元の localhost（pnpm dev、pnpm preview）だけで、
// Safari などが Secure の Cookie を http の localhost では保存しない。https では Secure と `__Host-` を付け、
// http では付けない。ログインの途中の state の Cookie（src/server/auth/oauth-state.ts）も同じ扱いにする。
// 綴りだけで決めると、本番の設定が http になっても Secure が黙って外れるので、http を許すのは下の isAllowedPublicOrigin が
// 通す手元のホストだけにし、app のミドルウェアが起動時に検査する（src/server/app.ts）
export function isSecureOrigin(publicOrigin: string): boolean {
  return new URL(publicOrigin).protocol === 'https:';
}

// http で公開してよいのは、手元で動かすときのループバックのホストだけ（URL の hostname は IPv6 を `[::1]` で返す）
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);

// 公開する URL として使ってよいか: https か、ループバックのホストへの http。解釈できない値は使えない
export function isAllowedPublicOrigin(publicOrigin: unknown): boolean {
  if (typeof publicOrigin !== 'string') return false;
  try {
    const url = new URL(publicOrigin);
    return url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname));
  } catch {
    return false;
  }
}

export function sessionCookieOptions(publicOrigin: string) {
  return {
    httpOnly: true,
    secure: isSecureOrigin(publicOrigin),
    sameSite: 'Lax',
    path: '/',
    maxAge: SESSION_LIFETIME_DAYS * SECONDS_PER_DAY,
  } as const;
}

// Cookie を消すときの属性。`__Host-` の名前は Secure と Path=/ が要るので、発行と同じ値を渡す
export function sessionCookieClearOptions(publicOrigin: string) {
  return { secure: isSecureOrigin(publicOrigin), path: '/' } as const;
}

// Cookie に入れるトークンの形（32 バイトの乱数の base64url、43文字）
export const SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

// Cookie の名前は公開する URL で決める。https では `__Host-` を付け、サブドメインや http の側から上書きされないようにする
// （Secure、Path=/、Domain なしを、ブラウザが名前で強制する）。http の localhost では、上の理由で付けない
export function sessionCookieName(publicOrigin: string): string {
  return isSecureOrigin(publicOrigin) ? '__Host-sg_session' : 'sg_session';
}
