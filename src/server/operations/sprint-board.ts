import { now, todayIn } from '../../shared/clock.ts';
import {
  sprintBoard,
  taskColumnMove,
  type ColumnMoveConflictReason,
  type SprintBoardColumn,
  type SprintBoardTask,
} from '../../shared/operations/sprint/index.ts';
import {
  activeSprintRowFilter,
  previousStatementChanged,
  type ExpressionBuilder,
  type OrganizationDb,
  type OrganizationTables,
  type QueryCreator,
} from '../db/index.ts';
import { ApiError } from '../errors.ts';
import { uuidv7 } from '../uuid.ts';
import { implement } from './implement.ts';
import { MAX_TIES, placeAfter, placeFirst, placeLast, type MovePlan, type Positioned } from './move-position.ts';
import { activeSprint, firstColumn, summaryOf } from './sprint.ts';
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
        .select(['workspaces.timezone', 'workspaces.week_start'])
        .where('workspaces.id', '=', workspaceId)
        .where('workspaces.organization_id', '=', organizationId),
    ),
    db.statement((q) =>
      q
        .selectFrom('sprints')
        .select(['sprints.id', 'sprints.name', 'sprints.goal', 'sprints.start_on', 'sprints.end_on', 'sprints.status'])
        .where('sprints.workspace_id', '=', workspaceId)
        .where(activeSprintRowFilter('sprints')),
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
        .leftJoin('repositories', (join) =>
          join
            .onRef('repositories.id', '=', 'tasks.repository_id')
            .on('repositories.workspace_id', '=', workspaceId)
            .on('repositories.deleted_at', 'is', null),
        )
        .select([
          'tasks.id',
          'tasks.title',
          'tasks.points',
          'tasks.due_on',
          'repositories.id as repository_id',
          'repositories.name as repository_name',
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
  const weekStart = settings.week_start;
  if (sprintRow === undefined) return { sprint: null, columns: [], today, week_start: weekStart };

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
      due_on: row.due_on,
      repository:
        row.repository_id === null || row.repository_name === null
          ? null
          : { id: row.repository_id, name: row.repository_name },
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
  return { sprint: summaryOf(sprintRow), columns, today, week_start: weekStart };
});

// カードがこの列にいる、という条件。column_id がその列を指すか、削除した列を指していて（列の削除で移し損ねたカード）、
// この列が先頭の列であること。画面は後者のカードを先頭の列に出すので、並びの計算も同じ列に数える
function inColumn(
  eb: ExpressionBuilder<OrganizationTables, 'tasks'>,
  from: From,
  workspaceId: string,
  columnId: string,
) {
  return eb.or([
    eb('tasks.column_id', '=', columnId),
    eb.and([
      eb.not(
        eb.exists(
          from
            .selectFrom('board_columns as live')
            .select('live.id')
            .where('live.id', '=', eb.ref('tasks.column_id'))
            .where('live.workspace_id', '=', workspaceId)
            .where('live.deleted_at', 'is', null),
        ),
      ),
      eb(eb.val(columnId), '=', firstColumn(from, workspaceId)),
    ]),
  ]);
}

// 移す先の列の並び（スプリントの中の、その列の削除していないカード）から、移すカードを除いたもの
function cardsIn(from: From, workspaceId: string, sprintId: string, columnId: string, taskId: string) {
  return from
    .selectFrom('tasks')
    .where('tasks.workspace_id', '=', workspaceId)
    .where('tasks.sprint_id', '=', sprintId)
    .where((eb) => inColumn(eb, from, workspaceId, columnId))
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

// カードが移す先の列の求められた位置にいるか。afterId は task-column-move の after_task_id と同じ（null は先頭、省くと末尾、
// カードの ID ならその直後）。列の並びは column_position、id の順。position は読み直したカードの今の位置
async function isPlaced(
  db: OrganizationDb,
  place: {
    workspaceId: string;
    sprintId: string;
    columnId: string;
    taskId: string;
    afterId: string | null | undefined;
    position: string;
  },
): Promise<boolean> {
  const { workspaceId, sprintId, columnId, taskId, afterId, position } = place;
  const precedes = (eb: ExpressionBuilder<OrganizationTables, 'tasks'>) =>
    eb.or([
      eb('tasks.column_position', '<', position),
      eb.and([eb('tasks.column_position', '=', position), eb('tasks.id', '<', taskId)]),
    ]);
  if (afterId === undefined) {
    const follower = await db.first(
      db.statement((q) =>
        cardsIn(q, workspaceId, sprintId, columnId, taskId)
          .select('tasks.id')
          .where((eb) => eb.not(precedes(eb)))
          .limit(1),
      ),
    );
    return follower === undefined;
  }
  const predecessor = await db.first(
    db.statement((q) =>
      cardsIn(q, workspaceId, sprintId, columnId, taskId)
        .select('tasks.id')
        .where(precedes)
        .orderBy('tasks.column_position', 'desc')
        .orderBy('tasks.id', 'desc')
        .limit(1),
    ),
  );
  return (predecessor?.id ?? null) === afterId;
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
          'tasks.column_position',
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
  // 移せる状態のカード。読んだときのスプリントと列のままで、未完了、スプリントが進行中のまま、閉じていないワークスペース、
  // 移す先の列が今もある（完了の列でない）こと、直前のカードが今も読んだ値の位置にあること。
  // 時刻や位置の一致では自分の更新かどうかを決められない（同じミリ秒に同じ先へ移す別の要求と区別できない）ので、
  // 振り直しと本体の更新が同じ条件を使い、履歴は本体の更新の件数（previousStatementChanged）に結ぶ
  const movable = (from: From) =>
    from
      .selectFrom('tasks as mv')
      .select('mv.id')
      .where('mv.id', '=', taskId)
      .where('mv.workspace_id', '=', workspaceId)
      .where('mv.tray', '=', 'backlog')
      .where('mv.sprint_id', '=', sprintId)
      .where('mv.column_id', card.column_id === null ? 'is' : '=', card.column_id)
      .where('mv.completed_at', 'is', null)
      .where('mv.deleted_at', 'is', null)
      .where((eb) =>
        eb.and([
          eb.exists(openWorkspace(from, organizationId, workspaceId)),
          eb.exists(activeSprint(from, workspaceId).where('act.id', '=', sprintId)),
          eb.exists(
            from
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
            cardsIn(from, workspaceId, sprintId, columnId, taskId)
              .select('tasks.id')
              .where('tasks.id', '=', after!.id)
              .where('tasks.column_position', '=', after!.position),
          ),
        ),
      );

  const results = await db.batch([
    // 同じ値のカードの振り直し。移せる状態のときだけ、読んだときの値のままのカードを書く。
    // 本体の更新より前に置くので、断られた要求は振り直しも書かない（間に他の要求は入らず、振り直しは移せる状態を変えない）
    ...plan.renumber.map((row) =>
      db.statement((q) =>
        q
          .updateTable('tasks')
          .set({ column_position: row.to, updated_at: updatedAt })
          .where('id', '=', row.id)
          .where('workspace_id', '=', workspaceId)
          .where('sprint_id', '=', sprintId)
          .where((eb) => inColumn(eb, q, workspaceId, columnId))
          .where('column_position', '=', row.from)
          .where('deleted_at', 'is', null)
          .where((eb) => eb.exists(movable(q))),
      ),
    ),
    db.statement((q) =>
      q
        .updateTable('tasks')
        .set({ column_id: columnId, column_position: plan.position, updated_at: updatedAt })
        .where('id', '=', taskId)
        .where((eb) => eb.exists(movable(q))),
    ),
    // 列が変わったときだけ履歴を書く（直前の更新が行を変えたときだけ）。列の中の並べ替えだけなら残さない
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
                  .where(previousStatementChanged),
              ),
          ),
        ]
      : []),
  ]);

  if ((results[plan.renumber.length]?.changes ?? 0) === 0) {
    // 読んでから書くまでに、閉じたか、スプリントが終わったか、タスクが消えたか完了したか、列か直前のカードが消えたか、
    // 別の要求が先に列か直前のカードを動かした
    await throwIfClosed(db, workspaceId);
    const latest = await movingCard(db, workspaceId, taskId);
    assertMovable(latest, await targetColumn(db, workspaceId, columnId));
    // 同じ移動の要求が2回届いた（二重送信、再送）。先の要求が通った後なら、カードは既に移す先の列の求められた位置にいるので、
    // 書かずに成功として返す（履歴も書かない）
    if (
      latest.column_id === columnId &&
      latest.column_position !== null &&
      (await isPlaced(db, { workspaceId, sprintId, columnId, taskId, afterId, position: latest.column_position }))
    ) {
      return { task_id: taskId, column_id: columnId };
    }
    if (afterId != null) await planCardMove(db, workspaceId, sprintId, columnId, taskId, afterId);
    throw columnConflict('changed');
  }
  return { task_id: taskId, column_id: columnId };
});
