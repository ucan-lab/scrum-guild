import { generateKeyBetween } from 'fractional-indexing';
import { monthIn, now } from '../../shared/clock.ts';
import { XP_TASK_COMPLETED, XP_TASK_CREATED } from '../../shared/experience.ts';
import { taskComplete, taskCreate, taskList } from '../../shared/operations/task/index.ts';
import { MIN_POINTS_FOR_EXPERIENCE } from '../../shared/task.ts';
import type { OrganizationDb, OrganizationTables, QueryCreator } from '../db/index.ts';
import { ApiError } from '../errors.ts';
import { uuidv7 } from '../uuid.ts';
import { implement } from './implement.ts';

type Tables = OrganizationTables;

// 呼んだ人の users の行。permission: 'member' は users の行がある人だけを通す。型の上の null を 404 で閉じる
function actorUserIdOf(actor: { userId: string | null }): string {
  if (actor.userId === null) throw new ApiError(404, 'not_found');
  return actor.userId;
}

// そのワークスペースに今所属している、無効でない人の名前。いなければ undefined
function activeMemberName(
  from: Pick<QueryCreator<Tables>, 'selectFrom'>,
  organizationId: string,
  workspaceId: string,
  userId: string,
) {
  return from
    .selectFrom('memberships as m')
    .innerJoin('users as u', 'u.id', 'm.user_id')
    .select('u.name')
    .where('m.workspace_id', '=', workspaceId)
    .where('m.user_id', '=', userId)
    .where('m.left_at', 'is', null)
    .where('u.organization_id', '=', organizationId)
    .where('u.disabled_at', 'is', null);
}

// 閉じていないワークスペース。書く文の条件に入れ、読んでから書くまでの間にワークスペースが閉じた競合を止める
// （登録の関数が見る閉じたかどうかは、読み取りの時点の値）
function openWorkspace(from: Pick<QueryCreator<Tables>, 'selectFrom'>, organizationId: string, workspaceId: string) {
  return from
    .selectFrom('workspaces')
    .select('workspaces.id')
    .where('workspaces.id', '=', workspaceId)
    .where('workspaces.organization_id', '=', organizationId)
    .where('workspaces.closed_at', 'is', null);
}

