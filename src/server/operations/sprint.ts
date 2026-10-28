import { generateNKeysBetween } from 'fractional-indexing';
import { now, todayIn } from '../../shared/clock.ts';
import {
  sprintCreate,
  sprintDelete,
  sprintList,
  sprintStart,
  sprintTaskAdd,
  sprintTaskRemove,
  sprintUpdate,
  type SprintConflictReason,
  type SprintSummary,
  type SprintTask,
  type SprintTaskConflictReason,
} from '../../shared/operations/sprint/index.ts';
import { sprintDefaults, sprintEndOn, sprintLengthOf } from '../../shared/sprint.ts';
import {
  jsonList,
  jsonPairLookup,
  previousStatementChanged,
  sprintLeftLogSql,
  sprintLogRefSql,
  uuidv7Sql,
  type OrganizationDb,
  type OrganizationTables,
  type QueryCreator,
} from '../db/index.ts';
import { ApiError } from '../errors.ts';
import { uuidv7 } from '../uuid.ts';
import { implement } from './implement.ts';
import { actorUserIdOf, changeLogColumns, openWorkspace, throwIfClosed } from './write-guards.ts';

// 同時の更新に負けたときにやり直す回数の上限。超えたら 409 の conflict（story-update と同じ）
const MAX_UPDATE_ATTEMPTS = 3;

export type SprintRow = {
  id: string;
  name: string | null;
  goal: string | null;
  start_on: string;
  end_on: string;
  status: string;
};

function conflict(reason: SprintConflictReason): ApiError {
  return new ApiError(409, 'conflict', { reason });
}

// 画面に返す形。一覧は planned と active だけを返し、変える操作は planned だけを書くので、status はこの2つになる
export function summaryOf(row: SprintRow): SprintSummary {
  return {
    id: row.id,
    name: row.name,
    goal: row.goal,
    start_on: row.start_on,
    end_on: row.end_on,
    length: sprintLengthOf(row.start_on, row.end_on),
    status: row.status === 'active' ? 'active' : 'planned',
  };
}

// 同じワークスペースの、削除していない、期間が [startOn, endOn] と重なるスプリント（終了したものも含む）。
// 変える操作では、変える行そのもの（exceptId）を外す。日付は YYYY-MM-DD なので、文字列の比較が日付の前後と一致する
function overlapping(
  from: Pick<QueryCreator<OrganizationTables>, 'selectFrom'>,
  workspaceId: string,
  startOn: string,
  endOn: string,
  exceptId: string | null,
) {
  const query = from
    .selectFrom('sprints as other')
    .select('other.id')
    .where('other.workspace_id', '=', workspaceId)
    .where('other.deleted_at', 'is', null)
    .where('other.start_on', '<=', endOn)
    .where('other.end_on', '>=', startOn);
  return exceptId === null ? query : query.where('other.id', '!=', exceptId);
}

async function overlapExists(
  db: OrganizationDb,
  workspaceId: string,
  startOn: string,
  endOn: string,
  exceptId: string | null,
): Promise<boolean> {
  const row = await db.first(db.statement((q) => overlapping(q, workspaceId, startOn, endOn, exceptId).limit(1)));
  return row !== undefined;
}

// 削除していないスプリント1件。ワークスペースで必ず絞る
async function readSprint(db: OrganizationDb, workspaceId: string, sprintId: string): Promise<SprintRow | undefined> {
  return db.first(
    db.statement((q) =>
      q
        .selectFrom('sprints')
        .select(['sprints.id', 'sprints.name', 'sprints.goal', 'sprints.start_on', 'sprints.end_on', 'sprints.status'])
        .where('sprints.id', '=', sprintId)
        .where('sprints.workspace_id', '=', workspaceId)
        .where('sprints.deleted_at', 'is', null),
    ),
  );
}

