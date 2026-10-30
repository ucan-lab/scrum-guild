import { generateKeyBetween } from 'fractional-indexing';
import { monthIn, now, todayIn, weekRangeIn } from '../../shared/clock.ts';
import { XP_HELP, XP_HELP_WEEKLY_LIMIT, XP_TASK_COMPLETED, XP_TASK_CREATED } from '../../shared/experience.ts';
import { backlogTree, taskComplete, taskCreate, taskMove } from '../../shared/operations/task/index.ts';
import { searchWordsOf } from '../../shared/backlog-filter.ts';
import { MIN_POINTS_FOR_EXPERIENCE } from '../../shared/task.ts';
import {
  sprintLeftLogSql,
  titleContainsAll,
  unindexed,
  type ExpressionBuilder,
  type OrganizationDb,
  type OrganizationTables,
  type QueryCreator,
} from '../db/index.ts';
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
import { taskAssigneePartyStatements } from './epic-party.ts';
import { implement } from './implement.ts';
import { sprintRefColumns, sprintRefOf, type SprintRefRow } from './sprint-refs.ts';
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
// 木の読み取りと、末尾の位置を決める読み取りと、並べ替えの兄弟を引く読み取りが同じ範囲を使う。
// tasks_story は story_id が NULL の行を全組織のぶん持ち（workspace_id を持たない）、ANALYZE の後は SQLite が NULL を別々の値と
// 数えて tasks_story を選び、全組織の親のないタスクを読んでから絞る計画に変わる。親なしの分岐は列を索引に使わせず（unindexed）、
// tasks_workspace_tray で引かせる。ストーリーの分岐は story_id の等号で tasks_story を使う
// （docs/data-model.md の「バックログの木」。test/backlog-filter.test.ts が ANALYZE の後の実行計画で確かめる）
function backlogTasksUnder(
  from: Pick<QueryCreator<Tables>, 'selectFrom'>,
  workspaceId: string,
  storyId: string | null,
) {
  const tasks = from
    .selectFrom('tasks')
    .where('tasks.workspace_id', '=', workspaceId)
    .where('tasks.tray', '=', 'backlog')
    .where('tasks.deleted_at', 'is', null);
  return storyId === null
    ? tasks.where(unindexed('tasks.story_id'), 'is', null)
    : tasks.where('tasks.story_id', '=', storyId);
}

// 起票で、親の配下（親なしなら親のないタスク）の末尾の位置を決めるために、いちばん後ろの行の position を読む文
export function lastPositionStatement(db: OrganizationDb, workspaceId: string, storyId: string | null) {
  return db.statement((q) =>
    backlogTasksUnder(q, workspaceId, storyId).select('tasks.position').orderBy('tasks.position', 'desc').limit(1),
  );
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
  const last = await db.first(lastPositionStatement(db, workspaceId, parentId));
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
    // 担当つきで親のストーリーの下に作ったら、そのストーリーの親の進行中のエピックの討伐隊に、担当を task_assignee で足す
    // （既にいれば何もしない）。直前のタスクの履歴が入った（= タスクを作れた）ときだけ。親のないタスクと担当なしでは文を足さない
    ...(assignee === null || parent === null
      ? []
      : taskAssigneePartyStatements(db, {
          workspaceId,
          taskId,
          assignee,
          actorUserId,
          at,
          taskUpdatedAt: createdAt,
        })),
  ]);

  // 読んでから書くまでに、ワークスペースが閉じたか、担当が所属を外れたか、親が消えたか完了したか、区分かリポジトリが削除されたら何も入らない
  if ((results[0]?.changes ?? 0) === 0) {
    await throwIfClosed(db, workspaceId);
    // 親が消えていれば 404、完了していれば 409。親は無事なら、担当が外れたか区分かリポジトリが消えたので 404
    if (parent !== null) await readParentStory(db, workspaceId, parent.id);
    throw new ApiError(404, 'not_found');
  }
  return {
    task: {
      id: taskId,
      title: input.title,
      points: input.points,
      due_on: null,
      assignee,
      category,
      repository,
      sprint: null,
    },
  };
});

type TaskPoints = 0 | 1 | 2 | 3 | 5 | 8 | 13 | null;

// ストーリー（親のないものとエピックの下のもの）の配下の、削除していないバックログのタスク。ストーリーから引いてタスクを結ぶ
// （FROM stories CROSS JOIN tasks）。SQLite は INNER JOIN だと、親のないタスクも含めた tasks_workspace_tray を先に走査する計画を
// 選ぶので、CROSS JOIN で順序を固定し、ストーリー側を `stories_workspace_epic` の先頭の列（workspace_id）で、タスク側を
// `tasks_story`（story_id, position の部分索引。未完了だけを読む文は `tasks_story_open`）で引く（結ぶ条件は WHERE に書く）。
// 両側をワークスペースで絞る
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

// users の行の人が、そのワークスペースに今所属していて担当にできる人か（activeMemberName、member-list と同じ条件）
function currentMember(eb: ExpressionBuilder<Tables, 'users'>, workspaceId: string) {
  return eb.and([
    eb('users.disabled_at', 'is', null),
    eb('users.login_subject', 'is not', null),
    eb.exists(
      eb
        .selectFrom('memberships as m')
        .select('m.id')
        .whereRef('m.user_id', '=', 'users.id')
        .where('m.workspace_id', '=', workspaceId)
        .where('m.left_at', 'is', null),
    ),
  ]);
}

