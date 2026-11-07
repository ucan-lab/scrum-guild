// 取り込みの同期（src/server/import/sync.ts）が使う文。接続と範囲の読み取り、取り込み（1件）の書き込み、接続の状態の書き込み。
// 組織の中の表だけを使い、共通の表とは結合しない（docs/data-model.md の「データベースの分け方」）。
// 組織は、接続のワークスペースを workspaces.organization_id で絞って確かめる
import type { Statement } from './entry.ts';
import type { OrganizationDb } from './entries.ts';

// 同期が読む接続。認証情報の列は暗号文のまま（復号は呼び出し側）
export type SyncConnection = {
  id: string;
  workspace_id: string;
  owner_user_id: string;
  provider: string;
  status: string;
  scope_mode: string;
  settings_json: string;
  credential_ciphertext: string | null;
  credential_key_version: number | null;
  sync_state_json: string;
  consecutive_failures: number;
};

// 登録者が無効でなく、ワークスペースに今も所属している、という条件（接続の停止は #67 で足すまでの守り）
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function ownerIsActive(eb: any, q: any, ownerColumn: string, workspaceColumn: string) {
  return eb.and([
    eb.exists(
      q
        .selectFrom('users')
        .select('users.id')
        .whereRef('users.id', '=', ownerColumn)
        .where('users.disabled_at', 'is', null),
    ),
    eb.exists(
      q
        .selectFrom('memberships')
        .select('memberships.id')
        .whereRef('memberships.user_id', '=', ownerColumn)
        .whereRef('memberships.workspace_id', '=', workspaceColumn)
        .where('memberships.left_at', 'is', null),
    ),
  ]);
}

export type SyncScope = { source_id: string; source_name: string };

// 削除していない接続を、組織で絞って1件読む。ワークスペースが閉じていれば読まない（閉じたワークスペースは同期を飛ばす）
export async function readSyncConnection(
  db: OrganizationDb,
  workspaceId: string,
  connectionId: string,
): Promise<{ connection: SyncConnection; scopes: SyncScope[] } | undefined> {
  const connection = await db.first(
    db.statement((q) =>
      q
        .selectFrom('connections')
        .innerJoin('workspaces', 'workspaces.id', 'connections.workspace_id')
        .select([
          'connections.id',
          'connections.workspace_id',
          'connections.owner_user_id',
          'connections.provider',
          'connections.status',
          'connections.scope_mode',
          'connections.settings_json',
          'connections.credential_ciphertext',
          'connections.credential_key_version',
          'connections.sync_state_json',
          'connections.consecutive_failures',
        ])
        .where('connections.id', '=', connectionId)
        .where('connections.workspace_id', '=', workspaceId)
        .where('connections.deleted_at', 'is', null)
        .where('workspaces.organization_id', '=', db.organizationId)
        .where('workspaces.closed_at', 'is', null)
        // 登録者が今もそのワークスペースにいて、無効にされていない（抜けた人や無効の人の認証情報で取り込まない）
        .where((eb) => ownerIsActive(eb, q, 'connections.owner_user_id', 'connections.workspace_id')),
    ),
  );
  if (connection === undefined) return undefined;
  const scopes = await db.rows(
    db.statement((q) =>
      q
        .selectFrom('connection_scopes')
        .select(['connection_scopes.source_id', 'connection_scopes.source_name'])
        .where('connection_scopes.connection_id', '=', connectionId)
        .orderBy('connection_scopes.source_id'),
    ),
  );
  return { connection, scopes };
}

// 受信箱の末尾の並びの値。受信箱が空なら undefined。組織を確かめた接続のワークスペースの ID だけを渡す（readSyncConnection の後に呼ぶ）。
// 末尾を読んでから書くまでの間に別の取り込みが入ると並びの値が重なりうるが、並びは id で決まるので壊れない
export async function readInboxTailPosition(db: OrganizationDb, workspaceId: string): Promise<string | undefined> {
  const row = await db.first(
    db.statement((q) =>
      q
        .selectFrom('tasks')
        .select('tasks.position')
        .where('tasks.workspace_id', '=', workspaceId)
        .where('tasks.tray', '=', 'inbox')
        .where('tasks.deleted_at', 'is', null)
        .orderBy('tasks.position', 'desc')
        .orderBy('tasks.id', 'desc')
        .limit(1),
    ),
  );
  return row?.position;
}