// 一覧、前のスプリント、ワークスペースのタイムゾーンと週の始まりを1回の batch() で読む。
// 前のスプリントは、削除していないもの（終了したものも含む）のうち最終日がいちばん後のもの
export const sprintListOperation = implement(sprintList, async ({ db, workspace }) => {
  const organizationId = db.organizationId;
  const workspaceId = workspace.workspaceId;
  const [workspaceResult, sprintsResult, previousResult, tasksResult] = await db.batch([
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
        .where('sprints.deleted_at', 'is', null)
        .where('sprints.status', 'in', ['planned', 'active'])
        .orderBy('sprints.start_on')
        .orderBy('sprints.id'),
    ),
    db.statement((q) =>
      q
        .selectFrom('sprints')
        .select(['sprints.start_on', 'sprints.end_on'])
        .where('sprints.workspace_id', '=', workspaceId)
        .where('sprints.deleted_at', 'is', null)
        .orderBy('sprints.end_on', 'desc')
        .limit(1),
    ),
    // 一覧のスプリントに入っている、削除していないタスク。スプリントから引いてタスクを結ぶ（tasks_sprint_column の索引で引く）。
    // 並びは列の順（ORDER BY is_done, position, id）、その中の column_position、id の順（同じ列の同じ位置は id の順）
    db.statement((q) =>
      q
        .selectFrom('sprints')
        .crossJoin('tasks')
        .leftJoin('board_columns', (join) =>
          join.onRef('board_columns.id', '=', 'tasks.column_id').on('board_columns.workspace_id', '=', workspaceId),
        )
        .leftJoin('users', (join) =>
          join.onRef('users.id', '=', 'tasks.assignee_user_id').on('users.organization_id', '=', organizationId),
        )
        .select([
          'tasks.sprint_id',
          'tasks.id',
          'tasks.title',
          'tasks.points',
          'tasks.assignee_user_id',
          'users.name as assignee_name',
          'tasks.completed_at',
        ])
        .whereRef('tasks.sprint_id', '=', 'sprints.id')
        .where('sprints.workspace_id', '=', workspaceId)
        .where('sprints.deleted_at', 'is', null)
        .where('sprints.status', 'in', ['planned', 'active'])
        .where('tasks.workspace_id', '=', workspaceId)
        .where('tasks.deleted_at', 'is', null)
        .orderBy('board_columns.is_done')
        .orderBy('board_columns.position')
        .orderBy('board_columns.id')
        .orderBy('tasks.column_position')
        .orderBy('tasks.id'),
    ),
  ] as const);
  const settings = workspaceResult.rows[0];
  if (settings === undefined) throw new ApiError(404, 'not_found');
  const today = todayIn(settings.timezone);
  const tasksBySprint = new Map<string, SprintTask[]>();
  for (const row of tasksResult.rows) {
    const list = tasksBySprint.get(row.sprint_id!) ?? [];
    list.push({
      id: row.id,
      title: row.title,
      points: row.points,
      assignee: row.assignee_user_id === null ? null : { id: row.assignee_user_id, name: row.assignee_name ?? '' },
      completed_at: row.completed_at,
    });
    tasksBySprint.set(row.sprint_id!, list);
  }
  return {
    sprints: sprintsResult.rows.map((row) => ({ ...summaryOf(row), tasks: tasksBySprint.get(row.id) ?? [] })),
    defaults: sprintDefaults(previousResult.rows[0] ?? null, today, settings.week_start),
  };
});

// 書く文は INSERT ... SELECT ... WHERE（閉じていないワークスペース、重なるスプリントが無い）。D1 の batch() は順に流れるので、
// 2つの要求が同時に同じ期間を作っても、後の要求の文は先に入った行を見て何も入れない
export const sprintCreateOperation = implement(sprintCreate, async ({ db, actor, workspace, input }) => {
  const actorUserId = actorUserIdOf(actor);
  const organizationId = db.organizationId;
  const workspaceId = workspace.workspaceId;
  const endOn = sprintEndOn(input.start_on, input.length);
  if (endOn === null) throw new ApiError(400, 'invalid_input');

  const at = now();
  const createdAt = at.toISOString();
  const sprintId = uuidv7(at);
  const created: Record<string, [null, string]> = {
    ...(input.name === null ? {} : { name: [null, input.name] }),
    start_on: [null, input.start_on],
    end_on: [null, endOn],
  };

  const results = await db.batch([
    db.statement((q) =>
      q
        .insertInto('sprints')
        .columns(['id', 'workspace_id', 'name', 'start_on', 'end_on', 'status', 'created_at', 'updated_at'])
        .expression(
          q
            .selectNoFrom((eb) => [
              eb.val(sprintId).as('id'),
              eb.val(workspaceId).as('workspace_id'),
              eb.val(input.name).as('name'),
              eb.val(input.start_on).as('start_on'),
              eb.val(endOn).as('end_on'),
              eb.val('planned').as('status'),
              eb.val(createdAt).as('created_at'),
              eb.val(createdAt).as('updated_at'),
            ])
            .where((eb) =>
              eb.and([
                eb.exists(openWorkspace(eb, organizationId, workspaceId)),
                eb.not(eb.exists(overlapping(eb, workspaceId, input.start_on, endOn, null))),
              ]),
            ),
        ),
    ),
    // 直前の INSERT が行を入れたときだけ履歴を書く（docs/data-model.md の「直前の文に結ぶ」）
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
              eb.val('sprint').as('entity_type'),
              eb.val(sprintId).as('entity_id'),
              eb.val('create').as('action'),
              eb.val(JSON.stringify(created)).as('changes_json'),
              eb.val(createdAt).as('created_at'),
            ])
            .where(previousStatementChanged),
        ),
    ),
  ]);

  if ((results[0]?.changes ?? 0) === 0) {
    // 読んでから書くまでに閉じたら 409 の workspace_closed。重なれば overlap。どちらでもなければ（ワークスペースが消えた）404
    await throwIfClosed(db, workspaceId);
    if (await overlapExists(db, workspaceId, input.start_on, endOn, null)) throw conflict('overlap');
    throw new ApiError(404, 'not_found');
  }
  return {
    sprint: summaryOf({
      id: sprintId,
      name: input.name,
      goal: null,
      start_on: input.start_on,
      end_on: endOn,
      status: 'planned',
    }),
  };
});

type UpdatedFields = { name?: string | null; start_on?: string; end_on?: string };

