import { generateKeyBetween } from 'fractional-indexing';
import { monthIn, now, todayIn } from '../../shared/clock.ts';
import { XP_TASK_COMPLETED, XP_TASK_CREATED } from '../../shared/experience.ts';
import { backlogTree, taskComplete, taskCreate, taskMove } from '../../shared/operations/task/index.ts';
import { MIN_POINTS_FOR_EXPERIENCE } from '../../shared/task.ts';
import type { OrganizationDb, OrganizationTables, QueryCreator } from '../db/index.ts';
import { ApiError } from '../errors.ts';
import { uuidv7 } from '../uuid.ts';
import {
  categoryConflict,
  categoryRow,
  readCategoryRef,
  readRepositoryRef,
  refOf,
  repositoryRow,
} from './definition-refs.ts';
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
import { activeMemberName, actorUserIdOf, changeLogColumns, openWorkspace, throwIfClosed } from './write-guards.ts';

type Tables = OrganizationTables;

// 削除していないバックログのタスク。親のないタスク（storyId が null）か、ストーリーの配下のタスク。
// 木の読み取りと、末尾の位置を決める読み取りが同じ範囲を使う
function backlogTasksUnder(
  from: Pick<QueryCreator<Tables>, 'selectFrom'>,
  workspaceId: string,
  storyId: string | null,
) {
  return from
    .selectFrom('tasks')
    .where('tasks.workspace_id', '=', workspaceId)
    .where('tasks.tray', '=', 'backlog')
    .where('tasks.story_id', storyId === null ? 'is' : '=', storyId)
    .where('tasks.deleted_at', 'is', null);
}

// 作るタスクの親にできる、削除していないストーリー。完了しているかは completed_at で見る
function storyRow(from: Pick<QueryCreator<Tables>, 'selectFrom'>, workspaceId: string, storyId: string) {
  return from
    .selectFrom('stories')
    .where('stories.id', '=', storyId)
    .where('stories.workspace_id', '=', workspaceId)
    .where('stories.deleted_at', 'is', null);
}

// 親にするストーリーを読む。無ければ 404、完了していれば 409 の conflict
async function readParentStory(db: OrganizationDb, workspaceId: string, storyId: string) {
  const story = await db.first(
    db.statement((q) =>
      storyRow(q, workspaceId, storyId).select(['stories.id', 'stories.title', 'stories.completed_at']),
    ),
  );
  if (story === undefined) throw new ApiError(404, 'not_found');
  if (story.completed_at !== null) throw new ApiError(409, 'conflict');
  return { id: story.id, title: story.title };
}

