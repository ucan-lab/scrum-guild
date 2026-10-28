import { now, todayIn } from '../../shared/clock.ts';
import {
  sprintBoard,
  taskColumnMove,
  type ColumnMoveConflictReason,
  type SprintBoardColumn,
  type SprintBoardTask,
} from '../../shared/operations/sprint/index.ts';
import { type OrganizationDb, type OrganizationTables, type QueryCreator } from '../db/index.ts';
import { ApiError } from '../errors.ts';
import { uuidv7 } from '../uuid.ts';
import { implement } from './implement.ts';
import { MAX_TIES, placeAfter, placeFirst, placeLast, type MovePlan, type Positioned } from './move-position.ts';
import { activeSprint, summaryOf } from './sprint.ts';
import { actorUserIdOf, changeLogColumns, openWorkspace, throwIfClosed } from './write-guards.ts';

type From = Pick<QueryCreator<OrganizationTables>, 'selectFrom'>;

function columnConflict(reason: ColumnMoveConflictReason): ApiError {
  return new ApiError(409, 'conflict', { reason });
}

// 進行中のスプリントと、列、入っているタスクを1回の batch() で読む。
// 列は削除していないもの（ORDER BY is_done, position, id）。カードは完了したもの（completed_at がある）を完了の列に、
// それ以外を column_id の列に、column_position、id の順に置く。削除した列を指すカード（列の削除で移し損ねたもの）は、
// 先頭の完了でない列に置いて見失わない
export const sprintBoardOperation = implement(sprintBoard, async ({ db, workspace }) => {
  const organizationId = db.organizationId;
  const workspaceId = workspace.workspaceId;
  const [workspaceResult, sprintResult, columnsResult, tasksResult] = await db.batch([
    db.statement((q) =>
      q
        .selectFrom('workspaces')
        .select('workspaces.timezone')
        .where('workspaces.id', '=', workspaceId)
        .where('workspaces.organization_id', '=', organizationId),
    ),
    db.statement((q) =>
      q
        .selectFrom('sprints')
        .select(['sprints.id', 'sprints.name', 'sprints.goal', 'sprints.start_on', 'sprints.end_on', 'sprints.status'])
        .where('sprints.workspace_id', '=', workspaceId)
        .where('sprints.status', '=', 'active')
        .where('sprints.deleted_at', 'is', null),
    ),
    db.statement((q) =>
      q
        .selectFrom('board_columns')
        .select(['board_columns.id', 'board_columns.name', 'board_columns.is_done'])
        .where('board_columns.workspace_id', '=', workspaceId)
        .where('board_columns.deleted_at', 'is', null)
        .orderBy('board_columns.is_done')
        .orderBy('board_columns.position')
        .orderBy('board_columns.id'),
    ),
    db.statement((q) =>
      q
        .selectFrom('tasks')
        .leftJoin('stories', (join) =>
          join.onRef('stories.id', '=', 'tasks.story_id').on('stories.workspace_id', '=', workspaceId),
        )
        .leftJoin('users', (join) =>
          join.onRef('users.id', '=', 'tasks.assignee_user_id').on('users.organization_id', '=', organizationId),
        )
        .select([
          'tasks.id',
          'tasks.title',
          'tasks.points',
          'tasks.column_id',
          'tasks.completed_at',
          'tasks.story_id',
          'stories.title as story_title',
          'tasks.assignee_user_id',
          'users.name as assignee_name',
        ])
        .where('tasks.workspace_id', '=', workspaceId)
        .where('tasks.sprint_id', '=', activeSprint(q, workspaceId))
        .where('tasks.deleted_at', 'is', null)
        .orderBy('tasks.column_position')
        .orderBy('tasks.id'),
    ),
  ] as const);

  const settings = workspaceResult.rows[0];
  if (settings === undefined) throw new ApiError(404, 'not_found');
  const today = todayIn(settings.timezone);
  const sprintRow = sprintResult.rows[0];
  if (sprintRow === undefined) return { sprint: null, columns: [], today };

  const firstOpenId = columnsResult.rows.find((column) => column.is_done === 0)?.id;
  const knownIds = new Set(columnsResult.rows.map((column) => column.id));
  const cardsByColumn = new Map<string, SprintBoardTask[]>();
  const doneId = columnsResult.rows.find((column) => column.is_done === 1)?.id;
  for (const row of tasksResult.rows) {
    const card: SprintBoardTask = {
      id: row.id,
      title: row.title,
      points: row.points,
      assignee: row.assignee_user_id === null ? null : { id: row.assignee_user_id, name: row.assignee_name ?? '' },
      completed_at: row.completed_at,
      story: row.story_id === null || row.story_title === null ? null : { id: row.story_id, title: row.story_title },
    };
    const columnId =
      row.completed_at !== null
        ? doneId
        : row.column_id !== null && knownIds.has(row.column_id)
          ? row.column_id
          : firstOpenId;
    if (columnId === undefined) continue;
    const list = cardsByColumn.get(columnId) ?? [];
    list.push(card);
    cardsByColumn.set(columnId, list);
  }
  const columns: SprintBoardColumn[] = columnsResult.rows.map((column) => ({
    id: column.id,
    name: column.name,
    is_done: column.is_done === 1,
    tasks: cardsByColumn.get(column.id) ?? [],
  }));
  return { sprint: summaryOf(sprintRow), columns, today };
});

