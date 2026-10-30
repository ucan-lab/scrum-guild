// スプリントの列（board_columns）の一覧、作成、名前の変更、並べ替え、削除。docs/data-model.md の board_columns と「書き込みの単位」。
// 区分とリポジトリ（definition.ts）と同じ書き方だが、列は完了の列（is_done = 1、name は空）を1つ持つ。
// 完了の列は、作る・直す・並べ替える・並びの直前に指す対象に入れない（読む文も書く文も is_done = 0 で絞る）。
// どの文もワークスペースで絞る
import { generateNKeysBetween } from 'fractional-indexing';
import { now } from '../../shared/clock.ts';
import { COLUMNS_PER_WORKSPACE } from '../../shared/column.ts';
import {
  columnCreate,
  columnDelete,
  columnList,
  columnMove,
  columnUpdate,
  type Column,
  type ColumnConflictReason,
} from '../../shared/operations/column/index.ts';
import {
  jsonPairRows,
  previousStatementChanged,
  uuidv7Sql,
  type OrganizationActor,
  type OrganizationDb,
  type OrganizationTables,
  type QueryCreator,
  type VerifiedWorkspace,
} from '../db/index.ts';
import { ApiError } from '../errors.ts';
import { uuidv7 } from '../uuid.ts';
import { implement } from './implement.ts';
import {
  MAX_TIES,
  moveConflict,
  placeAfter,
  placeFirst,
  placeLast,
  type MovePlan,
  type Positioned,
} from './move-position.ts';
import { actorUserIdOf, changeLogColumns, openWorkspace, throwIfClosed } from './write-guards.ts';

type From = Pick<QueryCreator<OrganizationTables>, 'selectFrom'>;
type Context = { db: OrganizationDb; actor: OrganizationActor; workspace: VerifiedWorkspace };

// 同時の更新に負けたときにやり直す回数の上限。超えたら 409 の conflict（changed）
const MAX_ATTEMPTS = 3;

function columnConflict(reason: ColumnConflictReason): ApiError {
  return new ApiError(409, 'conflict', { reason });
}

// 削除していない列
function liveColumns(from: From, workspaceId: string) {
  return from.selectFrom('board_columns').where('workspace_id', '=', workspaceId).where('deleted_at', 'is', null);
}

// 削除していない完了以外の列（作る・直す・並べ替えの対象。名前の重なりと数の上限もこの中で数える）
function openColumns(from: From, workspaceId: string) {
  return liveColumns(from, workspaceId).where('is_done', '=', 0);
}

// 同じ名前の、削除していない完了以外の列（自分を除く）
function sameName(from: From, workspaceId: string, name: string, exceptId: string | null) {
  return openColumns(from, workspaceId)
    .select('id')
    .where('name', '=', name)
    .$if(exceptId !== null, (qb) => qb.where('id', '!=', exceptId!));
}

function openCount(from: From, workspaceId: string) {
  return openColumns(from, workspaceId).select((eb) => eb.fn.countAll<number>().as('count'));
}

type Current = { id: string; name: string; position: string };

async function readOpenColumn(db: OrganizationDb, workspaceId: string, id: string): Promise<Current | undefined> {
  const row = await db.first(
    db.statement((q) => openColumns(q, workspaceId).select(['id', 'name', 'position']).where('id', '=', id)),
  );
  return row === undefined ? undefined : { id: row.id, name: row.name ?? '', position: row.position };
}

// ワークスペースの変更の履歴の1行（INSERT ... SELECT の選ぶ列）。列の変更は action = 'update'
// （組織の変更の履歴の画面は workspace の create、close、reopen だけを出す）
function workspaceLog(
  q: QueryCreator<OrganizationTables>,
  params: {
    id: string;
    organizationId: string;
    workspaceId: string;
    actorUserId: string;
    changes: unknown;
    at: string;
  },
) {
  return q.selectNoFrom((eb) => [
    eb.val(params.id).as('id'),
    eb.val(params.organizationId).as('organization_id'),
    eb.val(params.workspaceId).as('workspace_id'),
    eb.val(params.actorUserId).as('actor_user_id'),
    eb.val('workspace').as('entity_type'),
    eb.val(params.workspaceId).as('entity_id'),
    eb.val('update').as('action'),
    eb.val(JSON.stringify(params.changes)).as('changes_json'),
    eb.val(params.at).as('created_at'),
  ]);
}

