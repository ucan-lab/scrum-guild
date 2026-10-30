import { now } from '../../shared/clock.ts';
import { thanksSend, thanksRevoke, type ThanksConflictReason } from '../../shared/operations/task/index.ts';
import {
  previousStatementChanged,
  type OrganizationDb,
  type OrganizationTables,
  type QueryCreator,
} from '../db/index.ts';
import { ApiError } from '../errors.ts';
import { uuidv7 } from '../uuid.ts';
import { implement } from './implement.ts';
import { actorUserIdOf, changeLogColumns, openWorkspace, throwIfClosed } from './write-guards.ts';

const MAX_ATTEMPTS = 3;
const conflict = (reason: ThanksConflictReason) => new ApiError(409, 'conflict', { reason });

// タスクも組織とワークスペースで絞る。読む文と書く文が同じ条件を使う。
function taskRow(q: QueryCreator<OrganizationTables>, organizationId: string, workspaceId: string, taskId: string) {
  return q
    .selectFrom('tasks')
    .innerJoin('workspaces', 'workspaces.id', 'tasks.workspace_id')
    .where('workspaces.organization_id', '=', organizationId)
    .where('tasks.workspace_id', '=', workspaceId)
    .where('tasks.id', '=', taskId)
    .where('tasks.deleted_at', 'is', null);
}

// 感謝の相手は今の所属と有効な users の行で決める。ログインの手段と ID がまだ無い行（招待で待っている人）は、
// 担当の候補（member-list）に出ない人なので除く。
function recipientRow(
  q: QueryCreator<OrganizationTables>,
  organizationId: string,
  workspaceId: string,
  userId: string,
) {
  return q
    .selectFrom('users')
    .innerJoin('memberships', 'memberships.user_id', 'users.id')
    .select('users.id')
    .where('users.organization_id', '=', organizationId)
    .where('users.id', '=', userId)
    .where('users.disabled_at', 'is', null)
    .where('users.login_subject', 'is not', null)
    .where('memberships.workspace_id', '=', workspaceId)
    .where('memberships.left_at', 'is', null);
}

// 名前は事前の読み取りの値を使わず、履歴を書く文の中で users から引く。
// json_object の結果を直接 json_array に渡し、JSON の文字列ではなくオブジェクトとして残す。
function logStatement(
  db: OrganizationDb,
  workspaceId: string,
  taskId: string,
  actorId: string,
  recipientId: string,
  at: Date,
  revoke: boolean,
) {
  return db.statement((q) =>
    q
      .insertInto('change_logs')
      .columns(changeLogColumns)
      .expression(
        q
          .selectFrom('users')
          .select((eb) => {
            const person = eb.fn('json_object', [
              eb.val('id'),
              eb.ref('users.id'),
              eb.val('name'),
              eb.ref('users.name'),
            ]);
            const pair = revoke ? [person, eb.val(null)] : [eb.val(null), person];
            return [
              eb.val(uuidv7(at)).as('id'),
              eb.val(db.organizationId).as('organization_id'),
              eb.val(workspaceId).as('workspace_id'),
              eb.val(actorId).as('actor_user_id'),
              eb.val('task').as('entity_type'),
              eb.val(taskId).as('entity_id'),
              eb.val('update').as('action'),
              eb.fn<string>('json_object', [eb.val('thanks'), eb.fn('json_array', pair)]).as('changes_json'),
              eb.val(at.toISOString()).as('created_at'),
            ];
          })
          .where('users.id', '=', recipientId)
          .where('users.organization_id', '=', db.organizationId)
          .where(previousStatementChanged),
      ),
  );
}

