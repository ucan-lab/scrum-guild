// エピックとストーリーの削除（epic-delete、story-delete）と、ダイアログが出す削除の可否と配下の件数の読み取り。
// 削除は論理削除で、配下の扱いを選ぶ（docs/requirements.md の「削除」、docs/data-model.md の「書き込みの単位」の「エピックとストーリーの削除」）。
//   keep: 直接の子を親なしにする。子は移す先（親のないストーリー、親のないタスク）の末尾に、元の並び（position、id の順）のまま置き、
//         親から引き継いでいた区分を写す（削除の前後で集計の区分を変えない）
//   delete: 木の下をまとめて削除する。手で作ったタスクは論理削除、取り込んだタスクは削除せずアーカイブの末尾へ移す
// 書く文は子の数によらず決まった数で、1回の batch() に並べる。どの文も「消す根が削除されていない、閉じていないワークスペース」を
// 条件に持ち、根を削除する UPDATE は子の文の後ろに置く（根を先に消すと、後ろの文の条件が自分の削除と先の要求の削除を見分けられない）。
// 1つのトランザクションの中で条件は変わらないので、子の文が書いたなら根の UPDATE も通る。根の履歴は直前の UPDATE に結ぶ
import { now } from '../../shared/clock.ts';
import type { DeleteChildrenMode } from '../../shared/operations/delete-children.ts';
import { epicDelete } from '../../shared/operations/epic/index.ts';
import { storyDelete } from '../../shared/operations/story/index.ts';
import {
  previousStatementChanged,
  uuidv7Sql,
  type OrganizationDb,
  type OrganizationTables,
  type QueryCreator,
  type Statement,
} from '../db/index.ts';
import { ApiError } from '../errors.ts';
import { uuidv7 } from '../uuid.ts';
import { implement } from './implement.ts';
import { actorUserIdOf, changeLogColumns, mayDeleteOwned, openWorkspace, throwIfClosed } from './write-guards.ts';

type Tables = OrganizationTables;
type From = Pick<QueryCreator<Tables>, 'selectFrom'>;

// 消す根。エピックかストーリー
type Root = { kind: 'epic' | 'story'; id: string };

// 1回の削除で使う値。どの文も同じ時刻と同じ人で書く
type Context = {
  organizationId: string;
  workspaceId: string;
  actorUserId: string;
  at: Date;
  deletedAt: string;
};

// 位置を空の並びに振るときの基準。fractional-indexing の generateKeyBetween(null, null) と同じ値
const EMPTY_BASE = 'a0';
// 末尾に振る位置の最後の1字。fractional-indexing の鍵は小数の部分が '0' で終わってはいけないので、0 でない字で閉じる
const KEY_TERMINATOR = 'V';

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

// 配下のタスク（delete で消すかアーカイブへ移す）の ID。根がストーリーならその下、エピックなら配下の削除していないストーリーの下の、
// 削除していないタスク。完了したものも含む。imported で手で作ったものか取り込んだものに絞る
function tasksUnderRoot(from: From, workspaceId: string, root: Root, imported: 0 | 1) {
  return from
    .selectFrom('tasks as ut')
    .innerJoin('stories as us', (join) =>
      join.onRef('us.id', '=', 'ut.story_id').on('us.workspace_id', '=', workspaceId).on('us.deleted_at', 'is', null),
    )
    .select('ut.id')
    .where(root.kind === 'story' ? 'us.id' : 'us.epic_id', '=', root.id)
    .where('ut.workspace_id', '=', workspaceId)
    .where('ut.deleted_at', 'is', null)
    .where('ut.is_imported', '=', imported);
}

