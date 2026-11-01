// タスクの今日やるの印を付け外す（task-today-mark）。docs/data-model.md の「書き込みの単位」の「タスクの今日やるの印」
import { now, todayIn } from '../../shared/clock.ts';
import { taskTodayMark, type TaskTodayMarkConflictReason } from '../../shared/operations/task/index.ts';
import { previousStatementChanged, type OrganizationDb } from '../db/index.ts';
import { ApiError } from '../errors.ts';
import { uuidv7 } from '../uuid.ts';
import { implement } from './implement.ts';
import { actorUserIdOf, changeLogColumns, openWorkspace, throwIfClosed } from './write-guards.ts';

// 同時の更新に負けたときにやり直す回数の上限。超えたら 409 の conflict（task-assign と同じ）
const MAX_UPDATE_ATTEMPTS = 3;

function markConflict(reason: TaskTodayMarkConflictReason): ApiError {
  return new ApiError(409, 'conflict', { reason });
}

// 削除していないバックログのタスクの、担当と印と完了。ワークスペースで必ず絞る（受信箱とアーカイブのタスクは、task-complete と同じく 404）
async function readMarkState(db: OrganizationDb, workspaceId: string, taskId: string) {
  return db.first(
    db.statement((q) =>
      q
        .selectFrom('tasks')
        .select(['tasks.assignee_user_id', 'tasks.today_on', 'tasks.completed_at'])
        .where('tasks.id', '=', taskId)
        .where('tasks.workspace_id', '=', workspaceId)
        .where('tasks.tray', '=', 'backlog')
        .where('tasks.deleted_at', 'is', null),
    ),
  );
}

// ワークスペースのタイムゾーンの今日。組織とワークスペースで絞る
async function workspaceToday(db: OrganizationDb, workspaceId: string): Promise<string> {
  const row = await db.first(
    db.statement((q) =>
      q
        .selectFrom('workspaces')
        .select('workspaces.timezone')
        .where('workspaces.id', '=', workspaceId)
        .where('workspaces.organization_id', '=', db.organizationId),
    ),
  );
  if (row === undefined) throw new ApiError(404, 'not_found');
  return todayIn(row.timezone);
}

// 印を付けるか外す。読んだ状態が違うときだけ、「読んだ担当（呼んだ本人）のまま、読んだ今日やるの印のまま、完了していない、
// ワークスペースが開いている」という条件つきで書き、直前の更新が行を変えたときだけ履歴を書く。
// 通らなかったら読み直して、やり直す（task-assign と同じ。3 回まで）。バックログでないタスクと削除したタスクは 404
export const taskTodayMarkOperation = implement(taskTodayMark, async ({ db, actor, workspace, input }) => {
  const actorUserId = actorUserIdOf(actor);
  const organizationId = db.organizationId;
  const workspaceId = workspace.workspaceId;
  const taskId = input.task_id;

  for (let attempt = 0; attempt < MAX_UPDATE_ATTEMPTS; attempt++) {
    const current = await readMarkState(db, workspaceId, taskId);
    if (current === undefined) {
      await throwIfClosed(db, workspaceId);
      throw new ApiError(404, 'not_found');
    }
    // 閉じたワークスペースは、本人でも完了していても、まず workspace_closed で答える
    await throwIfClosed(db, workspaceId);
    if (current.assignee_user_id !== actorUserId) throw markConflict('not_assignee');
    if (current.completed_at !== null) throw markConflict('completed');
    // すでにその状態なら何も書かない。付いている印（持ち越しを含む）は、付け直しても日付を今日に書き換えない
    if (input.marked === (current.today_on !== null)) return { task_id: taskId, today_on: current.today_on };

    const next = input.marked ? await workspaceToday(db, workspaceId) : null;
    const at = now();
    const updatedAt = at.toISOString();
    const results = await db.batch([
      db.statement((q) =>
        q
          .updateTable('tasks')
          .set({ today_on: next, updated_at: updatedAt })
          .where((eb) =>
            eb.and([
              eb('id', '=', taskId),
              eb('workspace_id', '=', workspaceId),
              eb('tray', '=', 'backlog'),
              eb('deleted_at', 'is', null),
              eb('completed_at', 'is', null),
              // 読んだときの担当（呼んだ本人）と今日やるの印のまま（履歴の「前」がずれないように）
              eb('assignee_user_id', '=', actorUserId),
              eb('today_on', 'is', current.today_on),
              eb.exists(openWorkspace(q, organizationId, workspaceId)),
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
                eb.val(JSON.stringify({ today_on: [current.today_on, next] })).as('changes_json'),
                eb.val(updatedAt).as('created_at'),
              ])
              .where(previousStatementChanged),
          ),
      ),
    ]);

    if ((results[0]?.changes ?? 0) > 0) return { task_id: taskId, today_on: next };
    // 閉じていれば 409 の workspace_closed。どちらでもなければ、別の要求が先に担当か印を変えたか、完了にしたか、消したので、
    // 読み直してやり直す（次の周の読み取りが、404 か、本人でない、完了している、すでにその状態のどれかにする）
    await throwIfClosed(db, workspaceId);
  }
  throw new ApiError(409, 'conflict');
});