// 移す先の列の並び（スプリントの中の、その列の削除していないカード）から、移すカードを除いたもの
function cardsIn(from: From, workspaceId: string, sprintId: string, columnId: string, taskId: string) {
  return from
    .selectFrom('tasks')
    .where('tasks.workspace_id', '=', workspaceId)
    .where('tasks.sprint_id', '=', sprintId)
    .where('tasks.column_id', '=', columnId)
    .where('tasks.column_position', 'is not', null)
    .where('tasks.deleted_at', 'is', null)
    .where('tasks.id', '!=', taskId);
}

type CardPlace = { plan: MovePlan; after: Positioned | null };

const asPositioned = (row: { id: string; column_position: string | null }): Positioned => ({
  id: row.id,
  position: row.column_position!,
});

// 移すカードの新しい位置と、読んだ直前のカードを決める。直前のカードが移す先の列に無ければ 404。
// 列の全件は読まず、直前のカードと同じ値のカード（上限 MAX_TIES より1枚多くまで）と、それより大きい値の最初のカードだけを読む
async function planCardMove(
  db: OrganizationDb,
  workspaceId: string,
  sprintId: string,
  columnId: string,
  taskId: string,
  afterId: string | null | undefined,
): Promise<CardPlace> {
  const columns = ['tasks.id', 'tasks.column_position'] as const;
  if (afterId === undefined) {
    const last = await db.first(
      db.statement((q) =>
        cardsIn(q, workspaceId, sprintId, columnId, taskId)
          .select(columns)
          .orderBy('tasks.column_position', 'desc')
          .orderBy('tasks.id', 'desc')
          .limit(1),
      ),
    );
    return { plan: placeLast(last && asPositioned(last)), after: null };
  }
  if (afterId === null) {
    const first = await db.first(
      db.statement((q) =>
        cardsIn(q, workspaceId, sprintId, columnId, taskId)
          .select(columns)
          .orderBy('tasks.column_position')
          .orderBy('tasks.id')
          .limit(1),
      ),
    );
    return { plan: placeFirst(first && asPositioned(first)), after: null };
  }
  const afterRow = await db.first(
    db.statement((q) =>
      cardsIn(q, workspaceId, sprintId, columnId, taskId).select(columns).where('tasks.id', '=', afterId),
    ),
  );
  if (afterRow === undefined) throw new ApiError(404, 'not_found');
  const after = asPositioned(afterRow);
  const [ties, next] = await db.batch([
    db.statement((q) =>
      cardsIn(q, workspaceId, sprintId, columnId, taskId)
        .select(columns)
        .where('tasks.column_position', '=', after.position)
        .where('tasks.id', '>', after.id)
        .orderBy('tasks.id')
        .limit(MAX_TIES + 1),
    ),
    db.statement((q) =>
      cardsIn(q, workspaceId, sprintId, columnId, taskId)
        .select(columns)
        .where('tasks.column_position', '>', after.position)
        .orderBy('tasks.column_position')
        .orderBy('tasks.id')
        .limit(1),
    ),
  ] as const);
  return { plan: placeAfter(after, ties.rows.map(asPositioned), next.rows[0] && asPositioned(next.rows[0])), after };
}

