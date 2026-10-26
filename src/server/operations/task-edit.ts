import { now, todayIn } from '../../shared/clock.ts';
import { taskAssign, taskDelete, taskDetail, taskUpdate, type TaskDetail } from '../../shared/operations/task/index.ts';
import { previousStatementChanged, type OrganizationDb, type VerifiedWorkspace } from '../db/index.ts';
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
  activeMemberName,
  actorUserIdOf,
  changeLogColumns,
  mayDeleteOwned,
  openWorkspace,
  throwIfClosed,
} from './write-guards.ts';

// 同時の更新に負けたときにやり直す回数の上限。超えたら 409 の conflict
const MAX_UPDATE_ATTEMPTS = 3;

type TaskPoints = 0 | 1 | 2 | 3 | 5 | 8 | 13 | null;

// 削除していないタスクの、引き出しが出す欄と作った人。ワークスペースで必ず絞る。
// 担当の名前は組織で絞った users から、今所属しているかは、そのワークスペースの今の所属（left_at が空の行は1人に1つ）から読む
async function readTask(db: OrganizationDb, workspaceId: string, taskId: string) {
  const organizationId = db.organizationId;
  const row = await db.first(
    db.statement((q) =>
      q
        .selectFrom('tasks')
        .leftJoin('users as assignee', (join) =>
          join.onRef('assignee.id', '=', 'tasks.assignee_user_id').on('assignee.organization_id', '=', organizationId),
        )
        .leftJoin('memberships as assignee_membership', (join) =>
          join
            .onRef('assignee_membership.user_id', '=', 'tasks.assignee_user_id')
            .on('assignee_membership.workspace_id', '=', workspaceId)
            .on('assignee_membership.left_at', 'is', null),
        )
        // 区分は、親のストーリーの親のエピック、ストーリー、タスク自身の順に引き継ぐ。親の段は、同じワークスペースの削除していない区分だけを結ぶ。
        // 自身の区分とリポジトリは、履歴と書く文の条件に使うので削除したものも結び、削除したかを読む
        .leftJoin('stories', (join) =>
          join.onRef('stories.id', '=', 'tasks.story_id').on('stories.workspace_id', '=', workspaceId),
        )
        .leftJoin('epics', (join) =>
          join.onRef('epics.id', '=', 'stories.epic_id').on('epics.workspace_id', '=', workspaceId),
        )
        .leftJoin('categories as ec', (join) =>
          join
            .onRef('ec.id', '=', 'epics.category_id')
            .on('ec.workspace_id', '=', workspaceId)
            .on('ec.deleted_at', 'is', null),
        )
        .leftJoin('categories as sc', (join) =>
          join
            .onRef('sc.id', '=', 'stories.category_id')
            .on('sc.workspace_id', '=', workspaceId)
            .on('sc.deleted_at', 'is', null),
        )
        .leftJoin('categories as tc', (join) =>
          join.onRef('tc.id', '=', 'tasks.category_id').on('tc.workspace_id', '=', workspaceId),
        )
        .leftJoin('repositories', (join) =>
          join.onRef('repositories.id', '=', 'tasks.repository_id').on('repositories.workspace_id', '=', workspaceId),
        )
        .select([
          'tasks.id',
          'tasks.title',
          'tasks.body_md',
          'tasks.points',
          'tasks.due_on',
          'tasks.link_url',
          'tasks.is_imported',
          'tasks.completed_at',
          'tasks.created_by',
          'tasks.assignee_user_id',
          'tasks.today_on',
          'assignee.name as assignee_name',
          'assignee.disabled_at as assignee_disabled_at',
          'assignee_membership.id as assignee_membership_id',
          'tasks.story_id',
          'tasks.category_id',
          'tasks.repository_id',
          'ec.id as epic_category_id',
          'ec.name as epic_category_name',
          'sc.id as story_category_id',
          'sc.name as story_category_name',
          'tc.name as category_name',
          'tc.deleted_at as category_deleted_at',
          'repositories.name as repository_name',
          'repositories.deleted_at as repository_deleted_at',
        ])
        .where('tasks.id', '=', taskId)
        .where('tasks.workspace_id', '=', workspaceId)
        .where('tasks.deleted_at', 'is', null),
    ),
  );
  return row === undefined ? undefined : { ...row, points: row.points as TaskPoints };
}

type TaskRow = NonNullable<Awaited<ReturnType<typeof readTask>>>;

