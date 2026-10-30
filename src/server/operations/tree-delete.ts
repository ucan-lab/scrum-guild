// エピックとストーリーの削除（epic-delete、story-delete）と、ダイアログが出す削除の可否と配下の件数の読み取り。
// 削除は論理削除で、配下の扱いを選ぶ（docs/requirements.md の「削除」、docs/data-model.md の「書き込みの単位」の「エピックとストーリーの削除」）。
//   keep: 直接の子を親なしにする。子は移す先（親のないストーリー、親のないタスク）の末尾に、元の並び（position、id の順）のまま置き、
//         親から引き継いでいた区分を写す（削除の前後で集計の区分を変えない）
//   delete: 木の下をまとめて削除する。手で作ったタスクは論理削除、取り込んだタスクは削除せずアーカイブの末尾へ移す。
//         リーダーと管理者でない人は、削除していない手で作った配下がすべて本人の作ったもののときだけ消せる
// 書く文は子の数によらず決まった数で、1回の batch() に並べる。どの文も同じ前提（guardRow。消す根が削除されていない、閉じていない
// ワークスペース、リーダーと管理者でない人の delete なら他の人の作った配下が無い）を条件に持ち、根を削除する UPDATE は子の文の後ろに置く
// （根を先に消すと、後ろの文の条件が自分の削除と先の要求の削除を見分けられない）。1つのトランザクションの中で前提は変わらないので、
// 子の文が書いたなら根の UPDATE も通る。根の履歴は直前の UPDATE に結ぶ
import { now } from '../../shared/clock.ts';
import { DELETE_OTHERS_CHILDREN_REASON, type DeleteChildrenMode } from '../../shared/operations/delete-children.ts';
import { epicDelete } from '../../shared/operations/epic/index.ts';
import { storyDelete } from '../../shared/operations/story/index.ts';
import {
  previousStatementChanged,
  tailPosition,
  uuidv7Sql,
  type OrganizationDb,
  type OrganizationTables,
  type QueryCreator,
  type Statement,
  unindexed,
} from '../db/index.ts';
import { ApiError } from '../errors.ts';
import { uuidv7 } from '../uuid.ts';
import { implement } from './implement.ts';
import { actorUserIdOf, changeLogColumns, isLeaderOrAdmin, mayDeleteOwned, throwIfClosed } from './write-guards.ts';

type Tables = OrganizationTables;
type From = Pick<QueryCreator<Tables>, 'selectFrom'>;

// 消す根。エピックかストーリー
export type Root = { kind: 'epic' | 'story'; id: string };

// 1回の削除で使う値。どの文も同じ時刻と同じ人で書く。
// ownerOnly は、リーダーと管理者でない人の delete のときの呼んだ人。どの文も「この人以外の作った配下が無い」を条件に持つ
export type DeleteContext = {
  organizationId: string;
  workspaceId: string;
  actorUserId: string;
  at: Date;
  deletedAt: string;
  ownerOnly: string | null;
};

type Actor = { userId: string | null; isAdmin: boolean };
type Workspace = { workspaceId: string; actorRole: 'leader' | 'member' | null };

// 消す根が今も削除されていない。根の表は別名 root で引く（子の表と同じ表を結ぶときに名前がぶつからないように）
function liveRoot(from: From, workspaceId: string, root: Root) {
  return root.kind === 'epic'
    ? from
        .selectFrom('epics as root')
        .select('root.id')
        .where('root.id', '=', root.id)
        .where('root.workspace_id', '=', workspaceId)
        .where('root.deleted_at', 'is', null)
    : from
        .selectFrom('stories as root')
        .select('root.id')
        .where('root.id', '=', root.id)
        .where('root.workspace_id', '=', workspaceId)
        .where('root.deleted_at', 'is', null);
}