// バックログの木の絞り込み（定義の backlog-tree.ts）。undefined は絞らない、null は「なし」。words は検索の語（空なら検索しない）
export type BacklogTreeFilter = {
  assignee?: string | null;
  category?: string | null;
  repository?: string | null;
  epic?: string | null;
  words: readonly string[];
};

// ストーリーの下の未完了のタスク。ORDER BY を付けると SQLite が tasks_story_open を使わない計画を選ぶので、並べるのは読んだ後に行う。
// 区分は親から引き継ぐので、タスク自身の区分は読まない。
// 絞り込みは WHERE に足す。区分、エピック、検索は、タスクか親（ストーリー、その親のエピック）のどれかが当たれば当たり
// （区分とエピックは親から引き継ぐので、親で決まる）。担当とリポジトリは、タスク自身で決める。
// 担当の列は索引に使わせない（tasks_story_open を足す前は、SQLite が tasks_story の代わりに tasks_assignee_user をストーリーごとに
// 引く計画を選び、5 万件で 10 秒かかった。tasks_story_open があれば今はそれを選ぶが、計画が揺れないよう止めておく。
// test/backlog-filter.test.ts が実行計画で確かめる）
export function openStoryTasksStatement(db: OrganizationDb, workspaceId: string, filter: BacklogTreeFilter) {
  const { assignee, category, repository, epic, words } = filter;
  const organizationId = db.organizationId;
  return db.statement((q) =>
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
      // 入っているスプリント。同じワークスペースの削除していないものだけを結ぶ（下の親のないタスクも同じ）
      .leftJoin('sprints', (join) =>
        join
          .onRef('sprints.id', '=', 'tasks.sprint_id')
          .on('sprints.workspace_id', '=', workspaceId)
          .on('sprints.deleted_at', 'is', null),
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
        ...sprintRefColumns,
      ])
      .where('tasks.completed_at', 'is', null)
      .$if(assignee !== undefined, (qb) =>
        qb.where(unindexed('tasks.assignee_user_id'), assignee === null ? 'is' : '=', assignee!),
      )
      .$if(repository !== undefined, (qb) => qb.where('repositories.id', repository === null ? 'is' : '=', repository!))
      .$if(category !== undefined, (qb) =>
        qb.where((eb) => {
          // 引き継ぎを解いた区分の ID（親のないストーリーは自身の区分、エピックの下ならエピックの区分）。
          // 削除した区分を指していることもあるので、同じワークスペースの削除していない区分かも確かめる
          const resolved = eb
            .case()
            .when('stories.epic_id', 'is', null)
            .then(eb.ref('stories.category_id'))
            .else(
              eb
                .selectFrom('epics as parent_epic')
                .select('parent_epic.category_id')
                .whereRef('parent_epic.id', '=', 'stories.epic_id')
                .where('parent_epic.workspace_id', '=', workspaceId),
            )
            .end();
          const live = eb
            .selectFrom('categories as live_category')
            .select('live_category.id')
            .where('live_category.workspace_id', '=', workspaceId)
            .where('live_category.deleted_at', 'is', null);
          return category === null
            ? eb.not(eb.exists(live.where('live_category.id', '=', resolved)))
            : eb.and([eb(resolved, '=', category!), eb.exists(live.where('live_category.id', '=', category!))]);
        }),
      )
      .$if(epic !== undefined, (qb) => qb.where('stories.epic_id', epic === null ? 'is' : '=', epic!))
      .$if(words.length > 0, (qb) =>
        qb.where((eb) =>
          eb.or([
            titleContainsAll('tasks.title', words),
            titleContainsAll('stories.title', words),
            eb.exists(
              eb
                .selectFrom('epics as hit_epic')
                .select('hit_epic.id')
                .whereRef('hit_epic.id', '=', 'stories.epic_id')
                .where('hit_epic.workspace_id', '=', workspaceId)
                .where(titleContainsAll('hit_epic.title', words)),
            ),
          ]),
        ),
      ),
  );
}

// 親のない未完了のタスク。story_id は backlogTasksUnder が索引に使わせず、tasks_workspace_tray で引く
// （test/backlog-filter.test.ts が ANALYZE の後の実行計画で確かめる）
export function rootOpenTasksStatement(db: OrganizationDb, workspaceId: string, filter: BacklogTreeFilter) {
  const { assignee, category, repository, epic, words } = filter;
  const organizationId = db.organizationId;
  return db.statement((q) =>
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
      .leftJoin('sprints', (join) =>
        join
          .onRef('sprints.id', '=', 'tasks.sprint_id')
          .on('sprints.workspace_id', '=', workspaceId)
          .on('sprints.deleted_at', 'is', null),
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
        ...sprintRefColumns,
      ])
      .where('tasks.completed_at', 'is', null)
      .$if(assignee !== undefined, (qb) =>
        qb.where('tasks.assignee_user_id', assignee === null ? 'is' : '=', assignee!),
      )
      .$if(repository !== undefined, (qb) => qb.where('repositories.id', repository === null ? 'is' : '=', repository!))
      .$if(category !== undefined, (qb) => qb.where('categories.id', category === null ? 'is' : '=', category!))
      // 親のないタスクはエピックの下に無いので、エピックで絞ると（エピックなしを除いて）どれも当たらない
      .$if(typeof epic === 'string', (qb) => qb.limit(0))
      .$if(words.length > 0, (qb) => qb.where(titleContainsAll('tasks.title', words)))
      .orderBy('tasks.position')
      .orderBy('tasks.id'),
  );
}