// 書いた後に読めなかった理由を決める。閉じていれば 409 の workspace_closed、名前が重なれば duplicate_name、数が上限なら limit、
// どれでもなければ changed
async function throwCreateFailure(db: OrganizationDb, workspaceId: string, name: string): Promise<never> {
  await throwIfClosed(db, workspaceId);
  const [duplicate, count] = await db.batch([
    db.statement((q) => sameName(q, workspaceId, name, null).limit(1)),
    db.statement((q) => openCount(q, workspaceId)),
  ] as const);
  if (duplicate.rows.length > 0) throw columnConflict('duplicate_name');
  if (Number(count.rows[0]?.count ?? 0) >= COLUMNS_PER_WORKSPACE) throw columnConflict('limit');
  // どれでもなければ、読んでから書くまでに別の要求が名前か数を変えた。足す操作はやり直さず、changed で返す
  throw columnConflict('changed');
}

// 足す。位置は完了以外の列の末尾。同じ名前と数の上限は、書く文の条件（INSERT ... SELECT ... WHERE）で守り、同時に足しても重複を作らない
async function createColumn({ db, actor, workspace }: Context, name: string): Promise<Column> {
  const actorUserId = actorUserIdOf(actor);
  const organizationId = db.organizationId;
  const workspaceId = workspace.workspaceId;
  const last = await db.first(
    db.statement((q) =>
      openColumns(q, workspaceId).select(['position']).orderBy('position', 'desc').orderBy('id', 'desc').limit(1),
    ),
  );
  const at = now();
  const createdAt = at.toISOString();
  const id = uuidv7(at);
  const position = placeLast(last === undefined ? undefined : { id: '', position: last.position }).position;

  const results = await db.batch([
    db.statement((q) =>
      q
        .insertInto('board_columns')
        .columns(['id', 'workspace_id', 'name', 'is_done', 'position', 'created_at', 'updated_at'])
        .expression(
          q
            .selectNoFrom((eb) => [
              eb.val(id).as('id'),
              eb.val(workspaceId).as('workspace_id'),
              eb.val(name).as('name'),
              eb.val(0).as('is_done'),
              eb.val(position).as('position'),
              eb.val(createdAt).as('created_at'),
              eb.val(createdAt).as('updated_at'),
            ])
            .where((eb) =>
              eb.and([
                eb.exists(openWorkspace(eb, organizationId, workspaceId)),
                eb.not(eb.exists(sameName(eb, workspaceId, name, null))),
                eb(openCount(eb, workspaceId), '<', COLUMNS_PER_WORKSPACE),
              ]),
            ),
        ),
    ),
    // 足せたときだけ履歴を書く
    db.statement((q) =>
      q
        .insertInto('change_logs')
        .columns(changeLogColumns)
        .expression(
          workspaceLog(q, {
            id: uuidv7(at),
            organizationId,
            workspaceId,
            actorUserId,
            changes: { column: [null, { id, name }] },
            at: createdAt,
          }).where(previousStatementChanged),
        ),
    ),
  ]);
  if ((results[0]?.changes ?? 0) === 0) await throwCreateFailure(db, workspaceId, name);
  return { id, name, is_done: false, task_count: 0 };
}

// 削除すると移るタスクの数（column-list の task_count と同じ集計。movableTasks は下で定義する）
async function taskCountOf(db: OrganizationDb, workspaceId: string, columnId: string): Promise<number> {
  const row = await db.first(
    db.statement((q) =>
      movableTasks(q, workspaceId)
        .select((eb) => eb.fn.countAll<number>().as('count'))
        .where('t.column_id', '=', columnId),
    ),
  );
  return Number(row?.count ?? 0);
}