// 条件で落ちた書き込みの理由を、書いた後に読み直して決める。閉じていれば登録の関数と同じ 409 の workspace_closed
async function throwIfClosed(db: OrganizationDb, workspaceId: string): Promise<void> {
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

// 親のないバックログのタスク。一覧と、末尾の位置を決める読み取りが同じ範囲を使う
function rootBacklogTasks(from: Pick<QueryCreator<Tables>, 'selectFrom'>, workspaceId: string) {
  return from
    .selectFrom('tasks')
    .where('tasks.workspace_id', '=', workspaceId)
    .where('tasks.tray', '=', 'backlog')
    .where('tasks.story_id', 'is', null)
    .where('tasks.deleted_at', 'is', null);
}

export const taskCreateOperation = implement(taskCreate, async ({ db, actor, workspace, input }) => {
  const actorUserId = actorUserIdOf(actor);
  const organizationId = db.organizationId;
  const workspaceId = workspace.workspaceId;

  // 担当は、このワークスペースに今所属している人だけ。読んで名前を残し、書く文にも同じ条件を入れる
  let assignee: { id: string; name: string } | null = null;
  if (input.assignee_user_id !== null) {
    const found = await db.first(
      db.statement((q) => activeMemberName(q, organizationId, workspaceId, input.assignee_user_id!)),
    );
    if (found === undefined) throw new ApiError(404, 'not_found');
    assignee = { id: input.assignee_user_id, name: found.name };
  }

  // 位置は親のないタスクの末尾。完了したタスクも並びに残っているので、それも含めた末尾に置く。
  // 同時に作ると同じ位置になりうるが、並びは id で決まるので順番は崩れない
  const last = await db.first(
    db.statement((q) =>
      rootBacklogTasks(q, workspaceId).select('tasks.position').orderBy('tasks.position', 'desc').limit(1),
    ),
  );
  const at = now();
  const createdAt = at.toISOString();
  const taskId = uuidv7(at);
  const position = generateKeyBetween(last?.position ?? null, null);

  const results = await db.batch([
    db.statement((q) =>
      q
        .insertInto('tasks')
        .columns([
          'id',
          'workspace_id',
          'is_imported',
          'tray',
          'title',
          'points',
          'assignee_user_id',
          'position',
          'created_by',
          'created_at',
          'updated_at',
        ])
        .expression(
          q
            .selectNoFrom((eb) => [
              eb.val(taskId).as('id'),
              eb.val(workspaceId).as('workspace_id'),
              eb.val(0).as('is_imported'),
              eb.val('backlog').as('tray'),
              eb.val(input.title).as('title'),
              eb.val(input.points).as('points'),
              eb.val(assignee?.id ?? null).as('assignee_user_id'),
              eb.val(position).as('position'),
              eb.val(actorUserId).as('created_by'),
              eb.val(createdAt).as('created_at'),
              eb.val(createdAt).as('updated_at'),
            ])
            .where((eb) => eb.exists(openWorkspace(eb, organizationId, workspaceId)))
            .$if(assignee !== null, (qb) =>
              qb.where((eb) => eb.exists(activeMemberName(eb, organizationId, workspaceId, assignee!.id))),
            ),
        ),
    ),
    // 作った行がある（担当の条件を通った）ときだけ履歴を書く
    db.statement((q) =>
      q
        .insertInto('change_logs')
        .columns([
          'id',
          'organization_id',
          'workspace_id',
          'actor_user_id',
          'entity_type',
          'entity_id',
          'action',
          'changes_json',
          'created_at',
        ])
        .expression(
          q
            .selectNoFrom((eb) => [
              eb.val(uuidv7(at)).as('id'),
              eb.val(organizationId).as('organization_id'),
              eb.val(workspaceId).as('workspace_id'),
              eb.val(actorUserId).as('actor_user_id'),
              eb.val('task').as('entity_type'),
              eb.val(taskId).as('entity_id'),
              eb.val('create').as('action'),
              eb
                .val(
                  JSON.stringify({
                    title: [null, input.title],
                    points: [null, input.points],
                    ...(assignee === null ? {} : { assignee: [null, assignee] }),
                  }),
                )
                .as('changes_json'),
              eb.val(createdAt).as('created_at'),
            ])
            .where((eb) =>
              eb.exists(
                eb
                  .selectFrom('tasks')
                  .select('tasks.id')
                  .where('tasks.id', '=', taskId)
                  .where('tasks.workspace_id', '=', workspaceId),
              ),
            ),
        ),
    ),
  ]);

  // 読んでから書くまでに、ワークスペースが閉じたか、担当が所属を外れたら何も入らない
  if ((results[0]?.changes ?? 0) === 0) {
    await throwIfClosed(db, workspaceId);
    throw new ApiError(404, 'not_found');
  }
  return { task: { id: taskId, title: input.title, points: input.points, assignee } };
});

// 件数に上限を付けない。バックログの木と絞り込みは、バックログと階層の Issue で足す
export const taskListOperation = implement(taskList, async ({ db, workspace }) => {
  const workspaceId = workspace.workspaceId;
  const [openResult, completedResult] = await db.batch([
    db.statement((q) =>
      rootBacklogTasks(q, workspaceId)
        .leftJoin('users', (join) =>
          join.onRef('users.id', '=', 'tasks.assignee_user_id').on('users.organization_id', '=', db.organizationId),
        )
        .select(['tasks.id', 'tasks.title', 'tasks.points', 'tasks.assignee_user_id', 'users.name as assignee_name'])
        .where('tasks.completed_at', 'is', null)
        .orderBy('tasks.position')
        .orderBy('tasks.id'),
    ),
    db.statement((q) =>
      rootBacklogTasks(q, workspaceId)
        .select((eb) => eb.fn.countAll<number>().as('count'))
        .where('tasks.completed_at', 'is not', null),
    ),
  ] as const);

  return {
    tasks: openResult.rows.map((row) => ({
      id: row.id,
      title: row.title,
      points: row.points as 0 | 1 | 2 | 3 | 5 | 8 | 13 | null,
      assignee: row.assignee_user_id === null ? null : { id: row.assignee_user_id, name: row.assignee_name ?? '' },
    })),
    completed_count: Number(completedResult.rows[0]?.count ?? 0),
  };
});

// 完了の記録の列。INSERT ... SELECT の選ぶ列の並びと合わせる
const completionColumns = [
  'id',
  'workspace_id',
  'task_id',
  'completed_at',
  'completed_by',
  'points',
  'assignee_user_id',
  'sprint_id',
  'category_id',
  'billing_month',
  'created_at',
  'updated_at',
] as const;

const grantColumns = [
  'id',
  'workspace_id',
  'user_id',
  'action',
  'task_id',
  'completion_id',
  'amount',
  'dedupe_key',
  'confirmed_at',
] as const;

// 自分の文が入れた完了の記録がある、という条件。後続の文はこれで、先に入った文が通ったかを見る
function completionExists(eb: Pick<QueryCreator<Tables>, 'selectFrom'>, workspaceId: string, completionId: string) {
  return eb
    .selectFrom('completions')
    .select('completions.id')
    .where('completions.id', '=', completionId)
    .where('completions.workspace_id', '=', workspaceId);
}

type CompletionParams = {
  workspaceId: string;
  taskId: string;
  completionId: string;
  userId: string;
  at: string;
};

// 起票と完了の経験値の1行。ポイント、起票した人、担当は先に読まず、tasks の行から取る。
// 条件は、ポイントが 1 以上（完了にした時点の値）と、自分の完了の記録が入ったこと
function grantStatement(
  db: OrganizationDb,
  params: CompletionParams,
  grant: { id: string; action: 'task_created' | 'task_completed'; amount: number },
) {
  const { workspaceId, taskId, completionId, userId, at } = params;
  return db.statement((q) =>
    q
      .insertInto('xp_grants')
      .columns(grantColumns)
      .expression(
        q
          .selectFrom('tasks')
          .select((eb) => [
            eb.val(grant.id).as('id'),
            'tasks.workspace_id as workspace_id',
            // 起票は作った人へ。完了は完了した時点の担当者へ、担当がいなければ完了にした人へ
            grant.action === 'task_created'
              ? eb.ref('tasks.created_by').as('user_id')
              : eb.fn.coalesce('tasks.assignee_user_id', eb.val(userId)).as('user_id'),
            eb.val(grant.action).as('action'),
            'tasks.id as task_id',
            eb.val(completionId).as('completion_id'),
            eb.val(grant.amount).as('amount'),
            eb.val(`${grant.action}:${completionId}`).as('dedupe_key'),
            eb.val(at).as('confirmed_at'),
          ])
          .where((eb) =>
            eb.and([
              eb('tasks.id', '=', taskId),
              eb('tasks.workspace_id', '=', workspaceId),
              eb('tasks.points', '>=', MIN_POINTS_FOR_EXPERIENCE),
              ...(grant.action === 'task_created' ? [eb('tasks.created_by', 'is not', null)] : []),
              // 受け取る人は、このワークスペースに今所属している人だけ（所属していない管理者は経験値の対象にならない）
              eb.exists(
                eb
                  .selectFrom('memberships')
                  .select('memberships.id')
                  .where('memberships.workspace_id', '=', workspaceId)
                  .where('memberships.left_at', 'is', null)
                  .where(
                    'memberships.user_id',
                    '=',
                    grant.action === 'task_created'
                      ? eb.ref('tasks.created_by')
                      : eb.fn.coalesce('tasks.assignee_user_id', eb.val(userId)),
                  ),
              ),
              eb.exists(completionExists(q, workspaceId, completionId)),
            ]),
          ),
      ),
  );
}

export const taskCompleteOperation = implement(taskComplete, async ({ db, actor, workspace, input }) => {
  const userId = actorUserIdOf(actor);
  const organizationId = db.organizationId;
  const workspaceId = workspace.workspaceId;
  const taskId = input.task_id;

  // 計上月を決めるタイムゾーンと、履歴に残す自分の名前。ポイント、担当、区分は読まず、書く文が tasks の行から取る
  const [workspaceResult, userResult] = await db.batch([
    db.statement((q) =>
      q
        .selectFrom('workspaces')
        .select('timezone')
        .where('id', '=', workspaceId)
        .where('organization_id', '=', organizationId),
    ),
    db.statement((q) =>
      q.selectFrom('users').select('name').where('id', '=', userId).where('organization_id', '=', organizationId),
    ),
  ] as const);
  const timezone = workspaceResult.rows[0]?.timezone;
  const userName = userResult.rows[0]?.name;
  if (timezone === undefined || userName === undefined) throw new ApiError(404, 'not_found');

  const at = now();
  const completedAt = at.toISOString();
  const params: CompletionParams = { workspaceId, taskId, completionId: uuidv7(at), userId, at: completedAt };
  const { completionId } = params;
  const billingMonth = monthIn(timezone, at);

  const results = await db.batch([
    // 1. tasks。変わった行が0なら、タスクが無いか、すでに完了
    db.statement((q) =>
      q
        .updateTable('tasks')
        .set({ completed_at: completedAt, completed_by: userId, updated_at: completedAt })
        .where('id', '=', taskId)
        .where('workspace_id', '=', workspaceId)
        .where('completed_at', 'is', null)
        .where('deleted_at', 'is', null)
        .where((eb) => eb.exists(openWorkspace(q, organizationId, workspaceId))),
    ),
    // 2. completions。止めた時計で同じ人が2回完了にしても、先に入った記録があれば何も入らない
    db.statement((q) =>
      q
        .insertInto('completions')
        .columns(completionColumns)
        .expression(
          q
            .selectFrom('tasks')
            .leftJoin('categories', (join) =>
              join
                .onRef('categories.id', '=', 'tasks.category_id')
                .onRef('categories.workspace_id', '=', 'tasks.workspace_id'),
            )
            .select((eb) => [
              eb.val(completionId).as('id'),
              'tasks.workspace_id as workspace_id',
              'tasks.id as task_id',
              'tasks.completed_at as completed_at',
              'tasks.completed_by as completed_by',
              'tasks.points as points',
              'tasks.assignee_user_id as assignee_user_id',
              'tasks.sprint_id as sprint_id',
              'tasks.category_id as category_id',
              // 月ごとに計上する区分のときだけ入る。既定は完了した月（ワークスペースのタイムゾーン）
              eb
                .case()
                .when('categories.is_billed_monthly', '=', 1)
                .then(billingMonth)
                .else(null)
                .end()
                .as('billing_month'),
              eb.val(completedAt).as('created_at'),
              eb.val(completedAt).as('updated_at'),
            ])
            .where((eb) =>
              eb.and([
                eb('tasks.id', '=', taskId),
                eb('tasks.workspace_id', '=', workspaceId),
                eb('tasks.completed_at', '=', completedAt),
                eb('tasks.completed_by', '=', userId),
                eb.not(
                  eb.exists(
                    eb
                      .selectFrom('completions')
                      .select('completions.id')
                      .where('completions.workspace_id', '=', workspaceId)
                      .where('completions.task_id', '=', taskId)
                      .where('completions.completed_at', '=', completedAt),
                  ),
                ),
              ]),
            ),
        ),
    ),
    // 3. xp_grants。起票と完了
    grantStatement(db, params, { id: uuidv7(at), action: 'task_created', amount: XP_TASK_CREATED }),
    grantStatement(db, params, { id: uuidv7(at), action: 'task_completed', amount: XP_TASK_COMPLETED }),
    // 4. change_logs。3 と同じく、自分の完了の記録が入ったときだけ
    db.statement((q) =>
      q
        .insertInto('change_logs')
        .columns([
          'id',
          'organization_id',
          'workspace_id',
          'actor_user_id',
          'entity_type',
          'entity_id',
          'action',
          'changes_json',
          'created_at',
        ])
        .expression(
          q
            .selectNoFrom((eb) => [
              eb.val(uuidv7(at)).as('id'),
              eb.val(organizationId).as('organization_id'),
              eb.val(workspaceId).as('workspace_id'),
              eb.val(userId).as('actor_user_id'),
              eb.val('task').as('entity_type'),
              eb.val(taskId).as('entity_id'),
              eb.val('complete').as('action'),
              eb
                .val(
                  JSON.stringify({
                    completed_at: [null, completedAt],
                    completed_by: [null, { id: userId, name: userName }],
                  }),
                )
                .as('changes_json'),
              eb.val(completedAt).as('created_at'),
            ])
            .where((eb) => eb.exists(completionExists(q, workspaceId, completionId))),
        ),
    ),
  ]);

  if ((results[0]?.changes ?? 0) === 0) {
    // 先に読んだ値ではなく、書いた結果で決める。読んでから書くまでに閉じたなら 409 の workspace_closed、
    // タスクが無い（別の組織のタスクを含む）なら 404、あるのに変わらなければ完了済みの 409 の conflict
    await throwIfClosed(db, workspaceId);
    const existing = await db.first(
      db.statement((q) =>
        q
          .selectFrom('tasks')
          .select('tasks.id')
          .where('tasks.id', '=', taskId)
          .where('tasks.workspace_id', '=', workspaceId)
          .where('tasks.deleted_at', 'is', null),
      ),
    );
    throw existing === undefined ? new ApiError(404, 'not_found') : new ApiError(409, 'conflict');
  }
  return { task_id: taskId, completed_at: completedAt };
});
