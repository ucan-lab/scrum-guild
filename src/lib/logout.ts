// ログアウトの結果の振り分け。成功と、401 の unauthenticated（もうセッションが無い）なら「移る」、
// 通信の失敗（status 0）、5xx、そのほかなら「留まる」。
// 留まるのは、Cookie と sessions の行が残ったまま /login へ移すと、ログアウトできたように見えるため（共有の端末で危ない）。
// callOperation の結果の形（ApiResult）のうち、振り分けに使う部分だけを受ける
export type LogoutResult = { ok: true } | { ok: false; status: number; error: { code: string } | null };

export type LogoutOutcome = 'leave' | 'stay';

export const loggedOutPath = '/login?logged_out=1';

export function logoutOutcome(result: LogoutResult): LogoutOutcome {
  if (result.ok) return 'leave';
  return result.status === 401 && result.error?.code === 'unauthenticated' ? 'leave' : 'stay';
}