// 削除する権限。作った人とリーダー（管理者を含む）
function mayDelete(
  task: Pick<TaskRow, 'created_by'>,
  actor: { userId: string | null; isAdmin: boolean },
  workspace: VerifiedWorkspace,
): boolean {
  return mayDeleteOwned(task.created_by, actor, workspace);
}

// 削除できるか。取り込んだタスクは削除で片付けず、アーカイブで外す（docs/requirements.md の「削除」）ので、権限があっても削除できない
function canDelete(
  task: Pick<TaskRow, 'created_by' | 'is_imported'>,
  actor: { userId: string | null; isAdmin: boolean },
  workspace: VerifiedWorkspace,
): boolean {
  return task.is_imported === 0 && mayDelete(task, actor, workspace);
}

// 担当と、今そのワークスペースに所属していないか（抜けた、無効にされた）
function assigneeOf(row: TaskRow): TaskDetail['assignee'] {
  if (row.assignee_user_id === null) return null;
  return {
    id: row.assignee_user_id,
    name: row.assignee_name ?? '',
    left: row.assignee_membership_id === null || row.assignee_disabled_at !== null,
  };
}

// 引き継ぎを解いた区分。親のあるタスクは親の区分（エピック、ストーリーの順）、親のないタスクは自身の区分（削除していないもの）
function categoryOf(row: TaskRow): TaskDetail['category'] {
  if (row.story_id !== null) {
    if (row.epic_category_id !== null) {
      return { id: row.epic_category_id, name: row.epic_category_name ?? '', inherited: true };
    }
    if (row.story_category_id !== null) {
      return { id: row.story_category_id, name: row.story_category_name ?? '', inherited: true };
    }
    return null;
  }
  if (row.category_id === null || row.category_deleted_at !== null) return null;
  return { id: row.category_id, name: row.category_name ?? '', inherited: false };
}

function repositoryOf(row: TaskRow): TaskDetail['repository'] {
  if (row.repository_id === null || row.repository_deleted_at !== null) return null;
  return { id: row.repository_id, name: row.repository_name ?? '' };
}

function detailOf(
  row: TaskRow,
  actor: { userId: string | null; isAdmin: boolean },
  workspace: VerifiedWorkspace,
): TaskDetail {
  return {
    id: row.id,
    title: row.title,
    body_md: row.body_md,
    points: row.points,
    due_on: row.due_on,
    link_url: row.link_url,
    assignee: assigneeOf(row),
    is_imported: row.is_imported === 1,
    completed_at: row.completed_at,
    can_delete: canDelete(row, actor, workspace),
    story_id: row.story_id,
    category: categoryOf(row),
    repository: repositoryOf(row),
  };
}

export const taskDetailOperation = implement(taskDetail, async ({ db, actor, workspace, input }) => {
  const task = await readTask(db, workspace.workspaceId, input.task_id);
  if (task === undefined) throw new ApiError(404, 'not_found');
  // 期日の印を決める、ワークスペースのタイムゾーンでの今日と週の始まり（backlog-tree と同じ。ブラウザの時計に頼らない）。組織とワークスペースで絞る
  const settings = await db.first(
    db.statement((q) =>
      q
        .selectFrom('workspaces')
        .select(['workspaces.timezone', 'workspaces.week_start'])
        .where('workspaces.id', '=', workspace.workspaceId)
        .where('workspaces.organization_id', '=', db.organizationId),
    ),
  );
  if (settings === undefined) throw new ApiError(404, 'not_found');
  return { task: detailOf(task, actor, workspace), today: todayIn(settings.timezone), week_start: settings.week_start };
});

// 書く欄。ポイントと期日、リンク、本文、区分、リポジトリは空にできる
type UpdatedFields = {
  title?: string;
  points?: TaskPoints;
  due_on?: string | null;
  link_url?: string | null;
  body_md?: string | null;
  category_id?: string | null;
  repository_id?: string | null;
};

type Ref = { id: string; name: string } | null;