export const taskCreateOperation = implement(taskCreate, async ({ db, actor, workspace, input }) => {
  const actorUserId = actorUserIdOf(actor);
  const organizationId = db.organizationId;
  const workspaceId = workspace.workspaceId;

  // 担当は、このワークスペースに今所属している人だけ。読んで名前を残し、書く文にも同じ条件を入れる
  let assignee: { id: string; name: string } | null = null;
  if (input.assignee_user_id !== null) {
    const found = await db.first(
      db.statement((q) => activeMemberName(q, organizationId, workspaceId, input.assignee_user_id!)),
    );
    if (found === undefined) throw new ApiError(404, 'not_found');
    assignee = { id: input.assignee_user_id, name: found.name };
  }

  // 親は、同じワークスペースの削除していない、完了していないストーリー。無ければ 404、完了していれば 409。書く文にも同じ条件を入れる
  const parentId = input.story_id;
  // 区分は親のないタスクだけが持つ（親の下では引き継ぐ）
  if (parentId !== null && input.category_id !== null) throw categoryConflict('has_parent');
  const parent = parentId === null ? null : await readParentStory(db, workspaceId, parentId);
  // 区分とリポジトリは、同じワークスペースの削除していないものだけ。無ければ 404。読んで名前を残し、書く文にも同じ条件を入れる
  const category = input.category_id === null ? null : await readCategoryRef(db, workspaceId, input.category_id);
  const repository =
    input.repository_id === null ? null : await readRepositoryRef(db, workspaceId, input.repository_id);

  // 位置は親の配下（親なしなら、親のないタスク）の末尾。完了したタスクも並びに残っているので、それも含めた末尾に置く。
  // 同時に作ると同じ位置になりうる。同じ位置の行は id の順に並ぶ（同じミリ秒の中では作った順とは限らない）
  const last = await db.first(
    db.statement((q) =>
      backlogTasksUnder(q, workspaceId, parentId).select('tasks.position').orderBy('tasks.position', 'desc').limit(1),
    ),
  );
  const at = now();
  const createdAt = at.toISOString();
  const taskId = uuidv7(at);
  const position = generateKeyBetween(last?.position ?? null, null);

  const results = await db.batch([
    db.statement((q) =>
      q
        .insertInto('tasks')
        .columns([
          'id',
          'workspace_id',
          'is_imported',
          'tray',
          'title',
          'points',
          'story_id',
          'category_id',
          'repository_id',
          'assignee_user_id',
          'position',
          'created_by',
          'created_at',
          'updated_at',
        ])
        .expression(
          q
            .selectNoFrom((eb) => [
              eb.val(taskId).as('id'),
              eb.val(workspaceId).as('workspace_id'),
              eb.val(0).as('is_imported'),
              eb.val('backlog').as('tray'),
              eb.val(input.title).as('title'),
              eb.val(input.points).as('points'),
              eb.val(parent?.id ?? null).as('story_id'),
              eb.val(category?.id ?? null).as('category_id'),
              eb.val(repository?.id ?? null).as('repository_id'),
              eb.val(assignee?.id ?? null).as('assignee_user_id'),
              eb.val(position).as('position'),
              eb.val(actorUserId).as('created_by'),
              eb.val(createdAt).as('created_at'),
              eb.val(createdAt).as('updated_at'),
            ])
            .where((eb) => eb.exists(openWorkspace(eb, organizationId, workspaceId)))
            .$if(assignee !== null, (qb) =>
              qb.where((eb) => eb.exists(activeMemberName(eb, organizationId, workspaceId, assignee!.id))),
            )
            .$if(parent !== null, (qb) =>
              qb.where((eb) =>
                eb.exists(
                  storyRow(eb, workspaceId, parent!.id).select('stories.id').where('stories.completed_at', 'is', null),
                ),
              ),
            )
            .$if(category !== null, (qb) =>
              qb.where((eb) => eb.exists(categoryRow(eb, workspaceId, category!.id).select('categories.id'))),
            )
            .$if(repository !== null, (qb) =>
              qb.where((eb) => eb.exists(repositoryRow(eb, workspaceId, repository!.id).select('repositories.id'))),
            ),
        ),
    ),
    // 作った行がある（担当と親の条件を通った）ときだけ履歴を書く
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
              eb.val('create').as('action'),
              eb
                .val(
                  JSON.stringify({
                    title: [null, input.title],
                    points: [null, input.points],
                    ...(assignee === null ? {} : { assignee: [null, assignee] }),
                    ...(parent === null ? {} : { story: [null, parent] }),
                    ...(category === null ? {} : { category: [null, category] }),
                    ...(repository === null ? {} : { repository: [null, repository] }),
                  }),
                )
                .as('changes_json'),
              eb.val(createdAt).as('created_at'),
            ])
            .where((eb) =>
              eb.exists(
                eb
                  .selectFrom('tasks')
                  .select('tasks.id')
                  .where('tasks.id', '=', taskId)
                  .where('tasks.workspace_id', '=', workspaceId),
              ),
            ),
        ),
    ),
  ]);

  // 読んでから書くまでに、ワークスペースが閉じたか、担当が所属を外れたか、親が消えたか完了したか、区分かリポジトリが削除されたら何も入らない
  if ((results[0]?.changes ?? 0) === 0) {
    await throwIfClosed(db, workspaceId);
    // 親が消えていれば 404、完了していれば 409。親は無事なら、担当が外れたか区分かリポジトリが消えたので 404
    if (parent !== null) await readParentStory(db, workspaceId, parent.id);
    throw new ApiError(404, 'not_found');
  }
  return {
    task: { id: taskId, title: input.title, points: input.points, due_on: null, assignee, category, repository },
  };
});

type TaskPoints = 0 | 1 | 2 | 3 | 5 | 8 | 13 | null;

// ストーリー（親のないものとエピックの下のもの）の配下の、削除していないバックログのタスク。ストーリーから引いてタスクを結ぶ
// （FROM stories CROSS JOIN tasks）。SQLite は INNER JOIN だと、親のないタスクも含めた tasks_workspace_tray を先に走査する計画を
// 選ぶので、CROSS JOIN で順序を固定し、ストーリー側を `stories_workspace_epic` の先頭の列（workspace_id）で、タスク側を
// `tasks_story`（story_id, position の部分索引）で引く（結ぶ条件は WHERE に書く）。両側をワークスペースで絞る
function tasksUnderStories(from: Pick<QueryCreator<Tables>, 'selectFrom'>, workspaceId: string) {
  return from
    .selectFrom('stories')
    .crossJoin('tasks')
    .whereRef('tasks.story_id', '=', 'stories.id')
    .whereRef('tasks.workspace_id', '=', 'stories.workspace_id')
    .where('stories.workspace_id', '=', workspaceId)
    .where('stories.deleted_at', 'is', null)
    .where('tasks.tray', '=', 'backlog')
    .where('tasks.deleted_at', 'is', null);
}

