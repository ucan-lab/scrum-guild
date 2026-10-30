import { unindexed, type OrganizationDb } from '../db/index.ts';
import type {
  CompletedBacklogCursor,
  CompletedBacklogTask,
} from '../../shared/operations/task/backlog-completed-tasks.ts';
import { backlogCompletedTasks } from '../../shared/operations/task/index.ts';
import { ApiError } from '../errors.ts';
import { implement } from './implement.ts';

// 完了したバックログのタスクを、新しい順（completed_at、同じなら id の降順）に limit + 1 件まで引く。
// storyId が null なら親のないタスク。tasks_story は story_id が NULL の行を全組織のぶん持ち、ANALYZE の後は
// SQLite が NULL を別々の値と数えて tasks_story を選び、全組織の親のないタスクを読む計画に変わる。
// 親なしの分岐は列を索引に使わせず（unindexed）、tasks_workspace_tray で引かせる。
// ストーリーの分岐は story_id の等号で tasks_story を使う（docs/data-model.md の「バックログの木」）
export function completedTasksStatement(
  db: OrganizationDb,
  workspaceId: string,
  storyId: string | null,
  before: CompletedBacklogCursor | undefined,
  limit: number,
) {
  return db.statement((q) => {
    let query = q
      .selectFrom('tasks')
      .innerJoin('workspaces as w', 'w.id', 'tasks.workspace_id')
      .leftJoin('users as u', (join) =>
        join.onRef('u.id', '=', 'tasks.assignee_user_id').on('u.organization_id', '=', db.organizationId),
      )
      .select([
        'tasks.id',
        'tasks.title',
        'tasks.points',
        'tasks.completed_at',
        'u.id as assignee_id',
        'u.name as assignee_name',
      ])
      .where('w.organization_id', '=', db.organizationId)
      .where('tasks.workspace_id', '=', workspaceId)
      .where('tasks.tray', '=', 'backlog')
      .where('tasks.deleted_at', 'is', null)
      .where('tasks.completed_at', 'is not', null);
    query =
      storyId === null
        ? query.where(unindexed('tasks.story_id'), 'is', null)
        : query.where('tasks.story_id', '=', storyId);
    if (before !== undefined)
      query = query.where((eb) =>
        eb.or([
          eb('tasks.completed_at', '<', before.completed_at),
          eb.and([eb('tasks.completed_at', '=', before.completed_at), eb('tasks.id', '<', before.id)]),
        ]),
      );
    return query
      .orderBy('tasks.completed_at', 'desc')
      .orderBy('tasks.id', 'desc')
      .limit(limit + 1);
  });
}

export const backlogCompletedTasksOperation = implement(backlogCompletedTasks, async ({ db, workspace, input }) => {
  const storyId = input.story_id;
  if (storyId !== null) {
    const story = await db.first(
      db.statement((q) =>
        q
          .selectFrom('stories as s')
          .innerJoin('workspaces as w', 'w.id', 's.workspace_id')
          .select('s.id')
          .where('w.organization_id', '=', db.organizationId)
          .where('s.workspace_id', '=', workspace.workspaceId)
          .where('s.id', '=', storyId)
          .where('s.deleted_at', 'is', null),
      ),
    );
    if (story === undefined) throw new ApiError(404, 'not_found');
  }
  const rows = await db.rows(completedTasksStatement(db, workspace.workspaceId, storyId, input.before, input.limit));
  const tasks = rows.slice(0, input.limit).map((row) => ({
    id: row.id,
    title: row.title,
    points: row.points as CompletedBacklogTask['points'],
    completed_at: row.completed_at!,
    assignee: row.assignee_id === null ? null : { id: row.assignee_id, name: row.assignee_name! },
  }));
  const last = tasks.at(-1);
  return {
    tasks,
    next: rows.length > input.limit && last !== undefined ? { completed_at: last.completed_at, id: last.id } : null,
  };
});
