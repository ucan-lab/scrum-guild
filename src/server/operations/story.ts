import { generateKeyBetween } from 'fractional-indexing';
import { now } from '../../shared/clock.ts';
import { XP_STORY_COMPLETED } from '../../shared/experience.ts';
import {
  storyComplete,
  storyCreate,
  storyGet,
  storyMove,
  storyReopen,
  storyUpdate,
  type StoryDetail,
} from '../../shared/operations/story/index.ts';
import type { StoryCompletionConflictReason } from '../../shared/operations/story/story-complete.ts';
import {
  jsonList,
  previousStatementChanged,
  type OrganizationDb,
  type OrganizationTables,
  type QueryCreator,
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

// ストーリーのダイアログの欄。作るときの履歴に使う
const EDITABLE_FIELDS = ['title', 'acceptance_criteria_md', 'body_md', 'due_on', 'link_url'] as const;

// 同時の更新に負けたときにやり直す回数の上限。超えたら 409 の conflict
const MAX_UPDATE_ATTEMPTS = 3;

// 削除していないストーリーの、ダイアログが出す欄。ワークスペースで必ず絞る
async function readStory(db: OrganizationDb, workspaceId: string, storyId: string): Promise<StoryDetail | undefined> {
  return db.first(
    db.statement((q) =>
      q
        .selectFrom('stories')
        .select([
          'stories.id',
          'stories.title',
          'stories.acceptance_criteria_md',
          'stories.body_md',
          'stories.due_on',
          'stories.link_url',
        ])
        .where('stories.id', '=', storyId)
        .where('stories.workspace_id', '=', workspaceId)
        .where('stories.deleted_at', 'is', null),
    ),
  );
}

export const storyGetOperation = implement(storyGet, async ({ db, workspace, input }) => {
  const story = await readStory(db, workspace.workspaceId, input.story_id);
  if (story === undefined) throw new ApiError(404, 'not_found');
  return { story };
});

export const storyCreateOperation = implement(storyCreate, async ({ db, actor, workspace, input }) => {
  const actorUserId = actorUserIdOf(actor);
  const organizationId = db.organizationId;
  const workspaceId = workspace.workspaceId;

  // 位置は親のないストーリーの末尾。完了したストーリーも並びに残っているので、それも含めた末尾に置く
  const last = await db.first(
    db.statement((q) =>
      q
        .selectFrom('stories')
        .select('stories.position')
        .where('stories.workspace_id', '=', workspaceId)
        .where('stories.epic_id', 'is', null)
        .where('stories.deleted_at', 'is', null)
        .orderBy('stories.position', 'desc')
        .limit(1),
    ),
  );
  const at = now();
  const createdAt = at.toISOString();
  const storyId = uuidv7(at);
  const position = generateKeyBetween(last?.position ?? null, null);

  const created: Record<string, [null, unknown]> = { title: [null, input.title] };
  for (const field of EDITABLE_FIELDS) {
    if (field !== 'title' && input[field] !== null) created[field] = [null, input[field]];
  }

  const results = await db.batch([
    db.statement((q) =>
      q
        .insertInto('stories')
        .columns([
          'id',
          'workspace_id',
          'epic_id',
          'title',
          'acceptance_criteria_md',
          'body_md',
          'due_on',
          'link_url',
          'created_by',
          'position',
          'created_at',
          'updated_at',
        ])
        .expression(
          q
            .selectNoFrom((eb) => [
              eb.val(storyId).as('id'),
              eb.val(workspaceId).as('workspace_id'),
              eb.val(null).as('epic_id'),
              eb.val(input.title).as('title'),
              eb.val(input.acceptance_criteria_md).as('acceptance_criteria_md'),
              eb.val(input.body_md).as('body_md'),
              eb.val(input.due_on).as('due_on'),
              eb.val(input.link_url).as('link_url'),
              eb.val(actorUserId).as('created_by'),
              eb.val(position).as('position'),
              eb.val(createdAt).as('created_at'),
              eb.val(createdAt).as('updated_at'),
            ])
            .where((eb) => eb.exists(openWorkspace(eb, organizationId, workspaceId))),
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
              eb.val('story').as('entity_type'),
              eb.val(storyId).as('entity_id'),
              eb.val('create').as('action'),
              eb.val(JSON.stringify(created)).as('changes_json'),
              eb.val(createdAt).as('created_at'),
            ])
            .where((eb) =>
              eb.exists(
                eb
                  .selectFrom('stories')
                  .select('stories.id')
                  .where('stories.id', '=', storyId)
                  .where('stories.workspace_id', '=', workspaceId),
              ),
            ),
        ),
    ),
  ]);

  // 読んでから書くまでに、ワークスペースが閉じたら何も入らない
  if ((results[0]?.changes ?? 0) === 0) {
    await throwIfClosed(db, workspaceId);
    throw new ApiError(404, 'not_found');
  }
  return {
    story: {
      id: storyId,
      title: input.title,
      acceptance_criteria_md: input.acceptance_criteria_md,
      body_md: input.body_md,
      due_on: input.due_on,
      link_url: input.link_url,
    },
  };
});

