// スプリントを終える（sprint-close）。docs/data-model.md の「書き込みの単位」の「スプリントの終了」
import { generateNKeysBetween } from 'fractional-indexing';
import { now } from '../../shared/clock.ts';
import { sprintClose, type SprintRef } from '../../shared/operations/sprint/index.ts';
import {
  jsonList,
  jsonPairLookup,
  previousStatementChanged,
  sprintLogRefSql,
  uuidv7Sql,
  type OrganizationDb,
  type OrganizationTables,
  type QueryCreator,
} from '../db/index.ts';
import { ApiError } from '../errors.ts';
import { uuidv7 } from '../uuid.ts';
import { implement } from './implement.ts';
import { firstColumn } from './sprint.ts';
import { actorUserIdOf, changeLogColumns, openWorkspace, throwIfClosed } from './write-guards.ts';

type From = Pick<QueryCreator<OrganizationTables>, 'selectFrom'>;

// 読み直してやり直す回数の上限。超えたら 409 の conflict（changed）
const MAX_CLOSE_ATTEMPTS = 3;

function conflict(reason: 'not_active' | 'carry_target' | 'changed'): ApiError {
  return new ApiError(409, 'conflict', { reason });
}

type ClosingSprint = {
  id: string;
  name: string | null;
  goal: string | null;
  start_on: string;
  end_on: string;
  status: string;
};

// 終えるスプリントと持ち越し先、入っている未完了のタスク（終えるスプリントでの並びの順）、先頭の列を1回の batch() で読む。
// 持ち越し先を指さないとき（バックログ）は、持ち越し先の文は行を返さない（主キーは NULL にならない）
async function readClosing(db: OrganizationDb, workspaceId: string, sprintId: string, carryId: string | null) {
  const [sprintResult, tasksResult, carryResult, columnResult] = await db.batch([
    db.statement((q) =>
      q
        .selectFrom('sprints')
        .select(['sprints.id', 'sprints.name', 'sprints.goal', 'sprints.start_on', 'sprints.end_on', 'sprints.status'])
        .where('sprints.id', '=', sprintId)
        .where('sprints.workspace_id', '=', workspaceId)
        .where('sprints.deleted_at', 'is', null),
    ),
    // 未完了のタスク。列の順（ORDER BY is_done, position, id）、その中の column_position、id の順（sprint-list と同じ）。
    // 持ち越し先の列でもこの順に並べる
    db.statement((q) =>
      q
        .selectFrom('tasks')
        .leftJoin('board_columns', (join) =>
          join.onRef('board_columns.id', '=', 'tasks.column_id').on('board_columns.workspace_id', '=', workspaceId),
        )
        .select('tasks.id')
        .where('tasks.sprint_id', '=', sprintId)
        .where('tasks.workspace_id', '=', workspaceId)
        .where('tasks.deleted_at', 'is', null)
        .where('tasks.completed_at', 'is', null)
        .orderBy('board_columns.is_done')
        .orderBy('board_columns.position')
        .orderBy('board_columns.id')
        .orderBy('tasks.column_position')
        .orderBy('tasks.id'),
    ),
    db.statement((q) =>
      q
        .selectFrom('sprints')
        .select(['sprints.id', 'sprints.name', 'sprints.goal', 'sprints.start_on', 'sprints.end_on', 'sprints.status'])
        .where('sprints.id', carryId === null ? 'is' : '=', carryId)
        .where('sprints.workspace_id', '=', workspaceId)
        .where('sprints.deleted_at', 'is', null),
    ),
    db.statement((q) => firstColumn(q, workspaceId)),
  ] as const);
  return {
    sprint: sprintResult.rows[0] as ClosingSprint | undefined,
    taskIds: tasksResult.rows.map((row) => row.id),
    carry: carryResult.rows[0] as ClosingSprint | undefined,
    columnId: columnResult.rows[0]?.id,
  };
}