export const thanksSendOperation = implement(thanksSend, async ({ db, workspace, actor, input }) => {
  const actorId = actorUserIdOf(actor);
  const workspaceId = workspace.workspaceId;
  const organizationId = db.organizationId;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    await throwIfClosed(db, workspaceId);
    const task = await db.first(
      db.statement((q) =>
        taskRow(q, organizationId, workspaceId, input.task_id).select([
          'tasks.assignee_user_id',
          'tasks.created_by',
          'tasks.completed_at',
        ]),
      ),
    );
    if (!task) throw new ApiError(404, 'not_found');
    if ((task.assignee_user_id ?? task.created_by) !== actorId) throw new ApiError(403, 'forbidden');
    if (task.completed_at !== null) throw conflict('completed');
    if (input.recipient_user_id === actorId) throw conflict('self');
    if (!(await db.first(db.statement((q) => recipientRow(q, organizationId, workspaceId, input.recipient_user_id))))) {
      throw new ApiError(404, 'not_found');
    }
    const duplicate = await db.first(
      db.statement((q) =>
        q
          .selectFrom('thanks')
          .select('id')
          .where('workspace_id', '=', workspaceId)
          .where('task_id', '=', input.task_id)
          .where('recipient_user_id', '=', input.recipient_user_id),
      ),
    );
    if (duplicate) throw conflict('duplicate');
    const at = now();
    const id = uuidv7(at);
    const results = await db.batch([
      db.statement((q) =>
        q
          .insertInto('thanks')
          .columns(['id', 'workspace_id', 'task_id', 'sender_user_id', 'recipient_user_id', 'created_at'])
          .expression(
            taskRow(q, organizationId, workspaceId, input.task_id)
              .select((eb) => [
                eb.val(id).as('id'),
                eb.val(workspaceId).as('workspace_id'),
                eb.ref('tasks.id').as('task_id'),
                eb.val(actorId).as('sender_user_id'),
                eb.val(input.recipient_user_id).as('recipient_user_id'),
                eb.val(at.toISOString()).as('created_at'),
              ])
              .where('tasks.completed_at', 'is', null)
              .where((eb) =>
                eb.or([
                  eb('tasks.assignee_user_id', '=', actorId),
                  eb.and([eb('tasks.assignee_user_id', 'is', null), eb('tasks.created_by', '=', actorId)]),
                ]),
              )
              .where((eb) => eb.exists(openWorkspace(q, organizationId, workspaceId)))
              .where((eb) => eb.exists(recipientRow(q, organizationId, workspaceId, input.recipient_user_id))),
          )
          .onConflict((oc) => oc.columns(['task_id', 'recipient_user_id']).doNothing()),
      ),
      logStatement(db, workspaceId, input.task_id, actorId, input.recipient_user_id, at, false),
    ]);
    if ((results[0]?.changes ?? 0) > 0) return { thanks_id: id };
    // 競合に負けたら、次の周で所属、担当、完了、重複を読み直して理由を決める。
  }
  throw new ApiError(409, 'conflict');
});

export const thanksRevokeOperation = implement(thanksRevoke, async ({ db, workspace, actor, input }) => {
  const actorId = actorUserIdOf(actor);
  const workspaceId = workspace.workspaceId;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    await throwIfClosed(db, workspaceId);
    const thanks = await db.first(
      db.statement((q) =>
        q
          .selectFrom('thanks')
          .innerJoin('tasks', 'tasks.id', 'thanks.task_id')
          .innerJoin('workspaces', 'workspaces.id', 'tasks.workspace_id')
          .select(['thanks.task_id', 'thanks.sender_user_id', 'thanks.recipient_user_id', 'tasks.completed_at'])
          .where('thanks.id', '=', input.thanks_id)
          .where('thanks.workspace_id', '=', workspaceId)
          .where('tasks.workspace_id', '=', workspaceId)
          .where('tasks.deleted_at', 'is', null)
          .where('workspaces.organization_id', '=', db.organizationId),
      ),
    );
    if (!thanks) throw new ApiError(404, 'not_found');
    if (thanks.sender_user_id !== actorId) throw new ApiError(403, 'forbidden');
    if (thanks.completed_at !== null) throw conflict('completed');
    const at = now();
    const results = await db.batch([
      db.statement((q) =>
        q
          .deleteFrom('thanks')
          .where('id', '=', input.thanks_id)
          .where('workspace_id', '=', workspaceId)
          .where('sender_user_id', '=', actorId)
          .where((eb) =>
            eb.exists(
              taskRow(q, db.organizationId, workspaceId, thanks.task_id)
                .select('tasks.id')
                .where('tasks.completed_at', 'is', null),
            ),
          )
          .where((eb) => eb.exists(openWorkspace(q, db.organizationId, workspaceId))),
      ),
      logStatement(db, workspaceId, thanks.task_id, actorId, thanks.recipient_user_id, at, true),
    ]);
    if ((results[0]?.changes ?? 0) > 0) return { thanks_id: input.thanks_id };
  }
  throw new ApiError(409, 'conflict');
});

export async function readThanks(
  db: OrganizationDb,
  workspaceId: string,
  taskId: string,
  actorId: string | null,
  writable: boolean,
) {
  const rows = await db.rows(
    db.statement((q) =>
      q
        .selectFrom('thanks')
        .innerJoin('users as sender', (join) =>
          join.onRef('sender.id', '=', 'thanks.sender_user_id').on('sender.organization_id', '=', db.organizationId),
        )
        .innerJoin('users as recipient', (join) =>
          join
            .onRef('recipient.id', '=', 'thanks.recipient_user_id')
            .on('recipient.organization_id', '=', db.organizationId),
        )
        .select([
          'thanks.id',
          'thanks.created_at',
          'sender.id as sender_id',
          'sender.name as sender_name',
          'recipient.id as recipient_id',
          'recipient.name as recipient_name',
        ])
        .where('thanks.workspace_id', '=', workspaceId)
        .where('thanks.task_id', '=', taskId)
        .orderBy('thanks.created_at')
        .orderBy('thanks.id'),
    ),
  );
  return rows.map((row) => ({
    id: row.id,
    sender: { id: row.sender_id, name: row.sender_name },
    recipient: { id: row.recipient_id, name: row.recipient_name },
    created_at: row.created_at,
    can_revoke: writable && row.sender_id === actorId,
  }));
}