// 他の人の作った、削除していない配下。根がストーリーなら手で作った配下のタスク、エピックなら配下のストーリーか、その下の手で作ったタスク
// （完了したものも含む）。取り込んだタスクは削除せずアーカイブへ移すだけで、作った人もいないので数えない。
// タスクは tasks_story、ストーリーは stories_workspace_epic の索引で引く。あるかだけを見るので1行まで
function othersUnderRoot(from: From, workspaceId: string, root: Root, userId: string) {
  if (root.kind === 'story') {
    return from
      .selectFrom('tasks as ot')
      .select('ot.id')
      .where('ot.story_id', '=', root.id)
      .where('ot.workspace_id', '=', workspaceId)
      .where('ot.deleted_at', 'is', null)
      .where('ot.is_imported', '=', 0)
      .where('ot.created_by', '<>', userId)
      .limit(1);
  }
  return from
    .selectFrom('stories as os')
    .select('os.id')
    .where('os.workspace_id', '=', workspaceId)
    .where('os.epic_id', '=', root.id)
    .where('os.deleted_at', 'is', null)
    .where((eb) =>
      eb.or([
        eb('os.created_by', '<>', userId),
        eb.exists(
          eb
            .selectFrom('tasks as ot')
            .select('ot.id')
            .whereRef('ot.story_id', '=', 'os.id')
            .where('ot.workspace_id', '=', workspaceId)
            .where('ot.deleted_at', 'is', null)
            .where('ot.is_imported', '=', 0)
            .where('ot.created_by', '<>', userId),
        ),
      ]),
    )
    .limit(1);
}

// どの文も持つ前提。閉じていない組織のワークスペースで、消す根が削除されていない。ownerOnly があれば、その人以外の作った配下が無い。
// 1行を返す副問い合わせで、文には EXISTS で入れる
function guardRow(from: From, context: DeleteContext, root: Root) {
  const { organizationId, workspaceId, ownerOnly } = context;
  return from
    .selectFrom('workspaces as gw')
    .select('gw.id')
    .where('gw.id', '=', workspaceId)
    .where('gw.organization_id', '=', organizationId)
    .where('gw.closed_at', 'is', null)
    .where((eb) => eb.exists(liveRoot(from, workspaceId, root)))
    .$if(ownerOnly !== null, (qb) =>
      qb.where((eb) => eb.not(eb.exists(othersUnderRoot(from, workspaceId, root, ownerOnly!)))),
    );
}

// 配下のタスク（delete で消すかアーカイブへ移す）の ID。根がストーリーならその下、エピックなら配下の削除していないストーリーの下の、
// 削除していないタスク。完了したものも含む。imported で手で作ったものか取り込んだものに絞る。
// どちらも story_id で tasks_story の索引に乗せる。エピックは配下のストーリーを stories_workspace_epic で引いてからタスクを引くよう、
// FROM stories CROSS JOIN tasks で順序を固定する（INNER JOIN や story_id IN (...) では、SQLite が tasks_workspace_tray で
// ワークスペースの全タスクを走査する計画を選ぶ。backlog-tree と同じ）
// imported が null なら、どちらも
function tasksUnderRoot(from: From, workspaceId: string, root: Root, imported: 0 | 1 | null) {
  if (root.kind === 'story') {
    return from
      .selectFrom('tasks as ut')
      .select('ut.id')
      .where('ut.story_id', '=', root.id)
      .where('ut.workspace_id', '=', workspaceId)
      .where('ut.deleted_at', 'is', null)
      .$if(imported !== null, (qb) => qb.where('ut.is_imported', '=', imported!));
  }
  return epicTasks(from, workspaceId, root.id)
    .select('ut.id')
    .$if(imported !== null, (qb) => qb.where('ut.is_imported', '=', imported!));
}

// エピックの配下の削除していないストーリーの下の、削除していないタスク（ストーリーは us、タスクは ut）
function epicTasks(from: From, workspaceId: string, epicId: string) {
  return from
    .selectFrom('stories as us')
    .crossJoin('tasks as ut')
    .where('us.workspace_id', '=', workspaceId)
    .where('us.epic_id', '=', epicId)
    .where('us.deleted_at', 'is', null)
    .whereRef('ut.story_id', '=', 'us.id')
    .where('ut.workspace_id', '=', workspaceId)
    .where('ut.deleted_at', 'is', null);
}

// 移す先の最後の位置（1行）。tailPosition の last に渡す
function lastStoryPosition(from: From, workspaceId: string) {
  return from
    .selectFrom('stories as a')
    .select('a.position')
    .where('a.workspace_id', '=', workspaceId)
    .where('a.epic_id', 'is', null)
    .where('a.deleted_at', 'is', null)
    .orderBy('a.position', 'desc')
    .limit(1);
}