// 読んだ値と、送られた値から決めた次の値の差。長さだけを送ると、今の開始日から最終日を決め直す
function diffOf(current: SprintRow, input: { name?: string | null; start_on?: string; length?: number }) {
  const startOn = input.start_on ?? current.start_on;
  const endOn = sprintEndOn(startOn, input.length ?? sprintLengthOf(current.start_on, current.end_on));
  if (endOn === null) throw new ApiError(400, 'invalid_input');
  const values: UpdatedFields = {};
  const changes: Record<string, [string | null, string | null]> = {};
  if (input.name !== undefined && input.name !== current.name) {
    values.name = input.name;
    changes.name = [current.name, input.name];
  }
  if (startOn !== current.start_on) {
    values.start_on = startOn;
    changes.start_on = [current.start_on, startOn];
  }
  if (endOn !== current.end_on) {
    values.end_on = endOn;
    changes.end_on = [current.end_on, endOn];
  }
  return {
    values,
    changes,
    startOn,
    endOn,
    rangeChanged: values.start_on !== undefined || values.end_on !== undefined,
    isEmpty: Object.keys(changes).length === 0,
  };
}

// 書き方は epic-update と同じ。読んだ値からの差を、読んだ値のままで、始まっておらず、期間を変えるなら重なるスプリントが無いときだけ書き、
// 通らなかったら理由を読み直して分ける（閉じた、無い、始まった、重なる）。どれでもなければ、読み直して差を作り直す
export const sprintUpdateOperation = implement(sprintUpdate, async ({ db, actor, workspace, input }) => {
  const actorUserId = actorUserIdOf(actor);
  const organizationId = db.organizationId;
  const workspaceId = workspace.workspaceId;
  const sprintId = input.sprint_id;

  for (let attempt = 0; attempt < MAX_UPDATE_ATTEMPTS; attempt++) {
    const current = await readSprint(db, workspaceId, sprintId);
    if (current === undefined) {
      await throwIfClosed(db, workspaceId);
      throw new ApiError(404, 'not_found');
    }
    if (current.status !== 'planned') {
      await throwIfClosed(db, workspaceId);
      throw conflict('started');
    }
    const { values, changes, startOn, endOn, rangeChanged, isEmpty } = diffOf(current, input);
    if (isEmpty) {
      // 書くものが無くても、閉じたワークスペースは断る
      await throwIfClosed(db, workspaceId);
      return { sprint: summaryOf(current) };
    }

    const at = now();
    const updatedAt = at.toISOString();
    const results = await db.batch([
      db.statement((q) =>
        q
          .updateTable('sprints')
          .set({ ...values, updated_at: updatedAt })
          .where((eb) =>
            eb.and([
              eb('id', '=', sprintId),
              eb('workspace_id', '=', workspaceId),
              eb('deleted_at', 'is', null),
              eb('status', '=', 'planned'),
              eb.exists(openWorkspace(q, organizationId, workspaceId)),
              ...(rangeChanged ? [eb.not(eb.exists(overlapping(q, workspaceId, startOn, endOn, sprintId)))] : []),
              // 書く列が、読んだときの値のまま。期間を変えるときは、片側だけを書くときも両端を守る
              // （最終日と重なりの検査は読んだ開始日と最終日から決めたので、もう片側を別の要求が動かしていたら書かない）
              ...(values.name === undefined ? [] : [eb('name', 'is', current.name)]),
              ...(rangeChanged ? [eb('start_on', 'is', current.start_on), eb('end_on', 'is', current.end_on)] : []),
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
                eb.val(uuidv7(at)).as('id'),
                eb.val(organizationId).as('organization_id'),
                eb.val(workspaceId).as('workspace_id'),
                eb.val(actorUserId).as('actor_user_id'),
                eb.val('sprint').as('entity_type'),
                eb.val(sprintId).as('entity_id'),
                eb.val('update').as('action'),
                eb.val(JSON.stringify(changes)).as('changes_json'),
                eb.val(updatedAt).as('created_at'),
              ])
              .where(previousStatementChanged),
          ),
      ),
    ]);

    if ((results[0]?.changes ?? 0) > 0) {
      const updated = await readSprint(db, workspaceId, sprintId);
      if (updated === undefined) throw new ApiError(404, 'not_found');
      return { sprint: summaryOf(updated) };
    }
    await throwIfClosed(db, workspaceId);
    const reread = await readSprint(db, workspaceId, sprintId);
    if (reread === undefined) throw new ApiError(404, 'not_found');
    if (reread.status !== 'planned') throw conflict('started');
    if (rangeChanged && (await overlapExists(db, workspaceId, startOn, endOn, sprintId))) throw conflict('overlap');
  }
  throw new ApiError(409, 'conflict');
});

// 進行中のスプリント（削除していない）。1つのワークスペースに高々1つ（一意の索引 sprints_active）。
// 始める文の条件（無いこと）と、条件で落ちた理由の判定、スプリントの画面の読み取りと列の移動の条件に使う
export function activeSprint(from: From, workspaceId: string) {
  return from
    .selectFrom('sprints as act')
    .select('act.id')
    .where('act.workspace_id', '=', workspaceId)
    .where('act.status', '=', 'active')
    .where('act.deleted_at', 'is', null);
}

