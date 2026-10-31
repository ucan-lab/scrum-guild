import { todayIn } from '../../shared/clock.ts';
import { addDays, dueStatus } from '../../shared/due.ts';
import { today, type TodayTask } from '../../shared/operations/organization/today.ts';
import { implement } from './implement.ts';

type Row = {
  id: string;
  title: string;
  points: number | null;
  due_on: string | null;
  today_on: string | null;
  completed_at: string | null;
  workspace_id: string;
  workspace_name: string;
  timezone: string;
  week_start: number;
  position: string;
  assignee_id: string | null;
  assignee_name: string | null;
  repository_id: string | null;
  repository_name: string | null;
  sprint_id: string | null;
  sprint_name: string | null;
  sprint_start_on: string | null;
  sprint_end_on: string | null;
  sprint_status: string | null;
};

function carryDays(todayDate: string, markedOn: string | null): number {
  if (markedOn === null || markedOn >= todayDate) return 0;
  let days = 0;
  let date = markedOn;
  while (date < todayDate) {
    date = addDays(date, 1);
    days++;
  }
  return days;
}

export const todayOperation = implement(today, async ({ db, actor }) => {
  if (actor.userId === null) return { tasks: [], sprint_goals: [] };
  const [tasksResult, goalsResult] = await db.batch([
    db.statement((q) =>
      q
        .selectFrom('memberships as m')
        .innerJoin('workspaces as w', 'w.id', 'm.workspace_id')
        .innerJoin('tasks as t', 't.workspace_id', 'm.workspace_id')
        .leftJoin('users as u', (join) =>
          join.onRef('u.id', '=', 't.assignee_user_id').on('u.organization_id', '=', db.organizationId),
        )
        .leftJoin('repositories as r', (join) =>
          join
            .onRef('r.id', '=', 't.repository_id')
            .onRef('r.workspace_id', '=', 't.workspace_id')
            .on('r.deleted_at', 'is', null),
        )
        .leftJoin('sprints as s', (join) =>
          join
            .onRef('s.id', '=', 't.sprint_id')
            .onRef('s.workspace_id', '=', 't.workspace_id')
            .on('s.deleted_at', 'is', null),
        )
        .select([
          't.id',
          't.title',
          't.points',
          't.due_on',
          't.today_on',
          't.completed_at',
          't.position',
          'w.id as workspace_id',
          'w.name as workspace_name',
          'w.timezone',
          'w.week_start',
          'u.id as assignee_id',
          'u.name as assignee_name',
          'r.id as repository_id',
          'r.name as repository_name',
          's.id as sprint_id',
          's.name as sprint_name',
          's.start_on as sprint_start_on',
          's.end_on as sprint_end_on',
          's.status as sprint_status',
        ])
        .where('m.user_id', '=', actor.userId)
        .where('m.left_at', 'is', null)
        .where('w.organization_id', '=', db.organizationId)
        .where('w.closed_at', 'is', null)
        .where('t.tray', '=', 'backlog')
        .where('t.deleted_at', 'is', null)
        .where('t.assignee_user_id', '=', actor.userId),
    ),
    db.statement((q) =>
      q
        .selectFrom('sprints as s')
        .innerJoin('workspaces as w', 'w.id', 's.workspace_id')
        .innerJoin('memberships as m', 'm.workspace_id', 's.workspace_id')
        .select(['w.id as workspace_id', 'w.name as workspace_name', 's.goal'])
        .where('m.user_id', '=', actor.userId)
        .where('m.left_at', 'is', null)
        .where('w.organization_id', '=', db.organizationId)
        .where('w.closed_at', 'is', null)
        .where('s.deleted_at', 'is', null)
        .where('s.status', '=', 'active')
        .where('s.goal', 'is not', null)
        .where('s.goal', '!=', ''),
    ),
  ] as const);

  const rows = tasksResult.rows as Row[];
  const tasks = rows.map((row): TodayTask & { timezone: string } => {
    const clock = { today: todayIn(row.timezone), week_start: Number(row.week_start) };
    return {
      id: row.id,
      title: row.title,
      points: row.points as TodayTask['points'],
      due_on: row.due_on,
      today_on: row.today_on,
      completed_at: row.completed_at,
      workspace_id: row.workspace_id,
      workspace_name: row.workspace_name,
      ...clock,
      position: row.position,
      timezone: row.timezone,
      assignee: row.assignee_id === null ? null : { id: row.assignee_id, name: row.assignee_name ?? '' },
      repository: row.repository_id === null ? null : { id: row.repository_id, name: row.repository_name ?? '' },
      sprint:
        row.sprint_id === null
          ? null
          : { id: row.sprint_id, name: row.sprint_name, start_on: row.sprint_start_on!, end_on: row.sprint_end_on! },
      carry_days: carryDays(clock.today, row.today_on),
      sprint_active: row.sprint_status === 'active',
      is_today_completed:
        row.completed_at !== null && todayIn(row.timezone, new Date(row.completed_at)) === clock.today,
    };
  });
  return {
    tasks: tasks.filter((task) => {
      if (task.completed_at !== null) return todayIn(task.timezone, new Date(task.completed_at)) === task.today;
      if (task.today_on !== null) return true;
      if (
        task.due_on !== null &&
        ['overdue', 'today', 'this_week'].includes(dueStatus(task.due_on, task.today, task.week_start))
      )
        return true;
      return task.sprint_active;
    }),
    sprint_goals: goalsResult.rows.map((row) => ({
      workspace_id: row.workspace_id,
      workspace_name: row.workspace_name,
      goal: row.goal!,
    })),
  };
});
