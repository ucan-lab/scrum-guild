// ログインの画面の、メールアドレスとパスワードでのログイン（POST /api/auth/password/login、src/server/auth/password-login.ts）。
// 操作の定義の外の口なので callOperation を通さず、同じオリジンへ fetch で JSON を送る。
// 成功なら戻る先（自分のサイトのパス）を、失敗なら出す文言のキーを返す。文言は OAuth の ?error= と同じものを使い、
// 401 だけは「メールアドレスかパスワードが違います」の1つの文言にする（違うパスワードと無いメールアドレスを分けない）
import { isErrorBody, type ErrorBody } from '../shared/errors.ts';
import { safeReturnTo } from '../shared/return-to.ts';
import type { DictionaryKey } from '../shared/vocabulary.ts';

export const PASSWORD_LOGIN_PATH = '/api/auth/password/login';

export type PasswordLoginInput = { email: string; password: string; returnTo: string };

export type PasswordLoginOutcome = { ok: true; returnTo: string } | { ok: false; message: DictionaryKey };

function reasonOf(error: ErrorBody['error'] | null): unknown {
  const details = error?.details;
  return typeof details === 'object' && details !== null && 'reason' in details ? details.reason : undefined;
}

// 失敗の応答から出す文言。403 は、パスワードが合った後に入れる組織が無いときだけ details.reason（denied、suspended）が付く
export function passwordLoginErrorMessage(status: number, error: ErrorBody['error'] | null): DictionaryKey {
  if (status === 401) return 'loginErrorInvalidCredentials';
  if (status === 403) {
    const reason = reasonOf(error);
    // 文言は OAuth の denied と同じ事情を伝えるが、招待された手段（GitHub か Google）を確かめる案内は外す
    if (reason === 'denied') return 'loginErrorDeniedPassword';
    if (reason === 'suspended') return 'loginErrorSuspended';
  }
  if (status === 429) return 'loginErrorTooMany';
  return 'loginErrorUnavailable';
}

export async function submitPasswordLogin(
  input: PasswordLoginInput,
  fetcher: typeof fetch = fetch,
): Promise<PasswordLoginOutcome> {
  let res: Response;
  try {
    res = await fetcher(PASSWORD_LOGIN_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ email: input.email, password: input.password, return_to: input.returnTo }),
    });
  } catch {
    return { ok: false, message: 'loginErrorUnavailable' };
  }
  const body: unknown = await res.json().catch(() => null);
  if (res.ok) {
    const returnTo =
      typeof body === 'object' && body !== null && 'return_to' in body ? safeReturnTo(body.return_to) : undefined;
    // 200 でも形が違えば失敗として扱う（転送が効かず index.html が返ったときなど）
    return returnTo === undefined ? { ok: false, message: 'loginErrorUnavailable' } : { ok: true, returnTo };
  }
  return { ok: false, message: passwordLoginErrorMessage(res.status, isErrorBody(body) ? body.error : null) };
}