// 件数に上限を付けない。重さは 5 万件で測る Issue で決める。
// ストーリーは親のないものとエピックの下のものを1つの文で読み、epic_id で分ける。削除したエピックの下のストーリーも
// （その配下のタスクも）読むが、エピックの一覧に親が無いので、どこにも並べずに捨てる
export const backlogTreeOperation = implement(backlogTree, async ({ db, workspace }) => {
  const organizationId = db.organizationId;
  const workspaceId = workspace.workspaceId;
  const [workspaceResult, epicsResult, storiesResult, storyTasksResult, totalsResult, rootOpenResult, rootDoneResult] =
    await db.batch([
      db.statement((q) =>
        q
          .selectFrom('workspaces')
          .select(['workspaces.timezone', 'workspaces.week_start'])
          .where('workspaces.id', '=', workspaceId)
          .where('workspaces.organization_id', '=', organizationId),
      ),
      db.statement((q) =>
        q
          .selectFrom('epics')
          // 区分は、同じワークスペースの削除していないものだけを結ぶ（下の行も同じ）
          .leftJoin('categories', (join) =>
            join
              .onRef('categories.id', '=', 'epics.category_id')
              .on('categories.workspace_id', '=', workspaceId)
              .on('categories.deleted_at', 'is', null),
          )
          .select([
            'epics.id',
            'epics.title',
            'epics.due_on',
            'epics.link_url',
            'epics.completed_at',
            'epics.canceled_at',
            'categories.id as category_ref_id',
            'categories.name as category_name',
          ])
          .where('epics.workspace_id', '=', workspaceId)
          .where('epics.deleted_at', 'is', null)
          .orderBy('epics.position')
          .orderBy('epics.id'),
      ),
      db.statement((q) =>
        q
          .selectFrom('stories')
          .leftJoin('categories', (join) =>
            join
              .onRef('categories.id', '=', 'stories.category_id')
              .on('categories.workspace_id', '=', workspaceId)
              .on('categories.deleted_at', 'is', null),
          )
          .select([
            'stories.id',
            'stories.epic_id',
            'stories.title',
            'stories.due_on',
            'stories.link_url',
            'stories.completed_at',
            'categories.id as category_ref_id',
            'categories.name as category_name',
          ])
          .where('stories.workspace_id', '=', workspaceId)
          .where('stories.deleted_at', 'is', null)
          .orderBy('stories.position')
          .orderBy('stories.id'),
      ),
      // 配下の未完了のタスク。ORDER BY を付けると SQLite が tasks_story を使わない計画を選ぶので、並べるのは下で行う。
      // 区分は親から引き継ぐので、タスク自身の区分は読まない
      db.statement((q) =>
        tasksUnderStories(q, workspaceId)
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
            'tasks.story_id',
            'tasks.id',
            'tasks.title',
            'tasks.points',
            'tasks.due_on',
            'tasks.position',
            'tasks.assignee_user_id',
            'users.name as assignee_name',
            'repositories.id as repository_ref_id',
            'repositories.name as repository_name',
          ])
          .where('tasks.completed_at', 'is', null),
      ),
      // ストーリーごとの、完了した件数とポイントの合計。未見積もりは 0
      db.statement((q) =>
        tasksUnderStories(q, workspaceId)
          .select((eb) => [
            'stories.id as story_id',
            eb.fn
              .sum<number>(eb.case().when('tasks.completed_at', 'is not', null).then(1).else(0).end())
              .as('completed_count'),
            eb.fn
              .sum<number>(
                eb
                  .case()
                  .when('tasks.completed_at', 'is not', null)
                  .then(eb.fn.coalesce('tasks.points', eb.lit(0)))
                  .else(0)
                  .end(),
              )
              .as('points_done'),
            eb.fn.sum<number>(eb.fn.coalesce('tasks.points', eb.lit(0))).as('points_all'),
          ])
          .groupBy('stories.id'),
      ),
      db.statement((q) =>
        backlogTasksUnder(q, workspaceId, null)
          .leftJoin('users', (join) =>
            join.onRef('users.id', '=', 'tasks.assignee_user_id').on('users.organization_id', '=', organizationId),
          )
          .leftJoin('categories', (join) =>
            join
              .onRef('categories.id', '=', 'tasks.category_id')
              .on('categories.workspace_id', '=', workspaceId)
              .on('categories.deleted_at', 'is', null),
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
            'tasks.assignee_user_id',
            'users.name as assignee_name',
            'categories.id as category_ref_id',
            'categories.name as category_name',
            'repositories.id as repository_ref_id',
            'repositories.name as repository_name',
          ])
          .where('tasks.completed_at', 'is', null)
          .orderBy('tasks.position')
          .orderBy('tasks.id'),
      ),
      db.statement((q) =>
        backlogTasksUnder(q, workspaceId, null)
          .select((eb) => eb.fn.countAll<number>().as('count'))
          .where('tasks.completed_at', 'is not', null),
      ),
    ] as const);

  const settings = workspaceResult.rows[0];
  if (settings === undefined) throw new ApiError(404, 'not_found');

  type Row = {
    id: string;
    title: string;
    points: number | null;
    due_on: string | null;
    assignee_user_id: string | null;
    assignee_name: string | null;
    repository_ref_id: string | null;
    repository_name: string | null;
  };
  type Ref = { id: string; name: string } | null;
  // category は引き継ぎを解いた区分（親のないタスクは自身の区分、ストーリーの下のタスクは親の区分）
  const taskOf = (row: Row, category: Ref) => ({
    id: row.id,
    title: row.title,
    points: row.points as TaskPoints,
    due_on: row.due_on,
    assignee: row.assignee_user_id === null ? null : { id: row.assignee_user_id, name: row.assignee_name ?? '' },
    category,
    repository: refOf(row.repository_ref_id, row.repository_name),
  });

  // 区分は、エピック、ストーリー、タスクの順に引き継ぐ。エピックの区分を先に引いておく
  const epicCategories = new Map<string, Ref>(
    epicsResult.rows.map((epic) => [epic.id, refOf(epic.category_ref_id, epic.category_name)]),
  );
  type StoryRow = (typeof storiesResult.rows)[number];
  const storyCategoryOf = (story: StoryRow): Ref =>
    story.epic_id === null
      ? refOf(story.category_ref_id, story.category_name)
      : (epicCategories.get(story.epic_id) ?? null);
  const storyCategories = new Map<string, Ref>(storiesResult.rows.map((story) => [story.id, storyCategoryOf(story)]));

  // position の順（同じ値なら id の順）。position は fractional-indexing の ASCII の文字列なので、文字列の比較が SQLite の並びと同じ
  const byPosition = (a: { position: string; id: string }, b: { position: string; id: string }) =>
    a.position === b.position ? (a.id < b.id ? -1 : 1) : a.position < b.position ? -1 : 1;
  const tasksByStory = new Map<string, ReturnType<typeof taskOf>[]>();
  for (const row of [...storyTasksResult.rows].sort(byPosition)) {
    const list = tasksByStory.get(row.story_id!) ?? [];
    list.push(taskOf(row, storyCategories.get(row.story_id!) ?? null));
    tasksByStory.set(row.story_id!, list);
  }
  const totalsByStory = new Map(totalsResult.rows.map((row) => [row.story_id!, row]));

  // 応答には epic_id を載せない（親はエピックの行の配下に並べることで示す）
  const storyOf = (story: StoryRow) => {
    const totals = totalsByStory.get(story.id);
    return {
      id: story.id,
      title: story.title,
      due_on: story.due_on,
      link_url: story.link_url,
      completed_at: story.completed_at,
      category: storyCategories.get(story.id) ?? null,
      tasks: tasksByStory.get(story.id) ?? [],
      completed_task_count: Number(totals?.completed_count ?? 0),
      points_done: Number(totals?.points_done ?? 0),
      points_all: Number(totals?.points_all ?? 0),
    };
  };
  // エピックごとの配下のストーリー（position の順のまま分ける）
  const storiesByEpic = new Map<string, ReturnType<typeof storyOf>[]>();
  const rootStories: ReturnType<typeof storyOf>[] = [];
  for (const row of storiesResult.rows) {
    if (row.epic_id === null) {
      rootStories.push(storyOf(row));
      continue;
    }
    const list = storiesByEpic.get(row.epic_id) ?? [];
    list.push(storyOf(row));
    storiesByEpic.set(row.epic_id, list);
  }

  return {
    today: todayIn(settings.timezone),
    week_start: settings.week_start,
    // 区分を結んだ列（category_ref_id、category_name）は、出力のスキーマに無いので応答から落ちる
    epics: epicsResult.rows.map((epic) => {
      const stories = storiesByEpic.get(epic.id) ?? [];
      return {
        ...epic,
        category: epicCategories.get(epic.id) ?? null,
        stories,
        points_done: stories.reduce((sum, story) => sum + story.points_done, 0),
        points_all: stories.reduce((sum, story) => sum + story.points_all, 0),
      };
    }),
    stories: rootStories,
    tasks: rootOpenResult.rows.map((row) => taskOf(row, refOf(row.category_ref_id, row.category_name))),
    completed_count: Number(rootDoneResult.rows[0]?.count ?? 0),
  };
});