// 書く欄。タイトルは空にできないので、欄ごとに型を分ける
type UpdatedFields = {
  title?: string;
  acceptance_criteria_md?: string | null;
  body_md?: string | null;
  due_on?: string | null;
  link_url?: string | null;
};

// 読んだ値と、送られた値の差。送られた欄のうち、読んだ値と違うものだけを書く
function diffOf(current: StoryDetail, input: UpdatedFields) {
  const values: UpdatedFields = {};
  const changes: Record<string, [string | null, string | null]> = {};
  if (input.title !== undefined && input.title !== current.title) {
    values.title = input.title;
    changes.title = [current.title, input.title];
  }
  for (const field of ['acceptance_criteria_md', 'body_md', 'due_on', 'link_url'] as const) {
    const next = input[field];
    if (next === undefined || next === current[field]) continue;
    values[field] = next;
    changes[field] = [current[field], next];
  }
  return { values, changes, isEmpty: Object.keys(changes).length === 0 };
}

export const storyUpdateOperation = implement(storyUpdate, async ({ db, actor, workspace, input }) => {
  const actorUserId = actorUserIdOf(actor);
  const organizationId = db.organizationId;
  const workspaceId = workspace.workspaceId;
  const storyId = input.story_id;

  // 読んだ値からの差を、「読んだ値のままなら」という条件つきで書く。読んでから書くまでに別の要求が同じ欄を変えていたら、
  // 更新は通らない（履歴の「前」がずれるのと、同じ値の指定が取りこぼされるのを防ぐ）。通らなかったら読み直して、差を作り直す。
  // 別の欄だけを変えた要求とは、条件がぶつからない（送っていない欄は条件にも書く値にも入れない）
  for (let attempt = 0; attempt < MAX_UPDATE_ATTEMPTS; attempt++) {
    const current = await readStory(db, workspaceId, storyId);
    if (current === undefined) {
      await throwIfClosed(db, workspaceId);
      throw new ApiError(404, 'not_found');
    }
    const { values, changes, isEmpty } = diffOf(current, input);
    if (isEmpty) {
      // 書くものが無くても、閉じたワークスペースは断る
      await throwIfClosed(db, workspaceId);
      return { story: current };
    }

    const at = now();
    const updatedAt = at.toISOString();
    const results = await db.batch([
      db.statement((q) =>
        q
          .updateTable('stories')
          .set({ ...values, updated_at: updatedAt })
          .where((eb) =>
            eb.and([
              eb('id', '=', storyId),
              eb('workspace_id', '=', workspaceId),
              eb('deleted_at', 'is', null),
              eb.exists(openWorkspace(q, organizationId, workspaceId)),
              // 書く欄が、読んだときの値のまま
              ...(values.title === undefined ? [] : [eb('title', 'is', current.title)]),
              ...(values.acceptance_criteria_md === undefined
                ? []
                : [eb('acceptance_criteria_md', 'is', current.acceptance_criteria_md)]),
              ...(values.body_md === undefined ? [] : [eb('body_md', 'is', current.body_md)]),
              ...(values.due_on === undefined ? [] : [eb('due_on', 'is', current.due_on)]),
              ...(values.link_url === undefined ? [] : [eb('link_url', 'is', current.link_url)]),
            ]),
          ),
      ),
      // 自分の更新が通ったときだけ履歴を書く。更新が通らなかった（閉じた、削除された、別の要求が先に変えた）ときは、
      // 行が書いた値と同じになっていても、自分の更新ではない同じ時刻の行を拾わないよう、書いた値の一致も条件にする
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
                eb.val('story').as('entity_type'),
                eb.val(storyId).as('entity_id'),
                eb.val('update').as('action'),
                eb.val(JSON.stringify(changes)).as('changes_json'),
                eb.val(updatedAt).as('created_at'),
              ])
              .where((eb) =>
                eb.and([
                  eb.exists(
                    eb
                      .selectFrom('stories')
                      .select('stories.id')
                      .where((sb) =>
                        sb.and([
                          sb('stories.id', '=', storyId),
                          sb('stories.workspace_id', '=', workspaceId),
                          sb('stories.deleted_at', 'is', null),
                          sb('stories.updated_at', '=', updatedAt),
                          ...(values.title === undefined ? [] : [sb('stories.title', 'is', values.title)]),
                          ...(values.acceptance_criteria_md === undefined
                            ? []
                            : [sb('stories.acceptance_criteria_md', 'is', values.acceptance_criteria_md)]),
                          ...(values.body_md === undefined ? [] : [sb('stories.body_md', 'is', values.body_md)]),
                          ...(values.due_on === undefined ? [] : [sb('stories.due_on', 'is', values.due_on)]),
                          ...(values.link_url === undefined ? [] : [sb('stories.link_url', 'is', values.link_url)]),
                        ]),
                      ),
                  ),
                  eb.exists(openWorkspace(eb, organizationId, workspaceId)),
                ]),
              ),
          ),
      ),
    ]);

    if ((results[0]?.changes ?? 0) > 0) {
      const updated = await readStory(db, workspaceId, storyId);
      if (updated === undefined) throw new ApiError(404, 'not_found');
      return { story: updated };
    }
    // 閉じていれば 409 の workspace_closed。無ければ 404。どちらでもなければ、別の要求が先に同じ欄を変えたので、読み直してやり直す
    await throwIfClosed(db, workspaceId);
    if ((await readStory(db, workspaceId, storyId)) === undefined) throw new ApiError(404, 'not_found');
  }
  throw new ApiError(409, 'conflict');
});

