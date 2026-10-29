// タスクの完了を戻す（task-reopen）。docs/data-model.md の「書き込みの単位」の「完了を戻す」
import { generateKeyBetween } from 'fractional-indexing';
import { now } from '../../shared/clock.ts';
import { taskReopen, type TaskReopenConflictReason } from '../../shared/operations/task/index.ts';
import {
  previousStatementChanged,
  type OrganizationDb,
  type OrganizationTables,
  type QueryCreator,
} from '../db/index.ts';
import { ApiError } from '../errors.ts';
import { uuidv7 } from '../uuid.ts';
import { implement } from './implement.ts';
import { activeSprint } from './sprint.ts';
import { actorUserIdOf, changeLogColumns, openWorkspace, throwIfClosed } from './write-guards.ts';

type From = Pick<QueryCreator<OrganizationTables>, 'selectFrom'>;

function reopenConflict(reason: TaskReopenConflictReason): ApiError {
  return new ApiError(409, 'conflict', { reason });
}

// 完了を戻せない理由。戻せるなら null。task-reopen の断りと、task-detail の reopenable が同じ判定を使う。
// - not_completed: 完了していない
// - sprint_closed: スプリントに入ったまま完了していて、そのスプリントが進行中でない（終了したか削除した）。
//   完了で始まっていないスプリントからは外れる（task-complete）ので、始まっていないスプリントの中の完了したタスクはふつう無い。あれば同じに断る
// - parent_completed: 親のストーリーが完了している
export function reopenBlockOf(state: {
  completedAt: string | null;
  sprintId: string | null;
  sprintActive: boolean;
  parentCompleted: boolean;
}): TaskReopenConflictReason | null {
  if (state.completedAt === null) return 'not_completed';
  if (state.sprintId !== null && !state.sprintActive) return 'sprint_closed';
  if (state.parentCompleted) return 'parent_completed';
  return null;
}

// 戻すタスクと、戻す完了の記録（completed_at が tasks.completed_at と同じ行。レビューの再依頼で複数ありうる）、
// 完了の前の列、先頭の完了でない列を1回の batch() で読む。バックログの削除していないタスクだけ。ワークスペースで必ず絞る
async function readReopenTarget(db: OrganizationDb, workspaceId: string, taskId: string) {
  const organizationId = db.organizationId;
  const [taskResult, completionResult, firstResult] = await db.batch([
    db.statement((q) =>
      q
        .selectFrom('tasks')
        .leftJoin('sprints', (join) =>
          join.onRef('sprints.id', '=', 'tasks.sprint_id').on('sprints.workspace_id', '=', workspaceId),
        )
        .leftJoin('stories', (join) =>
          join.onRef('stories.id', '=', 'tasks.story_id').on('stories.workspace_id', '=', workspaceId),
        )
        .leftJoin('users', (join) =>
          join.onRef('users.id', '=', 'tasks.completed_by').on('users.organization_id', '=', organizationId),
        )
        .leftJoin('board_columns as current', (join) =>
          join.onRef('current.id', '=', 'tasks.column_id').on('current.workspace_id', '=', workspaceId),
        )
        .select([
          'tasks.id',
          'tasks.sprint_id',
          'tasks.column_id',
          'tasks.completed_at',
          'tasks.completed_by',
          'users.name as completed_by_name',
          'current.name as column_name',
          'sprints.status as sprint_status',
          'sprints.deleted_at as sprint_deleted_at',
          'stories.completed_at as story_completed_at',
        ])
        .where('tasks.id', '=', taskId)
        .where('tasks.workspace_id', '=', workspaceId)
        .where('tasks.tray', '=', 'backlog')
        .where('tasks.deleted_at', 'is', null),
    ),
    db.statement((q) =>
      q
        .selectFrom('completions')
        .innerJoin('tasks', (join) =>
          join
            .onRef('tasks.id', '=', 'completions.task_id')
            .onRef('tasks.completed_at', '=', 'completions.completed_at')
            .on('tasks.workspace_id', '=', workspaceId),
        )
        .leftJoin('board_columns as previous', (join) =>
          join
            .onRef('previous.id', '=', 'completions.previous_column_id')
            .on('previous.workspace_id', '=', workspaceId)
            .on('previous.deleted_at', 'is', null)
            .on('previous.is_done', '=', 0),
        )
        .select(['completions.id', 'previous.id as previous_column_id', 'previous.name as previous_column_name'])
        .where('completions.task_id', '=', taskId)
        .where('completions.workspace_id', '=', workspaceId)
        .orderBy('completions.id', 'desc')
        .limit(1),
    ),
    db.statement((q) =>
      q
        .selectFrom('board_columns')
        .select(['board_columns.id', 'board_columns.name'])
        .where('board_columns.workspace_id', '=', workspaceId)
        .where('board_columns.is_done', '=', 0)
        .where('board_columns.deleted_at', 'is', null)
        .orderBy('board_columns.position')
        .orderBy('board_columns.id')
        .limit(1),
    ),
  ] as const);
  const task = taskResult.rows[0];
  if (task === undefined) return undefined;
  return { task, completion: completionResult.rows[0] ?? null, firstColumn: firstResult.rows[0] ?? null };
}

