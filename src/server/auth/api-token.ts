// API トークンを発行し、読み、取り消し、掃除する（docs/data-model.md の `api_tokens`）。
// 人が差分を読む領域（docs/development.md の「マージの判定」）
import { API_TOKEN_MAX_LIFETIME_DAYS, API_TOKEN_PATTERN, type ApiTokenScope } from '../../shared/api-token.ts';
import { commonDb, type CommonDb, type Statement } from '../db/index.ts';
import { randomToken, sha256Hex } from './tokens.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

export type ApiToken = { accountId: string; tokenHash: string; scope: ApiTokenScope };

// 生の値は、ハッシュする前の `sgp_` + 乱数。DB にはこの SHA-256 の小文字の16進だけを持つ
export function hashApiToken(token: string): Promise<string> {
  return sha256Hex(token);
}

function isScope(value: string): value is ApiTokenScope {
  return value === 'read' || value === 'write';
}

// トークンを発行し、生の値を返す。生の値を返すのはこの1回だけで、DB にもログにも残さない。
// 期限は now から lifetimeDays 日後で固定。1〜90日（省略は90日）の整数以外は例外にして、行を作らない
export async function issueApiToken(
  env: Env,
  input: { accountId: string; name: string; scope: ApiTokenScope; now: Date; lifetimeDays?: number },
): Promise<string> {
  const lifetimeDays = input.lifetimeDays ?? API_TOKEN_MAX_LIFETIME_DAYS;
  if (!Number.isInteger(lifetimeDays) || lifetimeDays < 1 || lifetimeDays > API_TOKEN_MAX_LIFETIME_DAYS) {
    throw new Error(`API トークンの有効日数は 1〜${API_TOKEN_MAX_LIFETIME_DAYS} の整数`);
  }
  const raw = `sgp_${randomToken()}`;
  const tokenHash = await hashApiToken(raw);
  const db = commonDb(env);
  await db.batch([
    db.statement((q) =>
      q.insertInto('api_tokens').values({
        token_hash: tokenHash,
        account_id: input.accountId,
        name: input.name,
        scope: input.scope,
        created_at: input.now.toISOString(),
        last_used_at: null,
        expires_at: new Date(input.now.getTime() + lifetimeDays * DAY_MS).toISOString(),
        revoked_at: null,
      }),
    ),
  ]);
  return raw;
}

// 形が違う、無い、期限切れ（expires_at <= now）、取消済みは undefined。読めたら last_used_at を now に書き直す。
// expires_at は延ばさない（セッションと違い、使っても期限は変わらない）。
// 書き直しは、より新しい last_used_at を巻き戻さないよう、前の値が now より前のときだけ当てる
export async function readApiToken(env: Env, token: string | undefined, now: Date): Promise<ApiToken | undefined> {
  if (token === undefined || !API_TOKEN_PATTERN.test(token)) return undefined;
  const tokenHash = await hashApiToken(token);
  const db = commonDb(env);
  const row = await db.first(
    db.statement((q) =>
      q
        .selectFrom('api_tokens')
        .select(['account_id', 'scope', 'expires_at', 'revoked_at'])
        .where('token_hash', '=', tokenHash),
    ),
  );
  if (row === undefined || row.revoked_at !== null || row.expires_at <= now.toISOString()) return undefined;
  if (!isScope(row.scope)) return undefined;

  const usedAt = now.toISOString();
  try {
    await db.batch([
      db.statement((q) =>
        q
          .updateTable('api_tokens')
          .set({ last_used_at: usedAt })
          .where('token_hash', '=', tokenHash)
          .where((eb) => eb.or([eb('last_used_at', 'is', null), eb('last_used_at', '<', usedAt)])),
      ),
    ]);
  } catch (err) {
    // last_used_at は記録にすぎず、トークンは読めているのでリクエストは続ける（readSession の書き直しと同じ）。
    // 例外の message に SQL や接続の詳細が混ざりうるので、名前だけを残す
    console.error(
      JSON.stringify({
        level: 'error',
        code: 'internal',
        reason: 'トークンの last_used_at の書き込みに失敗した',
        error: err instanceof Error ? err.name : typeof err,
      }),
    );
  }
  return { accountId: row.account_id, tokenHash, scope: row.scope };
}

// その人のトークンを取り消す。ログインできる条件を失ったと判定した時刻（checkedAt）までに作られたものだけ。
// 判定の後に発行したトークンを、その判定が取り消さないため（deleteSessionsOf と同じ）。取り消し済みの行は書き直さない
export async function revokeApiTokensOf(db: CommonDb, accountId: string, checkedAt: Date): Promise<void> {
  await db.batch([revokeApiTokensStatement(db, accountId, checkedAt)]);
}

// revokeApiTokensOf の文。セッションの削除と1回の batch() で送る呼び出し（end-credentials.ts）が、条件を別に持たずに使う
export function revokeApiTokensStatement(db: CommonDb, accountId: string, checkedAt: Date): Statement<'common'> {
  return db.statement((q) =>
    q
      .updateTable('api_tokens')
      .set({ revoked_at: new Date().toISOString() })
      .where('account_id', '=', accountId)
      .where('revoked_at', 'is', null)
      .where('created_at', '<=', checkedAt.toISOString()),
  );
}

// 期限切れ（expires_at <= now）の行を消し、消した件数を返す。取り消し済みでも、期限が来るまでは残す。
// 手で発行する上限90日のトークンなので行は少なく、1文で消す
export async function deleteExpiredApiTokens(env: Env, now: Date): Promise<number> {
  const db = commonDb(env);
  const [result] = await db.batch([
    db.statement((q) => q.deleteFrom('api_tokens').where('expires_at', '<=', now.toISOString())),
  ]);
  return result.changes;
}
