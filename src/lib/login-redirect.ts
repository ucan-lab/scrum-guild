// 401 の unauthenticated を受けたときの行き先（ログインの画面と約束した形）。
// 今のパスとクエリを return_to に入れ、ログインの後にそこへ戻す。戻す処理はログインの画面（と Worker）の受け持ち
import { safeReturnTo } from '../shared/return-to.ts';

export const loginPath = '/login';

// return_to の検査は、ログインの後に戻す側（開始の API とログインの画面）と同じ関数に1つだけ持つ（src/shared/return-to.ts）。
// 作る側でも外へ向けた値を作らず、受け付けない値は `/` に落とす。ログインの画面に付ける理由は無い
export function loginUrl(current: { pathname: string; search: string }): string {
  return `${loginPath}?return_to=${encodeURIComponent(safeReturnTo(current.pathname + current.search))}`;
}

// 403 の terms_required（今の版の規約に同意していない）を受けたときの行き先。同意の画面（/consent）が、
// 同意した後に return_to へ戻す。return_to の作り方は loginUrl と同じ
export function consentUrl(current: { pathname: string; search: string }): string {
  return `/consent?return_to=${encodeURIComponent(safeReturnTo(current.pathname + current.search))}`;
}

export function isTermsRequired(result: { ok: boolean; error?: { code: string } | null }): boolean {
  return !result.ok && result.error?.code === 'terms_required';
}

export function isUnauthenticated(result: { ok: boolean; error?: { code: string } | null }): boolean {
  return !result.ok && result.error?.code === 'unauthenticated';
}