// 始める。書く文は、読んだスプリントが始まっておらず（planned）、最終日がワークスペースの今日以降で、閉じていないワークスペースで、
// 進行中のスプリントが無いときだけ書く。開始日は見ない（開始日より前に始めてよい）。
// 今日はワークスペースのタイムゾーンで数え、書く文の条件には読んだ日付の値を渡す（判定と書き込みで今日がずれない）。
// D1 の batch() は順に流れるので、2つの要求が同時に始めても、後の要求の文は先に始まった行を見て何も書かない（一意の索引 sprints_active も守る）。
// 通らなかったら理由を読み直して分ける（閉じた、無い、始まった、終わっている、進行中が既にある）
export const sprintStartOperation = implement(sprintStart, async ({ db, actor, workspace, input }) => {
  const actorUserId = actorUserIdOf(actor);
  const organizationId = db.organizationId;
  const workspaceId = workspace.workspaceId;
  const sprintId = input.sprint_id;
  const goal = input.goal;

  const at = now();
  const settings = await db.first(
    db.statement((q) =>
      q
        .selectFrom('workspaces')
        .select('workspaces.timezone')
        .where('workspaces.id', '=', workspaceId)
        .where('workspaces.organization_id', '=', organizationId),
    ),
  );
  if (settings === undefined) throw new ApiError(404, 'not_found');
  const today = todayIn(settings.timezone, at);

  const current = await readSprint(db, workspaceId, sprintId);
  if (current === undefined) {
    await throwIfClosed(db, workspaceId);
    throw new ApiError(404, 'not_found');
  }
  if (current.status !== 'planned') {
    await throwIfClosed(db, workspaceId);
    throw conflict('started');
  }
  if (current.end_on < today) {
    await throwIfClosed(db, workspaceId);
    throw conflict('ended');
  }

  const startedAt = at.toISOString();
  const results = await db.batch([
    db.statement((q) =>
      q
        .updateTable('sprints')
        .set({ status: 'active', goal, started_at: startedAt, started_by: actorUserId, updated_at: startedAt })
        .where((eb) =>
          eb.and([
            eb('id', '=', sprintId),
            eb('workspace_id', '=', workspaceId),
            eb('deleted_at', 'is', null),
            eb('status', '=', 'planned'),
            eb('end_on', '>=', today),
            eb.exists(openWorkspace(q, organizationId, workspaceId)),
            eb.not(eb.exists(activeSprint(q, workspaceId))),
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
              eb.val(uuidv7(at)).as('id'),
              eb.val(organizationId).as('organization_id'),
              eb.val(workspaceId).as('workspace_id'),
              eb.val(actorUserId).as('actor_user_id'),
              eb.val('sprint').as('entity_type'),
              eb.val(sprintId).as('entity_id'),
              eb.val('update').as('action'),
              eb
                .val(
                  JSON.stringify({
                    status: ['planned', 'active'],
                    ...(goal === null ? {} : { goal: [null, goal] }),
                  }),
                )
                .as('changes_json'),
              eb.val(startedAt).as('created_at'),
            ])
            .where(previousStatementChanged),
        ),
    ),
  ]);

  if ((results[0]?.changes ?? 0) === 0) {
    await throwIfClosed(db, workspaceId);
    const reread = await readSprint(db, workspaceId, sprintId);
    if (reread === undefined) throw new ApiError(404, 'not_found');
    if (reread.status !== 'planned') throw conflict('started');
    if (reread.end_on < today) throw conflict('ended');
    if ((await db.first(db.statement((q) => activeSprint(q, workspaceId).limit(1)))) !== undefined) {
      throw conflict('active_exists');
    }
    throw new ApiError(409, 'conflict');
  }
  return { sprint: summaryOf({ ...current, goal, status: 'active' }) };
});

