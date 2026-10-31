// API トークンを発行し、読み、取り消し、掃除する（docs/data-model.md の `api_tokens`）。
// 人が差分を読む領域（docs/development.md の「マージの判定」）
import {
  API_TOKEN_LIMIT_REASON,
  API_TOKEN_MAX_ACTIVE,
  API_TOKEN_MAX_LIFETIME_DAYS,
  API_TOKEN_PATTERN,
  type ApiTokenScope,
} from '../../shared/api-token.ts';
import { commonDb, type CommonDb } from '../db/index.ts';
import { ApiError } from '../errors.ts';
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
  return (await issueApiTokenWith(commonDb(env), input)).raw;
}

export type IssuedApiToken = { raw: string; tokenHash: string; expiresAt: string };

// issueApiToken と同じ発行を、渡された共通の入口で行う（操作の処理は env を持たず、確かめた入口だけを受け取るため）。
// 一覧と応答に出す id（ハッシュ）と期限も返す
export async function issueApiTokenWith(
  db: CommonDb,
  input: { accountId: string; name: string; scope: ApiTokenScope; now: Date; lifetimeDays?: number },
): Promise<IssuedApiToken> {
  const lifetimeDays = input.lifetimeDays ?? API_TOKEN_MAX_LIFETIME_DAYS;
  if (!Number.isInteger(lifetimeDays) || lifetimeDays < 1 || lifetimeDays > API_TOKEN_MAX_LIFETIME_DAYS) {
    throw new Error(`API トークンの有効日数は 1〜${API_TOKEN_MAX_LIFETIME_DAYS} の整数`);
  }
  const raw = `sgp_${randomToken()}`;
  const tokenHash = await hashApiToken(raw);
  const expiresAt = new Date(input.now.getTime() + lifetimeDays * DAY_MS).toISOString();
  const createdAt = input.now.toISOString();
  // 有効な行の数の確かめと INSERT を1文にする。読んでから書くと、同時の発行が揃って上限を超える
  const [inserted] = await db.batch([
    db.statement((q) =>
      q
        .insertInto('api_tokens')
        .columns([
          'token_hash',
          'account_id',
          'name',
          'scope',
          'created_at',
          'last_used_at',
          'expires_at',
          'revoked_at',
        ])
        .expression(
          q
            .selectNoFrom((eb) => [
              eb.val(tokenHash).as('token_hash'),
              eb.val(input.accountId).as('account_id'),
              eb.val(input.name).as('name'),
              eb.val(input.scope).as('scope'),
              eb.val(createdAt).as('created_at'),
              eb.val(null).as('last_used_at'),
              eb.val(expiresAt).as('expires_at'),
              eb.val(null).as('revoked_at'),
            ])
            .where((eb) =>
              eb(
                eb
                  .selectFrom('api_tokens')
                  .select((count) => count.fn.countAll<number>().as('count'))
                  .where('account_id', '=', input.accountId)
                  .where('revoked_at', 'is', null)
                  .where('expires_at', '>', createdAt),
                '<',
                API_TOKEN_MAX_ACTIVE,
              ),
            ),
        ),
    ),
  ]);
  if (inserted.changes === 0) throw new ApiError(409, 'conflict', { reason: API_TOKEN_LIMIT_REASON });
  return { raw, tokenHash, expiresAt };
}

export type ListedApiToken = {
  id: string;
  name: string;
  scope: ApiTokenScope;
  created_at: string;
  last_used_at: string | null;
  expires_at: string;
};

// その人の、取り消していない、期限が来ていない（expires_at > now）トークンを、作った順の新しい方から返す。
// 値もハッシュ以外の秘密も返さない（id はハッシュで、取消に使う）。読むだけで last_used_at は書き直さない
export async function listApiTokensOf(db: CommonDb, accountId: string, now: Date): Promise<ListedApiToken[]> {
  const rows = await db.rows(
    db.statement((q) =>
      q
        .selectFrom('api_tokens')
        .select(['token_hash', 'name', 'scope', 'created_at', 'last_used_at', 'expires_at'])
        .where('account_id', '=', accountId)
        .where('revoked_at', 'is', null)
        .where('expires_at', '>', now.toISOString())
        .orderBy('created_at', 'desc')
        .orderBy('token_hash')
        // 発行が上限を守るので超えないはずの保険。行が増えても一覧が膨らまない
        .limit(API_TOKEN_MAX_ACTIVE),
    ),
  );
  return rows.flatMap((row) =>
    isScope(row.scope)
      ? [
          {
            id: row.token_hash,
            name: row.name,
            scope: row.scope,
            created_at: row.created_at,
            last_used_at: row.last_used_at,
            expires_at: row.expires_at,
          },
        ]
      : [],
  );
}

// その人の1件のトークンを取り消す。その人の行が無ければ（他人の行も同じ）false。取り消し済みなら true を返し、revoked_at は書き直さない。
// 期限が切れた行にも成功する。先に読むのは 404 と成功を分けるため。書く文の WHERE に account_id と revoked_at IS NULL を入れ、
// 読んだ後の取り消しと重なっても、最初の revoked_at を残す
export async function revokeApiTokenOf(
  db: CommonDb,
  accountId: string,
  tokenHash: string,
  now: Date,
): Promise<boolean> {
  const row = await db.first(
    db.statement((q) =>
      q
        .selectFrom('api_tokens')
        .select('token_hash')
        .where('token_hash', '=', tokenHash)
        .where('account_id', '=', accountId),
    ),
  );
  if (row === undefined) return false;
  await db.batch([
    db.statement((q) =>
      q
        .updateTable('api_tokens')
        .set({ revoked_at: now.toISOString() })
        .where('token_hash', '=', tokenHash)
        .where('account_id', '=', accountId)
        .where('revoked_at', 'is', null),
    ),
  ]);
  return true;
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

// その人のトークンを、checkedAt までに作られたものだけ取り消す。checkedAt より後に発行したトークンは残す（deleteSessionsOf と同じ）。
// 取り消し済みの行は書き直さない。呼ぶのは今はテストだけで、本番の道は無い
export async function revokeApiTokensOf(db: CommonDb, accountId: string, checkedAt: Date): Promise<void> {
  await db.batch([
    db.statement((q) =>
      q
        .updateTable('api_tokens')
        .set({ revoked_at: new Date().toISOString() })
        .where('account_id', '=', accountId)
        .where('revoked_at', 'is', null)
        .where('created_at', '<=', checkedAt.toISOString()),
    ),
  ]);
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
