// 401 の unauthenticated を受けたときの行き先（#52 のログインの画面と約束した形）。
// 今のパスとクエリを return_to に入れ、ログインの後にそこへ戻す。戻す処理はログインの画面の受け持ち

export const loginPath = '/login';

// return_to は自分のオリジンのパスだけにする。`//` と `/\` で始まる値は、ブラウザが別のオリジンとして解釈するので `/` に落とす
// （ログインの後に戻す側も検査するが、作る側でも外へ向けた値を作らない）
function safeReturnPath(path: string): string {
  if (!path.startsWith('/') || path.startsWith('//') || path.startsWith('/\\')) return '/';
  return path;
}

export function loginUrl(current: { pathname: string; search: string }): string {
  return `${loginPath}?return_to=${encodeURIComponent(safeReturnPath(current.pathname + current.search))}`;
}

export function isUnauthenticated(result: { ok: boolean; error?: { code: string } | null }): boolean {
  return !result.ok && result.error?.code === 'unauthenticated';
}