// 持ち越し先のスプリントの、先頭の列の末尾の column_position
async function tailPosition(db: OrganizationDb, workspaceId: string, carryId: string, columnId: string) {
  const row = await db.first(
    db.statement((q) =>
      q
        .selectFrom('tasks')
        .select('tasks.column_position')
        .where('tasks.workspace_id', '=', workspaceId)
        .where('tasks.sprint_id', '=', carryId)
        .where('tasks.column_id', '=', columnId)
        .where('tasks.deleted_at', 'is', null)
        .orderBy('tasks.column_position', 'desc')
        .limit(1),
    ),
  );
  return row?.column_position ?? null;
}

function refOf(sprint: ClosingSprint): SprintRef {
  return { id: sprint.id, name: sprint.name, start_on: sprint.start_on, end_on: sprint.end_on };
}

// 終える。先に読んだものから、書く文を決める。書く文は持ち越すタスクの数によらない決まった数で、1回の batch() で送る。
// 持ち越すタスクの ID と位置は JSON の配列1つで渡す（bind は1つなので、1文の bind の上限にも batch() の大きさにも当たらず、分けない）。
// 1. sprints: 進行中のまま、読んだ未完了のタスクの集合のまま、持ち越し先が先のスプリントのまま、閉じていないワークスペースのときだけ closed にする。
// 2. スプリントの change_logs: 直前の UPDATE が行を変えたときだけ入れる。以降の文は、この履歴の行（この要求だけの id）があることを条件にする。
//    止めた時計（DEV_NOW）では、先に終えた要求と自分の終了を時刻で見分けられないため
// 3. 持ち越すタスクごとの change_logs、4. 入っている行を completed か carried_over で閉じる、5. 持ち越し先がスプリントなら新しい行を足す、
// 6. 持ち越すタスクを書く。3〜5 はタスクを書き換えないので、6 まで同じタスクに当たる。履歴を先に置く（書き換えた後は条件に当たらなくなるため）。
// 通らなかったら理由を読み直して分ける（閉じた、無い、進行中でない、持ち越し先が合わない）。どれでもなければ読み直してやり直す
export const sprintCloseOperation = implement(sprintClose, async ({ db, actor, workspace, input }) => {
  const actorUserId = actorUserIdOf(actor);
  const organizationId = db.organizationId;
  const workspaceId = workspace.workspaceId;
  const sprintId = input.sprint_id;
  const carryId = input.carry_sprint_id;

  for (let attempt = 0; attempt < MAX_CLOSE_ATTEMPTS; attempt++) {
    const { sprint, taskIds, carry, columnId } = await readClosing(db, workspaceId, sprintId, carryId);
    if (sprint === undefined) {
      await throwIfClosed(db, workspaceId);
      throw new ApiError(404, 'not_found');
    }
    if (sprint.status !== 'active') {
      await throwIfClosed(db, workspaceId);
      throw conflict('not_active');
    }
    // ゴールのあるスプリントは達成を聞き、ゴールのないスプリントは聞かない
    if ((sprint.goal !== null) !== (input.is_goal_achieved !== null)) throw new ApiError(400, 'invalid_input');
    if (carryId !== null) {
      if (carry === undefined) {
        await throwIfClosed(db, workspaceId);
        throw new ApiError(404, 'not_found');
      }
      // 持ち越し先は、先のスプリントのうち終えるスプリントの最終日より後に始まるもの
      if (carry.status !== 'planned' || carry.start_on <= sprint.end_on) {
        await throwIfClosed(db, workspaceId);
        throw conflict('carry_target');
      }
    }
    const carriesToSprint = carryId !== null && taskIds.length > 0;
    if (carriesToSprint && columnId === undefined) {
      // 列が1つも無いワークスペース（作る操作が必ず列を作るので、ふつうは無い）には持ち越せない
      await throwIfClosed(db, workspaceId);
      throw new ApiError(404, 'not_found');
    }

    const at = now();
    const closedAt = at.toISOString();
    const logId = uuidv7(at);
    const positions: (readonly [string, string])[] = [];
    if (carriesToSprint) {
      const keys = generateNKeysBetween(await tailPosition(db, workspaceId, carryId, columnId!), null, taskIds.length);
      taskIds.forEach((id, index) => positions.push([id, keys[index]!]));
    }
    const goalAchieved = input.is_goal_achieved === null ? null : input.is_goal_achieved ? 1 : 0;

    // この要求が終えた、という条件。履歴の行は直前の UPDATE が行を変えたときだけ入り、id はこの要求だけの値
    const ownLog = (from: From) =>
      from
        .selectFrom('change_logs as own')
        .select('own.id')
        .where('own.id', '=', logId)
        .where('own.workspace_id', '=', workspaceId);

    const results = await db.batch([
      db.statement((q) =>
        q
          .updateTable('sprints')
          .set({
            status: 'closed',
            closed_at: closedAt,
            closed_by: actorUserId,
            is_goal_achieved: goalAchieved,
            updated_at: closedAt,
          })
          .where((eb) =>
            eb.and([
              eb('id', '=', sprintId),
              eb('workspace_id', '=', workspaceId),
              eb('deleted_at', 'is', null),
              eb('status', '=', 'active'),
              eb('goal', 'is', sprint.goal),
              eb.exists(openWorkspace(q, organizationId, workspaceId)),
              // 未完了のタスクの集合が読んだものと同じ（読んだ以外が無く、読んだものが全部ある）
              eb.not(
                eb.exists(
                  q
                    .selectFrom('tasks as u')
                    .select('u.id')
                    .where('u.sprint_id', '=', sprintId)
                    .where('u.workspace_id', '=', workspaceId)
                    .where('u.deleted_at', 'is', null)
                    .where('u.completed_at', 'is', null)
                    .where('u.id', 'not in', jsonList(taskIds)),
                ),
              ),
              eb(
                q
                  .selectFrom('tasks as k')
                  .select((s) => s.fn.countAll<number>().as('n'))
                  .where('k.id', 'in', jsonList(taskIds))
                  .where('k.sprint_id', '=', sprintId)
                  .where('k.workspace_id', '=', workspaceId)
                  .where('k.deleted_at', 'is', null)
                  .where('k.completed_at', 'is', null),
                '=',
                taskIds.length,
              ),
              ...(carryId === null
                ? []
                : [
                    eb.exists(
                      q
                        .selectFrom('sprints as target')
                        .select('target.id')
                        .where('target.id', '=', carryId)
                        .where('target.workspace_id', '=', workspaceId)
                        .where('target.deleted_at', 'is', null)
                        .where('target.status', '=', 'planned')
                        .where('target.start_on', '>', sprint.end_on),
                    ),
                  ]),
              ...(carriesToSprint
                ? [
                    eb.exists(
                      q
                        .selectFrom('board_columns as col')
                        .select('col.id')
                        .where('col.id', '=', columnId!)
                        .where('col.workspace_id', '=', workspaceId)
                        .where('col.deleted_at', 'is', null),
                    ),
                  ]
                : []),
            ]),
          ),
      ),
      // 直前の UPDATE が行を変えたときだけ履歴を書く（docs/data-model.md の「直前の文に結ぶ」）
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
                eb.val(actorUserId).as('actor_user_id'),
                eb.val('sprint').as('entity_type'),
                eb.val(sprintId).as('entity_id'),
                eb.val('update').as('action'),
                eb
                  .val(
                    JSON.stringify({
                      status: ['active', 'closed'],
                      ...(input.is_goal_achieved === null ? {} : { is_goal_achieved: [null, input.is_goal_achieved] }),
                    }),
                  )
                  .as('changes_json'),
                eb.val(closedAt).as('created_at'),
              ])
              .where(previousStatementChanged),
          ),
      ),
      // 持ち越すタスクごとの履歴（{"sprint": [前, 後]}）。スプリントの名前は、書くときの今の名前を引く
      db.statement((q) =>
        q
          .insertInto('change_logs')
          .columns(changeLogColumns)
          .expression(
            q
              .selectFrom('tasks as t')
              .innerJoin('sprints as cur', (join) =>
                join.onRef('cur.id', '=', 't.sprint_id').on('cur.workspace_id', '=', workspaceId),
              )
              .leftJoin('sprints as next', (join) =>
                join.on('next.id', carryId === null ? 'is' : '=', carryId).on('next.workspace_id', '=', workspaceId),
              )
              .select((eb) => [
                uuidv7Sql(at).as('id'),
                eb.val(organizationId).as('organization_id'),
                eb.val(workspaceId).as('workspace_id'),
                eb.val(actorUserId).as('actor_user_id'),
                eb.val('task').as('entity_type'),
                eb.ref('t.id').as('entity_id'),
                eb.val('update').as('action'),
                eb
                  .fn<string>('json_object', [
                    eb.val('sprint'),
                    eb.fn('json_array', [sprintLogRefSql('cur'), sprintLogRefSql('next')]),
                  ])
                  .as('changes_json'),
                eb.val(closedAt).as('created_at'),
              ])
              .where('t.sprint_id', '=', sprintId)
              .where('t.workspace_id', '=', workspaceId)
              .where('t.deleted_at', 'is', null)
              .where('t.completed_at', 'is', null)
              .where((eb) => eb.exists(ownLog(q))),
          ),
      ),
      // 入っている行を閉じる。完了したタスクは completed、未完了のタスクは carried_over
      db.statement((q) =>
        q
          .updateTable('sprint_entries')
          .set((eb) => ({
            ended_at: closedAt,
            outcome: eb
              .case()
              .when(
                eb.exists(
                  q
                    .selectFrom('tasks as c')
                    .select('c.id')
                    .where('c.id', '=', eb.ref('sprint_entries.task_id'))
                    .where('c.workspace_id', '=', workspaceId)
                    .where('c.completed_at', 'is not', null),
                ),
              )
              .then('completed')
              .else('carried_over')
              .end(),
          }))
          .where('workspace_id', '=', workspaceId)
          .where('sprint_id', '=', sprintId)
          .where('ended_at', 'is', null)
          .where((eb) => eb.exists(ownLog(q))),
      ),
      // 持ち越し先がスプリントなら、持ち越すタスクの新しい行を足す（バックログへなら足さない）
      ...(carryId === null
        ? []
        : [
            db.statement((q) =>
              q
                .insertInto('sprint_entries')
                .columns(['id', 'workspace_id', 'sprint_id', 'task_id', 'added_at', 'added_by', 'ended_at', 'outcome'])
                .expression(
                  q
                    .selectFrom('tasks as t')
                    .select((eb) => [
                      uuidv7Sql(at).as('id'),
                      eb.val(workspaceId).as('workspace_id'),
                      eb.val(carryId).as('sprint_id'),
                      eb.ref('t.id').as('task_id'),
                      eb.val(closedAt).as('added_at'),
                      eb.val(actorUserId).as('added_by'),
                      eb.val(null).as('ended_at'),
                      eb.val(null).as('outcome'),
                    ])
                    .where('t.sprint_id', '=', sprintId)
                    .where('t.workspace_id', '=', workspaceId)
                    .where('t.deleted_at', 'is', null)
                    .where('t.completed_at', 'is', null)
                    .where((eb) => eb.exists(ownLog(q))),
                ),
            ),
          ]),
      // 持ち越すタスクを書く。バックログへなら、スプリント、列、列の中の位置を空にする
      db.statement((q) =>
        q
          .updateTable('tasks')
          .set((eb) => ({
            sprint_id: carryId,
            column_id: carriesToSprint ? columnId! : null,
            column_position: carriesToSprint ? jsonPairLookup(positions, eb.ref('tasks.id')) : null,
            updated_at: closedAt,
          }))
          .where('sprint_id', '=', sprintId)
          .where('workspace_id', '=', workspaceId)
          .where('deleted_at', 'is', null)
          .where('completed_at', 'is', null)
          .where((eb) => eb.exists(ownLog(q))),
      ),
    ]);

    if ((results[0]?.changes ?? 0) > 0) {
      return {
        sprint_id: sprintId,
        // 最後の文（持ち越すタスクを書く文）が書いた件数
        carried_count: results.at(-1)?.changes ?? 0,
        carry_to: carry === undefined ? null : refOf(carry),
      };
    }
    // 読んでから書くまでに、閉じた、スプリントが終了か削除された、持ち越し先が変わった、未完了のタスクが変わった。
    // 閉じていれば 409 にし、そうでなければ読み直して理由を分け、どれでもなければやり直す
    await throwIfClosed(db, workspaceId);
  }
  throw conflict('changed');
});