// バックログの親なしは、story_id を索引に使わせず（unindexed）、tasks_workspace_tray で引かせる。ANALYZE の後は、SQLite が
// NULL を別々の値と数えて tasks_story を選び、全組織の親のないタスクを読む計画になるため（task.ts の backlogTasksUnder と同じ。
// docs/data-model.md の「バックログの木」。test/backlog-filter.test.ts が実行計画で確かめる）。
// unindexed は表の名前つきの列だけを受けるので、この表は別名を付けずに引く
function lastTaskPosition(from: From, workspaceId: string, tray: 'backlog' | 'archive') {
  const tasks = from
    .selectFrom('tasks')
    .select('tasks.position')
    .where('tasks.workspace_id', '=', workspaceId)
    .where('tasks.tray', '=', tray)
    .where('tasks.deleted_at', 'is', null);
  return (tray === 'backlog' ? tasks.where(unindexed('tasks.story_id'), 'is', null) : tasks)
    .orderBy('tasks.position', 'desc')
    .limit(1);
}

// 根を削除する UPDATE と、直前の UPDATE に結んだ根の履歴（action = 'delete'）
function rootStatements(db: OrganizationDb, context: DeleteContext, root: Root): Statement<'organization'>[] {
  const { organizationId, workspaceId, actorUserId, at, deletedAt } = context;
  return [
    // 型は epics の表で書く。使う列（id、workspace_id、deleted_at、updated_at）は stories にも同じ名前と型である
    db.statement((q) =>
      q
        .updateTable(root.kind === 'epic' ? 'epics' : ('stories' as 'epics'))
        .set({ deleted_at: deletedAt, updated_at: deletedAt })
        .where('id', '=', root.id)
        .where('workspace_id', '=', workspaceId)
        .where('deleted_at', 'is', null)
        .where((eb) => eb.exists(guardRow(q, context, root))),
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
              eb.val(root.kind).as('entity_type'),
              eb.val(root.id).as('entity_id'),
              eb.val('delete').as('action'),
              eb.val(JSON.stringify({ deleted_at: [null, deletedAt] })).as('changes_json'),
              eb.val(deletedAt).as('created_at'),
            ])
            .where(previousStatementChanged),
        ),
    ),
  ];
}

// delete: 配下のタスクを片付ける5文。履歴を先に置く（片付けた後は、配下の条件に当たらなくなるため）。
// 1. スプリントに入っている配下のタスクの行を removed で閉じる、2. 手で作ったタスクの削除の履歴、
// 3. 取り込んだタスクのアーカイブの履歴（親と置き場所）、4. 取り込んだタスクをアーカイブの末尾へ移す（親、スプリント、列を空にする）、
// 5. 手で作ったタスクを論理削除する（スプリント、列を空にする）
function deleteTaskStatements(db: OrganizationDb, context: DeleteContext, root: Root): Statement<'organization'>[] {
  const { organizationId, workspaceId, actorUserId, at, deletedAt } = context;
  return [
    db.statement((q) =>
      q
        .updateTable('sprint_entries')
        .set({ ended_at: deletedAt, outcome: 'removed' })
        .where('workspace_id', '=', workspaceId)
        .where('ended_at', 'is', null)
        .where('task_id', 'in', tasksUnderRoot(q, workspaceId, root, null))
        .where((eb) => eb.exists(guardRow(q, context, root))),
    ),
    db.statement((q) =>
      q
        .insertInto('change_logs')
        .columns(changeLogColumns)
        .expression(
          q
            .selectFrom('tasks as t')
            .select((eb) => [
              uuidv7Sql(at).as('id'),
              eb.val(organizationId).as('organization_id'),
              eb.val(workspaceId).as('workspace_id'),
              eb.val(actorUserId).as('actor_user_id'),
              eb.val('task').as('entity_type'),
              eb.ref('t.id').as('entity_id'),
              eb.val('delete').as('action'),
              eb.val(JSON.stringify({ deleted_at: [null, deletedAt] })).as('changes_json'),
              eb.val(deletedAt).as('created_at'),
            ])
            .where('t.workspace_id', '=', workspaceId)
            .where((eb) => eb('t.id', 'in', tasksUnderRoot(q, workspaceId, root, 0)))
            .where((eb) => eb.exists(guardRow(q, context, root))),
        ),
    ),
    db.statement((q) =>
      q
        .insertInto('change_logs')
        .columns(changeLogColumns)
        .expression(
          q
            .selectFrom('tasks as t')
            .innerJoin('stories as s', (join) =>
              join.onRef('s.id', '=', 't.story_id').on('s.workspace_id', '=', workspaceId),
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
                  eb.val('story'),
                  eb.fn('json_array', [
                    eb.fn('json_object', [eb.val('id'), eb.ref('s.id'), eb.val('title'), eb.ref('s.title')]),
                    eb.lit(null),
                  ]),
                  eb.val('tray'),
                  eb.fn('json_array', [eb.ref('t.tray'), eb.val('archive')]),
                ])
                .as('changes_json'),
              eb.val(deletedAt).as('created_at'),
            ])
            .where('t.workspace_id', '=', workspaceId)
            .where((eb) => eb('t.id', 'in', tasksUnderRoot(q, workspaceId, root, 1)))
            .where((eb) => eb.exists(guardRow(q, context, root))),
        ),
    ),
    // アーカイブの末尾に、元の並び（親のストーリーの並び、その中のタスクの並び）のまま振る（tailPosition）
    db.statement((q) =>
      q
        .updateTable('tasks')
        .from(
          q
            .selectFrom('tasks as t')
            .innerJoin('stories as s', (join) =>
              join.onRef('s.id', '=', 't.story_id').on('s.workspace_id', '=', workspaceId),
            )
            .select((eb) => [
              't.id as id',
              tailPosition(
                lastTaskPosition(q, workspaceId, 'archive'),
                eb.fn
                  .agg<number>('row_number')
                  .over((ob) => ob.orderBy('s.position').orderBy('s.id').orderBy('t.position').orderBy('t.id')),
                eb.fn.countAll<number>().over(),
              ).as('position'),
            ])
            .where('t.workspace_id', '=', workspaceId)
            .where((eb) => eb('t.id', 'in', tasksUnderRoot(q, workspaceId, root, 1)))
            .where((eb) => eb.exists(guardRow(q, context, root)))
            .as('n'),
        )
        .set((eb) => ({
          tray: 'archive',
          story_id: null,
          sprint_id: null,
          column_id: null,
          column_position: null,
          position: eb.ref('n.position'),
          updated_at: deletedAt,
        }))
        .whereRef('tasks.id', '=', 'n.id')
        .where('tasks.workspace_id', '=', workspaceId),
    ),
    db.statement((q) =>
      q
        .updateTable('tasks')
        .set({ deleted_at: deletedAt, updated_at: deletedAt, sprint_id: null, column_id: null, column_position: null })
        .where('tasks.workspace_id', '=', workspaceId)
        .where((eb) => eb('tasks.id', 'in', tasksUnderRoot(q, workspaceId, root, 0)))
        .where((eb) => eb.exists(guardRow(q, context, root))),
    ),
  ];
}

