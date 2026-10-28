// 運用者の操作を、その組織の変更の履歴（組織の DB の change_logs）に残す（停止、再開、停止の理由の切り替え、上限の変更）。
// 共通の DB の organizations を書いた後に、別の batch() で書く（共通の表と組織の中の表は1回の batch() に混ぜない）
import type { OperatorTools } from './operator-tools.ts';

// 書けなくても投げず、組織の ID、変更の前後の値、日時、例外の名前だけをログに残す
// （例外の message に SQL や接続の詳細が混ざりうる）。organizations は書けているので、欠けた行は運用者がログから手で補える
export async function logOperatorChange(
  operator: OperatorTools,
  log: {
    operation: string;
    organizationId: string;
    action: 'suspend' | 'resume' | 'update';
    changes: Record<string, readonly [unknown, unknown]>;
    at: Date;
  },
): Promise<void> {
  try {
    await operator.appendChangeLog(log.organizationId, {
      entityType: 'organization',
      entityId: log.organizationId,
      action: log.action,
      changes: log.changes,
      at: log.at,
    });
  } catch (err) {
    console.error(
      JSON.stringify({
        level: 'error',
        code: 'internal',
        requestId: operator.requestId,
        operation: log.operation,
        route: 'operator',
        reason: '組織の状態は書けたが、変更の履歴を書けなかった',
        action: log.action,
        organizationId: log.organizationId,
        // 再開、切り替え、上限の変更は organizations の前の値を消すので、欠けた行を補えるよう前後の値と日時を残す（日時、日付、数だけ）
        changes: log.changes,
        at: log.at.toISOString(),
        error: err instanceof Error ? err.name : typeof err,
      }),
    );
  }
}