// 論理削除。書く文は、削除していない、始まっていない、閉じていないワークスペースのスプリントだけを書く
export const sprintDeleteOperation = implement(sprintDelete, async ({ db, actor, workspace, input }) => {
  const actorUserId = actorUserIdOf(actor);
  const organizationId = db.organizationId;
  const workspaceId = workspace.workspaceId;
  const sprintId = input.sprint_id;

  const current = await readSprint(db, workspaceId, sprintId);
  if (current === undefined) {
    await throwIfClosed(db, workspaceId);
    throw new ApiError(404, 'not_found');
  }
  if (current.status !== 'planned') {
    await throwIfClosed(db, workspaceId);
    throw conflict('started');
  }

  const at = now();
  const deletedAt = at.toISOString();
  const results = await db.batch([
    db.statement((q) =>
      q
        .updateTable('sprints')
        .set({ deleted_at: deletedAt, updated_at: deletedAt })
        .where((eb) =>
          eb.and([
            eb('id', '=', sprintId),
            eb('workspace_id', '=', workspaceId),
            eb('deleted_at', 'is', null),
            eb('status', '=', 'planned'),
            eb.exists(openWorkspace(q, organizationId, workspaceId)),
          ]),
        ),
    ),
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
              eb.val('sprint').as('entity_type'),
              eb.val(sprintId).as('entity_id'),
              eb.val('delete').as('action'),
              eb.val(JSON.stringify({ deleted_at: [null, deletedAt] })).as('changes_json'),
              eb.val(deletedAt).as('created_at'),
            ])
            .where(previousStatementChanged),
        ),
    ),
    // 入っていたタスクをバックログへ戻す3文。どれも、このスプリントをこの要求が削除した（deleted_at が自分の時刻）ことを条件にし、
    // 子の数によらない決まった数の文で書く。履歴を先に置く（戻した後は、入っていた条件に当たらなくなるため）
    // 1. タスクごとの変更の履歴（{"sprint": [前, null]}）
    db.statement((q) =>
      q
        .insertInto('change_logs')
        .columns(changeLogColumns)
        .expression(
          q
            .selectFrom('tasks as t')
            // スプリントの名前は、書くときの今の名前を引く（読んでから書くまでに名前が変わっても、履歴は書いた時点の名前）
            .innerJoin('sprints as cur', (join) =>
              join.onRef('cur.id', '=', 't.sprint_id').on('cur.workspace_id', '=', workspaceId),
            )
            .select((eb) => [
              uuidv7Sql(at).as('id'),
              eb.val(organizationId).as('organization_id'),
              eb.val(workspaceId).as('workspace_id'),
              eb.val(actorUserId).as('actor_user_id'),
              eb.val('task').as('entity_type'),
              eb.ref('t.id').as('entity_id'),
              eb.val('update').as('action'),
              sprintLeftLogSql('cur').as('changes_json'),
              eb.val(deletedAt).as('created_at'),
            ])
            .where('t.sprint_id', '=', sprintId)
            .where('t.workspace_id', '=', workspaceId)
            .where('t.deleted_at', 'is', null)
            .where((eb) => eb.exists(deletedNow(q, workspaceId, sprintId, deletedAt))),
        ),
    ),
    // 2. 入っていた行を removed で閉じる
    db.statement((q) =>
      q
        .updateTable('sprint_entries')
        .set({ ended_at: deletedAt, outcome: 'removed' })
        .where('workspace_id', '=', workspaceId)
        .where('sprint_id', '=', sprintId)
        .where('ended_at', 'is', null)
        .where((eb) => eb.exists(deletedNow(q, workspaceId, sprintId, deletedAt))),
    ),
    // 3. タスクのスプリント、列、列の中の位置を空にする
    db.statement((q) =>
      q
        .updateTable('tasks')
        .set({ sprint_id: null, column_id: null, column_position: null, updated_at: deletedAt })
        .where('sprint_id', '=', sprintId)
        .where('workspace_id', '=', workspaceId)
        .where('deleted_at', 'is', null)
        .where((eb) => eb.exists(deletedNow(q, workspaceId, sprintId, deletedAt))),
    ),
  ]);

  if ((results[0]?.changes ?? 0) === 0) {
    await throwIfClosed(db, workspaceId);
    const reread = await readSprint(db, workspaceId, sprintId);
    if (reread === undefined) throw new ApiError(404, 'not_found');
    if (reread.status !== 'planned') throw conflict('started');
    throw new ApiError(409, 'conflict');
  }
  return { sprint_id: sprintId };
});

// このスプリントを、この要求が削除した（deleted_at が自分の時刻）。削除の後ろの文の条件
function deletedNow(from: From, workspaceId: string, sprintId: string, deletedAt: string) {
  return from
    .selectFrom('sprints as gone')
    .select('gone.id')
    .where('gone.id', '=', sprintId)
    .where('gone.workspace_id', '=', workspaceId)
    .where('gone.deleted_at', '=', deletedAt);
}

type From = Pick<QueryCreator<OrganizationTables>, 'selectFrom'>;

function taskConflict(reason: SprintTaskConflictReason): ApiError {
  return new ApiError(409, 'conflict', { reason });
}

// タスクを出し入れできるスプリント。削除していない、始まっていないか進行中のもの（終了したスプリントの中身は変えない）
function openSprint(from: From, workspaceId: string, sprintId: string) {
  return from
    .selectFrom('sprints as target')
    .select('target.id')
    .where('target.id', '=', sprintId)
    .where('target.workspace_id', '=', workspaceId)
    .where('target.deleted_at', 'is', null)
    .where('target.status', 'in', ['planned', 'active']);
}

// 入れる先の列。削除していない列のうち、先頭（ORDER BY is_done, position）のもの
function firstColumn(from: From, workspaceId: string) {
  return from
    .selectFrom('board_columns as first')
    .select('first.id')
    .where('first.workspace_id', '=', workspaceId)
    .where('first.deleted_at', 'is', null)
    .orderBy('first.is_done')
    .orderBy('first.position')
    .orderBy('first.id')
    .limit(1);
}

// 読み直して再試行する回数の上限（読んだ先頭の列が書く前に消えたなど）。超えたら 409 の conflict
const MAX_ADD_ATTEMPTS = 3;

type AddRow = {
  id: string;
  tray: string;
  completed_at: string | null;
  deleted_at: string | null;
  sprint_id: string | null;
  // 今入っているスプリントの状態と削除した日時（入っていなければ空）
  sprint_status: string | null;
  sprint_deleted_at: string | null;
};

// 今入っているスプリントが終了していて（削除していない）、中身を変えられない
function inClosedSprint(row: AddRow): boolean {
  return row.sprint_id !== null && row.sprint_status === 'closed' && row.sprint_deleted_at === null;
}

type AddCounts = { completed: number; unavailable: number; already: number };

// 送られたタスクを、入れられるもの（送られた順）と、飛ばす理由ごとの件数に分ける。
// 無い、削除した、別のワークスペースや別の組織、バックログにないもの、終了したスプリントに入っているもの（移さない）は、
// あるかどうかを漏らさないよう同じ unavailable に数える
function classifyForAdd(taskIds: readonly string[], rows: readonly AddRow[], sprintId: string) {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const addable: string[] = [];
  const skipped: AddCounts = { completed: 0, unavailable: 0, already: 0 };
  for (const id of taskIds) {
    const row = byId.get(id);
    if (row === undefined || row.deleted_at !== null || row.tray !== 'backlog') skipped.unavailable++;
    else if (row.completed_at !== null) skipped.completed++;
    else if (row.sprint_id === sprintId) skipped.already++;
    else if (inClosedSprint(row)) skipped.unavailable++;
    else addable.push(id);
  }
  return { addable, skipped };
}