// delete（エピック）: 配下のストーリーの削除の履歴と、論理削除の2文。タスクの文の後ろに置く（タスクの文が配下のストーリーで絞るため）
function deleteStoryStatements(
  db: OrganizationDb,
  context: DeleteContext,
  epicId: string,
): Statement<'organization'>[] {
  const { organizationId, workspaceId, actorUserId, at, deletedAt } = context;
  const root: Root = { kind: 'epic', id: epicId };
  return [
    db.statement((q) =>
      q
        .insertInto('change_logs')
        .columns(changeLogColumns)
        .expression(
          q
            .selectFrom('stories as s')
            .select((eb) => [
              uuidv7Sql(at).as('id'),
              eb.val(organizationId).as('organization_id'),
              eb.val(workspaceId).as('workspace_id'),
              eb.val(actorUserId).as('actor_user_id'),
              eb.val('story').as('entity_type'),
              eb.ref('s.id').as('entity_id'),
              eb.val('delete').as('action'),
              eb.val(JSON.stringify({ deleted_at: [null, deletedAt] })).as('changes_json'),
              eb.val(deletedAt).as('created_at'),
            ])
            .where('s.workspace_id', '=', workspaceId)
            .where('s.epic_id', '=', epicId)
            .where('s.deleted_at', 'is', null)
            .where((eb) => eb.exists(guardRow(q, context, root))),
        ),
    ),
    db.statement((q) =>
      q
        .updateTable('stories')
        .set({ deleted_at: deletedAt, updated_at: deletedAt })
        .where('stories.workspace_id', '=', workspaceId)
        .where('stories.epic_id', '=', epicId)
        .where('stories.deleted_at', 'is', null)
        .where((eb) => eb.exists(guardRow(q, context, root))),
    ),
  ];
}

