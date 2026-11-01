// お試しの期限切れの組織を一時停止にする定期処理（実装は別の担当。今は入れ物だけ）
export async function suspendExpiredTrialsJob(_env: Env, _scheduledTime: Date): Promise<void> {
  throw new Error('未実装');
}
