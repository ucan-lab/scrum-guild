// お試しの期限（organizations.trial_ends_on、UTC の日付）を today より前に過ぎた、停止していない組織を、1文で一時的な停止にする。
// 期限の当日は止めない（trial_ends_on < today）。suspended_at と updated_at を at にし、purge_on は変えない（一時的な停止は持たない）。
// 停止中の組織（運用者の停止も解約も）と、期限の無い組織（運用者が作った）は条件に外れて触らない。
// UPDATE ... RETURNING の1文を共通の DB の batch() で送り、止めた組織の id と trial_ends_on（列は変えないので止める前と同じ）を返す。
// 組織の中の表は触らない（change_logs は別の batch() で、定期処理が appendScheduledChangeLog で書く）
import { commonDb } from './entries.ts';

export async function suspendExpiredTrials(
  env: Env,
  today: string,
  at: Date,
): Promise<readonly { id: string; trial_ends_on: string }[]> {
  const db = commonDb(env);
  const stamp = at.toISOString();
  const [result] = await db.batch([
    db.statement((q) =>
      q
        .updateTable('organizations')
        .set({ suspended_at: stamp, updated_at: stamp })
        .where('suspended_at', 'is', null)
        .where('trial_ends_on', 'is not', null)
        .where('trial_ends_on', '<', today)
        .returning(['id', 'trial_ends_on']),
    ),
  ]);
  return result.rows.flatMap((row) =>
    row.trial_ends_on === null ? [] : [{ id: row.id, trial_ends_on: row.trial_ends_on }],
  );
}