// 完了の記録の列。INSERT ... SELECT の選ぶ列の並びと合わせる
const completionColumns = [
  'id',
  'workspace_id',
  'task_id',
  'completed_at',
  'completed_by',
  'points',
  'assignee_user_id',
  'sprint_id',
  'category_id',
  'billing_month',
  'created_at',
  'updated_at',
] as const;

const grantColumns = [
  'id',
  'workspace_id',
  'user_id',
  'action',
  'task_id',
  'completion_id',
  'amount',
  'dedupe_key',
  'confirmed_at',
] as const;

// 自分の文が入れた完了の記録がある、という条件。後続の文はこれで、先に入った文が通ったかを見る
function completionExists(eb: Pick<QueryCreator<Tables>, 'selectFrom'>, workspaceId: string, completionId: string) {
  return eb
    .selectFrom('completions')
    .select('completions.id')
    .where('completions.id', '=', completionId)
    .where('completions.workspace_id', '=', workspaceId);
}

type CompletionParams = {
  workspaceId: string;
  taskId: string;
  completionId: string;
  userId: string;
  at: string;
};

// 起票と完了の経験値の1行。ポイント、起票した人、担当は先に読まず、tasks の行から取る。
// 条件は、ポイントが 1 以上（完了にした時点の値）と、自分の完了の記録が入ったこと
function grantStatement(
  db: OrganizationDb,
  params: CompletionParams,
  grant: { id: string; action: 'task_created' | 'task_completed'; amount: number },
) {
  const { workspaceId, taskId, completionId, userId, at } = params;
  return db.statement((q) =>
    q
      .insertInto('xp_grants')
      .columns(grantColumns)
      .expression(
        q
          .selectFrom('tasks')
          .select((eb) => [
            eb.val(grant.id).as('id'),
            'tasks.workspace_id as workspace_id',
            // 起票は作った人へ。完了は完了した時点の担当者へ、担当がいなければ完了にした人へ
            grant.action === 'task_created'
              ? eb.ref('tasks.created_by').as('user_id')
              : eb.fn.coalesce('tasks.assignee_user_id', eb.val(userId)).as('user_id'),
            eb.val(grant.action).as('action'),
            'tasks.id as task_id',
            eb.val(completionId).as('completion_id'),
            eb.val(grant.amount).as('amount'),
            eb.val(`${grant.action}:${completionId}`).as('dedupe_key'),
            eb.val(at).as('confirmed_at'),
          ])
          .where((eb) =>
            eb.and([
              eb('tasks.id', '=', taskId),
              eb('tasks.workspace_id', '=', workspaceId),
              eb('tasks.points', '>=', MIN_POINTS_FOR_EXPERIENCE),
              ...(grant.action === 'task_created' ? [eb('tasks.created_by', 'is not', null)] : []),
              // 受け取る人は、このワークスペースに今所属している人だけ（所属していない管理者は経験値の対象にならない）
              eb.exists(
                eb
                  .selectFrom('memberships')
                  .select('memberships.id')
                  .where('memberships.workspace_id', '=', workspaceId)
                  .where('memberships.left_at', 'is', null)
                  .where(
                    'memberships.user_id',
                    '=',
                    grant.action === 'task_created'
                      ? eb.ref('tasks.created_by')
                      : eb.fn.coalesce('tasks.assignee_user_id', eb.val(userId)),
                  ),
              ),
              eb.exists(completionExists(q, workspaceId, completionId)),
            ]),
          ),
      ),
  );
}

