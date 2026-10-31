// 期限を過ぎた oauth_states、sessions、rate_limits の行を消す定期処理（docs/data-model.md の各表）。
// 表ごとに1文、別々の batch() で送る。1つの batch() にまとめると、1文の失敗で3表とも消えない。
// 消した件数が上限に届いた表は、予算（回数と時間）の中で同じ文をもう一度送る。
// 1つの表が失敗したら、その表はそこで止め、残りの表は消し、全部を終えてから例外を投げる（cron の失敗として残る）
import { longestRateLimitWindowMs } from '../auth/rate-limit.ts';
import { commonDb, type CommonDb } from '../db/index.ts';

// 1文で消す行数の上限。1文を短く保つ
export const CLEANUP_ROW_LIMIT = 10000;
// 1回の cron で、1つの表に文を送る回数の上限。上限の行数に届き続ける表は、1回の cron で最大 20 万行まで消える
export const CLEANUP_MAX_ROUNDS = 20;
// cron の開始からこの時間がたったら、上限に届いた表でも文を繰り返さない（どの表も最初の1文は送る）
export const CLEANUP_TIME_BUDGET_MS = 20_000;

const JOB = 'cleanup-expired';

type CleanupTable = 'oauth_states' | 'sessions' | 'rate_limits';

// 例外の message には SQL や値が混ざりうるので、ログには出さない。
// 一時的な D1 の失敗か、文の不具合かを後から見分けられるよう、message を固定の分類名に直して残す
// 表名や列名が message に入るので、文の不具合（constraint、syntax）を先に見る
const FAILURE_CAUSES: readonly (readonly [string, RegExp])[] = [
  ['constraint', /constraint failed/i],
  ['syntax', /syntax error|no such (?:table|column)/i],
  ['network', /network connection lost|connection (?:reset|closed)|disconnected/i],
  // 「timeout が原因で reset された」message は、結果の reset を取る
  ['reset', /caused object to be reset|reset because|code was updated/i],
  ['timeout', /timed? ?out|exceeded (?:its )?(?:cpu|time)/i],
  ['overloaded', /overloaded|too many requests/i],
  ['busy', /SQLITE_BUSY|database is locked/i],
  ['storage', /exceeded maximum db size|SQLITE_FULL/i],
];

// ログのための分類が例外になると、残りの表の掃除まで止まるので、読めなければ unknown にする
export function classifyFailure(err: unknown): string {
  try {
    const messages: string[] = [];
    for (let current: unknown = err, depth = 0; current instanceof Error && depth < 3; depth++) {
      messages.push(current.message);
      current = current.cause;
    }
    const text = messages.join('\n');
    return FAILURE_CAUSES.find(([, pattern]) => pattern.test(text))?.[0] ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

// D1 は DELETE ... LIMIT を受けないので、主キーの副問い合わせで上限を付ける。
// 時刻の列は ISO 8601 の UTC で、文字列の比較が時刻の順になる（consumeRateLimit と同じ前提）。
// 文は表の try の中で組み立てる（時刻の計算が例外になっても、ほかの表は消す）
function cleanupStatements(db: CommonDb, now: Date, limit: number, longestWindowMs: number) {
  const at = now.toISOString();
  return {
    oauth_states: () =>
      db.statement((q) =>
        q
          .deleteFrom('oauth_states')
          .where('state', 'in', (eb) =>
            eb.selectFrom('oauth_states').select('state').where('expires_at', '<=', at).limit(limit),
          ),
      ),
    sessions: () =>
      db.statement((q) =>
        q
          .deleteFrom('sessions')
          .where('token_hash', 'in', (eb) =>
            eb.selectFrom('sessions').select('token_hash').where('expires_at', '<=', at).limit(limit),
          ),
      ),
    rate_limits: () => {
      // 最長の窓を過ぎた行は、どの枠から見ても窓の数え直しになる
      const cutoff = new Date(now.getTime() - longestWindowMs).toISOString();
      return db.statement((q) =>
        q
          .deleteFrom('rate_limits')
          .where('key', 'in', (eb) =>
            eb.selectFrom('rate_limits').select('key').where('window_start_at', '<=', cutoff).limit(limit),
          ),
      );
    },
  };
}

export type CleanupOptions = {
  // 1文で消す行数の上限
  limit?: number;
  // 1つの表に文を送る回数の上限
  maxRounds?: number;
  // 文を繰り返してよい時間（cron の開始から）
  timeBudgetMs?: number;
  // rate_limits を切る窓。操作の定義が窓を伸ばした場合をテストが確かめるのに渡す
  longestWindowMs?: number;
};

// 基準の時刻 now は3表で共通（controller.scheduledTime）。options は本番では渡さない
export async function cleanupExpired(env: Env, now: Date, options: CleanupOptions = {}): Promise<void> {
  const {
    limit = CLEANUP_ROW_LIMIT,
    maxRounds = CLEANUP_MAX_ROUNDS,
    timeBudgetMs = CLEANUP_TIME_BUDGET_MS,
    longestWindowMs = longestRateLimitWindowMs(),
  } = options;
  const startedAt = Date.now();
  const db = commonDb(env);
  const statements = cleanupStatements(db, now, limit, longestWindowMs);
  const deleted: Partial<Record<CleanupTable, number>> = {};
  const rounds: Partial<Record<CleanupTable, number>> = {};
  // 予算を使い切っても、最後の文がまだ上限に届いていた表（消すのが追いついていない）
  const behind: CleanupTable[] = [];
  const failed: CleanupTable[] = [];

  for (const table of Object.keys(statements) as CleanupTable[]) {
    deleted[table] = 0;
    rounds[table] = 0;
    const tableStartedAt = Date.now();
    try {
      const statement = statements[table]();
      for (;;) {
        const [result] = await db.batch([statement]);
        deleted[table] = (deleted[table] ?? 0) + result.changes;
        rounds[table] = (rounds[table] ?? 0) + 1;
        if (result.changes < limit) break;
        if ((rounds[table] ?? 0) >= maxRounds || Date.now() - startedAt >= timeBudgetMs) {
          behind.push(table);
          break;
        }
      }
    } catch (err) {
      failed.push(table);
      // 例外の message に SQL や接続の詳細が混ざりうるので、名前と分類名だけを残す
      console.error(
        JSON.stringify({
          level: 'error',
          code: 'internal',
          job: JOB,
          table,
          reason: '期限を過ぎた行の掃除に失敗した',
          error: err instanceof Error ? err.name : typeof err,
          cause: classifyFailure(err),
          rounds: rounds[table],
          elapsedMs: Date.now() - tableStartedAt,
        }),
      );
    }
  }

  // 件数だけを出す。行の中身（トークンのハッシュ、IP の入ったキー、state）は出さない。
  // deleted は表ごとの合計、rounds は文を送った回数。追いついていない表がある回は warn にする
  if (Object.values(deleted).some((count) => count > 0)) {
    const line = JSON.stringify({
      level: behind.length > 0 ? 'warn' : 'info',
      job: JOB,
      limit,
      deleted,
      rounds,
      behind,
    });
    if (behind.length > 0) console.warn(line);
    else console.info(line);
  }

  if (failed.length > 0) throw new Error(`期限を過ぎた行の掃除に失敗した表: ${failed.join(', ')}`);
}
