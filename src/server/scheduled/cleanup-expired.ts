// 期限を過ぎた oauth_states、sessions、rate_limits の行を消す定期処理（docs/data-model.md の各表）。
// 表ごとに1文、別々の batch() で送る。1つの batch() にまとめると、1文の失敗で3表とも消えない。
// 1つの表が失敗しても残りの表は消し、全部を終えてから例外を投げる（cron の失敗として残る）
import { longestRateLimitWindowMs } from '../auth/rate-limit.ts';
import { commonDb, type CommonDb } from '../db/index.ts';

// 1文で消す行数の上限。1回の処理を短く保つ。毎分動くので、1時間で表ごとに60万行まで追いつく
export const CLEANUP_ROW_LIMIT = 10000;

const JOB = 'cleanup-expired';

type CleanupTable = 'oauth_states' | 'sessions' | 'rate_limits';

// D1 は DELETE ... LIMIT を受けないので、主キーの副問い合わせで上限を付ける。
// 時刻の列は ISO 8601 の UTC で、文字列の比較が時刻の順になる（consumeRateLimit と同じ前提）
function cleanupStatements(db: CommonDb, now: Date, limit: number, longestWindowMs: number) {
  const at = now.toISOString();
  // 最長の窓を過ぎた行は、どの枠から見ても窓の数え直しになる
  const rateLimitCutoff = new Date(now.getTime() - longestWindowMs).toISOString();
  return {
    oauth_states: db.statement((q) =>
      q
        .deleteFrom('oauth_states')
        .where('state', 'in', (eb) =>
          eb.selectFrom('oauth_states').select('state').where('expires_at', '<=', at).limit(limit),
        ),
    ),
    sessions: db.statement((q) =>
      q
        .deleteFrom('sessions')
        .where('token_hash', 'in', (eb) =>
          eb.selectFrom('sessions').select('token_hash').where('expires_at', '<=', at).limit(limit),
        ),
    ),
    rate_limits: db.statement((q) =>
      q
        .deleteFrom('rate_limits')
        .where('key', 'in', (eb) =>
          eb.selectFrom('rate_limits').select('key').where('window_start_at', '<=', rateLimitCutoff).limit(limit),
        ),
    ),
  };
}

export type CleanupOptions = {
  // 1文で消す行数の上限
  limit?: number;
  // rate_limits を切る窓。操作の定義が窓を伸ばした場合をテストが確かめるのに渡す
  longestWindowMs?: number;
};

// 基準の時刻 now は3表で共通（controller.scheduledTime）。options は本番では渡さない
export async function cleanupExpired(env: Env, now: Date, options: CleanupOptions = {}): Promise<void> {
  const { limit = CLEANUP_ROW_LIMIT, longestWindowMs = longestRateLimitWindowMs() } = options;
  const db = commonDb(env);
  const statements = cleanupStatements(db, now, limit, longestWindowMs);
  const deleted: Partial<Record<CleanupTable, number>> = {};
  const failed: CleanupTable[] = [];

  for (const table of Object.keys(statements) as CleanupTable[]) {
    try {
      const [result] = await db.batch([statements[table]]);
      deleted[table] = result.changes;
    } catch (err) {
      failed.push(table);
      // 例外の message に SQL や接続の詳細が混ざりうるので、名前だけを残す
      console.error(
        JSON.stringify({
          level: 'error',
          code: 'internal',
          job: JOB,
          table,
          reason: '期限を過ぎた行の掃除に失敗した',
          error: err instanceof Error ? err.name : typeof err,
        }),
      );
    }
  }

  // 件数だけを出す。行の中身（トークンのハッシュ、IP の入ったキー、state）は出さない
  const counts = Object.values(deleted);
  if (counts.some((count) => count > 0)) {
    // 上限に届いた表がある回は、消すのが追いついていない合図として warn にする
    const behind = counts.some((count) => count >= limit);
    const line = JSON.stringify({ level: behind ? 'warn' : 'info', job: JOB, limit, deleted });
    if (behind) console.warn(line);
    else console.info(line);
  }

  if (failed.length > 0) throw new Error(`期限を過ぎた行の掃除に失敗した表: ${failed.join(', ')}`);
}