type ReopenTarget = NonNullable<Awaited<ReturnType<typeof readReopenTarget>>>;

// 読んだ状態から、戻せない理由を投げる。戻せるなら何もしない
function throwIfNotReopenable(target: Awaited<ReturnType<typeof readReopenTarget>>): asserts target is ReopenTarget {
  if (target === undefined) throw new ApiError(404, 'not_found');
  const { task } = target;
  const reason = reopenBlockOf({
    completedAt: task.completed_at,
    sprintId: task.sprint_id,
    sprintActive: task.sprint_status === 'active' && task.sprint_deleted_at === null,
    parentCompleted: task.story_completed_at !== null,
  });
  if (reason !== null) throw reopenConflict(reason);
}

const reversalColumns = [
  'id',
  'workspace_id',
  'user_id',
  'action',
  'task_id',
  'completion_id',
  'amount',
  'reverses_grant_id',
  'dedupe_key',
  'confirmed_at',
] as const;

// 自分の履歴の行がある、という条件。打ち消しと記録の削除は、これで自分の更新が通ったことを見る
// （履歴は直前の UPDATE が行を変えたときだけ入り、id はこの要求だけの値なので、止めた時計でも負けた要求とは一致しない）
function ownLog(from: From, workspaceId: string, logId: string) {
  return from
    .selectFrom('change_logs')
    .select('change_logs.id')
    .where('change_logs.id', '=', logId)
    .where('change_logs.workspace_id', '=', workspaceId);
}

// 戻す列と位置。進行中のスプリントの中で完了したタスクだけ。完了の前の列（削除していない完了でない列）か、無ければ先頭の完了でない列の、
// そのスプリントでの末尾。完了でない列が1つも無ければ列なし（画面は先頭の列に出す。ふつうは無い）
async function destinationOf(db: OrganizationDb, workspaceId: string, target: ReopenTarget) {
  const sprintId = target.task.sprint_id;
  if (sprintId === null) return null;
  const column =
    target.completion?.previous_column_id != null
      ? { id: target.completion.previous_column_id, name: target.completion.previous_column_name }
      : target.firstColumn;
  if (column === null) return { sprintId, column: null, position: null };
  const last = await db.first(
    db.statement((q) =>
      q
        .selectFrom('tasks')
        .select('tasks.column_position')
        .where('tasks.workspace_id', '=', workspaceId)
        .where('tasks.sprint_id', '=', sprintId)
        .where('tasks.column_id', '=', column.id)
        .where('tasks.column_position', 'is not', null)
        .where('tasks.deleted_at', 'is', null)
        .orderBy('tasks.column_position', 'desc')
        .limit(1),
    ),
  );
  return { sprintId, column, position: generateKeyBetween(last?.column_position ?? null, null) };
}

