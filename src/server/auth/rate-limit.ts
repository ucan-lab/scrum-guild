// アプリ側のレート制限（docs/data-model.md の `rate_limits`）。設けるのは、ログインと手動の同期だけ。
// 窓の最初の呼び出しから windowMs の間に max 回まで。1文の upsert で数えるので、並行した呼び出しも取りこぼさず、
// 窓を過ぎた最初の呼び出しが数え直す。断った呼び出しも数える
import type { AnyOperationDefinition } from '../../shared/operations/define.ts';
import { operations } from '../../shared/operations/index.ts';
import { commonDb } from '../db/index.ts';
import { clientIpUnits } from './client-ip.ts';

export type RateLimitPolicy = { max: number; windowMs: number };

// ログインで数える枠。loginRateLimits()、consumeLoginStartRateLimits() と LOGIN_RATE_LIMIT_POLICIES はこの辞書の値だけを使う。
// 期限を過ぎた rate_limits の行を消す境目の最長の窓は、この辞書と操作の定義から求める（longestRateLimitWindowMs）。
//   network: ログインの開始と戻り先を、同じ IP（CF-Connecting-IP。IPv6 は /64）から10分に60回まで。1回のログインで
//     2回数えるので30人分。同じオフィスの15人のチームが一斉に入っても詰まらない値にした
//   ipv6Site: IPv6 は /64 の枠に加えて、/48 の枠を数える。事業者の単位の /48 の中なら、/64 を変えて1つの枠を避けられる
//     ため。/48 の中には複数の利用者がいるので、/64 の10倍まで認める
//   global: ログインの開始だけを、全部の IP を合わせて10分に600回まで。IP を多く持つ人が、IP の数に比例して
//     oauth_states の行を書かせられないようにする。叩かれ続けても書き込みは月に約1,000万行で、居座る oauth_states は
//     約600行に収まる。代わりに、約10個の IP（600 ÷ network の60回）で新しいログインを止められる
export const LOGIN_RATE_LIMITS = {
  network: { max: 60, windowMs: 10 * 60 * 1000 },
  ipv6Site: { max: 600, windowMs: 10 * 60 * 1000 },
  global: { max: 600, windowMs: 10 * 60 * 1000 },
} as const satisfies Record<string, RateLimitPolicy>;

export const LOGIN_RATE_LIMIT: RateLimitPolicy = LOGIN_RATE_LIMITS.network;
export const LOGIN_RATE_LIMIT_IPV6_SITE: RateLimitPolicy = LOGIN_RATE_LIMITS.ipv6Site;
export const LOGIN_RATE_LIMIT_GLOBAL: RateLimitPolicy = LOGIN_RATE_LIMITS.global;

// IP の枠のキー（`login:<IP>`）とは重ならない。`global` は IP として解釈できず、解釈できない IP は `login:unknown` になる
export const LOGIN_GLOBAL_RATE_LIMIT_KEY = 'login:global';

export const LOGIN_RATE_LIMIT_POLICIES: readonly RateLimitPolicy[] = Object.values(LOGIN_RATE_LIMITS);

// consumeRateLimit に渡る全部の枠（ログインの枠と、操作の定義の rateLimit）のうち、最長の窓。
// この窓を過ぎた行は、どの枠から見ても数え直しになるので消してよい（src/server/scheduled/cleanup-expired.ts）。
// 操作の定義は src/shared/operations の operations（sessionOperations を含む全部）。register.ts の enforceRateLimit が
// windowSeconds * 1000 で使う
export function longestRateLimitWindowMs(definitions: readonly AnyOperationDefinition[] = operations): number {
  const windows = [
    ...LOGIN_RATE_LIMIT_POLICIES.map((policy) => policy.windowMs),
    ...definitions.flatMap((definition) =>
      definition.rateLimit === undefined ? [] : [definition.rateLimit.windowSeconds * 1000],
    ),
  ];
  return Math.max(...windows);
}

// 枠も操作の定義も読み込みの後は変わらないので、consumeRateLimit のたびに定義を走査せず1回だけ求める
const LONGEST_WINDOW_MS = longestRateLimitWindowMs();

export type LoginRateLimit = { key: string; policy: RateLimitPolicy };