// 読んだ値と、送られた値の差。送られた欄のうち、読んだ値と違うものだけを書く。
// 区分とリポジトリの履歴は {id, name} で残す（next は送られた値の名前。外すときと送られないときは null）
function diffOf(current: TaskRow, input: UpdatedFields, next: { category: Ref; repository: Ref }) {
  const values: UpdatedFields = {};
  const changes: Record<string, [unknown, unknown]> = {};
  if (input.title !== undefined && input.title !== current.title) {
    values.title = input.title;
    changes.title = [current.title, input.title];
  }
  if (input.points !== undefined && input.points !== current.points) {
    values.points = input.points;
    changes.points = [current.points, input.points];
  }
  for (const field of ['due_on', 'link_url', 'body_md'] as const) {
    const next = input[field];
    if (next === undefined || next === current[field]) continue;
    values[field] = next;
    changes[field] = [current[field], next];
  }
  if (input.category_id !== undefined && input.category_id !== current.category_id) {
    values.category_id = input.category_id;
    changes.category = [refOf(current.category_id, current.category_name), next.category];
  }
  if (input.repository_id !== undefined && input.repository_id !== current.repository_id) {
    values.repository_id = input.repository_id;
    changes.repository = [refOf(current.repository_id, current.repository_name), next.repository];
  }
  return { values, changes, isEmpty: Object.keys(changes).length === 0 };
}

// 送られた区分とリポジトリを読む。今と同じか外す（null）なら読まない。無ければ 404
async function readNextRefs(db: OrganizationDb, workspaceId: string, current: TaskRow, input: UpdatedFields) {
  const category =
    input.category_id == null || input.category_id === current.category_id
      ? null
      : await readCategoryRef(db, workspaceId, input.category_id);
  const repository =
    input.repository_id == null || input.repository_id === current.repository_id
      ? null
      : await readRepositoryRef(db, workspaceId, input.repository_id);
  return { category, repository };
}

// 変えられない変更を断る。完了したタスクのポイントは、経験値とスプリントの集計が完了の記録の値を使うので、ずれないように変えない。
// 取り込んだタスクのタイトルは同期で書き直し、リンクは手で作ったタスクだけが持つ
// 区分は親のないタスクだけが持つ（親のあるタスクは親から引き継ぐ）
function assertEditable(current: TaskRow, values: UpdatedFields): void {
  if (values.points !== undefined && current.completed_at !== null) throw new ApiError(409, 'conflict');
  if (current.is_imported === 1 && (values.title !== undefined || values.link_url !== undefined)) {
    throw new ApiError(409, 'conflict');
  }
  if (values.category_id !== undefined && current.story_id !== null) throw categoryConflict('has_parent');
}

