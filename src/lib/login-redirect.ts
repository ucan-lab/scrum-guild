// 401 の unauthenticated を受けたときの行き先（#52 のログインの画面と約束した形）。
// 今のパスとクエリを return_to に入れ、ログインの後にそこへ戻す。戻す処理はログインの画面の受け持ち

export const loginPath = '/login';

export function loginUrl(current: { pathname: string; search: string }): string {
  return `${loginPath}?return_to=${encodeURIComponent(current.pathname + current.search)}`;
}

export function isUnauthenticated(result: { ok: boolean; error?: { code: string } | null }): boolean {
  return !result.ok && result.error?.code === 'unauthenticated';
}