// 根を削除する UPDATE と、直前の UPDATE に結んだ根の履歴（action = 'delete'）。条件は、根が削除されていない、閉じていないワークスペース
function rootStatements(db: OrganizationDb, context: Context, root: Root): Statement<'organization'>[] {
  const { organizationId, workspaceId, actorUserId, at, deletedAt } = context;
  return [
    // 型は epics の表で書く。使う列（id、workspace_id、deleted_at、updated_at）は stories にも同じ名前と型である
    db.statement((q) =>
      q
        .updateTable(root.kind === 'epic' ? 'epics' : ('stories' as 'epics'))
        .set({ deleted_at: deletedAt, updated_at: deletedAt })
        .where((eb) =>
          eb.and([
            eb('id', '=', root.id),
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

// delete: 配下のタスクを片付ける4文。履歴を先に置く（片付けた後は、配下の条件に当たらなくなるため）。
// 1. 手で作ったタスクの削除の履歴、2. 取り込んだタスクのアーカイブの履歴（親と置き場所）、
// 3. 取り込んだタスクをアーカイブの末尾へ移す（親、スプリント、列を空にする）、4. 手で作ったタスクを論理削除する
function deleteTaskStatements(db: OrganizationDb, context: Context, root: Root): Statement<'organization'>[] {
  const { organizationId, workspaceId, actorUserId, at, deletedAt } = context;
  return [
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
            .where((eb) => eb.exists(liveRoot(q, workspaceId, root)))
            .where((eb) => eb.exists(openWorkspace(q, organizationId, workspaceId))),
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
            .where((eb) => eb.exists(liveRoot(q, workspaceId, root)))
            .where((eb) => eb.exists(openWorkspace(q, organizationId, workspaceId))),
        ),
    ),
    // アーカイブの末尾に、元の並び（親のストーリーの並び、その中のタスクの並び）のまま振る。振り方は tailKey の説明のとおり
    db.statement((q) =>
      q
        .updateTable('tasks')
        .from(
          q
            .selectFrom('tasks as t')
            .innerJoin('stories as s', (join) =>
              join.onRef('s.id', '=', 't.story_id').on('s.workspace_id', '=', workspaceId),
            )
            .innerJoin(
              q
                .selectFrom('tasks as a')
                .select((eb) => eb.fn.coalesce(eb.fn.max('a.position'), eb.val(EMPTY_BASE)).as('k'))
                .where('a.workspace_id', '=', workspaceId)
                .where('a.tray', '=', 'archive')
                .where('a.deleted_at', 'is', null)
                .as('base'),
              (join) => join.onTrue(),
            )
            .select((eb) => [
              't.id as id',
              eb(
                eb(
                  eb.ref('base.k'),
                  '||',
                  eb.fn<string>('printf', [
                    eb.val('%0*d'),
                    eb.fn('length', [eb.fn.countAll().over()]),
                    eb.fn
                      .agg<number>('row_number')
                      .over((ob) => ob.orderBy('s.position').orderBy('s.id').orderBy('t.position').orderBy('t.id')),
                  ]),
                ),
                '||',
                eb.val(KEY_TERMINATOR),
              ).as('position'),
            ])
            .where('t.workspace_id', '=', workspaceId)
            .where((eb) => eb('t.id', 'in', tasksUnderRoot(q, workspaceId, root, 1)))
            .where((eb) => eb.exists(liveRoot(q, workspaceId, root)))
            .where((eb) => eb.exists(openWorkspace(q, organizationId, workspaceId)))
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
        .whereRef('tasks.id', '=', 'n.id'),
    ),
    db.statement((q) =>
      q
        .updateTable('tasks')
        .set({ deleted_at: deletedAt, updated_at: deletedAt })
        .where('tasks.workspace_id', '=', workspaceId)
        .where((eb) => eb('tasks.id', 'in', tasksUnderRoot(q, workspaceId, root, 0)))
        .where((eb) => eb.exists(liveRoot(q, workspaceId, root)))
        .where((eb) => eb.exists(openWorkspace(q, organizationId, workspaceId))),
    ),
  ];
}

// delete（エピック）: 配下のストーリーの削除の履歴と、論理削除の2文。タスクの文の後ろに置く（タスクの文が配下のストーリーで絞るため）
function deleteStoryStatements(db: OrganizationDb, context: Context, epicId: string): Statement<'organization'>[] {
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
            .where((eb) => eb.exists(liveRoot(q, workspaceId, root)))
            .where((eb) => eb.exists(openWorkspace(q, organizationId, workspaceId))),
        ),
    ),
    db.statement((q) =>
      q
        .updateTable('stories')
        .set({ deleted_at: deletedAt, updated_at: deletedAt })
        .where('stories.workspace_id', '=', workspaceId)
        .where('stories.epic_id', '=', epicId)
        .where('stories.deleted_at', 'is', null)
        .where((eb) => eb.exists(liveRoot(q, workspaceId, root)))
        .where((eb) => eb.exists(openWorkspace(q, organizationId, workspaceId))),
    ),
  ];
}

// keep（エピック）: 配下のストーリーを親なしにする2文。1. 履歴（親と、区分が変わる行は区分）、2. 親を外し、エピックの区分を写し、
// 親のないストーリーの末尾に振る。区分は、エピックの区分（同じワークスペースの削除していないもの）があればそれ、無ければ今の値のまま
function keepStoryStatements(db: OrganizationDb, context: Context, epicId: string): Statement<'organization'>[] {
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
            .where((eb) => eb.exists(liveRoot(q, workspaceId, root)))
            .where((eb) => eb.exists(openWorkspace(q, organizationId, workspaceId))),
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
            .innerJoin(
              q
                .selectFrom('stories as a')
                .select((eb) => eb.fn.coalesce(eb.fn.max('a.position'), eb.val(EMPTY_BASE)).as('k'))
                .where('a.workspace_id', '=', workspaceId)
                .where('a.epic_id', 'is', null)
                .where('a.deleted_at', 'is', null)
                .as('base'),
              (join) => join.onTrue(),
            )
            .select((eb) => [
              's.id as id',
              eb.fn.coalesce('ec.id', 's.category_id').as('category_id'),
              eb(
                eb(
                  eb.ref('base.k'),
                  '||',
                  eb.fn<string>('printf', [
                    eb.val('%0*d'),
                    eb.fn('length', [eb.fn.countAll().over()]),
                    eb.fn.agg<number>('row_number').over((ob) => ob.orderBy('s.position').orderBy('s.id')),
                  ]),
                ),
                '||',
                eb.val(KEY_TERMINATOR),
              ).as('position'),
            ])
            .where('s.workspace_id', '=', workspaceId)
            .where('s.epic_id', '=', epicId)
            .where('s.deleted_at', 'is', null)
            .where((eb) => eb.exists(liveRoot(q, workspaceId, root)))
            .where((eb) => eb.exists(openWorkspace(q, organizationId, workspaceId)))
            .as('n'),
        )
        .set((eb) => ({
          epic_id: null,
          category_id: eb.ref('n.category_id'),
          position: eb.ref('n.position'),
          updated_at: deletedAt,
        }))
        .whereRef('stories.id', '=', 'n.id'),
    ),
  ];
}