type Tables = OrganizationTables;

// 移す先の並び（エピックの配下か、親のないストーリー）から、移すストーリーを除いたもの。完了したストーリーも含める
function siblingStories(
  from: Pick<QueryCreator<Tables>, 'selectFrom'>,
  workspaceId: string,
  epicId: string | null,
  storyId: string,
) {
  return from
    .selectFrom('stories')
    .where('stories.workspace_id', '=', workspaceId)
    .where('stories.epic_id', epicId === null ? 'is' : '=', epicId)
    .where('stories.deleted_at', 'is', null)
    .where('stories.id', '!=', storyId);
}

// 移す先の親にできる、削除していないエピック。完了も中止もしていないかは、呼ぶ側が見る
function epicRow(from: Pick<QueryCreator<Tables>, 'selectFrom'>, workspaceId: string, epicId: string) {
  return from
    .selectFrom('epics')
    .where('epics.id', '=', epicId)
    .where('epics.workspace_id', '=', workspaceId)
    .where('epics.deleted_at', 'is', null);
}

// 移す先のエピックを読む。無ければ 404。親が変わるときだけ、完了か中止していれば 409（parent_completed）
async function readMoveEpic(db: OrganizationDb, workspaceId: string, epicId: string, changing: boolean) {
  const epic = await db.first(
    db.statement((q) =>
      epicRow(q, workspaceId, epicId).select(['epics.id', 'epics.title', 'epics.completed_at', 'epics.canceled_at']),
    ),
  );
  if (epic === undefined) throw new ApiError(404, 'not_found');
  if (changing && (epic.completed_at !== null || epic.canceled_at !== null)) throw moveConflict('parent_completed');
  return { id: epic.id, title: epic.title };
}

// 移すストーリーの新しい位置と、読んだ直前の行を決める。考え方はタスクの移動（task.ts の planTaskMove）と同じ
async function planStoryMove(
  db: OrganizationDb,
  workspaceId: string,
  epicId: string | null,
  storyId: string,
  afterId: string | null | undefined,
): Promise<{ plan: MovePlan; after: Positioned | null }> {
  const columns = ['stories.id', 'stories.position'] as const;
  if (afterId === undefined) {
    const last = await db.first(
      db.statement((q) =>
        siblingStories(q, workspaceId, epicId, storyId)
          .select(columns)
          .orderBy('stories.position', 'desc')
          .orderBy('stories.id', 'desc')
          .limit(1),
      ),
    );
    return { plan: placeLast(last), after: null };
  }
  if (afterId === null) {
    const first = await db.first(
      db.statement((q) =>
        siblingStories(q, workspaceId, epicId, storyId)
          .select(columns)
          .orderBy('stories.position')
          .orderBy('stories.id')
          .limit(1),
      ),
    );
    return { plan: placeFirst(first), after: null };
  }
  const after = await db.first(
    db.statement((q) =>
      siblingStories(q, workspaceId, epicId, storyId).select(columns).where('stories.id', '=', afterId),
    ),
  );
  if (after === undefined) throw new ApiError(404, 'not_found');
  const [ties, next] = await db.batch([
    db.statement((q) =>
      siblingStories(q, workspaceId, epicId, storyId)
        .select(columns)
        .where('stories.position', '=', after.position)
        .where('stories.id', '>', after.id)
        .orderBy('stories.id')
        .limit(MAX_TIES + 1),
    ),
    db.statement((q) =>
      siblingStories(q, workspaceId, epicId, storyId)
        .select(columns)
        .where('stories.position', '>', after.position)
        .orderBy('stories.position')
        .orderBy('stories.id')
        .limit(1),
    ),
  ] as const);
  return { plan: placeAfter(after, ties.rows, next.rows[0]), after };
}