// 移すカード。削除していないバックログのタスクで、入っているスプリントの状態と、今の列の名前（履歴に残す）も読む。
// スプリントに入っていなければ行が無い
function movingCard(db: OrganizationDb, workspaceId: string, taskId: string) {
  return db.first(
    db.statement((q) =>
      q
        .selectFrom('tasks')
        .innerJoin('sprints', (join) =>
          join.onRef('sprints.id', '=', 'tasks.sprint_id').on('sprints.workspace_id', '=', workspaceId),
        )
        .leftJoin('board_columns as current', (join) =>
          join.onRef('current.id', '=', 'tasks.column_id').on('current.workspace_id', '=', workspaceId),
        )
        .select([
          'tasks.id',
          'tasks.sprint_id',
          'tasks.column_id',
          'tasks.completed_at',
          'sprints.status as sprint_status',
          'sprints.deleted_at as sprint_deleted_at',
          'current.name as column_name',
        ])
        .where('tasks.id', '=', taskId)
        .where('tasks.workspace_id', '=', workspaceId)
        .where('tasks.tray', '=', 'backlog')
        .where('tasks.deleted_at', 'is', null),
    ),
  );
}

// 移す先の列。削除していない列。無ければ行が無い
function targetColumn(db: OrganizationDb, workspaceId: string, columnId: string) {
  return db.first(
    db.statement((q) =>
      q
        .selectFrom('board_columns')
        .select(['board_columns.id', 'board_columns.name', 'board_columns.is_done'])
        .where('board_columns.id', '=', columnId)
        .where('board_columns.workspace_id', '=', workspaceId)
        .where('board_columns.deleted_at', 'is', null),
    ),
  );
}

// 読んだ行から、断る理由を決める。移せるなら何も投げない。task-move と同じく、読んでから書くまでの変化も同じ関数で見直す
function assertMovable(
  card: Awaited<ReturnType<typeof movingCard>>,
  column: Awaited<ReturnType<typeof targetColumn>>,
): asserts card is NonNullable<typeof card> {
  if (card === undefined) throw new ApiError(404, 'not_found');
  if (card.sprint_deleted_at !== null || card.sprint_status !== 'active') throw columnConflict('not_active');
  if (card.completed_at !== null) throw columnConflict('task_completed');
  if (column === undefined) throw new ApiError(404, 'not_found');
  if (column.is_done === 1) throw columnConflict('done_column');
}