// keep（ストーリー）: 配下のタスクを親なしにする2文。1. 履歴（親と、区分が変わる行は区分）、2. 親を外し、ストーリーが引き継いでいた
// 区分（親のエピックの区分、ストーリー自身の区分の順に、同じワークスペースの削除していないもの）を写し、親のないタスクの末尾に振る。
// 引き継ぐ区分が無ければ、今の値のまま
function keepTaskStatements(db: OrganizationDb, context: Context, storyId: string): Statement<'organization'>[] {
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
            .where((eb) => eb.exists(liveRoot(q, workspaceId, root)))
            .where((eb) => eb.exists(openWorkspace(q, organizationId, workspaceId))),
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
            .innerJoin(
              q
                .selectFrom('tasks as a')
                .select((eb) => eb.fn.coalesce(eb.fn.max('a.position'), eb.val(EMPTY_BASE)).as('k'))
                .where('a.workspace_id', '=', workspaceId)
                .where('a.tray', '=', 'backlog')
                .where('a.story_id', 'is', null)
                .where('a.deleted_at', 'is', null)
                .as('base'),
              (join) => join.onTrue(),
            )
            .select((eb) => [
              't.id as id',
              eb.fn.coalesce('ec.id', 'sc.id', 't.category_id').as('category_id'),
              eb(
                eb(
                  eb.ref('base.k'),
                  '||',
                  eb.fn<string>('printf', [
                    eb.val('%0*d'),
                    eb.fn('length', [eb.fn.countAll().over()]),
                    eb.fn.agg<number>('row_number').over((ob) => ob.orderBy('t.position').orderBy('t.id')),
                  ]),
                ),
                '||',
                eb.val(KEY_TERMINATOR),
              ).as('position'),
            ])
            .where('t.workspace_id', '=', workspaceId)
            .where('t.story_id', '=', storyId)
            .where('t.deleted_at', 'is', null)
            .where((eb) => eb.exists(liveRoot(q, workspaceId, root)))
            .where((eb) => eb.exists(openWorkspace(q, organizationId, workspaceId)))
            .as('n'),
        )
        .set((eb) => ({
          story_id: null,
          category_id: eb.ref('n.category_id'),
          position: eb.ref('n.position'),
          updated_at: deletedAt,
        }))
        .whereRef('tasks.id', '=', 'n.id'),
    ),
  ];
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