export const taskCompleteOperation = implement(taskComplete, async ({ db, actor, workspace, input }) => {
  const userId = actorUserIdOf(actor);
  const organizationId = db.organizationId;
  const workspaceId = workspace.workspaceId;
  const taskId = input.task_id;

  // 計上月を決めるタイムゾーンと、履歴に残す自分の名前。ポイント、担当、区分は読まず、書く文が tasks の行から取る
  const [workspaceResult, userResult] = await db.batch([
    db.statement((q) =>
      q
        .selectFrom('workspaces')
        .select('timezone')
        .where('id', '=', workspaceId)
        .where('organization_id', '=', organizationId),
    ),
    db.statement((q) =>
      q.selectFrom('users').select('name').where('id', '=', userId).where('organization_id', '=', organizationId),
    ),
  ] as const);
  const timezone = workspaceResult.rows[0]?.timezone;
  const userName = userResult.rows[0]?.name;
  if (timezone === undefined || userName === undefined) throw new ApiError(404, 'not_found');

  const at = now();
  const completedAt = at.toISOString();
  const params: CompletionParams = { workspaceId, taskId, completionId: uuidv7(at), userId, at: completedAt };
  const { completionId } = params;
  const billingMonth = monthIn(timezone, at);

  const results = await db.batch([
    // 1. tasks。変わった行が0なら、タスクが無い（この版の完了の前提に当たらないタスクを含む）か、すでに完了。
    // 前提は、スプリントに入っていないバックログのタスク（親のないタスクと、ストーリーの下のタスク）
    db.statement((q) =>
      q
        .updateTable('tasks')
        .set({ completed_at: completedAt, completed_by: userId, updated_at: completedAt })
        .where('id', '=', taskId)
        .where('workspace_id', '=', workspaceId)
        .where('tray', '=', 'backlog')
        .where('sprint_id', 'is', null)
        .where('completed_at', 'is', null)
        .where('deleted_at', 'is', null)
        .where((eb) => eb.exists(openWorkspace(q, organizationId, workspaceId))),
    ),
    // 2. completions。止めた時計で同じ人が2回完了にしても、先に入った記録があれば何も入らない
    db.statement((q) =>
      q
        .insertInto('completions')
        .columns(completionColumns)
        .expression(
          q
            .selectFrom('tasks')
            // 区分は、親のストーリーの親のエピック、ストーリー、タスクの順に、最初に入っているものを使う
            .leftJoin('stories', (join) =>
              join.onRef('stories.id', '=', 'tasks.story_id').onRef('stories.workspace_id', '=', 'tasks.workspace_id'),
            )
            .leftJoin('epics', (join) =>
              join.onRef('epics.id', '=', 'stories.epic_id').onRef('epics.workspace_id', '=', 'tasks.workspace_id'),
            )
            // 段ごとに、同じワークスペースの区分だけを結ぶ。別のワークスペースの区分が結ばれていても、その段は飛ばして次の段へ下りる
            .leftJoin('categories as ec', (join) =>
              join.onRef('ec.id', '=', 'epics.category_id').onRef('ec.workspace_id', '=', 'tasks.workspace_id'),
            )
            .leftJoin('categories as sc', (join) =>
              join.onRef('sc.id', '=', 'stories.category_id').onRef('sc.workspace_id', '=', 'tasks.workspace_id'),
            )
            .leftJoin('categories as tc', (join) =>
              join.onRef('tc.id', '=', 'tasks.category_id').onRef('tc.workspace_id', '=', 'tasks.workspace_id'),
            )
            .select((eb) => [
              eb.val(completionId).as('id'),
              'tasks.workspace_id as workspace_id',
              'tasks.id as task_id',
              'tasks.completed_at as completed_at',
              'tasks.completed_by as completed_by',
              'tasks.points as points',
              'tasks.assignee_user_id as assignee_user_id',
              'tasks.sprint_id as sprint_id',
              eb.fn.coalesce('ec.id', 'sc.id', 'tc.id').as('category_id'),
              // 引き継いだ区分が月ごとに計上するときだけ入る。既定は完了した月（ワークスペースのタイムゾーン）
              eb
                .case()
                .when(
                  eb
                    .case()
                    .when('ec.id', 'is not', null)
                    .then(eb.ref('ec.is_billed_monthly'))
                    .when('sc.id', 'is not', null)
                    .then(eb.ref('sc.is_billed_monthly'))
                    .else(eb.ref('tc.is_billed_monthly'))
                    .end(),
                  '=',
                  1,
                )
                .then(billingMonth)
                .else(null)
                .end()
                .as('billing_month'),
              eb.val(completedAt).as('created_at'),
              eb.val(completedAt).as('updated_at'),
            ])
            .where((eb) =>
              eb.and([
                eb('tasks.id', '=', taskId),
                eb('tasks.workspace_id', '=', workspaceId),
                eb('tasks.completed_at', '=', completedAt),
                eb('tasks.completed_by', '=', userId),
                eb.not(
                  eb.exists(
                    eb
                      .selectFrom('completions')
                      .select('completions.id')
                      .where('completions.workspace_id', '=', workspaceId)
                      .where('completions.task_id', '=', taskId)
                      .where('completions.completed_at', '=', completedAt),
                  ),
                ),
              ]),
            ),
        ),
    ),
    // 3. xp_grants。起票と完了
    grantStatement(db, params, { id: uuidv7(at), action: 'task_created', amount: XP_TASK_CREATED }),
    grantStatement(db, params, { id: uuidv7(at), action: 'task_completed', amount: XP_TASK_COMPLETED }),
    // 4. change_logs。3 と同じく、自分の完了の記録が入ったときだけ
    db.statement((q) =>
      q
        .insertInto('change_logs')
        .columns([
          'id',
          'organization_id',
          'workspace_id',
          'actor_user_id',
          'entity_type',
          'entity_id',
          'action',
          'changes_json',
          'created_at',
        ])
        .expression(
          q
            .selectNoFrom((eb) => [
              eb.val(uuidv7(at)).as('id'),
              eb.val(organizationId).as('organization_id'),
              eb.val(workspaceId).as('workspace_id'),
              eb.val(userId).as('actor_user_id'),
              eb.val('task').as('entity_type'),
              eb.val(taskId).as('entity_id'),
              eb.val('complete').as('action'),
              eb
                .val(
                  JSON.stringify({
                    completed_at: [null, completedAt],
                    completed_by: [null, { id: userId, name: userName }],
                  }),
                )
                .as('changes_json'),
              eb.val(completedAt).as('created_at'),
            ])
            .where((eb) => eb.exists(completionExists(q, workspaceId, completionId))),
        ),
    ),
  ]);

  if ((results[0]?.changes ?? 0) === 0) {
    // 先に読んだ値ではなく、書いた結果で決める。読んでから書くまでに閉じたなら 409 の workspace_closed、
    // タスクが無い（別の組織のタスクと、この版の完了の前提に当たらないタスクを含む）なら 404、
    // あるのに変わらなければ完了済みの 409 の conflict
    await throwIfClosed(db, workspaceId);
    const existing = await db.first(
      db.statement((q) =>
        q
          .selectFrom('tasks')
          .select('tasks.id')
          .where('tasks.id', '=', taskId)
          .where('tasks.workspace_id', '=', workspaceId)
          .where('tasks.tray', '=', 'backlog')
          .where('tasks.sprint_id', 'is', null)
          .where('tasks.deleted_at', 'is', null),
      ),
    );
    throw existing === undefined ? new ApiError(404, 'not_found') : new ApiError(409, 'conflict');
  }
  return { task_id: taskId, completed_at: completedAt };
});

