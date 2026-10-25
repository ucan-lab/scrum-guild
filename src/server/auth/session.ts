// セッションを読み、作り、消す（docs/data-model.md の `sessions`）。
// 人が差分を読む領域（docs/development.md の「マージの判定」）
import { SESSION_LIFETIME_DAYS, SESSION_TOKEN_PATTERN } from '../../shared/session-cookie.ts';
import { commonDb, type CommonDb, type Statement } from '../db/index.ts';
import { randomToken } from './tokens.ts';

// last_used_at を書き直すのは、前回から1時間以上たったときだけ。書き込みを減らすため
const REFRESH_AFTER_MS = 60 * 60 * 1000;
const LIFETIME_MS = SESSION_LIFETIME_DAYS * 24 * 60 * 60 * 1000;

export type Session = {
  accountId: string;
  // sessions.token_hash。ログアウトが今のセッションの行を指すのに使う
  tokenHash: string;
  // last_used_at と expires_at を書き直した。Cookie の期限も延ばす
  refreshed: boolean;
};

// Cookie の値は、ハッシュする前のランダムな ID。DB にはその SHA-256 の小文字の16進だけを持つ
export async function hashSessionToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

// 無いか、形が違うか、切れているときは undefined。期限を過ぎた行は入れず、書き直しもしない。
// 書き直しは読んだ last_used_at が変わっていないときだけ書く。並行した呼び出しの片方だけが書き、日時が巻き戻らない。
// 書き直しに失敗しても、セッションは読めているのでリクエストは続ける
export async function readSession(
  env: Env,
  token: string | undefined,
  now: Date,
  requestId: string,
): Promise<Session | undefined> {
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
  if (idleMs < REFRESH_AFTER_MS) return { accountId: row.account_id, tokenHash, refreshed: false };

  try {
    const [result] = await db.batch([
      db.statement((q) =>
        q
          .updateTable('sessions')
          .set({ last_used_at: now.toISOString(), expires_at: new Date(now.getTime() + LIFETIME_MS).toISOString() })
          .where('token_hash', '=', tokenHash)
          .where('last_used_at', '=', row.last_used_at),
      ),
    ]);
    return { accountId: row.account_id, tokenHash, refreshed: result.changes === 1 };
  } catch (err) {
    // 例外の message に SQL や接続の詳細が混ざりうるので、名前だけを残す
    console.error(
      JSON.stringify({
        level: 'error',
        code: 'internal',
        requestId,
        reason: 'セッションの書き直しに失敗した',
        error: err instanceof Error ? err.name : typeof err,
      }),
    );
    return { accountId: row.account_id, tokenHash, refreshed: false };
  }
}

// セッションを作り、Cookie に入れるトークンを返す。DB には SHA-256 のハッシュだけを入れ、トークンは残さない。
// replacedToken は、このリクエストが持っていた古いセッションの Cookie の値。ログインし直したら同じ書き込みで消す。
// 期限（expires_at）は呼び出しの時刻 now から30日。作成の時刻（created_at と last_used_at）は、挿入の直前の時刻にする。
// ログインできる条件を失ったと判定した時刻より後に作ったセッションを、その判定が消さないため（deleteSessionsOf）
export async function createSession(
  env: Env,
  accountId: string,
  now: Date,
  replacedToken: string | undefined,
): Promise<string> {
  const token = randomToken();
  const tokenHash = await hashSessionToken(token);
  const replacedHash =
    replacedToken !== undefined && SESSION_TOKEN_PATTERN.test(replacedToken)
      ? await hashSessionToken(replacedToken)
      : undefined;
  const createdAt = new Date().toISOString();
  const db = commonDb(env);
  const statements: Statement<'common'>[] = [
    db.statement((q) =>
      q.insertInto('sessions').values({
        token_hash: tokenHash,
        account_id: accountId,
        created_at: createdAt,
        last_used_at: createdAt,
        expires_at: new Date(now.getTime() + LIFETIME_MS).toISOString(),
      }),
    ),
  ];
  if (replacedHash !== undefined) {
    statements.push(db.statement((q) => q.deleteFrom('sessions').where('token_hash', '=', replacedHash)));
  }
  await db.batch(statements);
  return token;
}

// その人のセッションを消す。ログインできる条件を失ったと判定した時刻（checkedAt）までに作られたものだけ。
// 判定の後に、その人が入れる条件を満たして作ったセッション（ログインし直した直後など）を消さないため
export async function deleteSessionsOf(db: CommonDb, accountId: string, checkedAt: Date): Promise<void> {
  await db.batch([
    db.statement((q) =>
      q.deleteFrom('sessions').where('account_id', '=', accountId).where('created_at', '<=', checkedAt.toISOString()),
    ),
  ]);
}