// 組織を確かめた接続のワークスペースの ID だけを渡す。取り込み元の入れ物（source_container_id）から、結んだリポジトリの ID への表。ワークスペースのリポジトリは50件まで
export async function readRepositoriesByContainer(
  db: OrganizationDb,
  workspaceId: string,
  provider: string,
): Promise<Map<string, string>> {
  const rows = await db.rows(
    db.statement((q) =>
      q
        .selectFrom('repositories')
        .select(['repositories.id', 'repositories.source_container_id'])
        .where('repositories.workspace_id', '=', workspaceId)
        .where('repositories.provider', '=', provider)
        .where('repositories.source_container_id', 'is not', null)
        .where('repositories.deleted_at', 'is', null)
        .orderBy('repositories.position')
        .orderBy('repositories.id'),
    ),
  );
  const found = new Map<string, string>();
  for (const row of rows) {
    // 同じ入れ物を指すリポジトリが複数あれば、並びの先頭を使う
    if (row.source_container_id !== null && !found.has(row.source_container_id)) {
      found.set(row.source_container_id, row.id);
    }
  }
  return found;
}

// 取り込む1件。値は呼び出し側が整えた後のもの（タイトルの整形、期日、結ぶリポジトリ、並びの値）
export type ImportedTask = {
  taskId: string;
  workspaceId: string;
  connectionId: string;
  provider: string;
  assigneeUserId: string;
  repositoryId: string | null;
  position: string;
  title: string;
  kind: 'issue' | 'pull_request' | 'review_request';
  sourceId: string;
  reviewerSourceId: string;
  key: string;
  url: string;
  containerId: string;
  containerName: string;
  status: string;
  dueOn: string | null;
  updatedAt: string;
};

// 取り込み（1件）: tasks と task_sources を、1回の batch() で書く文の組を作る（docs/data-model.md の「書き込みの単位」）。
// batch() は件数 0 の文があっても後ろの文を書くので、どちらも自分の条件に前提を持つ。
//   - tasks は、接続が今も削除されず止まっておらず、ワークスペースが閉じておらず、同じ項目の task_sources が無いことが条件
//   - task_sources は、そのタスクの行があることが条件
// 同じ項目を同時に取り込むと、先に通った 1 つだけが tasks を書き、後の要求は 2 つの文とも 0 件になる
// （D1 の batch() はトランザクションで順に流れるので、後の要求の tasks の文は先の要求の task_sources を見る）
export function importTaskStatements(
  db: OrganizationDb,
  task: ImportedTask,
  at: string,
): [Statement<'organization'>, Statement<'organization'>] {
  const insertTask = db.statement((q) =>
    q
      .insertInto('tasks')
      .columns([
        'id',
        'workspace_id',
        'is_imported',
        'tray',
        'title',
        'body_md',
        'link_url',
        'story_id',
        'category_id',
        'repository_id',
        'sprint_id',
        'column_id',
        'assignee_user_id',
        'points',
        'due_on',
        'today_on',
        'completed_at',
        'completed_by',
        'position',
        'column_position',
        'created_by',
        'created_at',
        'updated_at',
        'deleted_at',
      ])
      .expression(
        q
          .selectNoFrom((eb) => [
            eb.val(task.taskId).as('id'),
            eb.val(task.workspaceId).as('workspace_id'),
            eb.val(1).as('is_imported'),
            eb.val('inbox').as('tray'),
            eb.val(task.title).as('title'),
            eb.cast<string | null>(eb.val(null), 'text').as('body_md'),
            eb.cast<string | null>(eb.val(null), 'text').as('link_url'),
            eb.cast<string | null>(eb.val(null), 'text').as('story_id'),
            eb.cast<string | null>(eb.val(null), 'text').as('category_id'),
            // 読んだ後に削除されたリポジトリは結ばない
            eb
              .selectFrom('repositories')
              .select('repositories.id')
              .where('repositories.id', '=', task.repositoryId ?? '')
              .where('repositories.workspace_id', '=', task.workspaceId)
              .where('repositories.deleted_at', 'is', null)
              .as('repository_id'),
            eb.cast<string | null>(eb.val(null), 'text').as('sprint_id'),
            eb.cast<string | null>(eb.val(null), 'text').as('column_id'),
            eb.val(task.assigneeUserId).as('assignee_user_id'),
            eb.cast<number | null>(eb.val(null), 'integer').as('points'),
            eb.cast<string | null>(eb.val(null), 'text').as('due_on'),
            eb.cast<string | null>(eb.val(null), 'text').as('today_on'),
            eb.cast<string | null>(eb.val(null), 'text').as('completed_at'),
            eb.cast<string | null>(eb.val(null), 'text').as('completed_by'),
            eb.val(task.position).as('position'),
            eb.cast<string | null>(eb.val(null), 'text').as('column_position'),
            eb.cast<string | null>(eb.val(null), 'text').as('created_by'),
            eb.val(at).as('created_at'),
            eb.val(at).as('updated_at'),
            eb.cast<string | null>(eb.val(null), 'text').as('deleted_at'),
          ])
          .where((eb) =>
            eb.and([
              eb.exists(
                q
                  .selectFrom('connections')
                  .innerJoin('workspaces', 'workspaces.id', 'connections.workspace_id')
                  .select('connections.id')
                  .where('connections.id', '=', task.connectionId)
                  .where('connections.workspace_id', '=', task.workspaceId)
                  .where('connections.deleted_at', 'is', null)
                  .where('connections.status', '!=', 'stopped')
                  .where('workspaces.organization_id', '=', db.organizationId)
                  .where('workspaces.closed_at', 'is', null)
                  .where((cb) => ownerIsActive(cb, q, 'connections.owner_user_id', 'connections.workspace_id')),
              ),
              eb.not(
                eb.exists(
                  q
                    .selectFrom('task_sources')
                    .select('task_sources.task_id')
                    .where('task_sources.workspace_id', '=', task.workspaceId)
                    .where('task_sources.provider', '=', task.provider)
                    .where('task_sources.source_kind', '=', task.kind)
                    .where('task_sources.source_id', '=', task.sourceId)
                    .where('task_sources.reviewer_source_id', '=', task.reviewerSourceId),
                ),
              ),
            ]),
          ),
      ),
  );

  const insertSource = db.statement((q) =>
    q
      .insertInto('task_sources')
      .columns([
        'task_id',
        'workspace_id',
        'connection_id',
        'provider',
        'source_kind',
        'source_id',
        'reviewer_source_id',
        'source_key',
        'source_url',
        'source_container_id',
        'source_container_name',
        'source_status',
        'source_due_on',
        'source_updated_at',
        'is_source_done',
        'missing_since_at',
        'last_seen_at',
        'created_at',
        'updated_at',
      ])
      .expression(
        q
          .selectNoFrom((eb) => [
            eb.val(task.taskId).as('task_id'),
            eb.val(task.workspaceId).as('workspace_id'),
            eb.val(task.connectionId).as('connection_id'),
            eb.val(task.provider).as('provider'),
            eb.val(task.kind).as('source_kind'),
            eb.val(task.sourceId).as('source_id'),
            eb.val(task.reviewerSourceId).as('reviewer_source_id'),
            eb.val(task.key).as('source_key'),
            eb.val(task.url).as('source_url'),
            eb.val(task.containerId).as('source_container_id'),
            eb.val(task.containerName).as('source_container_name'),
            eb.val(task.status).as('source_status'),
            eb.cast<string | null>(eb.val(task.dueOn), 'text').as('source_due_on'),
            eb.val(task.updatedAt).as('source_updated_at'),
            eb.val(0).as('is_source_done'),
            eb.cast<string | null>(eb.val(null), 'text').as('missing_since_at'),
            eb.val(at).as('last_seen_at'),
            eb.val(at).as('created_at'),
            eb.val(at).as('updated_at'),
          ])
          .where((eb) =>
            eb.exists(
              q
                .selectFrom('tasks')
                .select('tasks.id')
                .where('tasks.id', '=', task.taskId)
                .where('tasks.workspace_id', '=', task.workspaceId)
                .where('tasks.is_imported', '=', 1),
            ),
          ),
      ),
  );

  return [insertTask, insertSource];
}

