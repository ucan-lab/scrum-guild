import { generateKeyBetween } from 'fractional-indexing';
import { now } from '../../shared/clock.ts';
import { EPIC_DEFAULT_REWARD_TIER } from '../../shared/epic.ts';
import { epicCreate, epicGet, epicUpdate, type EpicDetail } from '../../shared/operations/epic/index.ts';
import { previousStatementChanged, type OrganizationDb } from '../db/index.ts';
import { ApiError } from '../errors.ts';
import { uuidv7 } from '../uuid.ts';
import { categoryRow, readCategoryRef, refOf } from './definition-refs.ts';
import { implement } from './implement.ts';
import { epicDeletion } from './tree-delete.ts';
import { actorUserIdOf, changeLogColumns, openWorkspace, throwIfClosed } from './write-guards.ts';

// エピックのダイアログの欄。作るときの履歴に使う
const EDITABLE_FIELDS = ['title', 'body_md', 'due_on', 'link_url'] as const;

// 同時の更新に負けたときにやり直す回数の上限。超えたら 409 の conflict（story-update と同じ）
const MAX_UPDATE_ATTEMPTS = 3;

type EpicRow = EpicDetail & { category_name: string | null; created_by: string };

// 削除していないエピックの、ダイアログが出す欄と、区分の名前（履歴に残す）。ワークスペースで必ず絞る
async function readEpic(db: OrganizationDb, workspaceId: string, epicId: string): Promise<EpicRow | undefined> {
  return db.first(
    db.statement((q) =>
      q
        .selectFrom('epics')
        .leftJoin('categories', (join) =>
          join
            .onRef('categories.id', '=', 'epics.category_id')
            .onRef('categories.workspace_id', '=', 'epics.workspace_id'),
        )
        .select([
          'epics.id',
          'epics.title',
          'epics.body_md',
          'epics.due_on',
          'epics.link_url',
          'epics.category_id',
          'epics.created_by',
          'categories.name as category_name',
        ])
        .where('epics.id', '=', epicId)
        .where('epics.workspace_id', '=', workspaceId)
        .where('epics.deleted_at', 'is', null),
    ),
  );
}

function detailOf(row: EpicRow): EpicDetail {
  return {
    id: row.id,
    title: row.title,
    body_md: row.body_md,
    due_on: row.due_on,
    link_url: row.link_url,
    category_id: row.category_id,
  };
}

// 削除のボタンと確認のために、呼んだ人が削除できるか（作った人かリーダー。管理者を含む）、まとめて削除できるかと、配下の件数も返す
export const epicGetOperation = implement(epicGet, async ({ db, actor, workspace, input }) => {
  const epic = await readEpic(db, workspace.workspaceId, input.epic_id);
  if (epic === undefined) throw new ApiError(404, 'not_found');
  return { epic: detailOf(epic), ...(await epicDeletion(db, actor, workspace, epic)) };
});