// 移す先の並び（親の配下か、親のないタスク）から、移すタスクを除いたもの。完了したタスクも並びに残っているので含める
function siblingTasks(
  from: Pick<QueryCreator<Tables>, 'selectFrom'>,
  workspaceId: string,
  storyId: string | null,
  taskId: string,
) {
  return backlogTasksUnder(from, workspaceId, storyId).where('tasks.id', '!=', taskId);
}

// 移すタスクの新しい位置と、読んだ直前の行を決める。直前の行が移す先に無ければ 404。親の行の全件は読まず、直前の行と同じ値の行
// （上限 MAX_TIES より1行多くまで）と、それより大きい値の最初の行だけを読む
async function planTaskMove(
  db: OrganizationDb,
  workspaceId: string,
  storyId: string | null,
  taskId: string,
  afterId: string | null | undefined,
): Promise<{ plan: MovePlan; after: Positioned | null }> {
  const columns = ['tasks.id', 'tasks.position'] as const;
  if (afterId === undefined) {
    const last = await db.first(
      db.statement((q) =>
        siblingTasks(q, workspaceId, storyId, taskId)
          .select(columns)
          .orderBy('tasks.position', 'desc')
          .orderBy('tasks.id', 'desc')
          .limit(1),
      ),
    );
    return { plan: placeLast(last), after: null };
  }
  if (afterId === null) {
    const first = await db.first(
      db.statement((q) =>
        siblingTasks(q, workspaceId, storyId, taskId)
          .select(columns)
          .orderBy('tasks.position')
          .orderBy('tasks.id')
          .limit(1),
      ),
    );
    return { plan: placeFirst(first), after: null };
  }
  const after = await db.first(
    db.statement((q) => siblingTasks(q, workspaceId, storyId, taskId).select(columns).where('tasks.id', '=', afterId)),
  );
  if (after === undefined) throw new ApiError(404, 'not_found');
  const [ties, next] = await db.batch([
    db.statement((q) =>
      siblingTasks(q, workspaceId, storyId, taskId)
        .select(columns)
        .where('tasks.position', '=', after.position)
        .where('tasks.id', '>', after.id)
        .orderBy('tasks.id')
        .limit(MAX_TIES + 1),
    ),
    db.statement((q) =>
      siblingTasks(q, workspaceId, storyId, taskId)
        .select(columns)
        .where('tasks.position', '>', after.position)
        .orderBy('tasks.position')
        .orderBy('tasks.id')
        .limit(1),
    ),
  ] as const);
  return { plan: placeAfter(after, ties.rows, next.rows[0]), after };
}

