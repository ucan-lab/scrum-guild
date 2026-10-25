// 開発用の時計（docs/development.md の「開発とテストでのログイン」）。.dev.vars の DEV_NOW があれば、now() はその時刻を
// 返し続ける。値は wrangler types が .dev.vars のあるときだけ型に出すので、型に頼らず、値の有無を見る
import { parseDevNow, setFixedNow } from '../shared/clock.ts';
import { isLoopbackHttpOrigin } from '../shared/session-cookie.ts';

export type DevClock =
  | { ok: true }
  // 本番の設定（ループバックの http でない公開 URL）に DEV_NOW がある。値は持たない
  | { ok: false; reason: 'not_local' | 'invalid' };

// リクエストごとに呼ぶ。DEV_NOW が無ければ本物の時計に戻す（env の違う呼び出しが同じ Worker に続いても、前の値を残さない）。
// 本番の守り: DEV_NOW があるのに公開 URL がループバックへの http でなければ、時計に触らず失敗を返す。
// 空の値も「ある」として扱う（空でも本番に残っていれば、置き間違いに気づかせる）
export function applyDevClock(env: object): DevClock {
  const raw = 'DEV_NOW' in env ? env.DEV_NOW : undefined;
  if (raw === undefined) {
    setFixedNow(undefined);
    return { ok: true };
  }
  const publicOrigin = 'PUBLIC_ORIGIN' in env ? env.PUBLIC_ORIGIN : undefined;
  if (!isLoopbackHttpOrigin(publicOrigin)) {
    setFixedNow(undefined);
    return { ok: false, reason: 'not_local' };
  }
  const parsed = parseDevNow(raw);
  if (!parsed.ok) {
    setFixedNow(undefined);
    return { ok: false, reason: 'invalid' };
  }
  setFixedNow(parsed.at);
  return { ok: true };
}