// 同期の結果として接続に書く値。成功は続きの位置（なければ空の状態）まで、失敗は種別ごと
export type SyncOutcome =
  | { kind: 'success'; syncStateJson: string }
  | { kind: 'auth_failed'; message: string }
  | { kind: 'error'; message: string };

// 接続の状態を1文で書く。接続が今も削除されておらず、止まっていないことが条件
// （同期の最中に止められた接続や削除された接続を、成功で書き戻さない）。ほかの失敗の回数は、読み直さず SQL の中で足す
export function syncOutcomeStatement(
  db: OrganizationDb,
  connection: { id: string; workspaceId: string },
  outcome: SyncOutcome,
  at: string,
): Statement<'organization'> {
  return db.statement((q) => {
    const base = q.updateTable('connections');
    const set =
      outcome.kind === 'success'
        ? base.set({
            status: 'active',
            stopped_reason: null,
            sync_state_json: outcome.syncStateJson,
            last_success_at: at,
            consecutive_failures: 0,
            last_error_message: null,
            last_error_at: null,
            updated_at: at,
          })
        : outcome.kind === 'auth_failed'
          ? base.set({
              status: 'stopped',
              stopped_reason: 'auth_failed',
              last_error_message: outcome.message,
              last_error_at: at,
              updated_at: at,
            })
          : base.set((eb) => ({
              status: 'error',
              consecutive_failures: eb('connections.consecutive_failures', '+', 1),
              last_error_message: outcome.message,
              last_error_at: at,
              updated_at: at,
            }));
    return set
      .where('connections.id', '=', connection.id)
      .where('connections.workspace_id', '=', connection.workspaceId)
      .where('connections.deleted_at', 'is', null)
      .where('connections.status', '!=', 'stopped')
      .where((eb) =>
        eb.exists(
          q
            .selectFrom('workspaces')
            .select('workspaces.id')
            .where('workspaces.id', '=', connection.workspaceId)
            .where('workspaces.organization_id', '=', db.organizationId),
        ),
      );
  });
}