// 親のない完了したタスクの件数（行は返さない）
export function rootCompletedCountStatement(db: OrganizationDb, workspaceId: string) {
  return db.statement((q) =>
    backlogTasksUnder(q, workspaceId, null)
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .where('tasks.completed_at', 'is not', null),
  );
}

// 件数に上限を付けない（5 万件で測った数は docs/data-model.md）。
// ストーリーは親のないものとエピックの下のものを1つの文で読み、epic_id で分ける。削除したエピックの下のストーリーも
// （その配下のタスクも）読むが、エピックの一覧に親が無いので、どこにも並べずに捨てる。
// 絞り込み（定義の backlog-tree.ts）は、タスクの2つの文の WHERE で絞る。ストーリーとエピックは全部読み（ポイントの合計を全体の値で返し、
// 親そのものが当たるかを決めるため）、検索の語がそろうかの印（title_hit）だけを足して、どれを残すかをここで決める
export const backlogTreeOperation = implement(backlogTree, async ({ db, actor, workspace, input }) => {
  const organizationId = db.organizationId;
  const workspaceId = workspace.workspaceId;
  // 'me' は呼んだ人。users の行が無い人（型の上だけ）は、どのタスクにも当たらない空の ID にする
  const assignee = input.assignee_user_id === 'me' ? (actor.userId ?? '') : input.assignee_user_id;
  const category = input.category_id;
  const repository = input.repository_id;
  const epic = input.epic_id;
  const words = input.query === undefined ? [] : searchWordsOf(input.query);
  const searching = words.length > 0;
  // タスクにしか無い条件（担当、リポジトリ）で絞っているか。そのときは、当たるタスクを持たない親を出さない
  const taskOnly = assignee !== undefined || repository !== undefined;
  const filtering = taskOnly || category !== undefined || epic !== undefined || searching;
  const filter: BacklogTreeFilter = { assignee, category, repository, epic, words };
  const [
    workspaceResult,
    epicsResult,
    storiesResult,
    storyTasksResult,
    totalsResult,
    rootOpenResult,
    rootDoneResult,
    assigneesResult,
  ] = await db.batch([
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
        // 検索しているときだけ、エピックの題が語をそろえて含むかを足す（1 か 0）
        .$if(searching, (qb) => qb.select(titleContainsAll('epics.title', words).as('title_hit')))
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
        .$if(searching, (qb) => qb.select(titleContainsAll('stories.title', words).as('title_hit')))
        .where('stories.workspace_id', '=', workspaceId)
        .where('stories.deleted_at', 'is', null)
        .orderBy('stories.position')
        .orderBy('stories.id'),
    ),
    openStoryTasksStatement(db, workspaceId, filter),
    // ストーリーごとの、完了した件数とポイントの合計。未見積もりは 0
    db.statement((q) =>
      tasksUnderStories(q, workspaceId)
        .select((eb) => [
          'stories.id as story_id',
          eb.fn
            .sum<number>(eb.case().when('tasks.completed_at', 'is not', null).then(1).else(0).end())
            .as('completed_count'),
          eb.fn.sum<number>(eb.case().when('tasks.completed_at', 'is', null).then(1).else(0).end()).as('open_count'),
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
    rootOpenTasksStatement(db, workspaceId, filter),
    rootCompletedCountStatement(db, workspaceId),
    // 担当の絞り込みの選択肢。今所属している人（担当にできる人と同じ条件）と、未完了のバックログのタスクの担当に残っている人
    db.statement((q) =>
      q
        .selectFrom('users')
        .select((eb) => ['users.id', 'users.name', currentMember(eb, workspaceId).as('is_current')])
        .where('users.organization_id', '=', organizationId)
        .where((eb) =>
          eb.or([
            currentMember(eb, workspaceId),
            eb.exists(
              eb
                .selectFrom('tasks as assigned')
                .select('assigned.id')
                .whereRef('assigned.assignee_user_id', '=', 'users.id')
                .where('assigned.workspace_id', '=', workspaceId)
                .where('assigned.tray', '=', 'backlog')
                .where('assigned.deleted_at', 'is', null)
                .where('assigned.completed_at', 'is', null),
            ),
          ]),
        )
        .orderBy('users.name')
        .orderBy('users.id'),
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
  } & SprintRefRow;
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
    sprint: sprintRefOf(row),
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
      open_task_count: Number(totals?.open_count ?? 0),
      points_done: Number(totals?.points_done ?? 0),
      points_all: Number(totals?.points_all ?? 0),
    };
  };
  // 親そのものが、区分、エピック、検索の絞り込みのすべてに当たるか。検索は、自身か親のエピックの題が語をそろえて含めば当たり
  type EpicRow = (typeof epicsResult.rows)[number];
  const titleHit = (row: { title_hit?: unknown }) => !searching || Number(row.title_hit) === 1;
  const epicsById = new Map(epicsResult.rows.map((row) => [row.id, row]));
  const epicSelfHit = (row: EpicRow) =>
    (category === undefined || (epicCategories.get(row.id)?.id ?? null) === category) &&
    (epic === undefined || row.id === epic) &&
    titleHit(row);
  const storySelfHit = (row: StoryRow) => {
    const parent = row.epic_id === null ? undefined : epicsById.get(row.epic_id);
    return (
      (category === undefined || (storyCategories.get(row.id)?.id ?? null) === category) &&
      (epic === undefined || row.epic_id === epic) &&
      (titleHit(row) || (parent !== undefined && Number(parent.title_hit) === 1))
    );
  };

  // エピックごとの配下のストーリー（position の順のまま分ける）。ポイントの合計は、絞っていても配下の全部のストーリーで数える
  const storiesByEpic = new Map<string, ReturnType<typeof storyOf>[]>();
  const epicTotals = new Map<string, { done: number; all: number }>();
  const rootStories: ReturnType<typeof storyOf>[] = [];
  for (const row of storiesResult.rows) {
    const story = storyOf(row);
    if (row.epic_id !== null) {
      const totals = epicTotals.get(row.epic_id) ?? { done: 0, all: 0 };
      epicTotals.set(row.epic_id, { done: totals.done + story.points_done, all: totals.all + story.points_all });
    }
    // 絞っているときは、当たるタスクを持つストーリーと、（担当とリポジトリで絞っていなければ）そのものが当たるストーリーだけを残す
    if (filtering && story.tasks.length === 0 && (taskOnly || !storySelfHit(row))) continue;
    if (row.epic_id === null) {
      rootStories.push(story);
      continue;
    }
    const list = storiesByEpic.get(row.epic_id) ?? [];
    list.push(story);
    storiesByEpic.set(row.epic_id, list);
  }

  // 絞っているときの、親に選べるストーリー（完了していないもの）。木の順（エピックの順にその下のもの、続けて親のないもの）。
  // 削除したエピックの下のストーリーは、木と同じく出さない
  const openStoryChoices = () => {
    const choiceOf = (row: StoryRow) => ({
      id: row.id,
      title: row.title,
      epic_id: row.epic_id,
      category: storyCategories.get(row.id) ?? null,
    });
    const open = storiesResult.rows.filter((row) => row.completed_at === null);
    return [
      ...epicsResult.rows.flatMap((epicRow) => open.filter((row) => row.epic_id === epicRow.id).map(choiceOf)),
      ...open.filter((row) => row.epic_id === null).map(choiceOf),
    ];
  };

  return {
    today: todayIn(settings.timezone),
    week_start: settings.week_start,
    // 区分を結んだ列（category_ref_id、category_name）と検索の印（title_hit）は、出力のスキーマに無いので応答から落ちる。
    // 絞っているときは、残したストーリーを持つエピックと、（担当とリポジトリで絞っていなければ）そのものが当たるエピックだけを残す
    epics: epicsResult.rows
      .filter((row) => !filtering || storiesByEpic.has(row.id) || (!taskOnly && epicSelfHit(row)))
      .map((row) => ({
        ...row,
        category: epicCategories.get(row.id) ?? null,
        stories: storiesByEpic.get(row.id) ?? [],
        points_done: epicTotals.get(row.id)?.done ?? 0,
        points_all: epicTotals.get(row.id)?.all ?? 0,
      })),
    stories: rootStories,
    tasks: rootOpenResult.rows.map((row) => taskOf(row, refOf(row.category_ref_id, row.category_name))),
    // 絞っているときは出さない（画面は折りたたみの1行を出さない）
    completed_count: filtering ? null : Number(rootDoneResult.rows[0]?.count ?? 0),
    choices: {
      // 今所属している人を先に、それぞれ名前の順（並べ替えは安定）
      assignees: assigneesResult.rows
        .map((row) => ({ id: row.id, name: row.name, current: Number(row.is_current) === 1 }))
        .sort((a, b) => Number(b.current) - Number(a.current)),
      // 絞ると木から消えるエピックも選べるよう、全部を返す
      epics: epicsResult.rows.map((row) => ({
        id: row.id,
        title: row.title,
        finished: row.completed_at !== null || row.canceled_at !== null,
      })),
      stories: filtering ? openStoryChoices() : null,
    },
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
  'previous_column_id',
] as const;

// 読んでから書くまでに、スプリントか列が変わって書けなかったときにやり直す回数の上限。超えたら 409 の conflict
const MAX_COMPLETE_ATTEMPTS = 3;

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

const helpColumns = [...grantColumns, 'thank_id', 'helper_sender_user_id'] as const;

type HelpParams = CompletionParams & {
  // 完了の時刻と同じ週の範囲（UTC の ISO の時刻。始まりは含み、終わりは含まない）
  weekStart: string;
  weekEnd: string;
};

// 手助けの経験値の1行。タスクの感謝1件につき1行で、感謝を受け取った人に付く（送った人は helper_sender_user_id に残す）。
// 条件は、感謝の行が今もある、受け取る人が今このワークスペースに所属している、自分の完了の記録が入った、
// 同じ送り手と相手の、打ち消されていない手助け（正の値で、reverses_grant_id で指されていない行）のうち、確定日時が完了と同じ週に入るものが
// 上限（XP_HELP_WEEKLY_LIMIT）に満たない、の4つ。ポイントの条件は付けない。
// 件数は書く時点の表を数える。D1 の batch() は1つのトランザクションで、同じ batch の前の文の挿入が次の文に見えるので、
// 1つのタスクの複数の感謝も、同時に完了にした別のタスクの感謝も、上限を超えない（別の要求の batch() とは交わらない）
function helpStatement(db: OrganizationDb, params: HelpParams, grant: { id: string; thankId: string }) {
  const { workspaceId, taskId, completionId, at, weekStart, weekEnd } = params;
  return db.statement((q) =>
    q
      .insertInto('xp_grants')
      .columns(helpColumns)
      .expression(
        q
          .selectFrom('thanks')
          .select((eb) => [
            eb.val(grant.id).as('id'),
            'thanks.workspace_id as workspace_id',
            'thanks.recipient_user_id as user_id',
            eb.val('help').as('action'),
            'thanks.task_id as task_id',
            eb.val(completionId).as('completion_id'),
            eb.val(XP_HELP).as('amount'),
            eb.val(`help:${grant.thankId}:${completionId}`).as('dedupe_key'),
            eb.val(at).as('confirmed_at'),
            'thanks.id as thank_id',
            'thanks.sender_user_id as helper_sender_user_id',
          ])
          .where((eb) =>
            eb.and([
              eb('thanks.id', '=', grant.thankId),
              eb('thanks.workspace_id', '=', workspaceId),
              eb('thanks.task_id', '=', taskId),
              // 受け取る人は、このワークスペースに今所属している人だけ
              eb.exists(
                eb
                  .selectFrom('memberships')
                  .select('memberships.id')
                  .where('memberships.workspace_id', '=', workspaceId)
                  .where('memberships.left_at', 'is', null)
                  .whereRef('memberships.user_id', '=', 'thanks.recipient_user_id'),
              ),
              eb.exists(completionExists(q, workspaceId, completionId)),
              eb(
                eb
                  .selectFrom('xp_grants as h')
                  .select((hb) => hb.fn.countAll<number>().as('count'))
                  .where('h.workspace_id', '=', workspaceId)
                  .where('h.action', '=', 'help')
                  .whereRef('h.user_id', '=', 'thanks.recipient_user_id')
                  .whereRef('h.helper_sender_user_id', '=', 'thanks.sender_user_id')
                  .where('h.amount', '>', 0)
                  .where('h.confirmed_at', '>=', weekStart)
                  .where('h.confirmed_at', '<', weekEnd)
                  .where((hb) =>
                    hb.not(
                      hb.exists(
                        hb
                          .selectFrom('xp_grants as r')
                          .select('r.id')
                          .whereRef('r.reverses_grant_id', '=', 'h.id')
                          .where('r.workspace_id', '=', workspaceId),
                      ),
                    ),
                  ),
                '<',
                XP_HELP_WEEKLY_LIMIT,
              ),
            ]),
          ),
      ),
  );
}

// このタスクの感謝を、付ける順（送った順、同じなら id の順）に読む。上限は先に入った行から数えるので、順が結果を決める。ワークスペースで必ず絞る
function readTaskThanks(db: OrganizationDb, workspaceId: string, taskId: string) {
  return db.rows(
    db.statement((q) =>
      q
        .selectFrom('thanks')
        .select('thanks.id')
        .where('thanks.workspace_id', '=', workspaceId)
        .where('thanks.task_id', '=', taskId)
        .orderBy('thanks.created_at')
        .orderBy('thanks.id'),
    ),
  );
}

export const taskCompleteOperation = implement(taskComplete, async ({ db, actor, workspace, input }) => {
  const userId = actorUserIdOf(actor);
  const organizationId = db.organizationId;
  const workspaceId = workspace.workspaceId;
  const taskId = input.task_id;

  // 計上月と手助けの週を決めるタイムゾーンと週の始まり、履歴に残す自分の名前。ポイント、担当、区分は読まず、書く文が tasks の行から取る
  const [workspaceResult, userResult] = await db.batch([
    db.statement((q) =>
      q
        .selectFrom('workspaces')
        .select(['timezone', 'week_start'])
        .where('id', '=', workspaceId)
        .where('organization_id', '=', organizationId),
    ),
    db.statement((q) =>
      q.selectFrom('users').select('name').where('id', '=', userId).where('organization_id', '=', organizationId),
    ),
  ] as const);
  const timezone = workspaceResult.rows[0]?.timezone;
  const weekStart = workspaceResult.rows[0]?.week_start;
  const userName = userResult.rows[0]?.name;
  if (timezone === undefined || weekStart === undefined || userName === undefined) throw new ApiError(404, 'not_found');

  for (let attempt = 0; attempt < MAX_COMPLETE_ATTEMPTS; attempt++) {
    const target = await readCompleteTarget(db, workspaceId, taskId);
    if (target === undefined) {
      await throwIfClosed(db, workspaceId);
      throw new ApiError(404, 'not_found');
    }
    if (target.completed_at !== null) {
      await throwIfClosed(db, workspaceId);
      throw new ApiError(409, 'conflict');
    }
    const placement = await placementOf(db, workspaceId, target);
    const thanks = await readTaskThanks(db, workspaceId, taskId);
    const at = now();
    const week = weekRangeIn(timezone, weekStart, at);
    const { statements, taskIndex } = completeStatements(db, {
      organizationId,
      workspaceId,
      taskId,
      userId,
      userName,
      at,
      billingMonth: monthIn(timezone, at),
      weekStart: week.start,
      weekEnd: week.end,
      thankIds: thanks.map((row) => row.id),
      placement,
    });
    const results = await db.batch(statements);
    if ((results[taskIndex]?.changes ?? 0) > 0) {
      return { task_id: taskId, completed_at: at.toISOString(), left_sprint: placement.kind === 'planned' };
    }
    // 先に読んだ値ではなく、書いた結果で決める。読んでから書くまでに閉じたなら 409 の workspace_closed、
    // タスクが無い（別の組織のタスクと、バックログに無いタスクを含む）なら 404、完了していれば 409 の conflict。
    // どれでもなければ、読んでから書くまでにスプリントか列が変わったので、読み直してやり直す
    await throwIfClosed(db, workspaceId);
    const reread = await readCompleteTarget(db, workspaceId, taskId);
    if (reread === undefined) throw new ApiError(404, 'not_found');
    if (reread.completed_at !== null) throw new ApiError(409, 'conflict');
  }
  throw new ApiError(409, 'conflict');
});

// 完了にするタスクの、今のスプリント（とその状態）と列。バックログの削除していないタスクだけ。ワークスペースで必ず絞る
async function readCompleteTarget(db: OrganizationDb, workspaceId: string, taskId: string) {
  return db.first(
    db.statement((q) =>
      q
        .selectFrom('tasks')
        .leftJoin('sprints', (join) =>
          join.onRef('sprints.id', '=', 'tasks.sprint_id').on('sprints.workspace_id', '=', workspaceId),
        )
        .select([
          'tasks.id',
          'tasks.sprint_id',
          'tasks.column_id',
          'tasks.completed_at',
          'sprints.name as sprint_name',
          'sprints.start_on as sprint_start_on',
          'sprints.end_on as sprint_end_on',
          'sprints.status as sprint_status',
          'sprints.deleted_at as sprint_deleted_at',
        ])
        .where('tasks.id', '=', taskId)
        .where('tasks.workspace_id', '=', workspaceId)
        .where('tasks.tray', '=', 'backlog')
        .where('tasks.deleted_at', 'is', null),
    ),
  );
}

type CompleteTarget = NonNullable<Awaited<ReturnType<typeof readCompleteTarget>>>;

// 完了にするタスクの置き場所と、完了で書くもの（docs/data-model.md の「書き込みの単位」の「タスクの完了」）。
// - outside: スプリントの外。今のまま
// - active: 進行中のスプリントの中。完了の列の末尾へ移し、完了の記録にスプリントと完了の前の列を入れる。sprint_entries は書かない
// - planned: 始まっていないスプリントの中。スプリントから外し（sprint_entries を removed で閉じる）、スプリントの外の完了にする。
//   削除したスプリントを指すタスク（前の版に戻して作られうる）も同じに扱う（sprintDeleted が真）
type Placement =
  | { kind: 'outside' }
  | {
      kind: 'active';
      sprintId: string;
      columnId: string | null;
      doneColumnId: string | null;
      doneColumnPosition: string | null;
    }
  | { kind: 'planned'; sprintId: string; columnId: string | null; sprintDeleted: boolean };

async function placementOf(db: OrganizationDb, workspaceId: string, target: CompleteTarget): Promise<Placement> {
  const sprintId = target.sprint_id;
  if (sprintId === null) return { kind: 'outside' };
  if (target.sprint_deleted_at !== null || target.sprint_status === 'planned') {
    return { kind: 'planned', sprintId, columnId: target.column_id, sprintDeleted: target.sprint_deleted_at !== null };
  }
  if (target.sprint_status !== 'active') {
    // 終了したスプリントに残った未完了のタスク（終了で持ち越すので、ふつうは無い）は完了にしない
    await throwIfClosed(db, workspaceId);
    throw new ApiError(409, 'conflict');
  }
  // 完了の列（ワークスペースに1つ）と、このスプリントでのその列の末尾
  const [doneResult, lastResult] = await db.batch([
    db.statement((q) =>
      q
        .selectFrom('board_columns')
        .select('board_columns.id')
        .where('board_columns.workspace_id', '=', workspaceId)
        .where('board_columns.is_done', '=', 1)
        .where('board_columns.deleted_at', 'is', null)
        .limit(1),
    ),
    db.statement((q) =>
      q
        .selectFrom('tasks')
        .select('tasks.column_position')
        .where('tasks.workspace_id', '=', workspaceId)
        .where('tasks.sprint_id', '=', sprintId)
        .where('tasks.column_id', '=', (eb) =>
          eb
            .selectFrom('board_columns')
            .select('board_columns.id')
            .where('board_columns.workspace_id', '=', workspaceId)
            .where('board_columns.is_done', '=', 1)
            .where('board_columns.deleted_at', 'is', null)
            .limit(1),
        )
        .where('tasks.deleted_at', 'is', null)
        .orderBy('tasks.column_position', 'desc')
        .limit(1),
    ),
  ] as const);
  const doneColumnId = doneResult.rows[0]?.id ?? null;
  // 完了の列に既にいる（まだ完了にしていない）なら、位置は変えない
  const moving = doneColumnId !== null && doneColumnId !== target.column_id;
  return {
    kind: 'active',
    sprintId,
    columnId: target.column_id,
    doneColumnId: moving ? doneColumnId : null,
    doneColumnPosition: moving ? generateKeyBetween(lastResult.rows[0]?.column_position ?? null, null) : null,
  };
}

type CompleteContext = {
  organizationId: string;
  workspaceId: string;
  taskId: string;
  userId: string;
  userName: string;
  at: Date;
  billingMonth: string;
  // 完了の時刻と同じ週の範囲（手助けの上限を数える。UTC の ISO の時刻で、始まりは含み、終わりは含まない）
  weekStart: string;
  weekEnd: string;
  // このタスクの感謝の ID（手助けを付ける順）
  thankIds: string[];
  placement: Placement;
};

// 完了の batch() に並べる文と、tasks の UPDATE の位置（taskIndex）。後ろの文は自分の完了の記録が入ったことを条件にする。
// 始まっていないスプリントの中の完了だけは、先頭に入っている行を閉じる文を置き、tasks の UPDATE はこの要求がその行を閉じたこと
// （ended_at が自分の時刻）を条件にする。行を閉じる文が負けたら（入っている行が無い、読んでから書くまでに閉じられた）、何も書かない
function completeStatements(db: OrganizationDb, context: CompleteContext) {
  const { organizationId, workspaceId, taskId, userId, userName, at, billingMonth, placement } = context;
  const { weekStart, weekEnd, thankIds } = context;
  const completedAt = at.toISOString();
  const params: CompletionParams = { workspaceId, taskId, completionId: uuidv7(at), userId, at: completedAt };
  const { completionId } = params;
  // 完了の前にいた列。進行中のスプリントの中の完了だけ（完了を戻す操作 task-reopen が、この列へ戻す）
  const previousColumnId = placement.kind === 'active' ? placement.columnId : null;
  const inSprint = placement.kind === 'outside' ? null : placement;

  // 読んだスプリントが、読んだ状態のまま。始まっていないスプリントの中なら planned（削除していない）、削除したスプリントなら削除したまま
  const sprintAsRead = (from: Pick<QueryCreator<Tables>, 'selectFrom'>) => {
    const sprint = from
      .selectFrom('sprints as read_sprint')
      .select('read_sprint.id')
      .where('read_sprint.id', '=', inSprint!.sprintId)
      .where('read_sprint.workspace_id', '=', workspaceId);
    if (inSprint!.kind === 'planned' && inSprint!.sprintDeleted)
      return sprint.where('read_sprint.deleted_at', 'is not', null);
    return sprint.where('read_sprint.deleted_at', 'is', null).where('read_sprint.status', '=', inSprint!.kind);
  };

  // 0.（始まっていないスプリントの中だけ）入っている行を removed で閉じる。条件は 1 と同じ前提（読んだスプリントと列のままの、
  // 未完了のバックログのタスク、閉じていないワークスペース）
  const closeEntry =
    placement.kind === 'planned'
      ? [
          db.statement((q) =>
            q
              .updateTable('sprint_entries')
              .set({ ended_at: completedAt, outcome: 'removed' })
              .where('workspace_id', '=', workspaceId)
              .where('task_id', '=', taskId)
              .where('sprint_id', '=', placement.sprintId)
              .where('ended_at', 'is', null)
              .where((eb) =>
                eb.and([
                  eb.exists(openWorkspace(q, organizationId, workspaceId)),
                  eb.exists(sprintAsRead(q)),
                  eb.exists(
                    q
                      .selectFrom('tasks as closing')
                      .select('closing.id')
                      .where('closing.id', '=', taskId)
                      .where('closing.workspace_id', '=', workspaceId)
                      .where('closing.tray', '=', 'backlog')
                      .where('closing.completed_at', 'is', null)
                      .where('closing.deleted_at', 'is', null)
                      .where('closing.sprint_id', '=', placement.sprintId)
                      .where('closing.column_id', 'is', placement.columnId),
                  ),
                ]),
              ),
          ),
        ]
      : [];

  const statements = [
    ...closeEntry,
    // 1. tasks。変わった行が0なら、タスクが無い（バックログに無いタスクを含む）か、すでに完了か、読んでから書くまでにスプリントか列が変わった。
    // 置き場所ごとに、読んだスプリント（と列）のままで、スプリントの状態も読んだままであることを条件にする
    db.statement((q) =>
      q
        .updateTable('tasks')
        .set({
          completed_at: completedAt,
          completed_by: userId,
          updated_at: completedAt,
          ...(placement.kind === 'planned' ? { sprint_id: null, column_id: null, column_position: null } : {}),
          ...(placement.kind === 'active' && placement.doneColumnId !== null
            ? { column_id: placement.doneColumnId, column_position: placement.doneColumnPosition }
            : {}),
        })
        .where('id', '=', taskId)
        .where('workspace_id', '=', workspaceId)
        .where('tray', '=', 'backlog')
        .where('completed_at', 'is', null)
        .where('deleted_at', 'is', null)
        .where((eb) => eb.exists(openWorkspace(q, organizationId, workspaceId)))
        .$if(placement.kind === 'outside', (qb) => qb.where('sprint_id', 'is', null))
        .$if(inSprint !== null, (qb) =>
          qb
            .where('sprint_id', '=', inSprint!.sprintId)
            .where('column_id', 'is', inSprint!.columnId)
            .where((eb) => eb.exists(sprintAsRead(q))),
        )
        // 始まっていないスプリントの中なら、0 でこの要求が入っている行を閉じた
        .$if(placement.kind === 'planned', (qb) =>
          qb.where((eb) =>
            eb.exists(
              q
                .selectFrom('sprint_entries as closed_entry')
                .select('closed_entry.id')
                .where('closed_entry.workspace_id', '=', workspaceId)
                .where('closed_entry.task_id', '=', taskId)
                .where('closed_entry.sprint_id', '=', inSprint!.sprintId)
                .where('closed_entry.ended_at', '=', completedAt)
                .where('closed_entry.outcome', '=', 'removed'),
            ),
          ),
        ),
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
              eb.val(previousColumnId).as('previous_column_id'),
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
    // 3. xp_grants。起票と完了、続けてそのタスクの感謝1件につき手助け1行（感謝の順。上限は前の文の挿入を数えて守る）
    grantStatement(db, params, { id: uuidv7(at), action: 'task_created', amount: XP_TASK_CREATED }),
    grantStatement(db, params, { id: uuidv7(at), action: 'task_completed', amount: XP_TASK_COMPLETED }),
    ...thankIds.map((thankId) => helpStatement(db, { ...params, weekStart, weekEnd }, { id: uuidv7(at), thankId })),
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
    // 5. 始まっていないスプリントの中の完了だけ。スプリントから外した変更の履歴（名前は書くときの今の名前）。
    // 3 と同じく、自分の完了の記録が入ったときだけ
    ...(placement.kind === 'planned'
      ? [
          db.statement((q) =>
            q
              .insertInto('change_logs')
              .columns(changeLogColumns)
              .expression(
                q
                  .selectFrom('sprints as cur')
                  .select((eb) => [
                    eb.val(uuidv7(at)).as('id'),
                    eb.val(organizationId).as('organization_id'),
                    eb.val(workspaceId).as('workspace_id'),
                    eb.val(userId).as('actor_user_id'),
                    eb.val('task').as('entity_type'),
                    eb.val(taskId).as('entity_id'),
                    eb.val('update').as('action'),
                    sprintLeftLogSql('cur').as('changes_json'),
                    eb.val(completedAt).as('created_at'),
                  ])
                  .where('cur.id', '=', placement.sprintId)
                  .where('cur.workspace_id', '=', workspaceId)
                  .where((eb) => eb.exists(completionExists(q, workspaceId, completionId))),
              ),
          ),
        ]
      : []),
  ];
  return { statements, taskIndex: closeEntry.length };
}

// 移す先の並び（親の配下か、親のないタスク）から、移すタスクを除いたもの。完了したタスクも並びに残っているので含める
function siblingTasks(
  from: Pick<QueryCreator<Tables>, 'selectFrom'>,
  workspaceId: string,
  storyId: string | null,
  taskId: string,
) {
  return backlogTasksUnder(from, workspaceId, storyId).where('tasks.id', '!=', taskId);
}

// 並べ替えで兄弟を引く文。親なしの分岐は backlogTasksUnder が story_id を索引に使わせない
// （test/backlog-filter.test.ts が ANALYZE の後の実行計画で確かめる）
export function siblingStatements(db: OrganizationDb, workspaceId: string, storyId: string | null, taskId: string) {
  const columns = ['tasks.id', 'tasks.position'] as const;
  return {
    last: () =>
      db.statement((q) =>
        siblingTasks(q, workspaceId, storyId, taskId)
          .select(columns)
          .orderBy('tasks.position', 'desc')
          .orderBy('tasks.id', 'desc')
          .limit(1),
      ),
    first: () =>
      db.statement((q) =>
        siblingTasks(q, workspaceId, storyId, taskId)
          .select(columns)
          .orderBy('tasks.position')
          .orderBy('tasks.id')
          .limit(1),
      ),
    byId: (afterId: string) =>
      db.statement((q) =>
        siblingTasks(q, workspaceId, storyId, taskId).select(columns).where('tasks.id', '=', afterId),
      ),
    ties: (after: Positioned) =>
      db.statement((q) =>
        siblingTasks(q, workspaceId, storyId, taskId)
          .select(columns)
          .where('tasks.position', '=', after.position)
          .where('tasks.id', '>', after.id)
          .orderBy('tasks.id')
          .limit(MAX_TIES + 1),
      ),
    next: (after: Positioned) =>
      db.statement((q) =>
        siblingTasks(q, workspaceId, storyId, taskId)
          .select(columns)
          .where('tasks.position', '>', after.position)
          .orderBy('tasks.position')
          .orderBy('tasks.id')
          .limit(1),
      ),
  };
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
  const siblings = siblingStatements(db, workspaceId, storyId, taskId);
  if (afterId === undefined) return { plan: placeLast(await db.first(siblings.last())), after: null };
  if (afterId === null) return { plan: placeFirst(await db.first(siblings.first())), after: null };
  const after = await db.first(siblings.byId(afterId));
  if (after === undefined) throw new ApiError(404, 'not_found');
  const [ties, next] = await db.batch([siblings.ties(after), siblings.next(after)] as const);
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