// 名前を直す。今の名前と違うときだけ、読んだ名前のままで、同じ名前の列が無ければ、という条件つきで書く
async function updateColumn({ db, actor, workspace }: Context, id: string, name: string): Promise<Column> {
  const actorUserId = actorUserIdOf(actor);
  const organizationId = db.organizationId;
  const workspaceId = workspace.workspaceId;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const current = await readOpenColumn(db, workspaceId, id);
    if (current === undefined) {
      await throwIfClosed(db, workspaceId);
      throw new ApiError(404, 'not_found');
    }
    if (name === current.name) {
      await throwIfClosed(db, workspaceId);
      return { id, name, is_done: false, task_count: await taskCountOf(db, workspaceId, id) };
    }
    const at = now();
    const updatedAt = at.toISOString();
    const results = await db.batch([
      db.statement((q) =>
        q
          .updateTable('board_columns')
          .set({ name, updated_at: updatedAt })
          .where((eb) =>
            eb.and([
              eb('id', '=', id),
              eb('workspace_id', '=', workspaceId),
              eb('deleted_at', 'is', null),
              eb('is_done', '=', 0),
              eb('name', '=', current.name),
              eb.exists(openWorkspace(q, organizationId, workspaceId)),
              eb.not(eb.exists(sameName(q, workspaceId, name, id))),
            ]),
          ),
      ),
      db.statement((q) =>
        q
          .insertInto('change_logs')
          .columns(changeLogColumns)
          .expression(
            workspaceLog(q, {
              id: uuidv7(at),
              organizationId,
              workspaceId,
              actorUserId,
              changes: {
                column: [
                  { id, name: current.name },
                  { id, name },
                ],
              },
              at: updatedAt,
            }).where(previousStatementChanged),
          ),
      ),
    ]);
    if ((results[0]?.changes ?? 0) > 0) {
      return { id, name, is_done: false, task_count: await taskCountOf(db, workspaceId, id) };
    }
    // 閉じていれば 409、無ければ 404、同じ名前があれば duplicate_name。どれでもなければ、別の要求が先に変えたので読み直してやり直す
    await throwIfClosed(db, workspaceId);
    if ((await readOpenColumn(db, workspaceId, id)) === undefined) throw new ApiError(404, 'not_found');
    const duplicate = await db.first(db.statement((q) => sameName(q, workspaceId, name, id).limit(1)));
    if (duplicate !== undefined) throw columnConflict('duplicate_name');
  }
  throw columnConflict('changed');
}

// 動かす列を除いた、削除していない完了以外の列の並び
function siblings(from: From, workspaceId: string, id: string) {
  return openColumns(from, workspaceId).where('id', '!=', id);
}

// 新しい位置と、読んだ直前の行。考え方は区分の並べ替え（definition.ts の planMove）と同じ
async function planMove(
  db: OrganizationDb,
  workspaceId: string,
  id: string,
  afterId: string | null | undefined,
): Promise<{ plan: MovePlan; after: Positioned | null }> {
  if (afterId === undefined) {
    const last = await db.first(
      db.statement((q) =>
        siblings(q, workspaceId, id)
          .select(['id', 'position'])
          .orderBy('position', 'desc')
          .orderBy('id', 'desc')
          .limit(1),
      ),
    );
    return { plan: placeLast(last), after: null };
  }
  if (afterId === null) {
    const first = await db.first(
      db.statement((q) =>
        siblings(q, workspaceId, id).select(['id', 'position']).orderBy('position').orderBy('id').limit(1),
      ),
    );
    return { plan: placeFirst(first), after: null };
  }
  const after = await db.first(
    db.statement((q) => siblings(q, workspaceId, id).select(['id', 'position']).where('id', '=', afterId)),
  );
  if (after === undefined) throw new ApiError(404, 'not_found');
  const [ties, next] = await db.batch([
    db.statement((q) =>
      siblings(q, workspaceId, id)
        .select(['id', 'position'])
        .where('position', '=', after.position)
        .where('id', '>', after.id)
        .orderBy('id')
        .limit(MAX_TIES + 1),
    ),
    db.statement((q) =>
      siblings(q, workspaceId, id)
        .select(['id', 'position'])
        .where('position', '>', after.position)
        .orderBy('position')
        .orderBy('id')
        .limit(1),
    ),
  ] as const);
  return { plan: placeAfter(after, ties.rows, next.rows[0]), after };
}