// 移す先の親のストーリーを読む。無ければ 404。親が変わるときだけ、完了していれば 409（parent_completed）。
// 同じ親の中の並べ替えは、完了したストーリーの下でもできる
async function readMoveParent(db: OrganizationDb, workspaceId: string, storyId: string, changing: boolean) {
  const story = await db.first(
    db.statement((q) =>
      storyRow(q, workspaceId, storyId).select(['stories.id', 'stories.title', 'stories.completed_at']),
    ),
  );
  if (story === undefined) throw new ApiError(404, 'not_found');
  if (changing && story.completed_at !== null) throw moveConflict('parent_completed');
  return { id: story.id, title: story.title };
}

// 移すタスク。削除していないバックログのタスクで、今の親の題と区分の名前（履歴に残す）も読む
function movingTask(db: OrganizationDb, workspaceId: string, taskId: string) {
  return db.first(
    db.statement((q) =>
      q
        .selectFrom('tasks')
        .leftJoin('stories', (join) =>
          join.onRef('stories.id', '=', 'tasks.story_id').onRef('stories.workspace_id', '=', 'tasks.workspace_id'),
        )
        .leftJoin('categories', (join) =>
          join
            .onRef('categories.id', '=', 'tasks.category_id')
            .onRef('categories.workspace_id', '=', 'tasks.workspace_id'),
        )
        .select([
          'tasks.id',
          'tasks.story_id',
          'tasks.completed_at',
          'tasks.category_id',
          'stories.title as story_title',
          'categories.name as category_name',
        ])
        .where('tasks.id', '=', taskId)
        .where('tasks.workspace_id', '=', workspaceId)
        .where('tasks.tray', '=', 'backlog')
        .where('tasks.deleted_at', 'is', null),
    ),
  );
}

