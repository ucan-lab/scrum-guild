// お試しの期限を過ぎた、停止していない組織を、1文で一時的な停止にする（実装は別の担当。今は入れ物だけ）
export async function suspendExpiredTrials(
  _env: Env,
  _today: string,
  _at: Date,
): Promise<readonly { id: string; trial_ends_on: string }[]> {
  throw new Error('未実装');
}
