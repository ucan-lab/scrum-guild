// セッションを読む（docs/data-model.md の `sessions`）。作るのはログインの処理（#52）で、ここは既にあるものを引くだけ。
// 人が差分を読む領域（docs/development.md の「マージの判定」）
import { SESSION_LIFETIME_DAYS, SESSION_TOKEN_PATTERN } from '../../shared/session-cookie.ts';
import { commonDb } from '../db/index.ts';

// last_used_at を書き直すのは、前回から1時間以上たったときだけ。書き込みを減らすため
const REFRESH_AFTER_MS = 60 * 60 * 1000;
const LIFETIME_MS = SESSION_LIFETIME_DAYS * 24 * 60 * 60 * 1000;

export type Session = {
  accountId: string;
  // last_used_at と expires_at を書き直した。Cookie の期限も延ばす
  refreshed: boolean;
};

// Cookie の値は、ハッシュする前のランダムな ID。DB にはその SHA-256 の小文字の16進だけを持つ
export async function hashSessionToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

// 無いか、形が違うか、切れているときは undefined。期限を過ぎた行は入れず、書き直しもしない
export async function readSession(env: Env, token: string | undefined, now: Date): Promise<Session | undefined> {
  if (token === undefined || !SESSION_TOKEN_PATTERN.test(token)) return undefined;
  const tokenHash = await hashSessionToken(token);
  const db = commonDb(env);
  const row = await db.first(
    db.statement((q) =>
      q.selectFrom('sessions').select(['account_id', 'last_used_at', 'expires_at']).where('token_hash', '=', tokenHash),
    ),
  );
  if (row === undefined || row.expires_at <= now.toISOString()) return undefined;

  // 日時が読めない行は、書き直して直す
  const idleMs = now.getTime() - Date.parse(row.last_used_at);
  if (idleMs < REFRESH_AFTER_MS) return { accountId: row.account_id, refreshed: false };

  await db.batch([
    db.statement((q) =>
      q
        .updateTable('sessions')
        .set({ last_used_at: now.toISOString(), expires_at: new Date(now.getTime() + LIFETIME_MS).toISOString() })
        .where('token_hash', '=', tokenHash),
    ),
  ]);
  return { accountId: row.account_id, refreshed: true };
}