// keep（エピック）: 配下のストーリーを親なしにする2文。1. 履歴（親と、区分が変わる行は区分）、2. 親を外し、エピックの区分を写し、
// 親のないストーリーの末尾に振る。区分は、エピックの区分（同じワークスペースの削除していないもの）があればそれ、無ければ今の値のまま
function keepStoryStatements(db: OrganizationDb, context: DeleteContext, epicId: string): Statement<'organization'>[] {
  const { organizationId, workspaceId, actorUserId, at, deletedAt } = context;
  const root: Root = { kind: 'epic', id: epicId };
  return [
    db.statement((q) =>
      q
        .insertInto('change_logs')
        .columns(changeLogColumns)
        .expression(
          q
            .selectFrom('stories as s')
            .innerJoin('epics as e', (join) =>
              join.onRef('e.id', '=', 's.epic_id').on('e.workspace_id', '=', workspaceId),
            )
            .leftJoin('categories as ec', (join) =>
              join
                .onRef('ec.id', '=', 'e.category_id')
                .on('ec.workspace_id', '=', workspaceId)
                .on('ec.deleted_at', 'is', null),
            )
            .leftJoin('categories as sc', (join) =>
              join.onRef('sc.id', '=', 's.category_id').on('sc.workspace_id', '=', workspaceId),
            )
            .select((eb) => {
              const parent = eb.fn('json_array', [
                eb.fn('json_object', [eb.val('id'), eb.ref('e.id'), eb.val('title'), eb.ref('e.title')]),
                eb.lit(null),
              ]);
              return [
                uuidv7Sql(at).as('id'),
                eb.val(organizationId).as('organization_id'),
                eb.val(workspaceId).as('workspace_id'),
                eb.val(actorUserId).as('actor_user_id'),
                eb.val('story').as('entity_type'),
                eb.ref('s.id').as('entity_id'),
                eb.val('update').as('action'),
                eb
                  .case()
                  .when(eb.and([eb('ec.id', 'is not', null), eb('ec.id', 'is not', eb.ref('s.category_id'))]))
                  .then(
                    eb.fn<string>('json_object', [
                      eb.val('epic'),
                      parent,
                      eb.val('category'),
                      eb.fn('json_array', [
                        // 前の区分。空なら null（json() で包み、CASE を通しても JSON として入れる）
                        eb.fn('json', [
                          eb
                            .case()
                            .when('s.category_id', 'is', null)
                            .then(eb.lit(null))
                            .else(
                              eb.fn('json_object', [
                                eb.val('id'),
                                eb.ref('s.category_id'),
                                eb.val('name'),
                                eb.fn.coalesce('sc.name', eb.val('')),
                              ]),
                            )
                            .end(),
                        ]),
                        eb.fn('json_object', [eb.val('id'), eb.ref('ec.id'), eb.val('name'), eb.ref('ec.name')]),
                      ]),
                    ]),
                  )
                  .else(eb.fn<string>('json_object', [eb.val('epic'), parent]))
                  .end()
                  .as('changes_json'),
                eb.val(deletedAt).as('created_at'),
              ];
            })
            .where('s.workspace_id', '=', workspaceId)
            .where('s.epic_id', '=', epicId)
            .where('s.deleted_at', 'is', null)
            .where((eb) => eb.exists(guardRow(q, context, root))),
        ),
    ),
    db.statement((q) =>
      q
        .updateTable('stories')
        .from(
          q
            .selectFrom('stories as s')
            .innerJoin('epics as e', (join) =>
              join.onRef('e.id', '=', 's.epic_id').on('e.workspace_id', '=', workspaceId),
            )
            .leftJoin('categories as ec', (join) =>
              join
                .onRef('ec.id', '=', 'e.category_id')
                .on('ec.workspace_id', '=', workspaceId)
                .on('ec.deleted_at', 'is', null),
            )
            .select((eb) => [
              's.id as id',
              eb.fn.coalesce('ec.id', 's.category_id').as('category_id'),
              tailPosition(
                lastStoryPosition(q, workspaceId),
                eb.fn.agg<number>('row_number').over((ob) => ob.orderBy('s.position').orderBy('s.id')),
                eb.fn.countAll<number>().over(),
              ).as('position'),
            ])
            .where('s.workspace_id', '=', workspaceId)
            .where('s.epic_id', '=', epicId)
            .where('s.deleted_at', 'is', null)
            .where((eb) => eb.exists(guardRow(q, context, root)))
            .as('n'),
        )
        .set((eb) => ({
          epic_id: null,
          category_id: eb.ref('n.category_id'),
          position: eb.ref('n.position'),
          updated_at: deletedAt,
        }))
        .whereRef('stories.id', '=', 'n.id')
        .where('stories.workspace_id', '=', workspaceId),
    ),
  ];
}