export const taskUpdateOperation = implement(taskUpdate, async ({ db, actor, workspace, input }) => {
  const actorUserId = actorUserIdOf(actor);
  const organizationId = db.organizationId;
  const workspaceId = workspace.workspaceId;
  const taskId = input.task_id;

  // 読んだ値からの差を、「読んだ値のままなら」という条件つきで書く。読んでから書くまでに別の要求が同じ欄を変えていたら、
  // 更新は通らない（履歴の「前」がずれるのと、同じ値の指定が取りこぼされるのを防ぐ）。通らなかったら読み直して、差を作り直す。
  // ポイントを書く文は、完了していないことも条件にする（読んでから書くまでに完了にされたら、完了の記録の値とずれるため）
  for (let attempt = 0; attempt < MAX_UPDATE_ATTEMPTS; attempt++) {
    const current = await readTask(db, workspaceId, taskId);
    if (current === undefined) {
      await throwIfClosed(db, workspaceId);
      throw new ApiError(404, 'not_found');
    }
    const draft = diffOf(current, input, { category: null, repository: null });
    if (draft.isEmpty) {
      // 書くものが無くても、閉じたワークスペースは断る
      await throwIfClosed(db, workspaceId);
      return { task: detailOf(current, actor, workspace) };
    }
    assertEditable(current, draft.values);
    // 振る区分とリポジトリは、同じワークスペースの削除していないものだけ（無ければ 404）。書く文にも同じ条件を入れる
    const next = await readNextRefs(db, workspaceId, current, input);
    const { values, changes } = diffOf(current, input, next);

    const at = now();
    const updatedAt = at.toISOString();
    const results = await db.batch([
      db.statement((q) =>
        q
          .updateTable('tasks')
          .set({ ...values, updated_at: updatedAt })
          .where((eb) =>
            eb.and([
              eb('id', '=', taskId),
              eb('workspace_id', '=', workspaceId),
              eb('deleted_at', 'is', null),
              eb.exists(openWorkspace(q, organizationId, workspaceId)),
              // 書く欄が、読んだときの値のまま
              ...(values.title === undefined ? [] : [eb('title', 'is', current.title)]),
              ...(values.points === undefined
                ? []
                : [eb('points', 'is', current.points), eb('completed_at', 'is', null)]),
              ...(values.due_on === undefined ? [] : [eb('due_on', 'is', current.due_on)]),
              ...(values.link_url === undefined ? [] : [eb('link_url', 'is', current.link_url)]),
              ...(values.body_md === undefined ? [] : [eb('body_md', 'is', current.body_md)]),
              // 区分は、読んだ値のままで、親が無い（task-move が親の下へ移すと区分を空にする）
              ...(values.category_id === undefined
                ? []
                : [eb('category_id', 'is', current.category_id), eb('story_id', 'is', null)]),
              ...(values.repository_id === undefined ? [] : [eb('repository_id', 'is', current.repository_id)]),
              // 振る区分とリポジトリが、今も削除されていない
              ...(next.category === null
                ? []
                : [eb.exists(categoryRow(q, workspaceId, next.category.id).select('categories.id'))]),
              ...(next.repository === null
                ? []
                : [eb.exists(repositoryRow(q, workspaceId, next.repository.id).select('repositories.id'))]),
            ]),
          ),
      ),
      // 直前の更新が行を変えたときだけ履歴を書く（負けた要求は、止めた時計で同じ値を書いていても、履歴を書かない）
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
                eb.val(JSON.stringify(changes)).as('changes_json'),
                eb.val(updatedAt).as('created_at'),
              ])
              .where(previousStatementChanged),
          ),
      ),
    ]);

    if ((results[0]?.changes ?? 0) > 0) {
      const updated = await readTask(db, workspaceId, taskId);
      if (updated === undefined) throw new ApiError(404, 'not_found');
      return { task: detailOf(updated, actor, workspace) };
    }
    // 閉じていれば 409 の workspace_closed。無ければ 404。どちらでもなければ、別の要求が先に同じ欄を変えたので、読み直してやり直す
    // （完了にされていたか親の下へ移されていたら、次の周の assertEditable が 409 に、区分かリポジトリが削除されていたら、次の周の読み取りが 404 にする）
    await throwIfClosed(db, workspaceId);
    if ((await readTask(db, workspaceId, taskId)) === undefined) throw new ApiError(404, 'not_found');
  }
  throw new ApiError(409, 'conflict');
});

