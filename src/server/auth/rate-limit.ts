// アプリ側のレート制限（docs/data-model.md の `rate_limits`）。設けるのは、ログインと手動の同期だけ。
// 窓の最初の呼び出しから windowMs の間に max 回まで。1文の upsert で数えるので、並行した呼び出しも取りこぼさず、
// 窓を過ぎた最初の呼び出しが数え直す。断った呼び出しも数える
import { commonDb } from '../db/index.ts';
import { clientIpUnits } from './client-ip.ts';

export type RateLimitPolicy = { max: number; windowMs: number };

// ログインの開始と戻り先を、同じ IP（CF-Connecting-IP）から10分に60回まで。1回のログインで2回数えるので30人分。
// 同じオフィスの15人のチームが一斉に入っても詰まらない値にした
export const LOGIN_RATE_LIMIT: RateLimitPolicy = { max: 60, windowMs: 10 * 60 * 1000 };

// IPv6 は /64 の枠（上の LOGIN_RATE_LIMIT）に加えて、/48 の枠を数える。事業者の単位の /48 の中なら、/64 を変えて
// 1つの枠を避けられるため。/48 の中には複数の利用者がいるので、/64 の10倍まで認める
export const LOGIN_RATE_LIMIT_IPV6_SITE: RateLimitPolicy = { max: 600, windowMs: 10 * 60 * 1000 };

export type LoginRateLimit = { key: string; policy: RateLimitPolicy };

// 数える枠。IPv4 は `login:<IP>`、IPv6 は `login:<上位64ビット>::/64` と `login48:<上位48ビット>::/48`、
// 解釈できない値と IP の無いリクエスト（手元の開発）は `login:unknown`。本番は Cloudflare が必ず IP を付ける
export function loginRateLimits(ip: string | undefined): LoginRateLimit[] {
  const units = clientIpUnits(ip);
  switch (units.kind) {
    case 'v4':
      return [{ key: `login:${units.address}`, policy: LOGIN_RATE_LIMIT }];
    case 'v6':
      // 広い /48 の枠を先に数える。/48 を超えた後に /64 を変えて叩かれても、/64 の行を増やさないため
      return [
        { key: `login48:${units.network48}`, policy: LOGIN_RATE_LIMIT_IPV6_SITE },
        { key: `login:${units.network64}`, policy: LOGIN_RATE_LIMIT },
      ];
    case 'unknown':
      return [{ key: 'login:unknown', policy: LOGIN_RATE_LIMIT }];
  }
}

// 数えて、上限の内なら true。超えたら false
export async function consumeRateLimit(env: Env, key: string, policy: RateLimitPolicy, now: Date): Promise<boolean> {
  const db = commonDb(env);
  const at = now.toISOString();
  // 窓の開始時刻から windowMs 以上たっていれば、窓を数え直す。ISO 8601 の UTC は文字列の比較で時刻の順になる
  const cutoff = new Date(now.getTime() - policy.windowMs).toISOString();
  // 書き込みなので batch() で送る
  const [result] = await db.batch([
    db.statement((q) =>
      q
        .insertInto('rate_limits')
        .values({ key, window_start_at: at, count: 1 })
        .onConflict((conflict) =>
          conflict.column('key').doUpdateSet((eb) => ({
            window_start_at: eb
              .case()
              .when('rate_limits.window_start_at', '<=', cutoff)
              .then(at)
              .else(eb.ref('rate_limits.window_start_at'))
              .end(),
            count: eb
              .case()
              .when('rate_limits.window_start_at', '<=', cutoff)
              .then(1)
              .else(eb('rate_limits.count', '+', 1))
              .end(),
          })),
        )
        .returning('count'),
    ),
  ]);
  const row = result.rows[0];
  if (row === undefined) throw new Error('レート制限の行を数えられなかった');
  return row.count <= policy.max;
}

// ログインの枠を、広い枠から順に数える。上限を超えた枠があればそこで止めて false を返し、残りの枠は数えない
// （断った呼び出しで、狭い枠の行を作らない）
export async function consumeLoginRateLimits(env: Env, ip: string | undefined, now: Date): Promise<boolean> {
  for (const { key, policy } of loginRateLimits(ip)) {
    if (!(await consumeRateLimit(env, key, policy, now))) return false;
  }
  return true;
}