// 並べ替える。履歴は残さない
async function moveColumn({ db, workspace }: Context, id: string, afterId: string | null | undefined): Promise<void> {
  const organizationId = db.organizationId;
  const workspaceId = workspace.workspaceId;
  if (afterId === id) throw new ApiError(400, 'invalid_input');
  if ((await readOpenColumn(db, workspaceId, id)) === undefined) {
    await throwIfClosed(db, workspaceId);
    throw new ApiError(404, 'not_found');
  }
  const { plan, after } = await planMove(db, workspaceId, id, afterId);
  const updatedAt = now().toISOString();
  // 自分の更新が通った、という条件。振り直しはこれを自分の条件に持つ
  const moved = (from: From) =>
    openColumns(from, workspaceId)
      .select('id')
      .where('id', '=', id)
      .where('position', '=', plan.position)
      .where('updated_at', '=', updatedAt);

  const results = await db.batch([
    db.statement((q) =>
      q
        .updateTable('board_columns')
        .set({ position: plan.position, updated_at: updatedAt })
        .where('id', '=', id)
        .where('workspace_id', '=', workspaceId)
        .where('deleted_at', 'is', null)
        .where('is_done', '=', 0)
        .where((eb) => eb.exists(openWorkspace(q, organizationId, workspaceId)))
        // 直前の行が、今も読んだ値の位置にある
        .$if(after !== null, (qb) =>
          qb.where((eb) =>
            eb.exists(
              siblings(q, workspaceId, id)
                .select('id')
                .where('id', '=', after!.id)
                .where('position', '=', after!.position),
            ),
          ),
        ),
    ),
    ...plan.renumber.map((row) =>
      db.statement((q) =>
        q
          .updateTable('board_columns')
          .set({ position: row.to, updated_at: updatedAt })
          .where('id', '=', row.id)
          .where('workspace_id', '=', workspaceId)
          .where('position', '=', row.from)
          .where('deleted_at', 'is', null)
          .where('is_done', '=', 0)
          .where((eb) => eb.exists(moved(q))),
      ),
    ),
  ]);
  if ((results[0]?.changes ?? 0) === 0) {
    await throwIfClosed(db, workspaceId);
    if ((await readOpenColumn(db, workspaceId, id)) === undefined) throw new ApiError(404, 'not_found');
    if (afterId != null) await planMove(db, workspaceId, id, afterId);
    throw moveConflict('changed');
  }
}

// 削除で移すタスク。進行中と先のスプリント（削除していない planned と active）の、削除していない未完了のタスク
function movableTasks(from: From, workspaceId: string) {
  return from
    .selectFrom('tasks as t')
    .innerJoin('sprints as s', (join) => join.onRef('s.id', '=', 't.sprint_id').on('s.workspace_id', '=', workspaceId))
    .where('t.workspace_id', '=', workspaceId)
    .where('t.deleted_at', 'is', null)
    .where('t.completed_at', 'is', null)
    .where('s.deleted_at', 'is', null)
    .where('s.status', 'in', ['planned', 'active']);
}

type DeleteFacts = {
  column: { id: string; name: string | null; is_done: number } | undefined;
  // 削除する列のほかに、削除していない完了以外の列があるか
  hasOtherOpenColumn: boolean;
  target: { id: string; name: string | null; is_done: number } | undefined;
  // 移すタスク。移す前の列の中の順（column_position、id）
  tasks: { id: string; sprint_id: string }[];
  // 移し先の列の、スプリントごとの末尾の位置
  tails: Map<string, string>;
};

// 削除に要る行を1回の batch() で読む。移し先を送っていなければ読まない（行が無い）
async function readDeleteFacts(
  db: OrganizationDb,
  workspaceId: string,
  columnId: string,
  targetId: string | undefined,
): Promise<DeleteFacts> {
  const [column, other, target, tasks, tails] = await db.batch([
    db.statement((q) => liveColumns(q, workspaceId).select(['id', 'name', 'is_done']).where('id', '=', columnId)),
    db.statement((q) => openColumns(q, workspaceId).select('id').where('id', '!=', columnId).limit(1)),
    db.statement((q) =>
      liveColumns(q, workspaceId)
        .select(['id', 'name', 'is_done'])
        .where('id', '=', targetId ?? ''),
    ),
    db.statement((q) =>
      movableTasks(q, workspaceId)
        .select(['t.id', 't.sprint_id'])
        .where('t.column_id', '=', columnId)
        .orderBy('t.column_position')
        .orderBy('t.id'),
    ),
    db.statement((q) =>
      q
        .selectFrom('tasks as t')
        .innerJoin('sprints as s', (join) =>
          join.onRef('s.id', '=', 't.sprint_id').on('s.workspace_id', '=', workspaceId),
        )
        .select(['t.sprint_id', (eb) => eb.fn.max('t.column_position').as('tail')])
        .where('t.workspace_id', '=', workspaceId)
        .where('t.column_id', '=', targetId ?? '')
        .where('t.deleted_at', 'is', null)
        .where('s.deleted_at', 'is', null)
        .where('s.status', 'in', ['planned', 'active'])
        .groupBy('t.sprint_id'),
    ),
  ] as const);
  const tailMap = new Map<string, string>();
  for (const row of tails.rows) {
    if (row.sprint_id !== null && row.tail !== null) tailMap.set(row.sprint_id, row.tail);
  }
  return {
    column: column.rows[0],
    hasOtherOpenColumn: other.rows.length > 0,
    target: target.rows[0],
    tasks: tasks.rows.flatMap((row) => (row.sprint_id === null ? [] : [{ id: row.id, sprint_id: row.sprint_id }])),
    tails: tailMap,
  };
}