// 担当を替える（null で外す）。読んだ担当から替わるときだけ、「読んだ担当のまま、読んだ今日やるの印のまま、完了していない、
// 新しい担当が今所属している、ワークスペースが開いている」という条件つきで書き、同じ文で今日やるの印を消す。
// 通らなかったら読み直して、やり直す（task-update と同じ。3 回まで）
export const taskAssignOperation = implement(taskAssign, async ({ db, actor, workspace, input }) => {
  const actorUserId = actorUserIdOf(actor);
  const organizationId = db.organizationId;
  const workspaceId = workspace.workspaceId;
  const taskId = input.task_id;
  const nextId = input.assignee_user_id;

  for (let attempt = 0; attempt < MAX_UPDATE_ATTEMPTS; attempt++) {
    const current = await readTask(db, workspaceId, taskId);
    if (current === undefined) {
      await throwIfClosed(db, workspaceId);
      throw new ApiError(404, 'not_found');
    }
    if (current.assignee_user_id === nextId) {
      // 替わらなければ何も書かない（今日やるの印も消さない）。書くものが無くても、閉じたワークスペースは断る
      await throwIfClosed(db, workspaceId);
      return { task: detailOf(current, actor, workspace) };
    }
    // 完了したタスクの担当は替えない（完了の経験値と完了の記録が、完了した時点の担当を使うため）。
    // 閉じたワークスペースは、完了したタスクでも workspace_closed で答える
    if (current.completed_at !== null) {
      await throwIfClosed(db, workspaceId);
      throw new ApiError(409, 'conflict');
    }

    // 新しい担当は、このワークスペースに今所属している、無効でない人だけ。読んで名前を残し、書く文にも同じ条件を入れる
    let next: { id: string; name: string } | null = null;
    if (nextId !== null) {
      const found = await db.first(db.statement((q) => activeMemberName(q, organizationId, workspaceId, nextId)));
      if (found === undefined) {
        await throwIfClosed(db, workspaceId);
        throw new ApiError(404, 'not_found');
      }
      next = { id: nextId, name: found.name };
    }
    // 履歴には、そのときの名前を残す（後で名前が変わっても、履歴は変えない）
    const previous =
      current.assignee_user_id === null ? null : { id: current.assignee_user_id, name: current.assignee_name ?? '' };
    const changes = {
      assignee: [previous, next],
      ...(current.today_on === null ? {} : { today_on: [current.today_on, null] }),
    };

    const at = now();
    const updatedAt = at.toISOString();
    const results = await db.batch([
      db.statement((q) =>
        q
          .updateTable('tasks')
          .set({ assignee_user_id: nextId, today_on: null, updated_at: updatedAt })
          .where((eb) =>
            eb.and([
              eb('id', '=', taskId),
              eb('workspace_id', '=', workspaceId),
              eb('deleted_at', 'is', null),
              eb('completed_at', 'is', null),
              // 読んだときの担当と今日やるの印のまま（履歴の「前」がずれないように）
              eb('assignee_user_id', 'is', current.assignee_user_id),
              eb('today_on', 'is', current.today_on),
              eb.exists(openWorkspace(q, organizationId, workspaceId)),
              ...(nextId === null ? [] : [eb.exists(activeMemberName(q, organizationId, workspaceId, nextId))]),
            ]),
          ),
      ),
      // 直前の更新が行を変えたときだけ履歴を書く
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
                eb.val(JSON.stringify(changes)).as('changes_json'),
                eb.val(updatedAt).as('created_at'),
              ])
              .where(previousStatementChanged),
          ),
      ),
    ]);

    if ((results[0]?.changes ?? 0) > 0) {
      const updated = await readTask(db, workspaceId, taskId);
      if (updated === undefined) throw new ApiError(404, 'not_found');
      return { task: detailOf(updated, actor, workspace) };
    }
    // 閉じていれば 409 の workspace_closed。タスクが無いか、新しい担当が所属を外れていれば 404。
    // どちらでもなければ、別の要求が先に担当か今日やるの印を変えたか、完了にしたので、読み直してやり直す
    // （完了にされていたら、次の周が 409 にする）
    await throwIfClosed(db, workspaceId);
    if ((await readTask(db, workspaceId, taskId)) === undefined) throw new ApiError(404, 'not_found');
    if (
      nextId !== null &&
      (await db.first(db.statement((q) => activeMemberName(q, organizationId, workspaceId, nextId)))) === undefined
    ) {
      throw new ApiError(404, 'not_found');
    }
  }
  throw new ApiError(409, 'conflict');
});

export const taskDeleteOperation = implement(taskDelete, async ({ db, actor, workspace, input }) => {
  const actorUserId = actorUserIdOf(actor);
  const organizationId = db.organizationId;
  const workspaceId = workspace.workspaceId;
  const taskId = input.task_id;

  const task = await readTask(db, workspaceId, taskId);
  if (task === undefined) {
    await throwIfClosed(db, workspaceId);
    throw new ApiError(404, 'not_found');
  }
  if (!mayDelete(task, actor, workspace)) throw new ApiError(403, 'forbidden');
  // 取り込んだタスクはアーカイブで外す。削除は手で作ったタスクだけ
  if (task.is_imported === 1) throw new ApiError(409, 'conflict');

  const at = now();
  const deletedAt = at.toISOString();
  const results = await db.batch([
    db.statement((q) =>
      q
        .updateTable('tasks')
        .set({ deleted_at: deletedAt, updated_at: deletedAt })
        .where((eb) =>
          eb.and([
            eb('id', '=', taskId),
            eb('workspace_id', '=', workspaceId),
            eb('deleted_at', 'is', null),
            eb.exists(openWorkspace(q, organizationId, workspaceId)),
          ]),
        ),
    ),
    // 直前の削除が行を変えたときだけ履歴を書く（先に削除した要求があれば、止めた時計でも書かない）
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
              eb.val('delete').as('action'),
              eb.val(JSON.stringify({ deleted_at: [null, deletedAt] })).as('changes_json'),
              eb.val(deletedAt).as('created_at'),
            ])
            .where(previousStatementChanged),
        ),
    ),
  ]);

  // 読んでから書くまでに、閉じたか、別の要求が先に削除した
  if ((results[0]?.changes ?? 0) === 0) {
    await throwIfClosed(db, workspaceId);
    throw new ApiError(404, 'not_found');
  }
  return { task_id: taskId };
});