// keep（ストーリー）: 配下のタスクを親なしにする2文。1. 履歴（親と、区分が変わる行は区分）、2. 親を外し、ストーリーが引き継いでいた
// 区分（親のエピックの区分、ストーリー自身の区分の順に、同じワークスペースの削除していないもの）を写し、親のないタスクの末尾に振る。
// 引き継ぐ区分が無ければ、今の値のまま
function keepTaskStatements(db: OrganizationDb, context: DeleteContext, storyId: string): Statement<'organization'>[] {
  const { organizationId, workspaceId, actorUserId, at, deletedAt } = context;
  const root: Root = { kind: 'story', id: storyId };
  return [
    db.statement((q) =>
      q
        .insertInto('change_logs')
        .columns(changeLogColumns)
        .expression(
          q
            .selectFrom('tasks as t')
            .innerJoin('stories as s', (join) =>
              join.onRef('s.id', '=', 't.story_id').on('s.workspace_id', '=', workspaceId),
            )
            .leftJoin('epics as e', (join) =>
              join.onRef('e.id', '=', 's.epic_id').on('e.workspace_id', '=', workspaceId),
            )
            .leftJoin('categories as ec', (join) =>
              join
                .onRef('ec.id', '=', 'e.category_id')
                .on('ec.workspace_id', '=', workspaceId)
                .on('ec.deleted_at', 'is', null),
            )
            .leftJoin('categories as sc', (join) =>
              join
                .onRef('sc.id', '=', 's.category_id')
                .on('sc.workspace_id', '=', workspaceId)
                .on('sc.deleted_at', 'is', null),
            )
            .leftJoin('categories as tc', (join) =>
              join.onRef('tc.id', '=', 't.category_id').on('tc.workspace_id', '=', workspaceId),
            )
            .select((eb) => {
              const parent = eb.fn('json_array', [
                eb.fn('json_object', [eb.val('id'), eb.ref('s.id'), eb.val('title'), eb.ref('s.title')]),
                eb.lit(null),
              ]);
              const inherited = eb.fn.coalesce('ec.id', 'sc.id');
              return [
                uuidv7Sql(at).as('id'),
                eb.val(organizationId).as('organization_id'),
                eb.val(workspaceId).as('workspace_id'),
                eb.val(actorUserId).as('actor_user_id'),
                eb.val('task').as('entity_type'),
                eb.ref('t.id').as('entity_id'),
                eb.val('update').as('action'),
                eb
                  .case()
                  .when(eb.and([eb(inherited, 'is not', null), eb(inherited, 'is not', eb.ref('t.category_id'))]))
                  .then(
                    eb.fn<string>('json_object', [
                      eb.val('story'),
                      parent,
                      eb.val('category'),
                      eb.fn('json_array', [
                        eb.fn('json', [
                          eb
                            .case()
                            .when('t.category_id', 'is', null)
                            .then(eb.lit(null))
                            .else(
                              eb.fn('json_object', [
                                eb.val('id'),
                                eb.ref('t.category_id'),
                                eb.val('name'),
                                eb.fn.coalesce('tc.name', eb.val('')),
                              ]),
                            )
                            .end(),
                        ]),
                        eb.fn('json_object', [
                          eb.val('id'),
                          inherited,
                          eb.val('name'),
                          eb.case().when('ec.id', 'is not', null).then(eb.ref('ec.name')).else(eb.ref('sc.name')).end(),
                        ]),
                      ]),
                    ]),
                  )
                  .else(eb.fn<string>('json_object', [eb.val('story'), parent]))
                  .end()
                  .as('changes_json'),
                eb.val(deletedAt).as('created_at'),
              ];
            })
            .where('t.workspace_id', '=', workspaceId)
            .where('t.story_id', '=', storyId)
            .where('t.deleted_at', 'is', null)
            .where((eb) => eb.exists(guardRow(q, context, root))),
        ),
    ),
    db.statement((q) =>
      q
        .updateTable('tasks')
        .from(
          q
            .selectFrom('tasks as t')
            .innerJoin('stories as s', (join) =>
              join.onRef('s.id', '=', 't.story_id').on('s.workspace_id', '=', workspaceId),
            )
            .leftJoin('epics as e', (join) =>
              join.onRef('e.id', '=', 's.epic_id').on('e.workspace_id', '=', workspaceId),
            )
            .leftJoin('categories as ec', (join) =>
              join
                .onRef('ec.id', '=', 'e.category_id')
                .on('ec.workspace_id', '=', workspaceId)
                .on('ec.deleted_at', 'is', null),
            )
            .leftJoin('categories as sc', (join) =>
              join
                .onRef('sc.id', '=', 's.category_id')
                .on('sc.workspace_id', '=', workspaceId)
                .on('sc.deleted_at', 'is', null),
            )
            .select((eb) => [
              't.id as id',
              eb.fn.coalesce('ec.id', 'sc.id', 't.category_id').as('category_id'),
              tailPosition(
                lastTaskPosition(q, workspaceId, 'backlog'),
                eb.fn.agg<number>('row_number').over((ob) => ob.orderBy('t.position').orderBy('t.id')),
                eb.fn.countAll<number>().over(),
              ).as('position'),
            ])
            .where('t.workspace_id', '=', workspaceId)
            .where('t.story_id', '=', storyId)
            .where('t.deleted_at', 'is', null)
            .where((eb) => eb.exists(guardRow(q, context, root)))
            .as('n'),
        )
        .set((eb) => ({
          story_id: null,
          category_id: eb.ref('n.category_id'),
          position: eb.ref('n.position'),
          updated_at: deletedAt,
        }))
        .whereRef('tasks.id', '=', 'n.id')
        .where('tasks.workspace_id', '=', workspaceId),
    ),
  ];
}

