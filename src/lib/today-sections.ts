// 今日やることの区分の振り分けと並べ替え。`today` が返す行を、docs/requirements.md の「今日やること」の区分に分ける。
// 同じタスクは1つの区分にだけ入る。今日と今週の判定は、行ごとのワークスペースの今日と週の始まりで決める
import { dueStatus, type DueStatus } from '../shared/due.ts';
import type { TodayTask } from '../shared/operations/organization/today.ts';

export type TodaySections = {
  overdue: TodayTask[];
  today: TodayTask[];
  week: TodayTask[];
  sprint: TodayTask[];
  done: TodayTask[];
};

// UTF-16 のコード単位の比較。`localeCompare` は実行環境の言語で順が変わるので使わない
// （position は ASCII の大文字が小文字より前に来る並びで、SQL の ORDER BY と同じ）
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// 期日の早い順（無いものは最後）、同じなら ワークスペースの名前、ID、バックログの並び（position）、タスクの ID
export function compareTodayTasks(a: TodayTask, b: TodayTask): number {
  if (a.due_on !== b.due_on) {
    if (a.due_on === null) return 1;
    if (b.due_on === null) return -1;
    return compareText(a.due_on, b.due_on);
  }
  return (
    compareText(a.workspace_name, b.workspace_name) ||
    compareText(a.workspace_id, b.workspace_id) ||
    compareText(a.position, b.position) ||
    compareText(a.id, b.id)
  );
}

// 今日やると決めたものは、持ち越しの日数の多い順を先にして、同じなら通常の並び
function compareTodayMarked(a: TodayTask, b: TodayTask): number {
  return b.carry_days - a.carry_days || compareTodayTasks(a, b);
}

// 期日の状態。暦にない期日（壊れた値）は読めないので期日なしとして扱い、画面全体を落とさない（DueChip と同じ）
function dueStatusOf(task: TodayTask): DueStatus | null {
  if (task.due_on === null) return null;
  try {
    return dueStatus(task.due_on, task.today, task.week_start);
  } catch {
    return null;
  }
}

export function todaySections(tasks: readonly TodayTask[]): TodaySections {
  const sections: TodaySections = { overdue: [], today: [], week: [], sprint: [], done: [] };
  for (const task of tasks) {
    if (task.completed_at !== null) {
      // 今日より前に完了したものは、どの区分にも出さない
      if (task.is_today_completed) sections.done.push(task);
      continue;
    }
    // 印を付けたものは、期日に関わらず今日やると決めたものだけに出す
    if (task.today_on !== null) {
      sections.today.push(task);
      continue;
    }
    const status = dueStatusOf(task);
    if (status === 'overdue') sections.overdue.push(task);
    else if (status === 'today' || status === 'this_week') sections.week.push(task);
    // 期日が来週以降か無いもので、進行中のスプリントに入っているものだけ
    else if (task.sprint_active) sections.sprint.push(task);
  }
  sections.overdue.sort(compareTodayTasks);
  sections.today.sort(compareTodayMarked);
  sections.week.sort(compareTodayTasks);
  sections.sprint.sort(compareTodayTasks);
  sections.done.sort(compareTodayTasks);
  return sections;
}
