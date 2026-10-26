// 401 の unauthenticated を受けたときの行き先（ログインの画面と約束した形）。
// 今のパスとクエリを return_to に入れ、ログインの後にそこへ戻す。戻す処理はログインの画面（と Worker）の受け持ち
import { isSuspendedUnauthenticated, type ErrorBody } from '../shared/errors.ts';
import { safeReturnTo } from '../shared/return-to.ts';

export const loginPath = '/login';

type Failure = { ok: boolean; error?: ErrorBody['error'] | null };

// return_to の検査は、ログインの後に戻す側（開始の API とログインの画面）と同じ関数に1つだけ持つ（src/shared/return-to.ts）。
// 作る側でも外へ向けた値を作らず、受け付けない値は `/` に落とす。
// 401 の応答（failures）のどれかが「入れる組織が停止している」ことを伝えていれば、ログインの画面に理由（error=suspended）を付ける。
// 同時に呼んだ操作のうち、セッションが消える前に読まれたものは理由を持たない 401 になるので、複数を渡せる
export function loginUrl(current: { pathname: string; search: string }, ...failures: Failure[]): string {
  const returnTo = `${loginPath}?return_to=${encodeURIComponent(safeReturnTo(current.pathname + current.search))}`;
  return failures.some((failure) => !failure.ok && isSuspendedUnauthenticated(failure.error))
    ? `${returnTo}&error=suspended`
    : returnTo;
}

export function isUnauthenticated(result: { ok: boolean; error?: { code: string } | null }): boolean {
  return !result.ok && result.error?.code === 'unauthenticated';
}