// 送られたタスクの今の状態と、今入っているスプリントの状態（ワークスペースで絞る。別のワークスペースや別の組織の ID は行が無い）
async function readAddRows(db: OrganizationDb, workspaceId: string, taskIds: readonly string[]): Promise<AddRow[]> {
  return db.rows(addRowsStatement(db, workspaceId, taskIds));
}

function addRowsStatement(db: OrganizationDb, workspaceId: string, taskIds: readonly string[]) {
  return db.statement((q) =>
    q
      .selectFrom('tasks')
      .leftJoin('sprints as cur', (join) =>
        join.onRef('cur.id', '=', 'tasks.sprint_id').on('cur.workspace_id', '=', workspaceId),
      )
      .select([
        'tasks.id',
        'tasks.tray',
        'tasks.completed_at',
        'tasks.deleted_at',
        'tasks.sprint_id',
        'cur.status as sprint_status',
        'cur.deleted_at as sprint_deleted_at',
      ])
      .where('tasks.workspace_id', '=', workspaceId)
      .where('tasks.id', 'in', jsonList(taskIds)),
  );
}

// 1件も入らなかったときのエラー。1件のときと同じ（入れられないタスクがあれば 404、完了したタスクだけなら 409 の completed）
function nothingAdded(skipped: AddCounts): ApiError {
  return skipped.unavailable > 0 ? new ApiError(404, 'not_found') : taskConflict('completed');
}

// スプリントにタスクを入れる。書く文は送られたタスクの数によらない4文で、1回の batch() で送る。
// どの文も同じ前提（閉じていないワークスペース、入れる先が削除していない planned か active、読んだ先頭の列が今もある）と、
// タスクごとの条件（そのワークスペースの、バックログの、未完了の、削除していない、このスプリントに入っていないタスク）を持つ。
// 1. 変更の履歴（{"sprint": [前, 後]}。前は今入っているスプリントか null）、2. 別のスプリントに入っている行を removed で閉じる、
// 3. 入った行を足す、4. タスクのスプリント、先頭の列、列の中の末尾の位置を書く。1〜3 はタスクを書き換えないので、4 まで同じタスクに当たる
export const sprintTaskAddOperation = implement(sprintTaskAdd, async ({ db, actor, workspace, input }) => {
  const actorUserId = actorUserIdOf(actor);
  const organizationId = db.organizationId;
  const workspaceId = workspace.workspaceId;
  const sprintId = input.sprint_id;
  const taskIds = [...new Set(input.task_ids)];

  for (let attempt = 0; attempt < MAX_ADD_ATTEMPTS; attempt++) {
    const outcome = await addOnce(db, { organizationId, workspaceId, actorUserId, sprintId, taskIds });
    if (outcome !== 'retry') return outcome;
  }
  throw new ApiError(409, 'conflict');
});

type AddContext = {
  organizationId: string;
  workspaceId: string;
  actorUserId: string;
  sprintId: string;
  taskIds: readonly string[];
};

