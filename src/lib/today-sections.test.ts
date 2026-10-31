import { describe, expect, test } from 'vitest';
import type { TodayTask } from '../shared/operations/organization/today.ts';
import { compareTodayTasks, todaySections } from './today-sections.ts';

// 2026-11-04 は水曜。週の始まりが月曜なら、今週は 11-02〜11-08
const TODAY = '2026-11-04';

function task(id: string, overrides: Partial<TodayTask> = {}): TodayTask {
  return {
    id,
    title: id,
    points: null,
    due_on: null,
    today_on: null,
    completed_at: null,
    workspace_id: 'w1',
    workspace_name: 'ワークスペース',
    today: TODAY,
    week_start: 1,
    position: 'a0',
    carry_days: 0,
    sprint_active: false,
    is_today_completed: false,
    assignee: null,
    repository: null,
    sprint: null,
    ...overrides,
  };
}

function ids(list: readonly TodayTask[]): string[] {
  return list.map((entry) => entry.id);
}

describe('todaySections', () => {
  test('印がある未完了は、期日切れでも今日やると決めたものだけに出す', () => {
    const marked = task('marked', { today_on: TODAY, due_on: '2026-11-01' });
    const sections = todaySections([marked]);
    expect(ids(sections.today)).toEqual(['marked']);
    expect(sections.overdue).toEqual([]);
    expect(sections.week).toEqual([]);
  });

  test('印が無く期日を過ぎたものは期日切れ', () => {
    const sections = todaySections([task('late', { due_on: '2026-11-03' })]);
    expect(ids(sections.overdue)).toEqual(['late']);
  });

  test('今日が期日の行は今週が期日に入る（期日は今日の印は画面が付ける）', () => {
    const sections = todaySections([task('due-today', { due_on: TODAY })]);
    expect(ids(sections.week)).toEqual(['due-today']);
    expect(sections.overdue).toEqual([]);
  });

  test('今週の終わりまでの期日は今週が期日。週の始まりは行のワークスペースで決める', () => {
    const sundayStart = task('sun', { due_on: '2026-11-08', week_start: 0 });
    const mondayStart = task('mon', { due_on: '2026-11-08' });
    const sections = todaySections([sundayStart, mondayStart]);
    // 週の始まりが日曜なら 11-04 の週は 11-07 まで。月曜なら 11-08 まで
    expect(ids(sections.week)).toEqual(['mon']);
    expect(ids(sections.sprint)).toEqual([]);
  });

  test('期日が来週以降でスプリントに入っていなければ、どこにも出ない', () => {
    const sections = todaySections([task('later', { due_on: '2026-11-20' }), task('none')]);
    expect(Object.values(sections).flat()).toEqual([]);
  });

  test('期日が来週以降か無く、進行中のスプリントに入っていれば進行中のスプリント', () => {
    const sections = todaySections([
      task('later', { due_on: '2026-11-20', sprint_active: true }),
      task('none', { sprint_active: true }),
    ]);
    expect(ids(sections.sprint)).toEqual(['later', 'none']);
  });

  test('期日切れと今週が期日のものは、スプリントに入っていてもスプリントの区分に出さない', () => {
    const sections = todaySections([
      task('late', { due_on: '2026-11-01', sprint_active: true }),
      task('week', { due_on: '2026-11-06', sprint_active: true }),
    ]);
    expect(ids(sections.overdue)).toEqual(['late']);
    expect(ids(sections.week)).toEqual(['week']);
    expect(sections.sprint).toEqual([]);
  });

  test('完了済みは今日完了だけに出し、今日より前の完了はどこにも出さない', () => {
    const doneToday = task('done-today', {
      completed_at: '2026-11-04T01:00:00.000Z',
      is_today_completed: true,
      today_on: TODAY,
      due_on: '2026-11-01',
      sprint_active: true,
    });
    const doneBefore = task('done-before', { completed_at: '2026-11-02T01:00:00.000Z', due_on: '2026-11-01' });
    const sections = todaySections([doneToday, doneBefore]);
    expect(ids(sections.done)).toEqual(['done-today']);
    expect(sections.today).toEqual([]);
    expect(sections.overdue).toEqual([]);
    expect(sections.sprint).toEqual([]);
  });

  test('今日やると決めたものは、持ち越しが先頭で日数の多い順、同じなら期日の早い順', () => {
    const sections = todaySections([
      task('fresh', { today_on: TODAY, due_on: '2026-11-04' }),
      task('carry1', { today_on: '2026-11-03', carry_days: 1, due_on: '2026-11-09' }),
      task('carry3-late', { today_on: '2026-11-01', carry_days: 3, due_on: '2026-11-10' }),
      task('carry3-early', { today_on: '2026-11-01', carry_days: 3, due_on: '2026-11-05' }),
      task('fresh-none', { today_on: TODAY }),
    ]);
    expect(ids(sections.today)).toEqual(['carry3-early', 'carry3-late', 'carry1', 'fresh', 'fresh-none']);
  });
});

describe('compareTodayTasks', () => {
  test('期日の早い順で、期日の無いものは最後', () => {
    const list = [task('none'), task('b', { due_on: '2026-11-09' }), task('a', { due_on: '2026-11-05' })];
    expect(ids(list.toSorted(compareTodayTasks))).toEqual(['a', 'b', 'none']);
  });

  test('期日が同じなら、ワークスペースの名前、ID、並び、タスクの ID の順', () => {
    const list = [
      task('t4', { workspace_name: 'B', workspace_id: 'w1', position: 'a0' }),
      task('t3', { workspace_name: 'A', workspace_id: 'w9', position: 'a0' }),
      task('t2', { workspace_name: 'A', workspace_id: 'w2', position: 'a1' }),
      task('t1', { workspace_name: 'A', workspace_id: 'w2', position: 'a0' }),
      task('t0', { workspace_name: 'A', workspace_id: 'w2', position: 'a0' }),
    ];
    expect(ids(list.toSorted(compareTodayTasks))).toEqual(['t0', 't1', 't2', 't3', 't4']);
  });

  test('同じ名前のワークスペースは ID で分け、行が混ざらない', () => {
    const list = [
      task('x2', { workspace_id: 'w2', position: 'a0' }),
      task('y1', { workspace_id: 'w1', position: 'b0' }),
      task('x1', { workspace_id: 'w2', position: 'a1' }),
      task('y0', { workspace_id: 'w1', position: 'a0' }),
    ];
    expect(ids(list.toSorted(compareTodayTasks))).toEqual(['y0', 'y1', 'x2', 'x1']);
  });

  test("position はコード単位の比較で、'Zz' が 'a0' より先", () => {
    const list = [task('lower', { position: 'a0' }), task('upper', { position: 'Zz' })];
    expect(ids(list.toSorted(compareTodayTasks))).toEqual(['upper', 'lower']);
  });
});
