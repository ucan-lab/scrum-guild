// ワークスペースの下の書き込み（タスク、ストーリー、ワークスペースの終了と再開）が共通で使う、書く文の条件と、条件で落ちた理由の判定
import type { OrganizationDb, OrganizationTables, QueryCreator } from '../db/index.ts';
import { ApiError } from '../errors.ts';

type Tables = OrganizationTables;

// 呼んだ人の users の行。permission: 'member' と 'admin' は users の行がある人だけを通す。型の上の null を 404 で閉じる
export function actorUserIdOf(actor: { userId: string | null }): string {
  if (actor.userId === null) throw new ApiError(404, 'not_found');
  return actor.userId;
}

// 閉じていないワークスペース。書く文の条件に入れ、読んでから書くまでの間にワークスペースが閉じた競合を止める
// （登録の関数が見る閉じたかどうかは、読み取りの時点の値）
export function openWorkspace(
  from: Pick<QueryCreator<Tables>, 'selectFrom'>,
  organizationId: string,
  workspaceId: string,
) {
  return from
    .selectFrom('workspaces')
    .select('workspaces.id')
    .where('workspaces.id', '=', workspaceId)
    .where('workspaces.organization_id', '=', organizationId)
    .where('workspaces.closed_at', 'is', null);
}

// 条件で落ちた書き込みの理由を、書いた後に読み直して決める。閉じていれば登録の関数と同じ 409 の workspace_closed
export async function throwIfClosed(db: OrganizationDb, workspaceId: string): Promise<void> {
  const row = await db.first(
    db.statement((q) =>
      q
        .selectFrom('workspaces')
        .select('workspaces.closed_at')
        .where('workspaces.id', '=', workspaceId)
        .where('workspaces.organization_id', '=', db.organizationId),
    ),
  );
  if (row?.closed_at != null) throw new ApiError(409, 'workspace_closed');
}

// 履歴の1行の列。INSERT ... SELECT の選ぶ列の並びと合わせる
export const changeLogColumns = [
  'id',
  'organization_id',
  'workspace_id',
  'actor_user_id',
  'entity_type',
  'entity_id',
  'action',
  'changes_json',
  'created_at',
] as const;
