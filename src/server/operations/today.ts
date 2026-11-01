import { now, todayIn } from '../../shared/clock.ts';
import { daysBetween, dueStatus } from '../../shared/due.ts';
import { today, type TodayTask } from '../../shared/operations/organization/today.ts';
import type { OrganizationTables, QueryCreator } from '../db/index.ts';
import { implement } from './implement.ts';
import { reopenBlockOf } from './task-reopen.ts';

// タイムゾーンは UTC−12 時間から +14 時間なので、どのワークスペースの「今日」の始まりも今から 24 時間より前にはならない。
// 余裕を見て 2 日前より古い完了は SQL で落とす。今日かどうかの厳密な判定はワークスペースのタイムゾーンで行う
const COMPLETED_WINDOW_MS = 2 * 86_400_000;

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
  // 完了を戻せるか（reopenable）の判定に使う。削除したスプリントは結ばないので、task_sprint_id があって sprint_status が無ければ削除したスプリント
  task_sprint_id: string | null;
  story_completed_at: string | null;
};

function carryDays(todayDate: string, markedOn: string | null): number {
  if (markedOn === null || markedOn >= todayDate) return 0;
  return daysBetween(markedOn, todayDate);
}

// 区分のどれかに入りうるか。完了したものは今日完了だけ。未完了は、印がある、期日が今週の終わりまで、進行中のスプリントのどれか
function belongsToSection(row: Row, clock: { today: string; week_start: number }, completedToday: boolean): boolean {
  if (row.completed_at !== null) return completedToday;
  if (row.today_on !== null) return true;
  if (row.due_on !== null && dueStatus(row.due_on, clock.today, clock.week_start) !== 'later') return true;
  return row.sprint_status === 'active';
}

// 今日やることに読みうる、本人の担当のバックログのタスク（未完了か完了かは呼び出し側が絞る）。
// 区分に入るかの厳密な判定（ワークスペースのタイムゾーンでの今日、今週）は読んだ後の belongsToSection で行う
function todayTaskQuery(
  from: Pick<QueryCreator<OrganizationTables>, 'selectFrom'>,
  organizationId: string,
  userId: string,
) {
  return from
    .selectFrom('memberships as m')
    .innerJoin('workspaces as w', 'w.id', 'm.workspace_id')
    .innerJoin('tasks as t', 't.workspace_id', 'm.workspace_id')
    .leftJoin('users as u', (join) =>
      join.onRef('u.id', '=', 't.assignee_user_id').on('u.organization_id', '=', organizationId),
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
    .leftJoin('stories as st', (join) =>
      join.onRef('st.id', '=', 't.story_id').onRef('st.workspace_id', '=', 't.workspace_id'),
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
      't.sprint_id as task_sprint_id',
      'st.completed_at as story_completed_at',
    ])
    .where('m.user_id', '=', userId)
    .where('m.left_at', 'is', null)
    .where('w.organization_id', '=', organizationId)
    .where('w.closed_at', 'is', null)
    .where('t.tray', '=', 'backlog')
    .where('t.deleted_at', 'is', null)
    .where('t.assignee_user_id', '=', userId);
}

export const todayOperation = implement(today, async ({ db, actor }) => {
  const userId = actor.userId;
  if (userId === null) return { tasks: [], sprint_goals: [] };
  const completedSince = new Date(now().getTime() - COMPLETED_WINDOW_MS).toISOString();
  const [openResult, completedResult, goalsResult] = await db.batch([
    // 未完了と完了は、tasks_assignee_user（assignee_user_id, deleted_at, completed_at）の範囲条件に乗せるため別の文にする。
    // 1 文に OR でまとめると索引が使えず、担当した全タスクを走査する。両者は completed_at の有無で排他なので、結果は連結するだけでよい
    db.statement((q) =>
      todayTaskQuery(q, db.organizationId, userId)
        .where('t.completed_at', 'is', null)
        .where((eb) =>
          eb.or([eb('t.today_on', 'is not', null), eb('t.due_on', 'is not', null), eb('t.sprint_id', 'is not', null)]),
        ),
    ),
    db.statement((q) => todayTaskQuery(q, db.organizationId, userId).where('t.completed_at', '>=', completedSince)),
    db.statement((q) =>
      q
        .selectFrom('sprints as s')
        .innerJoin('workspaces as w', 'w.id', 's.workspace_id')
        .innerJoin('memberships as m', 'm.workspace_id', 's.workspace_id')
        .select(['w.id as workspace_id', 'w.name as workspace_name', 's.goal'])
        .where('m.user_id', '=', userId)
        .where('m.left_at', 'is', null)
        .where('w.organization_id', '=', db.organizationId)
        .where('w.closed_at', 'is', null)
        .where('s.deleted_at', 'is', null)
        .where('s.status', '=', 'active')
        .where('s.goal', 'is not', null)
        .where('s.goal', '!=', '')
        .orderBy('w.name')
        .orderBy('w.id'),
    ),
  ] as const);

  const rows = [...openResult.rows, ...completedResult.rows] as Row[];
  // ワークスペースの今日は行ごとに求めず、ワークスペースごとに 1 回だけ求める
  const todayOfWorkspace = new Map<string, string>();
  const tasks: TodayTask[] = [];
  for (const row of rows) {
    let todayDate = todayOfWorkspace.get(row.workspace_id);
    if (todayDate === undefined) {
      todayDate = todayIn(row.timezone);
      todayOfWorkspace.set(row.workspace_id, todayDate);
    }
    const clock = { today: todayDate, week_start: Number(row.week_start) };
    const completedToday = row.completed_at !== null && todayIn(row.timezone, new Date(row.completed_at)) === todayDate;
    if (!belongsToSection(row, clock, completedToday)) continue;
    tasks.push({
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
      assignee: row.assignee_id === null ? null : { id: row.assignee_id, name: row.assignee_name ?? '' },
      repository: row.repository_id === null ? null : { id: row.repository_id, name: row.repository_name ?? '' },
      sprint:
        row.sprint_id === null
          ? null
          : { id: row.sprint_id, name: row.sprint_name, start_on: row.sprint_start_on!, end_on: row.sprint_end_on! },
      // 完了したタスクの印は区分に使わない（docs/data-model.md）ので、持ち越しの日数も出さない
      carry_days: row.completed_at === null ? carryDays(todayDate, row.today_on) : 0,
      sprint_active: row.sprint_status === 'active',
      is_today_completed: completedToday,
      // 完了を戻せるか。task-reopen と同じ判定（reopenBlockOf）。ワークスペースは閉じていない行だけを読んでいる
      reopenable:
        row.completed_at !== null &&
        reopenBlockOf({
          tray: 'backlog',
          completedAt: row.completed_at,
          sprintId: row.task_sprint_id,
          sprintActive: row.sprint_status === 'active',
          parentCompleted: row.story_completed_at !== null,
        }) === null,
    });
  }
  return {
    tasks,
    sprint_goals: goalsResult.rows.map((row) => ({
      workspace_id: row.workspace_id,
      workspace_name: row.workspace_name,
      goal: row.goal!,
    })),
  };
});
