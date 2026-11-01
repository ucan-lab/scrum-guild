// 定期処理の操作を、組織の変更の履歴（change_logs）に1行足す（実装は別の担当。今は入れ物だけ）
export async function appendScheduledChangeLog(
  _env: Env,
  _organizationId: string,
  _entry: {
    entityId: string;
    action: 'suspend';
    changes: Readonly<Record<string, readonly [unknown, unknown]>>;
    at: Date;
  },
): Promise<void> {
  throw new Error('未実装');
}