export const taskColumnMoveOperation = implement(taskColumnMove, async ({ db, actor, workspace, input }) => {
  const actorUserId = actorUserIdOf(actor);
  const organizationId = db.organizationId;
  const workspaceId = workspace.workspaceId;
  const taskId = input.task_id;
  const columnId = input.column_id;
  const afterId = input.after_task_id;
  if (afterId === taskId) throw new ApiError(400, 'invalid_input');

  const card = await movingCard(db, workspaceId, taskId);
  const column = card === undefined ? undefined : await targetColumn(db, workspaceId, columnId);
  assertMovable(card, column);
  const sprintId = card.sprint_id!;
  const columnChanged = card.column_id !== columnId;
  const { plan, after } = await planCardMove(db, workspaceId, sprintId, columnId, taskId, afterId);

  const at = now();
  const updatedAt = at.toISOString();
  // 自分の更新が通った、という条件。振り直しと履歴は、これを自分の条件に持つ（batch() は件数 0 の文があっても後ろの文を書く）
  const moved = (from: From) =>
    from
      .selectFrom('tasks')
      .select('tasks.id')
      .where('tasks.id', '=', taskId)
      .where('tasks.workspace_id', '=', workspaceId)
      .where('tasks.column_id', '=', columnId)
      .where('tasks.column_position', '=', plan.position)
      .where('tasks.updated_at', '=', updatedAt);

  const results = await db.batch([
    // 条件は、読んだときのスプリントと列のままで、スプリントが進行中のまま、閉じていないワークスペース、移す先の列が今もある
    // （完了の列でない）こと、直前のカードが今も読んだ値の位置にあること
    db.statement((q) =>
      q
        .updateTable('tasks')
        .set({ column_id: columnId, column_position: plan.position, updated_at: updatedAt })
        .where('id', '=', taskId)
        .where('workspace_id', '=', workspaceId)
        .where('tray', '=', 'backlog')
        .where('sprint_id', '=', sprintId)
        .where('column_id', card.column_id === null ? 'is' : '=', card.column_id)
        .where('completed_at', 'is', null)
        .where('deleted_at', 'is', null)
        .where((eb) =>
          eb.and([
            eb.exists(openWorkspace(q, organizationId, workspaceId)),
            eb.exists(activeSprint(q, workspaceId).where('act.id', '=', sprintId)),
            eb.exists(
              q
                .selectFrom('board_columns as target')
                .select('target.id')
                .where('target.id', '=', columnId)
                .where('target.workspace_id', '=', workspaceId)
                .where('target.deleted_at', 'is', null)
                .where('target.is_done', '=', 0),
            ),
          ]),
        )
        .$if(after !== null, (qb) =>
          qb.where((eb) =>
            eb.exists(
              cardsIn(q, workspaceId, sprintId, columnId, taskId)
                .select('tasks.id')
                .where('tasks.id', '=', after!.id)
                .where('tasks.column_position', '=', after!.position),
            ),
          ),
        ),
    ),
    // 同じ値のカードの振り直し。読んだときの値のままのカードだけを書く
    ...plan.renumber.map((row) =>
      db.statement((q) =>
        q
          .updateTable('tasks')
          .set({ column_position: row.to, updated_at: updatedAt })
          .where('id', '=', row.id)
          .where('workspace_id', '=', workspaceId)
          .where('sprint_id', '=', sprintId)
          .where('column_id', '=', columnId)
          .where('column_position', '=', row.from)
          .where('deleted_at', 'is', null)
          .where((eb) => eb.exists(moved(q))),
      ),
    ),
    // 列が変わったときだけ履歴を書く。列の中の並べ替えだけなら残さない
    ...(columnChanged
      ? [
          db.statement((q) =>
            q
              .insertInto('change_logs')
              .columns(changeLogColumns)
              .expression(
                q
                  .selectNoFrom((eb) => [
                    eb.val(uuidv7(at)).as('id'),
                    eb.val(organizationId).as('organization_id'),
                    eb.val(workspaceId).as('workspace_id'),
                    eb.val(actorUserId).as('actor_user_id'),
                    eb.val('task').as('entity_type'),
                    eb.val(taskId).as('entity_id'),
                    eb.val('update').as('action'),
                    eb
                      .val(
                        JSON.stringify({
                          column: [
                            card.column_id === null ? null : { id: card.column_id, name: card.column_name },
                            { id: column!.id, name: column!.name },
                          ],
                        }),
                      )
                      .as('changes_json'),
                    eb.val(updatedAt).as('created_at'),
                  ])
                  .where((eb) => eb.exists(moved(q))),
              ),
          ),
        ]
      : []),
  ]);

  if ((results[0]?.changes ?? 0) === 0) {
    // 読んでから書くまでに、閉じたか、スプリントが終わったか、タスクが消えたか完了したか、列か直前のカードが消えたか、
    // 別の要求が先に列か直前のカードを動かした
    await throwIfClosed(db, workspaceId);
    const latest = await movingCard(db, workspaceId, taskId);
    assertMovable(latest, await targetColumn(db, workspaceId, columnId));
    if (afterId != null) await planCardMove(db, workspaceId, sprintId, columnId, taskId, afterId);
    throw columnConflict('changed');
  }
  return { task_id: taskId, column_id: columnId };
});