// 1回分の読みと書き。読んでから書くまでに、スプリントもタスクも入れられるまま0件になった（読んだ先頭の列が消えたなど）ときは 'retry'
async function addOnce(
  db: OrganizationDb,
  { organizationId, workspaceId, actorUserId, sprintId, taskIds }: AddContext,
): Promise<{ added: number; skipped: AddCounts } | 'retry'> {
  const [sprintResult, rowsResult, columnResult, lastResult] = await db.batch([
    db.statement((q) =>
      q
        .selectFrom('sprints')
        .select(['sprints.id', 'sprints.name', 'sprints.start_on', 'sprints.end_on', 'sprints.status'])
        .where('sprints.id', '=', sprintId)
        .where('sprints.workspace_id', '=', workspaceId)
        .where('sprints.deleted_at', 'is', null),
    ),
    addRowsStatement(db, workspaceId, taskIds),
    db.statement((q) => firstColumn(q, workspaceId)),
    // 先頭の列の、このスプリントでの末尾
    db.statement((q) =>
      q
        .selectFrom('tasks')
        .select('tasks.column_position')
        .where('tasks.workspace_id', '=', workspaceId)
        .where('tasks.sprint_id', '=', sprintId)
        .where('tasks.column_id', '=', firstColumn(q, workspaceId))
        .where('tasks.deleted_at', 'is', null)
        .orderBy('tasks.column_position', 'desc')
        .limit(1),
    ),
  ] as const);

  const sprint = sprintResult.rows[0];
  if (sprint === undefined) {
    await throwIfClosed(db, workspaceId);
    throw new ApiError(404, 'not_found');
  }
  if (sprint.status === 'closed') {
    await throwIfClosed(db, workspaceId);
    throw taskConflict('closed');
  }
  const { addable, skipped } = classifyForAdd(taskIds, rowsResult.rows as AddRow[], sprintId);
  const columnId = columnResult.rows[0]?.id;
  if (addable.length === 0 || columnId === undefined) {
    // 書くものが無くても、閉じたワークスペースは断る
    await throwIfClosed(db, workspaceId);
    // 列が1つも無いワークスペース（作る操作が必ず列を作るので、ふつうは無い）には入れられない
    if (columnId === undefined) throw new ApiError(404, 'not_found');
    if (skipped.already > 0) return { added: 0, skipped };
    throw nothingAdded(skipped);
  }

  const at = now();
  const addedAt = at.toISOString();
  const keys = generateNKeysBetween(lastResult.rows[0]?.column_position ?? null, null, addable.length);
  const positions = addable.map((id, index) => [id, keys[index]!] as const);

  // 入れられるタスクの ID（そのワークスペースの、バックログの、未完了の、削除していない、このスプリントに入っていない、
  // 終了した（削除していない）スプリントに入っていないもの）
  const eligibleIds = (from: From) =>
    from
      .selectFrom('tasks as e')
      .select('e.id')
      .where('e.id', 'in', jsonList(addable))
      .where('e.workspace_id', '=', workspaceId)
      .where('e.tray', '=', 'backlog')
      .where('e.completed_at', 'is', null)
      .where('e.deleted_at', 'is', null)
      .where((eb) => eb.or([eb('e.sprint_id', 'is', null), eb('e.sprint_id', '!=', sprintId)]))
      .where((eb) =>
        eb.not(
          eb.exists(
            eb
              .selectFrom('sprints as closed')
              .select('closed.id')
              .whereRef('closed.id', '=', 'e.sprint_id')
              .where('closed.workspace_id', '=', workspaceId)
              .where('closed.status', '=', 'closed')
              .where('closed.deleted_at', 'is', null),
          ),
        ),
      );
  // どの文も持つ前提。閉じていないワークスペースで、入れる先が planned か active のまま、読んだ先頭の列が今もある。1行を返す副問い合わせ
  const guardRow = (from: From) =>
    from
      .selectFrom('workspaces as gw')
      .select('gw.id')
      .where('gw.id', '=', workspaceId)
      .where('gw.organization_id', '=', organizationId)
      .where('gw.closed_at', 'is', null)
      .where((eb) => eb.exists(openSprint(from, workspaceId, sprintId)))
      .where((eb) =>
        eb.exists(
          from
            .selectFrom('board_columns as col')
            .select('col.id')
            .where('col.id', '=', columnId)
            .where('col.workspace_id', '=', workspaceId)
            .where('col.deleted_at', 'is', null),
        ),
      );

  const results = await db.batch([
    db.statement((q) =>
      q
        .insertInto('change_logs')
        .columns(changeLogColumns)
        .expression(
          q
            .selectFrom('tasks as t')
            .leftJoin('sprints as prev', (join) =>
              join.onRef('prev.id', '=', 't.sprint_id').on('prev.workspace_id', '=', workspaceId),
            )
            // 前と後のスプリントの名前は、書くときの今の名前を引く
            .innerJoin('sprints as next', (join) =>
              join.on('next.id', '=', sprintId).on('next.workspace_id', '=', workspaceId),
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
                  eb.fn('json_array', [sprintLogRefSql('prev'), sprintLogRefSql('next')]),
                ])
                .as('changes_json'),
              eb.val(addedAt).as('created_at'),
            ])
            .where('t.id', 'in', eligibleIds(q))
            .where('t.workspace_id', '=', workspaceId)
            .where((eb) => eb.exists(guardRow(q))),
        ),
    ),
    // 別のスプリントに入っている行（と、念のため入っている行のすべて）を removed で閉じる。終了したスプリントの行は閉じない
    db.statement((q) =>
      q
        .updateTable('sprint_entries')
        .set({ ended_at: addedAt, outcome: 'removed' })
        .where('workspace_id', '=', workspaceId)
        .where('ended_at', 'is', null)
        .where('task_id', 'in', eligibleIds(q))
        .where((eb) =>
          eb.not(
            eb.exists(
              eb
                .selectFrom('sprints as closed')
                .select('closed.id')
                .whereRef('closed.id', '=', 'sprint_entries.sprint_id')
                .where('closed.workspace_id', '=', workspaceId)
                .where('closed.status', '=', 'closed')
                .where('closed.deleted_at', 'is', null),
            ),
          ),
        )
        .where((eb) => eb.exists(guardRow(q))),
    ),
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
              eb.val(sprintId).as('sprint_id'),
              eb.ref('t.id').as('task_id'),
              eb.val(addedAt).as('added_at'),
              eb.val(actorUserId).as('added_by'),
              eb.val(null).as('ended_at'),
              eb.val(null).as('outcome'),
            ])
            .where('t.id', 'in', eligibleIds(q))
            .where('t.workspace_id', '=', workspaceId)
            .where((eb) => eb.exists(guardRow(q))),
        ),
    ),
    db.statement((q) =>
      q
        .updateTable('tasks')
        .set((eb) => ({
          sprint_id: sprintId,
          column_id: columnId,
          column_position: jsonPairLookup(positions, eb.ref('tasks.id')),
          updated_at: addedAt,
        }))
        .where('id', 'in', eligibleIds(q))
        .where('workspace_id', '=', workspaceId)
        .where((eb) => eb.exists(guardRow(q))),
    ),
  ]);

  const added = results[3]?.changes ?? 0;
  if (added === addable.length) return { added, skipped };

  // 読んでから書くまでに、別の要求が入れられるタスクを変えた（完了にした、削除した、同じスプリントへ入れた）か、
  // スプリントか列かワークスペースが変わった。入れられなかったタスクを読み直して、理由ごとに数え直す
  if (added === 0) {
    await throwIfClosed(db, workspaceId);
    const reread = await readSprint(db, workspaceId, sprintId);
    if (reread === undefined) throw new ApiError(404, 'not_found');
    if (reread.status === 'closed') throw taskConflict('closed');
  }
  const recount = classifyForAdd(addable, await readAddRows(db, workspaceId, addable), sprintId);
  // スプリントもタスクも入れられるまま1件も書けなかった（読んだ先頭の列が消えたなど）。読み直してやり直す
  if (added === 0 && recount.addable.length > 0) return 'retry';
  // 今このスプリントに入っているもの（recount.skipped.already）のうち、この要求が入れた分（added）を除いた残りは、別の要求が先に入れた
  const result = {
    added,
    skipped: {
      completed: skipped.completed + recount.skipped.completed,
      unavailable: skipped.unavailable + recount.skipped.unavailable + recount.addable.length,
      already: skipped.already + Math.max(recount.skipped.already - added, 0),
    },
  };
  if (added === 0 && result.skipped.already === 0) throw nothingAdded(result.skipped);
  return result;
}