// 削除の batch() に並べる文。子の文、根の UPDATE、根の履歴の順。根の UPDATE は rootIndex 番目
export function deleteStatements(
  db: OrganizationDb,
  context: DeleteContext,
  root: Root,
  children: DeleteChildrenMode,
): { statements: Statement<'organization'>[]; rootIndex: number } {
  const childStatements =
    children === 'keep'
      ? root.kind === 'epic'
        ? keepStoryStatements(db, context, root.id)
        : keepTaskStatements(db, context, root.id)
      : [
          ...deleteTaskStatements(db, context, root),
          ...(root.kind === 'epic' ? deleteStoryStatements(db, context, root.id) : []),
        ];
  return { statements: [...childStatements, ...rootStatements(db, context, root)], rootIndex: childStatements.length };
}

// 削除する根の作った人。削除していない、同じワークスペースのもの
async function readRoot(db: OrganizationDb, workspaceId: string, root: Root) {
  return root.kind === 'epic'
    ? db.first(
        db.statement((q) =>
          q
            .selectFrom('epics')
            .select(['epics.id', 'epics.created_by'])
            .where('epics.id', '=', root.id)
            .where('epics.workspace_id', '=', workspaceId)
            .where('epics.deleted_at', 'is', null),
        ),
      )
    : db.first(
        db.statement((q) =>
          q
            .selectFrom('stories')
            .select(['stories.id', 'stories.created_by'])
            .where('stories.id', '=', root.id)
            .where('stories.workspace_id', '=', workspaceId)
            .where('stories.deleted_at', 'is', null),
        ),
      );
}

// 他の人の作った、削除していない配下があるか
async function hasOthersUnder(db: OrganizationDb, workspaceId: string, root: Root, userId: string): Promise<boolean> {
  const row = await db.first(db.statement((q) => othersUnderRoot(q, workspaceId, root, userId)));
  return row !== undefined;
}

function othersForbidden(): ApiError {
  return new ApiError(403, 'forbidden', { reason: DELETE_OTHERS_CHILDREN_REASON });
}

