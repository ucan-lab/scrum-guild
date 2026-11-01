// ワークスペースの区分（categories）とリポジトリ（repositories）、タスクの決まった欄（detail_fields）の定義の、一覧、作成、変更、並べ替え、削除。
// 3つの表は、使う列（id、workspace_id、name、position、deleted_at、created_at、updated_at）が同じ名前と型なので、文を1つの書き方で組む。
// Kysely の型は categories の表で書き（asTable）、どの表でも同じ列だけを、表の名前を付けずに参照する（区分だけの列
// is_billed_monthly は、区分のときだけ選ぶ）。どの文もワークスペースで絞る。
// 数の上限は表ごと（spec.limit。区分とリポジトリは 50、決まった欄は 10）。決まった欄は、削除しても振っていた先を戻さない
// （値の行は残し、削除した欄は未記入の判定から外れるだけ）ので、spec.items が空で、削除の文は定義の削除とその履歴の2つ
import { now } from '../../shared/clock.ts';
import { DEFINITIONS_PER_WORKSPACE, DETAIL_FIELDS_PER_WORKSPACE } from '../../shared/definition.ts';
import {
  categoryCreate,
  categoryDelete,
  categoryMove,
  categoryRepositoryList,
  categoryUpdate,
  detailFieldCreate,
  detailFieldDelete,
  detailFieldList,
  detailFieldMove,
  detailFieldUpdate,
  repositoryCreate,
  repositoryDelete,
  repositoryMove,
  repositoryUpdate,
  type DefinitionConflictReason,
} from '../../shared/operations/definition/index.ts';
import {
  uuidv7Sql,
  previousStatementChanged,
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
type DefinitionTable = 'categories' | 'repositories' | 'detail_fields';

// 定義を振る先。区分はエピック、ストーリー、タスクの category_id、リポジトリはタスクの repository_id
type ItemTarget = {
  readonly table: 'epics' | 'stories' | 'tasks';
  readonly column: 'category_id' | 'repository_id';
  readonly entityType: 'epic' | 'story' | 'task';
};

type DefinitionSpec = {
  readonly table: DefinitionTable;
  // 変更の履歴の entity_type と、振った先の履歴の欄の名前
  readonly entityType: 'category' | 'repository' | 'detail_field';
  readonly items: readonly ItemTarget[];
  // 削除していない定義の数の上限
  readonly limit: number;
};

const categorySpec: DefinitionSpec = {
  table: 'categories',
  entityType: 'category',
  limit: DEFINITIONS_PER_WORKSPACE,
  items: [
    { table: 'epics', column: 'category_id', entityType: 'epic' },
    { table: 'stories', column: 'category_id', entityType: 'story' },
    { table: 'tasks', column: 'category_id', entityType: 'task' },
  ],
};

const repositorySpec: DefinitionSpec = {
  table: 'repositories',
  entityType: 'repository',
  limit: DEFINITIONS_PER_WORKSPACE,
  items: [{ table: 'tasks', column: 'repository_id', entityType: 'task' }],
};

const detailFieldSpec: DefinitionSpec = {
  table: 'detail_fields',
  entityType: 'detail_field',
  limit: DETAIL_FIELDS_PER_WORKSPACE,
  items: [],
};

// 同時の更新に負けたときにやり直す回数の上限。超えたら 409 の conflict
const MAX_ATTEMPTS = 3;

// 型の上では categories として扱う（上の説明のとおり、両方の表に同じ列だけを使う）
function asTable(table: DefinitionTable): 'categories' {
  return table as 'categories';
}

// 振った先の表と列も、型の上では tasks.category_id として扱う（epics、stories、tasks のどれにも、id、workspace_id、deleted_at、
// updated_at と、振る列がある）
function asItem(item: ItemTarget): { table: 'tasks'; column: 'category_id' } {
  return item as unknown as { table: 'tasks'; column: 'category_id' };
}

// 削除していない定義。ワークスペースで絞る
function liveRows(from: From, table: DefinitionTable, workspaceId: string) {
  return from.selectFrom(asTable(table)).where('workspace_id', '=', workspaceId).where('deleted_at', 'is', null);
}

// 同じ名前の、削除していない定義（自分を除く）
function sameName(from: From, table: DefinitionTable, workspaceId: string, name: string, exceptId: string | null) {
  return liveRows(from, table, workspaceId)
    .select('id')
    .where('name', '=', name)
    .$if(exceptId !== null, (qb) => qb.where('id', '!=', exceptId!));
}

// 削除していない定義の数
function liveCount(from: From, table: DefinitionTable, workspaceId: string) {
  return liveRows(from, table, workspaceId).select((eb) => eb.fn.countAll<number>().as('count'));
}

function definitionConflict(reason: DefinitionConflictReason): ApiError {
  return new ApiError(409, 'conflict', { reason });
}

type Current = { id: string; name: string; position: string; is_billed_monthly: number | null };

async function readDefinition(
  db: OrganizationDb,
  spec: DefinitionSpec,
  workspaceId: string,
  id: string,
): Promise<Current | undefined> {
  const row = await db.first(
    db.statement((q) =>
      liveRows(q, spec.table, workspaceId)
        .select(['id', 'name', 'position'])
        .$if(spec.table === 'categories', (qb) => qb.select('is_billed_monthly'))
        .where('id', '=', id),
    ),
  );
  if (row === undefined) return undefined;
  const { is_billed_monthly: monthly } = row as { is_billed_monthly?: number };
  return { id: row.id, name: row.name, position: row.position, is_billed_monthly: monthly ?? null };
}

// 書いた後に読めなかった理由を決める。閉じていれば 409 の workspace_closed、名前が重なれば duplicate_name、数が上限なら limit
async function throwCreateFailure(db: OrganizationDb, spec: DefinitionSpec, workspaceId: string, name: string) {
  await throwIfClosed(db, workspaceId);
  const [duplicate, count] = await db.batch([
    db.statement((q) => sameName(q, spec.table, workspaceId, name, null).limit(1)),
    db.statement((q) => liveCount(q, spec.table, workspaceId)),
  ] as const);
  if (duplicate.rows.length > 0) throw definitionConflict('duplicate_name');
  if (Number(count.rows[0]?.count ?? 0) >= spec.limit) throw definitionConflict('limit');
  throw new ApiError(409, 'conflict');
}

type Context = { db: OrganizationDb; actor: OrganizationActor; workspace: VerifiedWorkspace };

// 定義の変更の履歴の1行（INSERT ... SELECT の選ぶ列）
function changeLogValues(
  q: QueryCreator<OrganizationTables>,
  params: {
    id: string;
    organizationId: string;
    workspaceId: string;
    actorUserId: string;
    entityType: string;
    entityId: string;
    action: string;
    changes: unknown;
    at: string;
  },
) {
  return q.selectNoFrom((eb) => [
    eb.val(params.id).as('id'),
    eb.val(params.organizationId).as('organization_id'),
    eb.val(params.workspaceId).as('workspace_id'),
    eb.val(params.actorUserId).as('actor_user_id'),
    eb.val(params.entityType).as('entity_type'),
    eb.val(params.entityId).as('entity_id'),
    eb.val(params.action).as('action'),
    eb.val(JSON.stringify(params.changes)).as('changes_json'),
    eb.val(params.at).as('created_at'),
  ]);
}

// 足す。位置は末尾。同じ名前と数の上限は、書く文の条件（INSERT ... SELECT ... WHERE）で守り、同時に足しても重複を作らない
async function createDefinition(
  { db, actor, workspace }: Context,
  spec: DefinitionSpec,
  input: { name: string; is_billed_monthly?: boolean },
): Promise<Current> {
  const actorUserId = actorUserIdOf(actor);
  const organizationId = db.organizationId;
  const workspaceId = workspace.workspaceId;
  const last = await db.first(
    db.statement((q) =>
      liveRows(q, spec.table, workspaceId)
        .select(['position'])
        .orderBy('position', 'desc')
        .orderBy('id', 'desc')
        .limit(1),
    ),
  );
  const at = now();
  const createdAt = at.toISOString();
  const id = uuidv7(at);
  const position = placeLast(last === undefined ? undefined : { id: '', position: last.position }).position;
  const monthly = spec.table === 'categories' ? (input.is_billed_monthly === true ? 1 : 0) : null;
  const created: Record<string, [null, unknown]> = { name: [null, input.name] };
  if (monthly !== null) created.is_billed_monthly = [null, monthly];

  const results = await db.batch([
    db.statement((q) =>
      q
        .insertInto(asTable(spec.table))
        .columns([
          'id',
          'workspace_id',
          'name',
          'position',
          'created_at',
          'updated_at',
          ...(monthly === null ? [] : (['is_billed_monthly'] as const)),
        ])
        .expression(
          q
            .selectNoFrom((eb) => [
              eb.val(id).as('id'),
              eb.val(workspaceId).as('workspace_id'),
              eb.val(input.name).as('name'),
              eb.val(position).as('position'),
              eb.val(createdAt).as('created_at'),
              eb.val(createdAt).as('updated_at'),
              ...(monthly === null ? [] : [eb.val(monthly).as('is_billed_monthly')]),
            ])
            .where((eb) =>
              eb.and([
                eb.exists(openWorkspace(eb, organizationId, workspaceId)),
                eb.not(eb.exists(sameName(eb, spec.table, workspaceId, input.name, null))),
                eb(liveCount(eb, spec.table, workspaceId), '<', spec.limit),
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
          changeLogValues(q, {
            id: uuidv7(at),
            organizationId,
            workspaceId,
            actorUserId,
            entityType: spec.entityType,
            entityId: id,
            action: 'create',
            changes: created,
            at: createdAt,
          }).where(previousStatementChanged),
        ),
    ),
  ]);
  if ((results[0]?.changes ?? 0) === 0) await throwCreateFailure(db, spec, workspaceId, input.name);
  return { id, name: input.name, position, is_billed_monthly: monthly };
}

// 名前（と区分の月ごとに計上するか）を変える。送った欄のうち、今の値と違うものだけを、読んだ値のままなら、という条件つきで書く。
// 名前を変えるときは、同じ名前の定義が無いことも同じ文の条件にする。月ごとに計上するかを切り替えても、完了の記録は変えない
async function updateDefinition(
  { db, actor, workspace }: Context,
  spec: DefinitionSpec,
  id: string,
  input: { name?: string; is_billed_monthly?: boolean },
): Promise<Current> {
  const actorUserId = actorUserIdOf(actor);
  const organizationId = db.organizationId;
  const workspaceId = workspace.workspaceId;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const current = await readDefinition(db, spec, workspaceId, id);
    if (current === undefined) {
      await throwIfClosed(db, workspaceId);
      throw new ApiError(404, 'not_found');
    }
    const values: { name?: string; is_billed_monthly?: number } = {};
    const changes: Record<string, [unknown, unknown]> = {};
    if (input.name !== undefined && input.name !== current.name) {
      values.name = input.name;
      changes.name = [current.name, input.name];
    }
    const monthly = input.is_billed_monthly === undefined ? undefined : input.is_billed_monthly ? 1 : 0;
    if (spec.table === 'categories' && monthly !== undefined && monthly !== current.is_billed_monthly) {
      values.is_billed_monthly = monthly;
      changes.is_billed_monthly = [current.is_billed_monthly, monthly];
    }
    if (Object.keys(changes).length === 0) {
      await throwIfClosed(db, workspaceId);
      return current;
    }

    const at = now();
    const updatedAt = at.toISOString();
    const results = await db.batch([
      db.statement((q) =>
        q
          .updateTable(asTable(spec.table))
          .set({ ...values, updated_at: updatedAt })
          .where((eb) =>
            eb.and([
              eb('id', '=', id),
              eb('workspace_id', '=', workspaceId),
              eb('deleted_at', 'is', null),
              eb.exists(openWorkspace(q, organizationId, workspaceId)),
              ...(values.name === undefined
                ? []
                : [
                    eb('name', '=', current.name),
                    eb.not(eb.exists(sameName(q, spec.table, workspaceId, values.name, id))),
                  ]),
              ...(values.is_billed_monthly === undefined
                ? []
                : [eb('is_billed_monthly', '=', current.is_billed_monthly!)]),
            ]),
          ),
      ),
      db.statement((q) =>
        q
          .insertInto('change_logs')
          .columns(changeLogColumns)
          .expression(
            changeLogValues(q, {
              id: uuidv7(at),
              organizationId,
              workspaceId,
              actorUserId,
              entityType: spec.entityType,
              entityId: id,
              action: 'update',
              changes,
              at: updatedAt,
            }).where(previousStatementChanged),
          ),
      ),
    ]);
    if ((results[0]?.changes ?? 0) > 0) {
      return {
        ...current,
        ...(values.name === undefined ? {} : { name: values.name }),
        ...(values.is_billed_monthly === undefined ? {} : { is_billed_monthly: values.is_billed_monthly }),
      };
    }
    // 閉じていれば 409、無ければ 404、同じ名前があれば duplicate_name。どれでもなければ、別の要求が先に変えたので読み直してやり直す
    await throwIfClosed(db, workspaceId);
    if ((await readDefinition(db, spec, workspaceId, id)) === undefined) throw new ApiError(404, 'not_found');
    if (values.name !== undefined) {
      const duplicate = await db.first(
        db.statement((q) => sameName(q, spec.table, workspaceId, values.name!, id).limit(1)),
      );
      if (duplicate !== undefined) throw definitionConflict('duplicate_name');
    }
  }
  throw new ApiError(409, 'conflict');
}

// 動かす定義を除いた、削除していない定義の並び
function siblings(from: From, table: DefinitionTable, workspaceId: string, id: string) {
  return liveRows(from, table, workspaceId).where('id', '!=', id);
}

// 新しい位置と、読んだ直前の行。考え方はタスクとストーリーの移動（task.ts の planTaskMove）と同じ
async function planMove(
  db: OrganizationDb,
  table: DefinitionTable,
  workspaceId: string,
  id: string,
  afterId: string | null | undefined,
): Promise<{ plan: MovePlan; after: Positioned | null }> {
  if (afterId === undefined) {
    const last = await db.first(
      db.statement((q) =>
        siblings(q, table, workspaceId, id)
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
        siblings(q, table, workspaceId, id).select(['id', 'position']).orderBy('position').orderBy('id').limit(1),
      ),
    );
    return { plan: placeFirst(first), after: null };
  }
  const after = await db.first(
    db.statement((q) => siblings(q, table, workspaceId, id).select(['id', 'position']).where('id', '=', afterId)),
  );
  if (after === undefined) throw new ApiError(404, 'not_found');
  const [ties, next] = await db.batch([
    db.statement((q) =>
      siblings(q, table, workspaceId, id)
        .select(['id', 'position'])
        .where('position', '=', after.position)
        .where('id', '>', after.id)
        .orderBy('id')
        .limit(MAX_TIES + 1),
    ),
    db.statement((q) =>
      siblings(q, table, workspaceId, id)
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
async function moveDefinition(
  { db, workspace }: Context,
  spec: DefinitionSpec,
  id: string,
  afterId: string | null | undefined,
): Promise<void> {
  const organizationId = db.organizationId;
  const workspaceId = workspace.workspaceId;
  if (afterId === id) throw new ApiError(400, 'invalid_input');
  if ((await readDefinition(db, spec, workspaceId, id)) === undefined) {
    await throwIfClosed(db, workspaceId);
    throw new ApiError(404, 'not_found');
  }
  const { plan, after } = await planMove(db, spec.table, workspaceId, id, afterId);
  const updatedAt = now().toISOString();
  // 自分の更新が通った、という条件。振り直しはこれを自分の条件に持つ
  const moved = (from: From) =>
    liveRows(from, spec.table, workspaceId)
      .select('id')
      .where('id', '=', id)
      .where('position', '=', plan.position)
      .where('updated_at', '=', updatedAt);

  const results = await db.batch([
    db.statement((q) =>
      q
        .updateTable(asTable(spec.table))
        .set({ position: plan.position, updated_at: updatedAt })
        .where('id', '=', id)
        .where('workspace_id', '=', workspaceId)
        .where('deleted_at', 'is', null)
        .where((eb) => eb.exists(openWorkspace(q, organizationId, workspaceId)))
        // 直前の行が、今も読んだ値の位置にある
        .$if(after !== null, (qb) =>
          qb.where((eb) =>
            eb.exists(
              siblings(q, spec.table, workspaceId, id)
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
          .updateTable(asTable(spec.table))
          .set({ position: row.to, updated_at: updatedAt })
          .where('id', '=', row.id)
          .where('workspace_id', '=', workspaceId)
          .where('position', '=', row.from)
          .where('deleted_at', 'is', null)
          .where((eb) => eb.exists(moved(q))),
      ),
    ),
  ]);
  if ((results[0]?.changes ?? 0) === 0) {
    await throwIfClosed(db, workspaceId);
    if ((await readDefinition(db, spec, workspaceId, id)) === undefined) throw new ApiError(404, 'not_found');
    if (afterId != null) await planMove(db, spec.table, workspaceId, id, afterId);
    throw moveConflict('changed');
  }
}

// 削除する（論理削除）。1回の batch()（1つのトランザクション）に、定義の削除、表ごとに1文の履歴（振っていた行ごとに1行）、
// 表ごとに1文の戻す文を並べる。履歴と戻す文は、どちらも「自分の削除が通った」と「今振っている削除していない行」を条件にし、
// 履歴を戻す文より前に置く。振っていた行の数によらず文の数は決まっている（区分は 2 + 3 + 3、リポジトリは 2 + 1 + 1）。
// 削除した後は、振る書き込み（作成と変更）が削除していない定義だけを条件にするので、新しく振られない。完了の記録は変えない
async function deleteDefinition({ db, actor, workspace }: Context, spec: DefinitionSpec, id: string): Promise<void> {
  const actorUserId = actorUserIdOf(actor);
  const organizationId = db.organizationId;
  const workspaceId = workspace.workspaceId;

  const at = now();
  const deletedAt = at.toISOString();
  // 自分の削除が通った定義の行（d）。後ろの文はこれと結んで、自分の削除が通ったことを条件に持つ。
  // 止めた時計で2回目の削除が同じ時刻を書いても、振っていた行は1回目が戻しているので、後ろの文は何も書かない
  const deletedRef = `${spec.table} as d` as 'categories as d';

  const results = await db.batch([
    db.statement((q) =>
      q
        .updateTable(asTable(spec.table))
        .set({ deleted_at: deletedAt, updated_at: deletedAt })
        .where((eb) =>
          eb.and([
            eb('id', '=', id),
            eb('workspace_id', '=', workspaceId),
            eb('deleted_at', 'is', null),
            eb.exists(openWorkspace(q, organizationId, workspaceId)),
          ]),
        ),
    ),
    db.statement((q) =>
      q
        .insertInto('change_logs')
        .columns(changeLogColumns)
        .expression(
          changeLogValues(q, {
            id: uuidv7(at),
            organizationId,
            workspaceId,
            actorUserId,
            entityType: spec.entityType,
            entityId: id,
            action: 'delete',
            changes: { deleted_at: [null, deletedAt] },
            at: deletedAt,
          }).where(previousStatementChanged),
        ),
    ),
    // 振っていた行の履歴。表ごとに1文で、戻す前に、今振っている削除していない行のすべてに書く。
    // ID は行ごとに SQL の中で UUIDv7 の形に作り、区分の名前は定義の行から取る
    ...spec.items.map((item) =>
      db.statement((q) => {
        const { table, column } = asItem(item);
        return q
          .insertInto('change_logs')
          .columns(changeLogColumns)
          .expression(
            q
              .selectFrom(`${table} as i` as 'tasks as i')
              .innerJoin(deletedRef, (join) =>
                join.on('d.id', '=', id).on('d.workspace_id', '=', workspaceId).on('d.deleted_at', '=', deletedAt),
              )
              .select((eb) => [
                uuidv7Sql(at).as('id'),
                eb.val(organizationId).as('organization_id'),
                eb.val(workspaceId).as('workspace_id'),
                eb.val(actorUserId).as('actor_user_id'),
                eb.val(item.entityType).as('entity_type'),
                eb.ref('i.id').as('entity_id'),
                eb.val('update').as('action'),
                eb
                  .fn<string>('json_object', [
                    eb.val(spec.entityType),
                    eb.fn('json_array', [
                      eb.fn('json_object', [eb.val('id'), eb.ref('d.id'), eb.val('name'), eb.ref('d.name')]),
                      eb.lit(null),
                    ]),
                  ])
                  .as('changes_json'),
                eb.val(deletedAt).as('created_at'),
              ])
              .where(`i.${column}` as 'i.category_id', '=', id)
              .where('i.workspace_id', '=', workspaceId)
              .where('i.deleted_at', 'is', null),
          );
      }),
    ),
    // 振っていた行を戻す。条件は履歴の文と同じ
    ...spec.items.map((item) =>
      db.statement((q) => {
        const { table, column } = asItem(item);
        return q
          .updateTable(table)
          .set({ [column]: null, updated_at: deletedAt })
          .where('workspace_id', '=', workspaceId)
          .where('deleted_at', 'is', null)
          .where(column, '=', id)
          .where((eb) =>
            eb.exists(
              eb
                .selectFrom(deletedRef)
                .select('d.id')
                .where('d.id', '=', id)
                .where('d.workspace_id', '=', workspaceId)
                .where('d.deleted_at', '=', deletedAt),
            ),
          );
      }),
    ),
  ]);
  if ((results[0]?.changes ?? 0) > 0) return;
  // 閉じていれば 409、無い（先に削除された、別のワークスペース、別の組織を含む）なら 404
  await throwIfClosed(db, workspaceId);
  throw new ApiError(404, 'not_found');
}

function categoryOf(row: Current) {
  return { id: row.id, name: row.name, is_billed_monthly: row.is_billed_monthly === 1 };
}

function repositoryOf(row: Current) {
  return { id: row.id, name: row.name };
}

export const categoryRepositoryListOperation = implement(categoryRepositoryList, async ({ db, workspace }) => {
  const workspaceId = workspace.workspaceId;
  const [categories, repositories] = await db.batch([
    db.statement((q) =>
      liveRows(q, 'categories', workspaceId)
        .select(['id', 'name', 'is_billed_monthly'])
        .orderBy('position')
        .orderBy('id'),
    ),
    db.statement((q) =>
      q
        .selectFrom('repositories')
        .select(['id', 'name'])
        .where('workspace_id', '=', workspaceId)
        .where('deleted_at', 'is', null)
        .orderBy('position')
        .orderBy('id'),
    ),
  ] as const);
  return {
    categories: categories.rows.map((row) => ({
      id: row.id,
      name: row.name,
      is_billed_monthly: row.is_billed_monthly === 1,
    })),
    repositories: repositories.rows,
  };
});

export const categoryCreateOperation = implement(categoryCreate, async (context) => ({
  category: categoryOf(await createDefinition(context, categorySpec, context.input)),
}));

export const categoryUpdateOperation = implement(categoryUpdate, async (context) => ({
  category: categoryOf(await updateDefinition(context, categorySpec, context.input.category_id, context.input)),
}));

export const categoryMoveOperation = implement(categoryMove, async (context) => {
  await moveDefinition(context, categorySpec, context.input.category_id, context.input.after_category_id);
  return { category_id: context.input.category_id };
});

export const categoryDeleteOperation = implement(categoryDelete, async (context) => {
  await deleteDefinition(context, categorySpec, context.input.category_id);
  return { category_id: context.input.category_id };
});

export const detailFieldListOperation = implement(detailFieldList, async ({ db, workspace }) => {
  const rows = await db.rows(
    db.statement((q) =>
      liveRows(q, 'detail_fields', workspace.workspaceId).select(['id', 'name']).orderBy('position').orderBy('id'),
    ),
  );
  return { fields: rows.map((row) => ({ id: row.id, name: row.name })) };
});

export const detailFieldCreateOperation = implement(detailFieldCreate, async (context) => ({
  field: repositoryOf(await createDefinition(context, detailFieldSpec, context.input)),
}));

export const detailFieldUpdateOperation = implement(detailFieldUpdate, async (context) => ({
  field: repositoryOf(await updateDefinition(context, detailFieldSpec, context.input.field_id, context.input)),
}));

export const detailFieldMoveOperation = implement(detailFieldMove, async (context) => {
  await moveDefinition(context, detailFieldSpec, context.input.field_id, context.input.after_field_id);
  return { field_id: context.input.field_id };
});

export const detailFieldDeleteOperation = implement(detailFieldDelete, async (context) => {
  await deleteDefinition(context, detailFieldSpec, context.input.field_id);
  return { field_id: context.input.field_id };
});

export const repositoryCreateOperation = implement(repositoryCreate, async (context) => ({
  repository: repositoryOf(await createDefinition(context, repositorySpec, context.input)),
}));

export const repositoryUpdateOperation = implement(repositoryUpdate, async (context) => ({
  repository: repositoryOf(await updateDefinition(context, repositorySpec, context.input.repository_id, context.input)),
}));

export const repositoryMoveOperation = implement(repositoryMove, async (context) => {
  await moveDefinition(context, repositorySpec, context.input.repository_id, context.input.after_repository_id);
  return { repository_id: context.input.repository_id };
});

export const repositoryDeleteOperation = implement(repositoryDelete, async (context) => {
  await deleteDefinition(context, repositorySpec, context.input.repository_id);
  return { repository_id: context.input.repository_id };
});