// 書く順は、tasks の条件つきの UPDATE、change_logs（直前の文が変えたときだけ）、打ち消し、completions の削除。
// 後ろの2つは自分の履歴が入ったことを条件にする。2つの要求が同時に戻しても、後の要求の UPDATE は完了した日時が変わって通らず、何も書かない
export const taskReopenOperation = implement(taskReopen, async ({ db, actor, workspace, input }) => {
  const userId = actorUserIdOf(actor);
  const organizationId = db.organizationId;
  const workspaceId = workspace.workspaceId;
  const taskId = input.task_id;

  const target = await readReopenTarget(db, workspaceId, taskId);
  throwIfNotReopenable(target);
  const { task, completion } = target;
  const completedAt = task.completed_at!;
  const destination = await destinationOf(db, workspaceId, target);

  // 打ち消す付与。その完了の記録で付いた、打ち消されていない経験値（今は起票と完了。所属を外れた人の分も取り消す）。
  // 完了した日時が読んだ値のままなら（書く文の条件）、読んでから書くまでにこの記録の付与は増えない
  const grants =
    completion === null
      ? []
      : await db.rows(
          db.statement((q) =>
            q
              .selectFrom('xp_grants as g')
              .select(['g.id', 'g.user_id', 'g.action', 'g.amount'])
              .where('g.workspace_id', '=', workspaceId)
              .where('g.completion_id', '=', completion.id)
              .where('g.task_id', '=', taskId)
              .where('g.reverses_grant_id', 'is', null)
              .where((eb) =>
                eb.not(
                  eb.exists(
                    eb
                      .selectFrom('xp_grants as r')
                      .select('r.id')
                      .whereRef('r.reverses_grant_id', '=', 'g.id')
                      .where('r.workspace_id', '=', workspaceId),
                  ),
                ),
              )
              .orderBy('g.id'),
          ),
        );

  const at = now();
  const reopenedAt = at.toISOString();
  const logId = uuidv7(at);
  const sprintId = task.sprint_id;
  const changes: Record<string, [unknown, unknown]> = {
    completed_at: [completedAt, null],
    completed_by: [
      task.completed_by === null ? null : { id: task.completed_by, name: task.completed_by_name ?? '' },
      null,
    ],
  };
  if (destination !== null) {
    changes.column = [
      task.column_id === null ? null : { id: task.column_id, name: task.column_name },
      destination.column === null ? null : { id: destination.column.id, name: destination.column.name },
    ];
  }

  const results = await db.batch([
    // 1. tasks。読んだ完了した日時のまま、読んだスプリントのまま（進行中）、親のストーリーが未完了、閉じていないワークスペース
    db.statement((q) =>
      q
        .updateTable('tasks')
        .set({
          completed_at: null,
          completed_by: null,
          updated_at: reopenedAt,
          ...(destination === null
            ? {}
            : { column_id: destination.column?.id ?? null, column_position: destination.position }),
        })
        .where('id', '=', taskId)
        .where('workspace_id', '=', workspaceId)
        .where('tray', '=', 'backlog')
        .where('deleted_at', 'is', null)
        .where('completed_at', '=', completedAt)
        .where('sprint_id', sprintId === null ? 'is' : '=', sprintId)
        .where((eb) =>
          eb.and([
            eb.exists(openWorkspace(q, organizationId, workspaceId)),
            eb.not(
              eb.exists(
                eb
                  .selectFrom('stories')
                  .select('stories.id')
                  .whereRef('stories.id', '=', 'tasks.story_id')
                  .where('stories.workspace_id', '=', workspaceId)
                  .where('stories.completed_at', 'is not', null),
              ),
            ),
            ...(sprintId === null ? [] : [eb.exists(activeSprint(q, workspaceId).where('act.id', '=', sprintId))]),
            // 戻す列が今も削除されていない
            ...(destination?.column == null
              ? []
              : [
                  eb.exists(
                    q
                      .selectFrom('board_columns as target')
                      .select('target.id')
                      .where('target.id', '=', destination.column.id)
                      .where('target.workspace_id', '=', workspaceId)
                      .where('target.deleted_at', 'is', null)
                      .where('target.is_done', '=', 0),
                  ),
                ]),
          ]),
        ),
    ),
    // 2. change_logs。直前の UPDATE が行を変えたときだけ
    db.statement((q) =>
      q
        .insertInto('change_logs')
        .columns(changeLogColumns)
        .expression(
          q
            .selectNoFrom((eb) => [
              eb.val(logId).as('id'),
              eb.val(organizationId).as('organization_id'),
              eb.val(workspaceId).as('workspace_id'),
              eb.val(userId).as('actor_user_id'),
              eb.val('task').as('entity_type'),
              eb.val(taskId).as('entity_id'),
              eb.val('reopen').as('action'),
              eb.val(JSON.stringify(changes)).as('changes_json'),
              eb.val(reopenedAt).as('created_at'),
            ])
            .where(previousStatementChanged),
        ),
    ),
    // 3. 打ち消しの明細。元の行を指し、負の値を足す（story-reopen と同じ形）
    ...grants.map((grant) =>
      db.statement((q) =>
        q
          .insertInto('xp_grants')
          .columns(reversalColumns)
          .expression(
            q
              .selectNoFrom((eb) => [
                eb.val(uuidv7(at)).as('id'),
                eb.val(workspaceId).as('workspace_id'),
                eb.val(grant.user_id).as('user_id'),
                eb.val(grant.action).as('action'),
                eb.val(taskId).as('task_id'),
                eb.val(completion!.id).as('completion_id'),
                eb.val(-grant.amount).as('amount'),
                eb.val(grant.id).as('reverses_grant_id'),
                eb.val(`reversal:${grant.id}`).as('dedupe_key'),
                eb.val(reopenedAt).as('confirmed_at'),
              ])
              .where((eb) =>
                eb.and([
                  eb.exists(ownLog(eb, workspaceId, logId)),
                  eb.not(
                    eb.exists(
                      eb
                        .selectFrom('xp_grants')
                        .select('xp_grants.id')
                        .where('xp_grants.reverses_grant_id', '=', grant.id)
                        .where('xp_grants.workspace_id', '=', workspaceId),
                    ),
                  ),
                ]),
              ),
          ),
      ),
    ),
    // 4. completions。戻した完了の記録を消す（完了の記録は今完了しているタスクだけが持つ）
    ...(completion === null
      ? []
      : [
          db.statement((q) =>
            q
              .deleteFrom('completions')
              .where('completions.id', '=', completion.id)
              .where('completions.workspace_id', '=', workspaceId)
              .where((eb) => eb.exists(ownLog(q, workspaceId, logId))),
          ),
        ]),
  ]);

  if ((results[0]?.changes ?? 0) === 0) {
    // 読んでから書くまでに、閉じたか、消えたか、別の要求が先に戻したか、スプリントが終わったか、親のストーリーが完了したか、
    // 戻してからもう一度完了にされた（完了した日時が変わった）か、戻す列が削除された
    await throwIfClosed(db, workspaceId);
    throwIfNotReopenable(await readReopenTarget(db, workspaceId, taskId));
    throw reopenConflict('changed');
  }
  return {
    task_id: taskId,
    sprint_id: sprintId,
    column_id: destination === null ? null : (destination.column?.id ?? null),
  };
});
