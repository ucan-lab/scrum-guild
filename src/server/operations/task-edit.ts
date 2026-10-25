import { now, todayIn } from '../../shared/clock.ts';
import { taskDelete, taskDetail, taskUpdate, type TaskDetail } from '../../shared/operations/task/index.ts';
import { previousStatementChanged, type OrganizationDb, type VerifiedWorkspace } from '../db/index.ts';
import { ApiError } from '../errors.ts';
import { uuidv7 } from '../uuid.ts';
import { implement } from './implement.ts';
import { actorUserIdOf, changeLogColumns, openWorkspace, throwIfClosed } from './write-guards.ts';

// 同時の更新に負けたときにやり直す回数の上限。超えたら 409 の conflict
const MAX_UPDATE_ATTEMPTS = 3;

type TaskPoints = 0 | 1 | 2 | 3 | 5 | 8 | 13 | null;

// 削除していないタスクの、引き出しが出す欄と作った人。ワークスペースで必ず絞る
async function readTask(db: OrganizationDb, workspaceId: string, taskId: string) {
  const row = await db.first(
    db.statement((q) =>
      q
        .selectFrom('tasks')
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
  return (
    actor.isAdmin || workspace.actorRole === 'leader' || (actor.userId !== null && task.created_by === actor.userId)
  );
}

// 削除できるか。取り込んだタスクは削除で片付けず、アーカイブで外す（docs/requirements.md の「削除」）ので、権限があっても削除できない
function canDelete(
  task: Pick<TaskRow, 'created_by' | 'is_imported'>,
  actor: { userId: string | null; isAdmin: boolean },
  workspace: VerifiedWorkspace,
): boolean {
  return task.is_imported === 0 && mayDelete(task, actor, workspace);
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
    is_imported: row.is_imported === 1,
    completed_at: row.completed_at,
    can_delete: canDelete(row, actor, workspace),
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

// 書く欄。ポイントと期日、リンク、本文は空にできる
type UpdatedFields = {
  title?: string;
  points?: TaskPoints;
  due_on?: string | null;
  link_url?: string | null;
  body_md?: string | null;
};

// 読んだ値と、送られた値の差。送られた欄のうち、読んだ値と違うものだけを書く
function diffOf(current: TaskRow, input: UpdatedFields) {
  const values: UpdatedFields = {};
  const changes: Record<string, [string | number | null, string | number | null]> = {};
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
  return { values, changes, isEmpty: Object.keys(changes).length === 0 };
}

// 変えられない変更を断る。完了したタスクのポイントは、経験値とスプリントの集計が完了の記録の値を使うので、ずれないように変えない。
// 取り込んだタスクのタイトルは同期で書き直し、リンクは手で作ったタスクだけが持つ
function assertEditable(current: TaskRow, values: UpdatedFields): void {
  if (values.points !== undefined && current.completed_at !== null) throw new ApiError(409, 'conflict');
  if (current.is_imported === 1 && (values.title !== undefined || values.link_url !== undefined)) {
    throw new ApiError(409, 'conflict');
  }
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
    const { values, changes, isEmpty } = diffOf(current, input);
    if (isEmpty) {
      // 書くものが無くても、閉じたワークスペースは断る
      await throwIfClosed(db, workspaceId);
      return { task: detailOf(current, actor, workspace) };
    }
    assertEditable(current, values);

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
    // （完了にされていたら、次の周の assertEditable が 409 にする）
    await throwIfClosed(db, workspaceId);
    if ((await readTask(db, workspaceId, taskId)) === undefined) throw new ApiError(404, 'not_found');
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
