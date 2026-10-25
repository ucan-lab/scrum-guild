// セッションの Cookie（docs/data-model.md の `sessions`）。読むのは src/server/operations/、発行するのはログインの処理（#52）。
// 発行と、使うたびの有効期限の延ばしが同じ属性になるよう、ここに1つだけ持つ

export const SESSION_COOKIE_NAME = 'sg_session';

// セッションが切れるまでの日数（最後に使ってから）
export const SESSION_LIFETIME_DAYS = 30;

const SECONDS_PER_DAY = 24 * 60 * 60;

export const sessionCookieOptions = {
  httpOnly: true,
  secure: true,
  sameSite: 'Lax',
  path: '/',
  maxAge: SESSION_LIFETIME_DAYS * SECONDS_PER_DAY,
} as const;

// Cookie に入れるトークンの形（32 バイトの乱数の base64url、43文字）
export const SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