export const taskMoveOperation = implement(taskMove, async ({ db, actor, workspace, input }) => {
  const actorUserId = actorUserIdOf(actor);
  const organizationId = db.organizationId;
  const workspaceId = workspace.workspaceId;
  const taskId = input.task_id;
  const afterId = input.after_task_id;
  if (afterId === taskId) throw new ApiError(400, 'invalid_input');

  // 移すタスクが無ければ 404、完了していれば 409（task_completed）。完了したタスクは画面に行が無く、並べ替えの対象にしない
  const current = await movingTask(db, workspaceId, taskId);
  if (current === undefined) throw new ApiError(404, 'not_found');
  if (current.completed_at !== null) throw moveConflict('task_completed');

  // 移す先の親は、同じワークスペースの削除していないストーリー。無ければ 404。親が変わるなら、完了していれば 409
  const parentId = input.story_id;
  const parentChanged = current.story_id !== parentId;
  const parent = parentId === null ? null : await readMoveParent(db, workspaceId, parentId, parentChanged);
  // ストーリーの下へ移して区分が消えるときは、前の区分を履歴に残す。親が変わってストーリーの下へ移すときは、
  // 書く文は区分が読んだ値（空も含む）のままであることも条件にする。読んだ後に付いた区分を、履歴なしに消さないため
  const guardsCategory = parentChanged && parentId !== null;
  const clearedCategory =
    parentChanged && parentId !== null && current.category_id !== null
      ? { id: current.category_id, name: current.category_name ?? '' }
      : null;
  const { plan, after } = await planTaskMove(db, workspaceId, parentId, taskId, afterId);

  const at = now();
  const updatedAt = at.toISOString();
  // 自分の更新が通った、という条件。振り直しと履歴は、これを自分の条件に持つ（batch() は件数 0 の文があっても後ろの文を書く）
  const moved = (from: Pick<QueryCreator<Tables>, 'selectFrom'>) =>
    from
      .selectFrom('tasks')
      .select('tasks.id')
      .where('tasks.id', '=', taskId)
      .where('tasks.workspace_id', '=', workspaceId)
      .where('tasks.story_id', parentId === null ? 'is' : '=', parentId)
      .where('tasks.position', '=', plan.position)
      .where('tasks.updated_at', '=', updatedAt);

  const results = await db.batch([
    // 条件は、読んだときの親のままで、閉じていないワークスペース、移す先の親（親が変わるなら完了していない）が今もあり、
    // 直前の行が今も読んだ値の位置にあること
    db.statement((q) =>
      q
        .updateTable('tasks')
        .set({
          story_id: parentId,
          position: plan.position,
          updated_at: updatedAt,
          // 区分は親のないタスクにだけ入る。ストーリーの下へ移したら空にする
          ...(parentId === null ? {} : { category_id: null }),
        })
        .where('id', '=', taskId)
        .where('workspace_id', '=', workspaceId)
        .where('tray', '=', 'backlog')
        .where('completed_at', 'is', null)
        .where('deleted_at', 'is', null)
        .where('story_id', current.story_id === null ? 'is' : '=', current.story_id)
        .$if(guardsCategory, (qb) =>
          qb.where('category_id', current.category_id === null ? 'is' : '=', current.category_id),
        )
        .where((eb) => eb.exists(openWorkspace(q, organizationId, workspaceId)))
        .$if(parentId !== null, (qb) =>
          qb.where((eb) =>
            eb.exists(
              storyRow(q, workspaceId, parentId!)
                .select('stories.id')
                .$if(parentChanged, (sb) => sb.where('stories.completed_at', 'is', null)),
            ),
          ),
        )
        .$if(after !== null, (qb) =>
          qb.where((eb) =>
            eb.exists(
              siblingTasks(q, workspaceId, parentId, taskId)
                .select('tasks.id')
                .where('tasks.id', '=', after!.id)
                .where('tasks.position', '=', after!.position),
            ),
          ),
        ),
    ),
    // 同じ値の行の振り直し。読んだときの値のままの行だけを書く
    ...plan.renumber.map((row) =>
      db.statement((q) =>
        q
          .updateTable('tasks')
          .set({ position: row.to, updated_at: updatedAt })
          .where('id', '=', row.id)
          .where('workspace_id', '=', workspaceId)
          .where('story_id', parentId === null ? 'is' : '=', parentId)
          .where('position', '=', row.from)
          .where('deleted_at', 'is', null)
          .where((eb) => eb.exists(moved(q))),
      ),
    ),
    // 親が変わったときだけ履歴を書く。並べ替えだけなら残さない
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
                    eb.val('task').as('entity_type'),
                    eb.val(taskId).as('entity_id'),
                    eb.val('update').as('action'),
                    eb
                      .val(
                        JSON.stringify({
                          story: [
                            current.story_id === null ? null : { id: current.story_id, title: current.story_title },
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
    // 読んでから書くまでに、閉じたか、タスクが消えたか完了したか、親か直前の行が消えたか、親が完了したか、
    // 別の要求が先に親を移したか直前の行を動かした
    await throwIfClosed(db, workspaceId);
    const latest = await movingTask(db, workspaceId, taskId);
    if (latest === undefined) throw new ApiError(404, 'not_found');
    if (latest.completed_at !== null) throw moveConflict('task_completed');
    if (parentId !== null) await readMoveParent(db, workspaceId, parentId, parentChanged);
    if (afterId != null) await planTaskMove(db, workspaceId, parentId, taskId, afterId);
    throw moveConflict('changed');
  }
  return { task_id: taskId, story_id: parentId };
});