export const epicCreateOperation = implement(epicCreate, async ({ db, actor, workspace, input }) => {
  const actorUserId = actorUserIdOf(actor);
  const organizationId = db.organizationId;
  const workspaceId = workspace.workspaceId;

  // 区分は、同じワークスペースの削除していない区分だけ。読んで名前を履歴に残し、書く文にも同じ条件を入れる
  const category = input.category_id === null ? null : await readCategoryRef(db, workspaceId, input.category_id);

  // 位置はエピックの末尾。完了と中止したエピックも並びに残っているので、それも含めた末尾に置く
  const last = await db.first(
    db.statement((q) =>
      q
        .selectFrom('epics')
        .select('epics.position')
        .where('epics.workspace_id', '=', workspaceId)
        .where('epics.deleted_at', 'is', null)
        .orderBy('epics.position', 'desc')
        .limit(1),
    ),
  );
  const at = now();
  const createdAt = at.toISOString();
  const epicId = uuidv7(at);
  const position = generateKeyBetween(last?.position ?? null, null);

  const created: Record<string, [null, unknown]> = { title: [null, input.title] };
  for (const field of EDITABLE_FIELDS) {
    if (field !== 'title' && input[field] !== null) created[field] = [null, input[field]];
  }
  if (category !== null) created.category = [null, category];

  const results = await db.batch([
    db.statement((q) =>
      q
        .insertInto('epics')
        .columns([
          'id',
          'workspace_id',
          'title',
          'body_md',
          'due_on',
          'link_url',
          'category_id',
          'reward_tier',
          'requester_user_id',
          'created_by',
          'position',
          'created_at',
          'updated_at',
        ])
        .expression(
          q
            .selectNoFrom((eb) => [
              eb.val(epicId).as('id'),
              eb.val(workspaceId).as('workspace_id'),
              eb.val(input.title).as('title'),
              eb.val(input.body_md).as('body_md'),
              eb.val(input.due_on).as('due_on'),
              eb.val(input.link_url).as('link_url'),
              eb.val(category?.id ?? null).as('category_id'),
              eb.val(EPIC_DEFAULT_REWARD_TIER).as('reward_tier'),
              // 依頼主は作った人。変える操作は #65 で足す
              eb.val(actorUserId).as('requester_user_id'),
              eb.val(actorUserId).as('created_by'),
              eb.val(position).as('position'),
              eb.val(createdAt).as('created_at'),
              eb.val(createdAt).as('updated_at'),
            ])
            .where((eb) => eb.exists(openWorkspace(eb, organizationId, workspaceId)))
            .$if(category !== null, (qb) =>
              qb.where((eb) => eb.exists(categoryRow(eb, workspaceId, category!.id).select('categories.id'))),
            ),
        ),
    ),
    // 作った行があるときだけ履歴を書く
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
              eb.val('epic').as('entity_type'),
              eb.val(epicId).as('entity_id'),
              eb.val('create').as('action'),
              eb.val(JSON.stringify(created)).as('changes_json'),
              eb.val(createdAt).as('created_at'),
            ])
            .where((eb) =>
              eb.exists(
                eb
                  .selectFrom('epics')
                  .select('epics.id')
                  .where('epics.id', '=', epicId)
                  .where('epics.workspace_id', '=', workspaceId),
              ),
            ),
        ),
    ),
  ]);

  // 読んでから書くまでに、ワークスペースが閉じたか、区分が削除されたら何も入らない
  if ((results[0]?.changes ?? 0) === 0) {
    await throwIfClosed(db, workspaceId);
    throw new ApiError(404, 'not_found');
  }
  return {
    epic: {
      id: epicId,
      title: input.title,
      body_md: input.body_md,
      due_on: input.due_on,
      link_url: input.link_url,
      category_id: category?.id ?? null,
    },
  };
});

// 書く欄。タイトルは空にできないので、欄ごとに型を分ける
type UpdatedFields = {
  title?: string;
  body_md?: string | null;
  due_on?: string | null;
  link_url?: string | null;
  category_id?: string | null;
};

// 読んだ値と、送られた値の差。送られた欄のうち、読んだ値と違うものだけを書く。区分の履歴は {id, name} で残す
// （next は送られた区分の名前。区分を外すときと送られないときは null）
function diffOf(current: EpicRow, input: UpdatedFields, nextCategory: { id: string; name: string } | null) {
  const values: UpdatedFields = {};
  const changes: Record<string, [unknown, unknown]> = {};
  if (input.title !== undefined && input.title !== current.title) {
    values.title = input.title;
    changes.title = [current.title, input.title];
  }
  for (const field of ['body_md', 'due_on', 'link_url'] as const) {
    const next = input[field];
    if (next === undefined || next === current[field]) continue;
    values[field] = next;
    changes[field] = [current[field], next];
  }
  if (input.category_id !== undefined && input.category_id !== current.category_id) {
    values.category_id = input.category_id;
    changes.category = [refOf(current.category_id, current.category_name), nextCategory];
  }
  return { values, changes, isEmpty: Object.keys(changes).length === 0 };
}