type DeleteArgs = {
  db: OrganizationDb;
  actor: { userId: string | null; isAdmin: boolean };
  workspace: { workspaceId: string; actorRole: 'leader' | 'member' | null };
};

// 削除の流れ。無ければ権限より先に 404、作った人でもリーダーでもなければ 403。書く文を1回の batch() で送り、根の UPDATE が
// 行を変えなければ（読んでから書くまでに閉じたか、別の要求が先に削除した）、閉じていれば 409、そうでなければ 404
async function deleteRoot(
  { db, actor, workspace }: DeleteArgs,
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

  const at = now();
  const context: Context = {
    organizationId: db.organizationId,
    workspaceId,
    actorUserId,
    at,
    deletedAt: at.toISOString(),
  };
  const childStatements =
    children === 'keep'
      ? root.kind === 'epic'
        ? keepStoryStatements(db, context, root.id)
        : keepTaskStatements(db, context, root.id)
      : [
          ...deleteTaskStatements(db, context, root),
          ...(root.kind === 'epic' ? deleteStoryStatements(db, context, root.id) : []),
        ];
  const results = await db.batch([...childStatements, ...rootStatements(db, context, root)]);
  if ((results[childStatements.length]?.changes ?? 0) > 0) return;
  await throwIfClosed(db, workspaceId);
  throw new ApiError(404, 'not_found');
}

export const epicDeleteOperation = implement(epicDelete, async ({ db, actor, workspace, input }) => {
  await deleteRoot({ db, actor, workspace }, { kind: 'epic', id: input.epic_id }, input.children);
  return { epic_id: input.epic_id };
});

export const storyDeleteOperation = implement(storyDelete, async ({ db, actor, workspace, input }) => {
  await deleteRoot({ db, actor, workspace }, { kind: 'story', id: input.story_id }, input.children);
  return { story_id: input.story_id };
});

// エピックの配下の件数。削除していないストーリーと、その下の削除していないタスク（完了したものも含む）
export async function epicChildCounts(db: OrganizationDb, workspaceId: string, epicId: string) {
  const [stories, tasks] = await db.batch([
    db.statement((q) =>
      q
        .selectFrom('stories')
        .select((eb) => eb.fn.countAll<number>().as('count'))
        .where('stories.workspace_id', '=', workspaceId)
        .where('stories.epic_id', '=', epicId)
        .where('stories.deleted_at', 'is', null),
    ),
    db.statement((q) =>
      q
        .selectFrom('tasks')
        .select((eb) => eb.fn.countAll<number>().as('count'))
        .where('tasks.workspace_id', '=', workspaceId)
        .where('tasks.deleted_at', 'is', null)
        .where((eb) =>
          eb(
            'tasks.story_id',
            'in',
            eb
              .selectFrom('stories as s')
              .select('s.id')
              .where('s.workspace_id', '=', workspaceId)
              .where('s.epic_id', '=', epicId)
              .where('s.deleted_at', 'is', null),
          ),
        ),
    ),
  ] as const);
  return { stories: stories.rows[0]?.count ?? 0, tasks: tasks.rows[0]?.count ?? 0 };
}

// ストーリーの配下の件数。削除していないタスク（完了したものも含む）
export async function storyChildCounts(db: OrganizationDb, workspaceId: string, storyId: string) {
  const row = await db.first(
    db.statement((q) =>
      q
        .selectFrom('tasks')
        .select((eb) => eb.fn.countAll<number>().as('count'))
        .where('tasks.workspace_id', '=', workspaceId)
        .where('tasks.story_id', '=', storyId)
        .where('tasks.deleted_at', 'is', null),
    ),
  );
  return { tasks: row?.count ?? 0 };
}