// 移すストーリーと、今の親の題と区分の名前（履歴に残す）
function movingStory(db: OrganizationDb, workspaceId: string, storyId: string) {
  return db.first(
    db.statement((q) =>
      q
        .selectFrom('stories')
        .leftJoin('epics', (join) =>
          join.onRef('epics.id', '=', 'stories.epic_id').onRef('epics.workspace_id', '=', 'stories.workspace_id'),
        )
        .leftJoin('categories', (join) =>
          join
            .onRef('categories.id', '=', 'stories.category_id')
            .onRef('categories.workspace_id', '=', 'stories.workspace_id'),
        )
        .select([
          'stories.id',
          'stories.epic_id',
          'stories.category_id',
          'epics.title as epic_title',
          'categories.name as category_name',
        ])
        .where('stories.id', '=', storyId)
        .where('stories.workspace_id', '=', workspaceId)
        .where('stories.deleted_at', 'is', null),
    ),
  );
}

export const storyMoveOperation = implement(storyMove, async ({ db, actor, workspace, input }) => {
  const actorUserId = actorUserIdOf(actor);
  const organizationId = db.organizationId;
  const workspaceId = workspace.workspaceId;
  const storyId = input.story_id;
  const afterId = input.after_story_id;
  if (afterId === storyId) throw new ApiError(400, 'invalid_input');

  const current = await movingStory(db, workspaceId, storyId);
  if (current === undefined) throw new ApiError(404, 'not_found');
  const parentId = input.epic_id;
  const parentChanged = current.epic_id !== parentId;
  const parent = parentId === null ? null : await readMoveEpic(db, workspaceId, parentId, parentChanged);
  // エピックの下へ移して区分が消えるときは、前の区分を履歴に残す。親が変わってエピックの下へ移すときは、
  // 書く文は区分が読んだ値（空も含む）のままであることも条件にする。読んだ後に付いた区分を、履歴なしに消さないため
  const guardsCategory = parentChanged && parentId !== null;
  const clearedCategory =
    parentChanged && parentId !== null && current.category_id !== null
      ? { id: current.category_id, name: current.category_name ?? '' }
      : null;
  const { plan, after } = await planStoryMove(db, workspaceId, parentId, storyId, afterId);

  const at = now();
  const updatedAt = at.toISOString();
  // 自分の更新が通った、という条件。振り直しと履歴は、これを自分の条件に持つ
  const moved = (from: Pick<QueryCreator<Tables>, 'selectFrom'>) =>
    from
      .selectFrom('stories')
      .select('stories.id')
      .where('stories.id', '=', storyId)
      .where('stories.workspace_id', '=', workspaceId)
      .where('stories.epic_id', parentId === null ? 'is' : '=', parentId)
      .where('stories.position', '=', plan.position)
      .where('stories.updated_at', '=', updatedAt);

  const results = await db.batch([
    db.statement((q) =>
      q
        .updateTable('stories')
        .set({
          epic_id: parentId,
          position: plan.position,
          updated_at: updatedAt,
          // 区分は親のないストーリーにだけ入る。エピックの下へ移したら空にする
          ...(parentId === null ? {} : { category_id: null }),
        })
        .where('id', '=', storyId)
        .where('workspace_id', '=', workspaceId)
        .where('deleted_at', 'is', null)
        .where('epic_id', current.epic_id === null ? 'is' : '=', current.epic_id)
        .$if(guardsCategory, (qb) =>
          qb.where('category_id', current.category_id === null ? 'is' : '=', current.category_id),
        )
        .where((eb) => eb.exists(openWorkspace(q, organizationId, workspaceId)))
        .$if(parentId !== null, (qb) =>
          qb.where((eb) =>
            eb.exists(
              epicRow(q, workspaceId, parentId!)
                .select('epics.id')
                .$if(parentChanged, (sb) =>
                  sb.where('epics.completed_at', 'is', null).where('epics.canceled_at', 'is', null),
                ),
            ),
          ),
        )
        // 直前の行が、今も読んだ値の位置にある
        .$if(after !== null, (qb) =>
          qb.where((eb) =>
            eb.exists(
              siblingStories(q, workspaceId, parentId, storyId)
                .select('stories.id')
                .where('stories.id', '=', after!.id)
                .where('stories.position', '=', after!.position),
            ),
          ),
        ),
    ),
    ...plan.renumber.map((row) =>
      db.statement((q) =>
        q
          .updateTable('stories')
          .set({ position: row.to, updated_at: updatedAt })
          .where('id', '=', row.id)
          .where('workspace_id', '=', workspaceId)
          .where('epic_id', parentId === null ? 'is' : '=', parentId)
          .where('position', '=', row.from)
          .where('deleted_at', 'is', null)
          .where((eb) => eb.exists(moved(q))),
      ),
    ),
    ...(parentChanged
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
                    eb.val('story').as('entity_type'),
                    eb.val(storyId).as('entity_id'),
                    eb.val('update').as('action'),
                    eb
                      .val(
                        JSON.stringify({
                          epic: [
                            current.epic_id === null ? null : { id: current.epic_id, title: current.epic_title },
                            parent,
                          ],
                          ...(clearedCategory === null ? {} : { category: [clearedCategory, null] }),
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
    // 読んでから書くまでに、閉じたか、ストーリーか親か直前の行が消えたか、親が完了したか、
    // 別の要求が先に親を移したか直前の行を動かした
    await throwIfClosed(db, workspaceId);
    if ((await movingStory(db, workspaceId, storyId)) === undefined) throw new ApiError(404, 'not_found');
    if (parentId !== null) await readMoveEpic(db, workspaceId, parentId, parentChanged);
    if (afterId != null) await planStoryMove(db, workspaceId, parentId, storyId, afterId);
    throw moveConflict('changed');
  }
  return { story_id: storyId, epic_id: parentId };
});

// ストーリーの完了と取り消しを 409 の conflict で断る。理由は details.reason に載せる
function completionConflict(reason: StoryCompletionConflictReason): ApiError {
  return new ApiError(409, 'conflict', { reason });
}

// 配下の、削除していない未完了のバックログのタスク。1件でもあれば完了にできない
function openTasksUnder(from: Pick<QueryCreator<Tables>, 'selectFrom'>, workspaceId: string, storyId: string) {
  return from
    .selectFrom('tasks')
    .select('tasks.id')
    .where('tasks.story_id', '=', storyId)
    .where('tasks.workspace_id', '=', workspaceId)
    .where('tasks.tray', '=', 'backlog')
    .where('tasks.deleted_at', 'is', null)
    .where('tasks.completed_at', 'is', null);
}

// ストーリーの完了の経験値を受け取る人の、元の付与。配下の削除していないタスクの、打ち消されていない完了の経験値（task_completed）で、
// 受け取った人が今そのワークスペースに所属しているもの。タスクから引いて付与を結ぶ（tasks_story と xp_grants_task の索引）
function recipientGrants(from: Pick<QueryCreator<Tables>, 'selectFrom'>, workspaceId: string, storyId: string) {
  return from
    .selectFrom('tasks')
    .crossJoin('xp_grants as g')
    .whereRef('g.task_id', '=', 'tasks.id')
    .where('tasks.story_id', '=', storyId)
    .where('tasks.workspace_id', '=', workspaceId)
    .where('tasks.deleted_at', 'is', null)
    .where('g.workspace_id', '=', workspaceId)
    .where('g.action', '=', 'task_completed')
    .where('g.reverses_grant_id', 'is', null)
    .where((eb) =>
      eb.and([
        eb.not(
          eb.exists(
            eb
              .selectFrom('xp_grants as r')
              .select('r.id')
              .whereRef('r.reverses_grant_id', '=', 'g.id')
              .where('r.workspace_id', '=', workspaceId),
          ),
        ),
        eb.exists(
          eb
            .selectFrom('memberships')
            .select('memberships.id')
            .whereRef('memberships.user_id', '=', 'g.user_id')
            .where('memberships.workspace_id', '=', workspaceId)
            .where('memberships.left_at', 'is', null),
        ),
      ]),
    );
}

// 完了にする前の状態。ストーリーの完了した日時、配下の未完了のタスクの件数、経験値の受け取り手
async function readCompletion(db: OrganizationDb, workspaceId: string, storyId: string) {
  const [storyResult, openResult, recipientResult] = await db.batch([
    db.statement((q) =>
      q
        .selectFrom('stories')
        // 親のエピック。削除したエピックは親として数えない
        .leftJoin('epics', (join) =>
          join
            .onRef('epics.id', '=', 'stories.epic_id')
            .onRef('epics.workspace_id', '=', 'stories.workspace_id')
            .on('epics.deleted_at', 'is', null),
        )
        .select([
          'stories.id',
          'stories.completed_at',
          'epics.completed_at as epic_completed_at',
          'epics.canceled_at as epic_canceled_at',
        ])
        .where('stories.id', '=', storyId)
        .where('stories.workspace_id', '=', workspaceId)
        .where('stories.deleted_at', 'is', null),
    ),
    db.statement((q) =>
      openTasksUnder(q, workspaceId, storyId)
        .clearSelect()
        .select((eb) => eb.fn.countAll<number>().as('count')),
    ),
    db.statement((q) => recipientGrants(q, workspaceId, storyId).select('g.user_id').distinct().orderBy('g.user_id')),
  ] as const);
  const story = storyResult.rows[0];
  if (story === undefined) return undefined;
  return {
    completedAt: story.completed_at,
    parentFinished: story.epic_completed_at !== null || story.epic_canceled_at !== null,
    openCount: Number(openResult.rows[0]?.count ?? 0),
    recipients: recipientResult.rows.map((row) => row.user_id),
  };
}

const storyGrantColumns = [
  'id',
  'workspace_id',
  'user_id',
  'action',
  'story_id',
  'amount',
  'reverses_grant_id',
  'dedupe_key',
  'confirmed_at',
] as const;

// 自分の履歴の行がある、という条件。経験値の付与と打ち消しは、これで自分の更新が通ったことを見る
// （履歴は直前の UPDATE が行を変えたときだけ入り、id はこの要求だけの値なので、止めた時計でも負けた要求とは一致しない）
function ownLog(from: Pick<QueryCreator<Tables>, 'selectFrom'>, workspaceId: string, logId: string) {
  return from
    .selectFrom('change_logs')
    .select('change_logs.id')
    .where('change_logs.id', '=', logId)
    .where('change_logs.workspace_id', '=', workspaceId);
}

// 完了の文は、配下に未完了のタスクが無いことと、受け取り手が読んだときのまま（読んだ人の外に、受け取る人が増えていない）ことを条件にする。
// 受け取り手が変わって通らなかったら（読んでから書くまでに、配下のタスクが完了した、所属が戻ったなど）、読み直してやり直す
export const storyCompleteOperation = implement(storyComplete, async ({ db, actor, workspace, input }) => {
  const userId = actorUserIdOf(actor);
  const organizationId = db.organizationId;
  const workspaceId = workspace.workspaceId;
  const storyId = input.story_id;

  // 履歴に残す自分の名前
  const user = await db.first(
    db.statement((q) =>
      q.selectFrom('users').select('name').where('id', '=', userId).where('organization_id', '=', organizationId),
    ),
  );
  if (user === undefined) throw new ApiError(404, 'not_found');

  for (let attempt = 0; attempt < MAX_UPDATE_ATTEMPTS; attempt++) {
    const state = await readCompletion(db, workspaceId, storyId);
    if (state === undefined) {
      await throwIfClosed(db, workspaceId);
      throw new ApiError(404, 'not_found');
    }
    if (state.completedAt !== null) {
      await throwIfClosed(db, workspaceId);
      throw completionConflict('completed');
    }
    // 完了か中止したエピックの下で完了にすると、取り消せず（parent_completed）、付けた経験値も打ち消せなくなるので断る
    if (state.parentFinished) {
      await throwIfClosed(db, workspaceId);
      throw completionConflict('parent_completed');
    }
    if (state.openCount > 0) {
      await throwIfClosed(db, workspaceId);
      throw completionConflict('open_tasks');
    }

    const at = now();
    const completedAt = at.toISOString();
    const logId = uuidv7(at);
    const { recipients } = state;
    const results = await db.batch([
      db.statement((q) =>
        q
          .updateTable('stories')
          .set({ completed_at: completedAt, completed_by: userId, updated_at: completedAt })
          .where('id', '=', storyId)
          .where('workspace_id', '=', workspaceId)
          .where('deleted_at', 'is', null)
          .where('completed_at', 'is', null)
          .where((eb) =>
            eb.and([
              eb.exists(openWorkspace(q, organizationId, workspaceId)),
              eb.not(eb.exists(openTasksUnder(q, workspaceId, storyId))),
              // 今の親のエピック（削除したものを除く）が、完了も中止もしていない。読んでから書くまでに親が移っても、今の親で見る
              eb.not(
                eb.exists(
                  eb
                    .selectFrom('epics')
                    .select('epics.id')
                    .whereRef('epics.id', '=', 'stories.epic_id')
                    .where('epics.workspace_id', '=', workspaceId)
                    .where('epics.deleted_at', 'is', null)
                    .where((sb) =>
                      sb.or([sb('epics.completed_at', 'is not', null), sb('epics.canceled_at', 'is not', null)]),
                    ),
                ),
              ),
              eb.not(
                eb.exists(
                  recipientGrants(q, workspaceId, storyId)
                    .select('g.id')
                    // 受け取り手が多くても bind の上限に当たらないよう、一覧は1つの値で渡す
                    .where('g.user_id', 'not in', jsonList(recipients)),
                ),
              ),
            ]),
          ),
      ),
      // 直前の UPDATE が行を変えたときだけ
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
                eb.val('story').as('entity_type'),
                eb.val(storyId).as('entity_id'),
                eb.val('complete').as('action'),
                eb
                  .val(
                    JSON.stringify({
                      completed_at: [null, completedAt],
                      completed_by: [null, { id: userId, name: user.name }],
                    }),
                  )
                  .as('changes_json'),
                eb.val(completedAt).as('created_at'),
              ])
              .where(previousStatementChanged),
          ),
      ),
      // 受け取り手に1人1回ずつ。書くときにも、元の付与が打ち消されていないことと、所属していることを確かめる
      ...recipients.map((recipient) => {
        const dedupeKey = `story_completed:${storyId}:${recipient}:${completedAt}`;
        return db.statement((q) =>
          q
            .insertInto('xp_grants')
            .columns(storyGrantColumns)
            .expression(
              q
                .selectNoFrom((eb) => [
                  eb.val(uuidv7(at)).as('id'),
                  eb.val(workspaceId).as('workspace_id'),
                  eb.val(recipient).as('user_id'),
                  eb.val('story_completed').as('action'),
                  eb.val(storyId).as('story_id'),
                  eb.val(XP_STORY_COMPLETED).as('amount'),
                  eb.val(null).as('reverses_grant_id'),
                  eb.val(dedupeKey).as('dedupe_key'),
                  eb.val(completedAt).as('confirmed_at'),
                ])
                .where((eb) =>
                  eb.and([
                    eb.exists(ownLog(eb, workspaceId, logId)),
                    eb.exists(
                      recipientGrants(eb, workspaceId, storyId).select('g.id').where('g.user_id', '=', recipient),
                    ),
                    // 止めた時計（DEV_NOW）で、完了、取り消し、完了を同じ時刻に流すと、同じキーの行が残っている
                    eb.not(
                      eb.exists(
                        eb.selectFrom('xp_grants').select('xp_grants.id').where('xp_grants.dedupe_key', '=', dedupeKey),
                      ),
                    ),
                  ]),
                ),
            ),
        );
      }),
    ]);

    if ((results[0]?.changes ?? 0) > 0) return { story_id: storyId, completed_at: completedAt };
    // 閉じていれば 409 の workspace_closed。そうでなければ読み直して、消えた、完了した、親のエピックが完了か中止した、未完了のタスクが増えたかを見て、
    // どれでもなければ（受け取り手が変わった）やり直す
    await throwIfClosed(db, workspaceId);
  }
  throw completionConflict('changed');
});

// 取り消す前の状態。完了した日時と完了にした人（履歴に残す名前）、親のエピックの完了と中止
function readReopening(db: OrganizationDb, workspaceId: string, storyId: string) {
  return db.first(
    db.statement((q) =>
      q
        .selectFrom('stories')
        // 親のエピック。削除したエピックは親として数えない（削除したエピックの下のストーリーの扱いは、エピックの削除の #65 で決める）
        .leftJoin('epics', (join) =>
          join
            .onRef('epics.id', '=', 'stories.epic_id')
            .onRef('epics.workspace_id', '=', 'stories.workspace_id')
            .on('epics.deleted_at', 'is', null),
        )
        .leftJoin('users', (join) =>
          join.onRef('users.id', '=', 'stories.completed_by').on('users.organization_id', '=', db.organizationId),
        )
        .select([
          'stories.id',
          'stories.epic_id',
          'stories.completed_at',
          'stories.completed_by',
          'users.name as completed_by_name',
          'epics.completed_at as epic_completed_at',
          'epics.canceled_at as epic_canceled_at',
        ])
        .where('stories.id', '=', storyId)
        .where('stories.workspace_id', '=', workspaceId)
        .where('stories.deleted_at', 'is', null),
    ),
  );
}

// 読んだ状態から、取り消せない理由を投げる。取り消せるなら何もしない
function throwIfNotReopenable(
  story: Awaited<ReturnType<typeof readReopening>>,
): asserts story is NonNullable<typeof story> {
  if (story === undefined) throw new ApiError(404, 'not_found');
  if (story.completed_at === null) throw completionConflict('not_completed');
  if (story.epic_id !== null && (story.epic_completed_at !== null || story.epic_canceled_at !== null)) {
    throw completionConflict('parent_completed');
  }
}

export const storyReopenOperation = implement(storyReopen, async ({ db, actor, workspace, input }) => {
  const userId = actorUserIdOf(actor);
  const organizationId = db.organizationId;
  const workspaceId = workspace.workspaceId;
  const storyId = input.story_id;

  const story = await readReopening(db, workspaceId, storyId);
  throwIfNotReopenable(story);
  const completedAt = story.completed_at!;
  const epicId = story.epic_id;

  // 打ち消す付与。このストーリーの、打ち消されていない完了の経験値。完了した日時が読んだ値のままなら（書く文の条件）、
  // 読んでから書くまでに新しい付与は入らない（入るのは、取り消してからもう一度完了にしたときだけ）
  const grants = await db.rows(
    db.statement((q) =>
      q
        .selectFrom('xp_grants as g')
        .select(['g.id', 'g.user_id', 'g.amount'])
        .where('g.story_id', '=', storyId)
        .where('g.workspace_id', '=', workspaceId)
        .where('g.action', '=', 'story_completed')
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
  const results = await db.batch([
    db.statement((q) =>
      q
        .updateTable('stories')
        .set({ completed_at: null, completed_by: null, updated_at: reopenedAt })
        .where('id', '=', storyId)
        .where('workspace_id', '=', workspaceId)
        .where('deleted_at', 'is', null)
        .where('completed_at', '=', completedAt)
        .where('epic_id', epicId === null ? 'is' : '=', epicId)
        .where((eb) => eb.exists(openWorkspace(q, organizationId, workspaceId)))
        // 親のエピック（削除したものを除く）が、完了も中止もしていない。読むときと同じく、削除したエピックは親として数えない
        .where((eb) =>
          eb.not(
            eb.exists(
              eb
                .selectFrom('epics')
                .select('epics.id')
                .whereRef('epics.id', '=', 'stories.epic_id')
                .where('epics.workspace_id', '=', workspaceId)
                .where('epics.deleted_at', 'is', null)
                .where((sb) =>
                  sb.or([sb('epics.completed_at', 'is not', null), sb('epics.canceled_at', 'is not', null)]),
                ),
            ),
          ),
        ),
    ),
    // 直前の UPDATE が行を変えたときだけ
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
              eb.val('story').as('entity_type'),
              eb.val(storyId).as('entity_id'),
              eb.val('reopen').as('action'),
              eb
                .val(
                  JSON.stringify({
                    completed_at: [completedAt, null],
                    completed_by: [
                      story.completed_by === null
                        ? null
                        : { id: story.completed_by, name: story.completed_by_name ?? '' },
                      null,
                    ],
                  }),
                )
                .as('changes_json'),
              eb.val(reopenedAt).as('created_at'),
            ])
            .where(previousStatementChanged),
        ),
    ),
    // 打ち消しの明細。元の行を指し、負の値を足す
    ...grants.map((grant) =>
      db.statement((q) =>
        q
          .insertInto('xp_grants')
          .columns(storyGrantColumns)
          .expression(
            q
              .selectNoFrom((eb) => [
                eb.val(uuidv7(at)).as('id'),
                eb.val(workspaceId).as('workspace_id'),
                eb.val(grant.user_id).as('user_id'),
                eb.val('story_completed').as('action'),
                eb.val(storyId).as('story_id'),
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
  ]);

  if ((results[0]?.changes ?? 0) === 0) {
    // 読んでから書くまでに、閉じたか、消えたか、別の要求が先に取り消したか、親のエピックが完了か中止したか、
    // 取り消してからもう一度完了にされた（完了した日時が変わった）
    await throwIfClosed(db, workspaceId);
    const latest = await readReopening(db, workspaceId, storyId);
    throwIfNotReopenable(latest);
    throw completionConflict('changed');
  }
  return { story_id: storyId };
});