// 読んだ行から、断る理由を決める。削除できるなら何も投げない。書く前と、書けなかった後の読み直しの両方が使う。
// 無い列（別の組織、別のワークスペース、削除済み）は 404、完了の列と最後の1つと移し先の足りなさは 409
function assertDeletable(
  facts: DeleteFacts,
  columnId: string,
  targetId: string | undefined,
): asserts facts is DeleteFacts & { column: NonNullable<DeleteFacts['column']> } {
  const { column } = facts;
  if (column === undefined) throw new ApiError(404, 'not_found');
  if (column.is_done === 1) throw columnConflict('done_column');
  if (!facts.hasOtherOpenColumn) throw columnConflict('last_column');
  if (targetId !== undefined) {
    if (targetId === columnId) throw columnConflict('target_invalid');
    if (facts.target === undefined) throw new ApiError(404, 'not_found');
    if (facts.target.is_done === 1) throw columnConflict('target_invalid');
  } else if (facts.tasks.length > 0) {
    throw columnConflict('target_required');
  }
}

// 削除する（論理削除）。先に読んだものから、書く文を決める。書く文は移すタスクの数によらない決まった数で、1回の batch() で送る。
// 移すタスクの ID と、移し先に置く位置（ID と位置の組）は JSON の配列で渡す（json_each。sprint-close と同じ）。
// 1. board_columns: 読んだ名前のままの完了以外の列を、閉じていないワークスペースで、ほかに削除していない完了以外の列があり
//    （同時に2つ消して0になるのを止める）、移し先が今も削除していない完了以外の列で、読んだ以外の移すタスクが残っていないときだけ削除する。
//    D1 は書き込みを1つずつ流すので、同時に別の列を消した要求は、先の削除を見て何も書かない
// 2. ワークスペースの change_logs: 直前の UPDATE が行を変えたときだけ入れる。以降の文は、この履歴の行（この要求だけの id）が
//    あることを条件にする。止めた時計（DEV_NOW）では、先に削除した要求と自分の削除を時刻で見分けられないため
// 3. 移すタスクごとの change_logs（task-column-move と同じ {"column": [{id, name}, {id, name}]}。名前は書くときの今の名前）、
//    4. 移すタスクを書く（column_id、column_position、updated_at）。3 と 4 は、読んだときのスプリント（sprintPairs）のままで、
//    そのスプリントが削除されておらず planned か active のタスクだけを対象にする（読んだ後に終了したスプリントのカードを動かさない）。
//    3 は 4 より前に置く（書き換えた後は条件に当たらなくなるため）
// 書けなかったら読み直して理由を分け（閉じた、無い、完了の列、最後の1つ、移し先が足りない）、どれでもなければやり直す
async function deleteColumn(
  { db, actor, workspace }: Context,
  columnId: string,
  targetId: string | undefined,
): Promise<number> {
  const actorUserId = actorUserIdOf(actor);
  const organizationId = db.organizationId;
  const workspaceId = workspace.workspaceId;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const facts = await readDeleteFacts(db, workspaceId, columnId, targetId);
    if (facts.column === undefined) await throwIfClosed(db, workspaceId);
    assertDeletable(facts, columnId, targetId);
    const { column, target, tasks } = facts;

    const at = now();
    const deletedAt = at.toISOString();
    const logId = uuidv7(at);
    // スプリントごとに、移し先の列の末尾へ、元の列の中の順で並べる
    const positions: [string, string][] = [];
    const bySprint = new Map<string, string[]>();
    for (const task of tasks) bySprint.set(task.sprint_id, [...(bySprint.get(task.sprint_id) ?? []), task.id]);
    for (const [sprintId, ids] of bySprint) {
      const keys = generateNKeysBetween(facts.tails.get(sprintId) ?? null, null, ids.length);
      ids.forEach((id, index) => positions.push([id, keys[index]!]));
    }

    // 移すタスクと、読んだときに入っていたスプリント（[タスクの ID, スプリントの ID]）
    const sprintPairs: [string, string][] = tasks.map((task) => [task.id, task.sprint_id]);

    const ownLog = (from: From) =>
      from
        .selectFrom('change_logs as own')
        .select('own.id')
        .where('own.id', '=', logId)
        .where('own.workspace_id', '=', workspaceId);

    const changes: Record<string, unknown> = { column: [{ id: column.id, name: column.name }, null] };
    // 移すタスクが無ければ、移し先は書かない
    if (target !== undefined && tasks.length > 0) {
      changes.target_column = [null, { id: target.id, name: target.name }];
    }

    const results = await db.batch([
      db.statement((q) =>
        q
          .updateTable('board_columns')
          .set({ deleted_at: deletedAt, updated_at: deletedAt })
          .where((eb) =>
            eb.and([
              eb('id', '=', columnId),
              eb('workspace_id', '=', workspaceId),
              eb('deleted_at', 'is', null),
              eb('is_done', '=', 0),
              eb('name', 'is', column.name),
              eb.exists(openWorkspace(q, organizationId, workspaceId)),
              eb.exists(openColumns(q, workspaceId).select('id').where('id', '!=', columnId)),
              ...(targetId === undefined
                ? []
                : [eb.exists(openColumns(q, workspaceId).select('id').where('id', '=', targetId))]),
              eb.not(
                eb.exists(
                  movableTasks(q, workspaceId)
                    .select('t.id')
                    .where('t.column_id', '=', columnId)
                    // 読んだ（タスク、スプリント）の組に無いもの。読んだ後に別のスプリントへ移ったカードも、組が変わるので数える
                    .where((eb) =>
                      eb.not(
                        eb.exists(
                          eb
                            .selectFrom(jsonPairRows(sprintPairs).as('seen'))
                            .select('seen.id')
                            .whereRef('seen.id', '=', 't.id')
                            .whereRef('seen.pos', '=', 't.sprint_id'),
                        ),
                      ),
                    ),
                ),
              ),
            ]),
          ),
      ),
      db.statement((q) =>
        q
          .insertInto('change_logs')
          .columns(changeLogColumns)
          .expression(
            workspaceLog(q, {
              id: logId,
              organizationId,
              workspaceId,
              actorUserId,
              changes,
              at: deletedAt,
            }).where(previousStatementChanged),
          ),
      ),
      ...(tasks.length === 0 || targetId === undefined
        ? []
        : [
            db.statement((q) =>
              q
                .insertInto('change_logs')
                .columns(changeLogColumns)
                .expression(
                  q
                    .selectFrom('tasks as t')
                    .innerJoin('board_columns as from', (join) =>
                      join.on('from.id', '=', columnId).on('from.workspace_id', '=', workspaceId),
                    )
                    .innerJoin('board_columns as to', (join) =>
                      join.on('to.id', '=', targetId).on('to.workspace_id', '=', workspaceId),
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
                          eb.val('column'),
                          eb.fn('json_array', [
                            eb.fn('json_object', [
                              eb.val('id'),
                              eb.ref('from.id'),
                              eb.val('name'),
                              eb.ref('from.name'),
                            ]),
                            eb.fn('json_object', [eb.val('id'), eb.ref('to.id'), eb.val('name'), eb.ref('to.name')]),
                          ]),
                        ])
                        .as('changes_json'),
                      eb.val(deletedAt).as('created_at'),
                    ])
                    // 読んだときのスプリントのままで、そのスプリントが削除されておらず planned か active のタスクだけ
                    .innerJoin(jsonPairRows(sprintPairs).as('sp'), (join) =>
                      join.onRef('sp.id', '=', 't.id').onRef('sp.pos', '=', 't.sprint_id'),
                    )
                    .where((eb) =>
                      eb.exists(
                        q
                          .selectFrom('sprints as live')
                          .select('live.id')
                          .where('live.id', '=', eb.ref('t.sprint_id'))
                          .where('live.workspace_id', '=', workspaceId)
                          .where('live.deleted_at', 'is', null)
                          .where('live.status', 'in', ['planned', 'active']),
                      ),
                    )
                    .where('t.workspace_id', '=', workspaceId)
                    .where('t.column_id', '=', columnId)
                    .where('t.deleted_at', 'is', null)
                    .where('t.completed_at', 'is', null)
                    .where((eb) => eb.exists(ownLog(q))),
                ),
            ),
            db.statement((q) =>
              q
                .updateTable('tasks')
                .from(jsonPairRows(positions).as('p'))
                .from(jsonPairRows(sprintPairs).as('sp'))
                .set((eb) => ({ column_id: targetId, column_position: eb.ref('p.pos'), updated_at: deletedAt }))
                .whereRef('tasks.id', '=', 'p.id')
                // 読んだときのスプリントのままで、そのスプリントが削除されておらず planned か active のタスクだけ
                .whereRef('sp.id', '=', 'tasks.id')
                .whereRef('sp.pos', '=', 'tasks.sprint_id')
                .where((eb) =>
                  eb.exists(
                    q
                      .selectFrom('sprints as live')
                      .select('live.id')
                      .where('live.id', '=', eb.ref('tasks.sprint_id'))
                      .where('live.workspace_id', '=', workspaceId)
                      .where('live.deleted_at', 'is', null)
                      .where('live.status', 'in', ['planned', 'active']),
                  ),
                )
                .where('tasks.workspace_id', '=', workspaceId)
                .where('tasks.column_id', '=', columnId)
                .where('tasks.deleted_at', 'is', null)
                .where('tasks.completed_at', 'is', null)
                .where((eb) => eb.exists(ownLog(q))),
            ),
          ]),
    ]);
    if ((results[0]?.changes ?? 0) > 0) return tasks.length === 0 ? 0 : (results.at(-1)?.changes ?? 0);
    // 閉じていれば 409。そうでなければ読み直して、上の順で理由を返す。どれでもなければ、別の要求が先に列かタスクを変えたのでやり直す
    await throwIfClosed(db, workspaceId);
    const latest = await readDeleteFacts(db, workspaceId, columnId, targetId);
    assertDeletable(latest, columnId, targetId);
  }
  throw columnConflict('changed');
}