// 数える枠。IPv4 は `login:<IP>`、IPv6 は `login:<上位64ビット>::/64` と `login48:<上位48ビット>::/48`、
// 解釈できない値と IP の無いリクエスト（手元の開発）は `login:unknown`。本番は Cloudflare が必ず IP を付ける
export function loginRateLimits(ip: string | undefined): LoginRateLimit[] {
  const units = clientIpUnits(ip);
  switch (units.kind) {
    case 'v4':
      return [{ key: `login:${units.address}`, policy: LOGIN_RATE_LIMITS.network }];
    case 'v6':
      // 広い /48 の枠を先に数える。/48 を超えた後に /64 を変えて叩かれても、/64 の行を増やさないため
      return [
        { key: `login48:${units.network48}`, policy: LOGIN_RATE_LIMITS.ipv6Site },
        { key: `login:${units.network64}`, policy: LOGIN_RATE_LIMITS.network },
      ];
    case 'unknown':
      return [{ key: 'login:unknown', policy: LOGIN_RATE_LIMITS.network }];
  }
}

// 数えて、上限の内なら true。超えたら false
export async function consumeRateLimit(env: Env, key: string, policy: RateLimitPolicy, now: Date): Promise<boolean> {
  // 最長の窓に入っていない枠を足すと、掃除が窓の途中で行を消し、上限が緩む（src/server/scheduled/cleanup-expired.ts）
  if (policy.windowMs > LONGEST_WINDOW_MS) {
    throw new Error(`レート制限の窓 ${policy.windowMs}ms が、掃除の境目の最長の窓を超えている`);
  }
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

// 数えずに読むだけで、次の呼び出しが上限を超えるか。窓を過ぎた行と行の無い枠は、consumeRateLimit が数え直すので超えない
export async function isRateLimitExceeded(env: Env, key: string, policy: RateLimitPolicy, now: Date): Promise<boolean> {
  const db = commonDb(env);
  const cutoff = new Date(now.getTime() - policy.windowMs).toISOString();
  const row = await db.first(
    db.statement((q) => q.selectFrom('rate_limits').select(['window_start_at', 'count']).where('key', '=', key)),
  );
  return row !== undefined && row.window_start_at > cutoff && row.count >= policy.max;
}

// ログインの IP の枠を、広い枠から順に数える。上限を超えた枠があればそこで止めて false を返し、残りの枠は数えない
// （断った呼び出しで、狭い枠の行を作らない）。戻り先はこの枠だけを数える
export async function consumeLoginRateLimits(env: Env, ip: string | undefined, now: Date): Promise<boolean> {
  for (const { key, policy } of loginRateLimits(ip)) {
    if (!(await consumeRateLimit(env, key, policy, now))) return false;
  }
  return true;
}

export type LoginStartRateLimit = { allowed: true } | { allowed: false; limitedBy: 'ip' | 'global' };

// ログインの開始の枠。全体の枠を読むだけで覗き → IP の枠を数え → 通った呼び出しだけ全体の枠を数える。
//   - 全体の枠を先に数えると、断った呼び出しも数えるので、1つの IP から叩き続けるだけで全体の枠を使い切れる。
//     この順なら、1つの IP が使える全体の枠は IP の枠の上限まで
//   - 全体の枠が上限の間は、覗いただけで断り、どの行も書かない（叩かれた回数だけ IP の行を書き続けない）
//   - 覗いた後に並行した呼び出しがすり抜けても、最後に全体の枠を数えるので上限は守られる
export async function consumeLoginStartRateLimits(
  env: Env,
  ip: string | undefined,
  now: Date,
): Promise<LoginStartRateLimit> {
  if (await isRateLimitExceeded(env, LOGIN_GLOBAL_RATE_LIMIT_KEY, LOGIN_RATE_LIMIT_GLOBAL, now)) {
    return { allowed: false, limitedBy: 'global' };
  }
  if (!(await consumeLoginRateLimits(env, ip, now))) return { allowed: false, limitedBy: 'ip' };
  if (!(await consumeRateLimit(env, LOGIN_GLOBAL_RATE_LIMIT_KEY, LOGIN_RATE_LIMIT_GLOBAL, now))) {
    return { allowed: false, limitedBy: 'global' };
  }
  return { allowed: true };
}
