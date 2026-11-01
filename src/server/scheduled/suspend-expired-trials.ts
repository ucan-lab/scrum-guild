// お試しの期限切れの組織を一時的な停止にする定期処理（docs/data-model.md の「書き込みの単位」の定期処理による停止）。
// 基準の日付は scheduledTime の UTC の日付（期限の当日までは止めない）。共通の DB の organizations の1文で止め、
// 返った組織ごとに、組織の DB の change_logs に定期処理の操作として1行足す。2つは別の batch() で書く
// （共通の表と組織の中の表は1回の batch() に混ぜない）。
// 履歴の書き込みが失敗しても停止は戻さず、投げずに、ほかの組織の履歴を続ける（運用者の操作と同じく、履歴を書けなくても成功として扱う）
import { utcDateOf } from '../../shared/operations/operator/index.ts';
import { appendScheduledChangeLog, SUSPEND_EXPIRED_TRIALS_LIMIT, suspendExpiredTrials } from '../db/index.ts';

const JOB = 'suspend-expired-trials';

// 止めた件数だけを info に出す（組織の ID や期限は出さない）。
// 履歴の失敗は、組織の ID、書こうとした changes、時刻、例外の名前だけを error に出す。例外の message は SQL や値が混ざりうるので出さない
export async function suspendExpiredTrialsJob(env: Env, scheduledTime: Date): Promise<void> {
  const stopped = await suspendExpiredTrials(env, utcDateOf(scheduledTime), scheduledTime);
  if (stopped.length > 0) {
    // 上限に届いた回は、積み残しがありうる（次の回に回る）ので warn にして印を付ける
    const limited = stopped.length >= SUSPEND_EXPIRED_TRIALS_LIMIT;
    const line = JSON.stringify({ level: limited ? 'warn' : 'info', job: JOB, suspended: stopped.length, limited });
    if (limited) console.warn(line);
    else console.info(line);
  }

  const at = scheduledTime.toISOString();
  for (const { id } of stopped) {
    const changes = { suspended_at: [null, at], purge_on: [null, null] } as const;
    try {
      await appendScheduledChangeLog(env, id, { entityId: id, action: 'suspend', changes, at: scheduledTime });
    } catch (err) {
      console.error(
        JSON.stringify({
          level: 'error',
          code: 'internal',
          job: JOB,
          reason: '組織の停止の履歴を書けなかった',
          organization_id: id,
          changes,
          at,
          error: err instanceof Error ? err.name : typeof err,
        }),
      );
    }
  }
}
