import type { CompletedBacklogTask } from '../../shared/operations/task/backlog-completed-tasks.ts';
import { backlogCompletedTasks } from '../../shared/operations/task/index.ts';
import { ApiError } from '../errors.ts';
import { implement } from './implement.ts';

export const backlogCompletedTasksOperation = implement(backlogCompletedTasks, async ({ db, workspace, input }) => {
  if (input.story_id !== null) {
    const story = await db.first(
      db.statement((q) =>
        q
          .selectFrom('stories as s')
          .innerJoin('workspaces as w', 'w.id', 's.workspace_id')
          .select('s.id')
          .where('w.organization_id', '=', db.organizationId)
          .where('s.workspace_id', '=', workspace.workspaceId)
          .where('s.id', '=', input.story_id!)
          .where('s.deleted_at', 'is', null),
      ),
    );
    if (story === undefined) throw new ApiError(404, 'not_found');
  }
  const before = input.before;
  const rows = await db.rows(
    db.statement((q) => {
      let query = q
        .selectFrom('tasks as t')
        .innerJoin('workspaces as w', 'w.id', 't.workspace_id')
        .leftJoin('users as u', (join) =>
          join.onRef('u.id', '=', 't.assignee_user_id').on('u.organization_id', '=', db.organizationId),
        )
        .select(['t.id', 't.title', 't.points', 't.completed_at', 'u.id as assignee_id', 'u.name as assignee_name'])
        .where('w.organization_id', '=', db.organizationId)
        .where('t.workspace_id', '=', workspace.workspaceId)
        .where('t.story_id', input.story_id === null ? 'is' : '=', input.story_id)
        .where('t.tray', '=', 'backlog')
        .where('t.deleted_at', 'is', null)
        .where('t.completed_at', 'is not', null);
      if (before !== undefined)
        query = query.where((eb) =>
          eb.or([
            eb('t.completed_at', '<', before.completed_at),
            eb.and([eb('t.completed_at', '=', before.completed_at), eb('t.id', '<', before.id)]),
          ]),
        );
      return query
        .orderBy('t.completed_at', 'desc')
        .orderBy('t.id', 'desc')
        .limit(input.limit + 1);
    }),
  );
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