// スプリントからタスクを外す。1. タスクのスプリント、列、列の中の位置を空にする（読んだスプリントのままで、未完了、
// スプリントが削除していない planned か active、閉じていないワークスペース）、2. 直前の UPDATE に結んだ変更の履歴、
// 3. 入っていた行を removed で閉じる（1 でこの要求がタスクを書いた（updated_at が自分の時刻で、スプリントが空）ことが条件）
export const sprintTaskRemoveOperation = implement(sprintTaskRemove, async ({ db, actor, workspace, input }) => {
  const actorUserId = actorUserIdOf(actor);
  const organizationId = db.organizationId;
  const workspaceId = workspace.workspaceId;
  const sprintId = input.sprint_id;
  const taskId = input.task_id;

  // 外すタスク（そのスプリントに入っている、削除していないもの）を読み、外せない理由を分ける
  const check = async () => {
    const sprintRow = await readSprint(db, workspaceId, sprintId);
    const task = await db.first(
      db.statement((q) =>
        q
          .selectFrom('tasks')
          .select(['tasks.id', 'tasks.completed_at'])
          .where('tasks.id', '=', taskId)
          .where('tasks.workspace_id', '=', workspaceId)
          .where('tasks.sprint_id', '=', sprintId)
          .where('tasks.deleted_at', 'is', null),
      ),
    );
    if (sprintRow === undefined || task === undefined) return { error: new ApiError(404, 'not_found') };
    if (sprintRow.status === 'closed') return { error: taskConflict('closed') };
    if (task.completed_at !== null) return { error: taskConflict('completed') };
    return { sprint: sprintRow };
  };

  const checked = await check();
  if (checked.error !== undefined) {
    await throwIfClosed(db, workspaceId);
    throw checked.error;
  }

  const at = now();
  const removedAt = at.toISOString();
  const results = await db.batch([
    db.statement((q) =>
      q
        .updateTable('tasks')
        .set({ sprint_id: null, column_id: null, column_position: null, updated_at: removedAt })
        .where('id', '=', taskId)
        .where('workspace_id', '=', workspaceId)
        .where('sprint_id', '=', sprintId)
        .where('completed_at', 'is', null)
        .where('deleted_at', 'is', null)
        .where((eb) =>
          eb.and([
            eb.exists(openWorkspace(q, organizationId, workspaceId)),
            eb.exists(openSprint(q, workspaceId, sprintId)),
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
            // スプリントの名前は、書くときの今の名前を引く
            .selectFrom('sprints as cur')
            .select((eb) => [
              eb.val(uuidv7(at)).as('id'),
              eb.val(organizationId).as('organization_id'),
              eb.val(workspaceId).as('workspace_id'),
              eb.val(actorUserId).as('actor_user_id'),
              eb.val('task').as('entity_type'),
              eb.val(taskId).as('entity_id'),
              eb.val('update').as('action'),
              sprintLeftLogSql('cur').as('changes_json'),
              eb.val(removedAt).as('created_at'),
            ])
            .where('cur.id', '=', sprintId)
            .where('cur.workspace_id', '=', workspaceId)
            .where(previousStatementChanged),
        ),
    ),
    db.statement((q) =>
      q
        .updateTable('sprint_entries')
        .set({ ended_at: removedAt, outcome: 'removed' })
        .where('workspace_id', '=', workspaceId)
        .where('task_id', '=', taskId)
        .where('sprint_id', '=', sprintId)
        .where('ended_at', 'is', null)
        .where((eb) =>
          eb.exists(
            eb
              .selectFrom('tasks as removed')
              .select('removed.id')
              .where('removed.id', '=', taskId)
              .where('removed.workspace_id', '=', workspaceId)
              .where('removed.sprint_id', 'is', null)
              .where('removed.updated_at', '=', removedAt),
          ),
        ),
    ),
  ]);

  if ((results[0]?.changes ?? 0) === 0) {
    // 読んでから書くまでに、閉じた、スプリントが終了か削除された、タスクが外されたか完了にされた
    await throwIfClosed(db, workspaceId);
    const rechecked = await check();
    throw rechecked.error ?? new ApiError(409, 'conflict');
  }
  return { task_id: taskId };
});