// 書き方は story-update と同じ（src/server/operations/story.ts）。読んだ値からの差を、読んだ値のままなら、という条件つきで書き、
// 通らなかったら読み直して差を作り直す。履歴だけは、直前の UPDATE に結ぶ（previousStatementChanged）
export const epicUpdateOperation = implement(epicUpdate, async ({ db, actor, workspace, input }) => {
  const actorUserId = actorUserIdOf(actor);
  const organizationId = db.organizationId;
  const workspaceId = workspace.workspaceId;
  const epicId = input.epic_id;

  for (let attempt = 0; attempt < MAX_UPDATE_ATTEMPTS; attempt++) {
    const current = await readEpic(db, workspaceId, epicId);
    if (current === undefined) {
      await throwIfClosed(db, workspaceId);
      throw new ApiError(404, 'not_found');
    }
    // 振る区分は、同じワークスペースの削除していない区分だけ（無ければ 404）。書く文にも同じ条件を入れる
    const nextCategory =
      input.category_id == null || input.category_id === current.category_id
        ? null
        : await readCategoryRef(db, workspaceId, input.category_id);
    const { values, changes, isEmpty } = diffOf(current, input, nextCategory);
    if (isEmpty) {
      // 書くものが無くても、閉じたワークスペースは断る
      await throwIfClosed(db, workspaceId);
      return { epic: detailOf(current) };
    }

    const at = now();
    const updatedAt = at.toISOString();
    const results = await db.batch([
      db.statement((q) =>
        q
          .updateTable('epics')
          .set({ ...values, updated_at: updatedAt })
          .where((eb) =>
            eb.and([
              eb('id', '=', epicId),
              eb('workspace_id', '=', workspaceId),
              eb('deleted_at', 'is', null),
              eb.exists(openWorkspace(q, organizationId, workspaceId)),
              // 書く欄が、読んだときの値のまま
              ...(values.title === undefined ? [] : [eb('title', 'is', current.title)]),
              ...(values.body_md === undefined ? [] : [eb('body_md', 'is', current.body_md)]),
              ...(values.due_on === undefined ? [] : [eb('due_on', 'is', current.due_on)]),
              ...(values.link_url === undefined ? [] : [eb('link_url', 'is', current.link_url)]),
              ...(values.category_id === undefined ? [] : [eb('category_id', 'is', current.category_id)]),
              ...(nextCategory === null
                ? []
                : [eb.exists(categoryRow(q, workspaceId, nextCategory.id).select('categories.id'))]),
            ]),
          ),
      ),
      // 直前の UPDATE が行を変えたときだけ履歴を書く（docs/data-model.md の「直前の文に結ぶ」。止めた時計や同じ値を書く要求で、
      // 負けた要求が履歴を二重に書かないため）
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
                eb.val('epic').as('entity_type'),
                eb.val(epicId).as('entity_id'),
                eb.val('update').as('action'),
                eb.val(JSON.stringify(changes)).as('changes_json'),
                eb.val(updatedAt).as('created_at'),
              ])
              .where(previousStatementChanged),
          ),
      ),
    ]);

    if ((results[0]?.changes ?? 0) > 0) {
      const updated = await readEpic(db, workspaceId, epicId);
      if (updated === undefined) throw new ApiError(404, 'not_found');
      return { epic: detailOf(updated) };
    }
    // 閉じていれば 409 の workspace_closed。無ければ 404。区分が削除されていれば、次の周の読み取りが 404 にする。
    // どれでもなければ、別の要求が先に同じ欄を変えたので、読み直してやり直す
    await throwIfClosed(db, workspaceId);
    if ((await readEpic(db, workspaceId, epicId)) === undefined) throw new ApiError(404, 'not_found');
  }
  throw new ApiError(409, 'conflict');
});