// 削除の流れ。無ければ権限より先に 404、作った人でもリーダーでもなければ 403。リーダーと管理者でない人の delete で、
// 他の人の作った配下があれば 403（details.reason は others_children）。書く文を1回の batch() で送り、根の UPDATE が
// 行を変えなければ読み直して、閉じていれば 409、根が無ければ 404（別の要求が先に削除した）、他の人の作った配下が移されてきていれば 403
async function deleteRoot(
  { db, actor, workspace }: { db: OrganizationDb; actor: Actor; workspace: Workspace },
  root: Root,
  children: DeleteChildrenMode,
): Promise<void> {
  const actorUserId = actorUserIdOf(actor);
  const workspaceId = workspace.workspaceId;
  const found = await readRoot(db, workspaceId, root);
  if (found === undefined) {
    await throwIfClosed(db, workspaceId);
    throw new ApiError(404, 'not_found');
  }
  if (!mayDeleteOwned(found.created_by, actor, workspace)) throw new ApiError(403, 'forbidden');
  const ownerOnly = children === 'delete' && !isLeaderOrAdmin(actor, workspace) ? actorUserId : null;
  if (ownerOnly !== null && (await hasOthersUnder(db, workspaceId, root, ownerOnly))) {
    await throwIfClosed(db, workspaceId);
    throw othersForbidden();
  }

  const at = now();
  const context: DeleteContext = {
    organizationId: db.organizationId,
    workspaceId,
    actorUserId,
    at,
    deletedAt: at.toISOString(),
    ownerOnly,
  };
  const { statements, rootIndex } = deleteStatements(db, context, root, children);
  const results = await db.batch(statements);
  if ((results[rootIndex]?.changes ?? 0) > 0) return;
  await throwIfClosed(db, workspaceId);
  if ((await readRoot(db, workspaceId, root)) === undefined) throw new ApiError(404, 'not_found');
  if (ownerOnly !== null && (await hasOthersUnder(db, workspaceId, root, ownerOnly))) throw othersForbidden();
  // 前提はどれも満たしていたのに書けなかった（同じトランザクションの中では起きない）
  throw new ApiError(409, 'conflict');
}

export const epicDeleteOperation = implement(epicDelete, async ({ db, actor, workspace, input }) => {
  await deleteRoot({ db, actor, workspace }, { kind: 'epic', id: input.epic_id }, input.children);
  return { epic_id: input.epic_id };
});

export const storyDeleteOperation = implement(storyDelete, async ({ db, actor, workspace, input }) => {
  await deleteRoot({ db, actor, workspace }, { kind: 'story', id: input.story_id }, input.children);
  return { story_id: input.story_id };
});

// 削除できるか（作った人かリーダー）と、まとめて削除できるか（削除できて、リーダーか管理者か、他の人の作った配下が無い）
async function deletionFlags(
  db: OrganizationDb,
  actor: Actor,
  workspace: Workspace,
  root: Root,
  createdBy: string,
): Promise<{ can_delete: boolean; can_delete_children: boolean }> {
  const canDelete = mayDeleteOwned(createdBy, actor, workspace);
  if (!canDelete || actor.userId === null) return { can_delete: canDelete, can_delete_children: false };
  if (isLeaderOrAdmin(actor, workspace)) return { can_delete: true, can_delete_children: true };
  return {
    can_delete: true,
    can_delete_children: !(await hasOthersUnder(db, workspace.workspaceId, root, actor.userId)),
  };
}

// epic-get が返す、削除の可否と配下の件数。件数は削除していないストーリーと、その下の削除していないタスク（完了したものも含む）
export async function epicDeletion(
  db: OrganizationDb,
  actor: Actor,
  workspace: Workspace,
  epic: { id: string; created_by: string },
) {
  const workspaceId = workspace.workspaceId;
  const [stories, tasks] = await db.batch([
    db.statement((q) =>
      q
        .selectFrom('stories')
        .select((eb) => eb.fn.countAll<number>().as('count'))
        .where('stories.workspace_id', '=', workspaceId)
        .where('stories.epic_id', '=', epic.id)
        .where('stories.deleted_at', 'is', null),
    ),
    db.statement((q) => epicTasks(q, workspaceId, epic.id).select((eb) => eb.fn.countAll<number>().as('count'))),
  ] as const);
  return {
    ...(await deletionFlags(db, actor, workspace, { kind: 'epic', id: epic.id }, epic.created_by)),
    children: { stories: stories.rows[0]?.count ?? 0, tasks: tasks.rows[0]?.count ?? 0 },
  };
}

// story-get が返す、削除の可否と配下の件数。件数は削除していないタスク（完了したものも含む）
export async function storyDeletion(
  db: OrganizationDb,
  actor: Actor,
  workspace: Workspace,
  story: { id: string; created_by: string },
) {
  const row = await db.first(
    db.statement((q) =>
      q
        .selectFrom('tasks')
        .select((eb) => eb.fn.countAll<number>().as('count'))
        .where('tasks.workspace_id', '=', workspace.workspaceId)
        .where('tasks.story_id', '=', story.id)
        .where('tasks.deleted_at', 'is', null),
    ),
  );
  return {
    ...(await deletionFlags(db, actor, workspace, { kind: 'story', id: story.id }, story.created_by)),
    children: { tasks: row?.count ?? 0 },
  };
}
