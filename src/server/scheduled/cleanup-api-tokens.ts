// 期限を過ぎた api_tokens の行を消す定期処理（docs/data-model.md の「期限切れの行の掃除」）。
// 手で発行する上限90日のトークンで行が少ないので、cleanup-expired.ts の3表のような上限と繰り返しは持たず、1文で消す。
// 3表の掃除（cleanupExpired）の結果の形を変えないよう、別の処理にして、同じ cron から続けて呼ぶ
import { deleteExpiredApiTokens } from '../auth/api-token.ts';

const JOB = 'cleanup-expired';

// 消した件数だけを出す。行の中身（トークンのハッシュ）は出さない。失敗は例外の名前だけを残して、呼び出し元へ投げ直す
export async function cleanupApiTokens(env: Env, now: Date): Promise<void> {
  try {
    const deleted = await deleteExpiredApiTokens(env, now);
    if (deleted > 0) console.info(JSON.stringify({ level: 'info', job: JOB, table: 'api_tokens', deleted }));
  } catch (err) {
    console.error(
      JSON.stringify({
        level: 'error',
        code: 'internal',
        job: JOB,
        table: 'api_tokens',
        reason: '期限を過ぎた行の掃除に失敗した',
        error: err instanceof Error ? err.name : typeof err,
      }),
    );
    throw new Error('期限を過ぎた行の掃除に失敗した表: api_tokens', { cause: err });
  }
}