export const columnListOperation = implement(columnList, async ({ db, workspace }) => {
  const workspaceId = workspace.workspaceId;
  const [columns, counts] = await db.batch([
    db.statement((q) =>
      liveColumns(q, workspaceId)
        .select(['id', 'name', 'is_done'])
        .orderBy('is_done')
        .orderBy('position')
        .orderBy('id'),
    ),
    db.statement((q) =>
      movableTasks(q, workspaceId)
        .select(['t.column_id', (eb) => eb.fn.countAll<number>().as('count')])
        .where('t.column_id', 'is not', null)
        .groupBy('t.column_id'),
    ),
  ] as const);
  const countOf = new Map(counts.rows.map((row) => [row.column_id, Number(row.count)]));
  return {
    columns: columns.rows.map((row) => ({
      id: row.id,
      name: row.name ?? '',
      is_done: row.is_done === 1,
      task_count: row.is_done === 1 ? 0 : (countOf.get(row.id) ?? 0),
    })),
  };
});

export const columnCreateOperation = implement(columnCreate, async (context) => ({
  column: await createColumn(context, context.input.name),
}));

export const columnUpdateOperation = implement(columnUpdate, async (context) => ({
  column: await updateColumn(context, context.input.column_id, context.input.name),
}));

export const columnMoveOperation = implement(columnMove, async (context) => {
  await moveColumn(context, context.input.column_id, context.input.after_column_id);
  return { column_id: context.input.column_id };
});

export const columnDeleteOperation = implement(columnDelete, async (context) => {
  const movedCount = await deleteColumn(context, context.input.column_id, context.input.target_column_id);
  return { column_id: context.input.column_id, moved_count: movedCount };
});
