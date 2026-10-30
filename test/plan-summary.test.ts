// 計画の画面の集計（plan-summary）。組織の分離と権限の種類ごとの許可と拒否は、一覧を回す test/operation-registry.test.ts が確かめる。
// ここでは数え方（ベロシティ、先のスプリントの集計、エピックの残り）を見る
import { describe, expect, test } from 'vitest';
import { createApp } from '../src/server/app.ts';
import { planSummary } from '../src/shared/operations/sprint/index.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import { createBoardColumn, createCompletion, createEpic, createSprint, createStory, createTask } from './factories.ts';
import { post } from './operations/harness.ts';
import { createTarget, testEnv, type Target } from './operations/world.ts';

const app = createApp(implementedOperations);

async function read(target: Target, workspaceId: string = target.workspace.id) {
  const res = await post(app, planSummary, {
    slug: target.slug,
    token: target.member.token,
    body: { workspace_id: workspaceId },
    env: testEnv,
  });
  expect(res.status).toBe(200);
  return (await res.json()) as {
    today: string;
    week_start: number;
    velocity: {
      average: number | null;
      sprints: { id: string; points: number; counted: boolean; extended_days: number; start_on: string }[];
    };
    lanes: { sprint_id: string; points: number; task_count: number; unestimated_count: number }[];
    epics: { id: string; title: string; due_on: string | null; points_done: number; points_all: number }[];
  };
}

let week = 0;
// 重ならない 14 日の期間。呼ぶたびに後ろへ進める（期間の重なりはアプリが検査するので、テストの行も重ねない）
function period() {
  week += 14;
  const start = new Date(Date.UTC(2025, 0, 1) + week * 86_400_000);
  const end = new Date(start.getTime() + 13 * 86_400_000);
  return { start_on: start.toISOString().slice(0, 10), end_on: end.toISOString().slice(0, 10) };
}

// 終了したスプリントに、完了の記録をポイントごとに足す
async function closedSprint(
  target: Target,
  points: (number | null)[],
  overrides: Parameters<typeof createSprint>[2] = {},
) {
  const sprint = await createSprint(target.organization, target.workspace.id, {
    status: 'closed',
    ...period(),
    ...overrides,
  });
  for (const value of points) {
    // 完了の記録のポイントがベロシティの元。タスクのポイントは見ない（完了の記録の修正で、記録だけが変わる）
    const task = await createTask(target.organization, target.workspace.id, target.member.userId!, {
      completed_at: '2026-10-20T00:00:00.000Z',
      completed_by: target.member.userId,
    });
    await createCompletion(target.organization, target.workspace.id, task.id, target.member.userId!, {
      sprint_id: sprint.id,
      points: value,
    });
  }
  return sprint;
}

describe('plan-summary のベロシティ', () => {
  test('終了したスプリントが無ければ平均は null で、延長した回も無い', async () => {
    const target = await createTarget();
    // 先のスプリントと進行中のスプリントは数えない
    await createSprint(target.organization, target.workspace.id, { status: 'active', ...period() });
    await createSprint(target.organization, target.workspace.id, { status: 'planned', ...period() });
    const body = await read(target);
    expect(body.velocity).toEqual({ average: null, sprints: [] });
  });

  test('3 つに満たなければあるだけで平均を出す', async () => {
    const target = await createTarget();
    const first = await closedSprint(target, [5, 3]);
    const second = await closedSprint(target, [2]);
    const body = await read(target);
    expect(body.velocity.average).toBe(5);
    expect(body.velocity.sprints.map((sprint) => [sprint.id, sprint.points, sprint.counted])).toEqual([
      [first.id, 8, true],
      [second.id, 2, true],
    ]);
  });

  test('延長した回を平均から除き、新しい 3 つの延長していない回で平均を出す。除いた回は counted が偽で残る', async () => {
    const target = await createTarget();
    const oldest = await closedSprint(target, [100]);
    const first = await closedSprint(target, [4, 2]);
    const extended = await closedSprint(target, [40], { extended_days: 3 });
    const second = await closedSprint(target, [8]);
    const third = await closedSprint(target, [10]);
    const body = await read(target);
    // 古い回（oldest）は新しい 3 つに入らず、その前の延長した回も無いので出ない
    expect(body.velocity.sprints.map((sprint) => [sprint.id, sprint.points, sprint.counted])).toEqual([
      [first.id, 6, true],
      [extended.id, 40, false],
      [second.id, 8, true],
      [third.id, 10, true],
    ]);
    expect(body.velocity.sprints[1]!.extended_days).toBe(3);
    expect(body.velocity.average).toBe(8);
    expect(body.velocity.sprints.some((sprint) => sprint.id === oldest.id)).toBe(false);
  });

  test('3 つの延長していない回より古い延長した回は出さない。延長した回だけなら平均は null', async () => {
    const target = await createTarget();
    await closedSprint(target, [9], { extended_days: 2 });
    const onlyExtended = await read(target);
    expect(onlyExtended.velocity.average).toBeNull();
    expect(onlyExtended.velocity.sprints).toHaveLength(1);
    expect(onlyExtended.velocity.sprints[0]!.counted).toBe(false);

    const other = await createTarget();
    await closedSprint(other, [7], { extended_days: 1 });
    for (const value of [1, 2, 3]) await closedSprint(other, [value]);
    const body = await read(other);
    expect(body.velocity.sprints.map((sprint) => sprint.counted)).toEqual([true, true, true]);
    expect(body.velocity.average).toBe(2);
  });

  test('完了の記録の修正で直したポイントをそのまま使い、空のポイントは 0 として足し、別のスプリントの記録を混ぜない', async () => {
    const target = await createTarget();
    const sprint = await closedSprint(target, [3, null]);
    // 完了の記録のポイントをリーダーが 3 から 8 に直した（タスクのポイントは 3 のまま）
    const task = await createTask(target.organization, target.workspace.id, target.member.userId!, {
      points: 3,
      completed_at: '2026-10-20T00:00:00.000Z',
    });
    await createCompletion(target.organization, target.workspace.id, task.id, target.member.userId!, {
      sprint_id: sprint.id,
      points: 8,
    });
    // スプリントの外の完了は数えない
    const outside = await createTask(target.organization, target.workspace.id, target.member.userId!, { points: 13 });
    await createCompletion(target.organization, target.workspace.id, outside.id, target.member.userId!, {
      points: 13,
    });
    const body = await read(target);
    expect(body.velocity.sprints.map((item) => item.points)).toEqual([11]);
    expect(body.velocity.average).toBe(11);
  });

  test('削除したスプリントと、ほかのワークスペースのスプリントを数えない', async () => {
    const target = await createTarget();
    const kept = await closedSprint(target, [5]);
    await closedSprint(target, [50], { deleted_at: '2026-10-21T00:00:00.000Z' });
    // 同じ組織の別のワークスペースの終了したスプリント
    const other = await createSprint(target.organization, target.otherWorkspace.id, { status: 'closed', ...period() });
    const task = await createTask(target.organization, target.otherWorkspace.id, target.admin.userId!, { points: 13 });
    await createCompletion(target.organization, target.otherWorkspace.id, task.id, target.admin.userId!, {
      sprint_id: other.id,
      points: 13,
    });
    const body = await read(target);
    expect(body.velocity.sprints.map((item) => item.id)).toEqual([kept.id]);
    expect(body.velocity.average).toBe(5);
  });
});

describe('plan-summary のベロシティの選び方', () => {
  test('新しい 3 つは作った順ではなく start_on で選び、開始日が古いスプリントを後から作っても入らない', async () => {
    const target = await createTarget();
    const newest = await closedSprint(target, [9], { start_on: '2031-03-01', end_on: '2031-03-14' });
    const middle = await closedSprint(target, [6], { start_on: '2031-02-01', end_on: '2031-02-14' });
    const oldest = await closedSprint(target, [3], { start_on: '2031-01-01', end_on: '2031-01-14' });
    // 後から作った、開始日の古いスプリントは新しい 3 つに入らない
    await closedSprint(target, [300], { start_on: '2020-01-01', end_on: '2020-01-14' });
    const body = await read(target);
    expect(body.velocity.sprints.map((sprint) => sprint.id)).toEqual([oldest.id, middle.id, newest.id]);
    expect(body.velocity.average).toBe(6);
  });

  test('先のスプリントは、作った順ではなく start_on の順に並ぶ', async () => {
    const target = await createTarget();
    const later = await createSprint(target.organization, target.workspace.id, {
      status: 'planned',
      start_on: '2032-02-01',
      end_on: '2032-02-14',
    });
    const earlier = await createSprint(target.organization, target.workspace.id, {
      status: 'active',
      start_on: '2032-01-01',
      end_on: '2032-01-14',
    });
    const body = await read(target);
    expect(body.lanes.map((lane) => lane.sprint_id)).toEqual([earlier.id, later.id]);
  });

  test('延長した回が 7 つあっても、除いた回として出るのは新しい 6 つまで', async () => {
    const target = await createTarget();
    for (const value of [1, 2, 3]) await closedSprint(target, [value]);
    const extended = [];
    for (let index = 0; index < 7; index += 1) {
      extended.push(await closedSprint(target, [2], { extended_days: 1 }));
    }
    const body = await read(target);
    const excluded = body.velocity.sprints.filter((sprint) => !sprint.counted);
    expect(excluded.map((sprint) => sprint.id)).toEqual(extended.slice(1).map((sprint) => sprint.id));
    expect(body.velocity.sprints.filter((sprint) => sprint.counted)).toHaveLength(3);
    expect(body.velocity.sprints).toHaveLength(9);
    expect(body.velocity.average).toBe(2);
  });
});

describe('plan-summary の先のスプリントの集計', () => {
  test('入れたポイント、件数、未見積もりの件数を開始日の順に返す。タスクの無いスプリントは 0', async () => {
    const target = await createTarget();
    const planned = await createSprint(target.organization, target.workspace.id, { status: 'planned', ...period() });
    const active = await createSprint(target.organization, target.workspace.id, { status: 'active', ...period() });
    const empty = await createSprint(target.organization, target.workspace.id, { status: 'planned', ...period() });
    const column = await createBoardColumn(target.organization, target.workspace.id);
    const put = (sprintId: string, overrides: Parameters<typeof createTask>[3]) =>
      createTask(target.organization, target.workspace.id, target.member.userId!, {
        sprint_id: sprintId,
        column_id: column.id,
        column_position: 'a0',
        ...overrides,
      });
    await put(planned.id, { points: 5 });
    await put(planned.id, { points: 3 });
    await put(planned.id, { points: null });
    await put(planned.id, { points: 8, deleted_at: '2026-10-21T00:00:00.000Z' });
    await put(active.id, { points: 2, completed_at: '2026-10-21T00:00:00.000Z' });
    // 完了した未見積もりは、直せないので未見積もりの件数に数えない。件数とポイントには数える
    await put(active.id, { points: null, completed_at: '2026-10-21T00:00:00.000Z' });
    await put(active.id, { points: null });
    await put(active.id, { points: null });
    const body = await read(target);
    expect(body.lanes).toEqual([
      { sprint_id: planned.id, points: 8, task_count: 3, unestimated_count: 1 },
      { sprint_id: active.id, points: 2, task_count: 4, unestimated_count: 2 },
      { sprint_id: empty.id, points: 0, task_count: 0, unestimated_count: 0 },
    ]);
  });

  test('終了したスプリントと削除したスプリント、ほかのワークスペースのスプリントは出さない', async () => {
    const target = await createTarget();
    await createSprint(target.organization, target.workspace.id, { status: 'closed', ...period() });
    await createSprint(target.organization, target.workspace.id, {
      status: 'planned',
      deleted_at: '2026-10-21T00:00:00.000Z',
      ...period(),
    });
    await createSprint(target.organization, target.otherWorkspace.id, { status: 'planned', ...period() });
    expect((await read(target)).lanes).toEqual([]);
  });
});

describe('plan-summary のエピックごとの残り', () => {
  async function epicWith(target: Target, overrides: Parameters<typeof createEpic>[3] = {}) {
    return createEpic(target.organization, target.workspace.id, target.member.userId!, overrides);
  }
  async function storyIn(target: Target, epicId: string | null, overrides: Parameters<typeof createStory>[3] = {}) {
    return createStory(target.organization, target.workspace.id, target.member.userId!, {
      epic_id: epicId,
      ...overrides,
    });
  }
  async function taskIn(target: Target, storyId: string | null, overrides: Parameters<typeof createTask>[3] = {}) {
    return createTask(target.organization, target.workspace.id, target.member.userId!, {
      story_id: storyId,
      ...overrides,
    });
  }

  test('配下のストーリーのタスクのポイントを、完了した分と全体で返す。未見積もりは 0 で、期日を添える', async () => {
    const target = await createTarget();
    const epic = await epicWith(target, { title: '交換先を増やす', due_on: '2026-11-27', position: 'a0' });
    const first = await storyIn(target, epic.id, { position: 'a0' });
    const second = await storyIn(target, epic.id, { position: 'a1' });
    await taskIn(target, first.id, { points: 5, completed_at: '2026-10-21T00:00:00.000Z' });
    await taskIn(target, first.id, { points: 3 });
    await taskIn(target, second.id, { points: null });
    await taskIn(target, second.id, { points: 2 });
    // 削除したタスクと、削除したストーリーの下のタスクは数えない
    await taskIn(target, second.id, { points: 13, deleted_at: '2026-10-21T00:00:00.000Z' });
    const gone = await storyIn(target, epic.id, { deleted_at: '2026-10-21T00:00:00.000Z' });
    await taskIn(target, gone.id, { points: 8 });
    // ストーリーを持たないエピックは 0 / 0
    const empty = await epicWith(target, { title: '空のエピック', position: 'a1' });
    const body = await read(target);
    expect(body.epics).toEqual([
      { id: epic.id, title: '交換先を増やす', due_on: '2026-11-27', points_done: 5, points_all: 10 },
      { id: empty.id, title: '空のエピック', due_on: null, points_done: 0, points_all: 0 },
    ]);
  });

  test('完了したエピックと中止したエピック、削除したエピック、ほかのワークスペースのエピックを出さない', async () => {
    const target = await createTarget();
    const open = await epicWith(target, { position: 'a0' });
    const completed = await epicWith(target, { position: 'a1', completed_at: '2026-10-21T00:00:00.000Z' });
    await epicWith(target, {
      position: 'a2',
      canceled_at: '2026-10-21T00:00:00.000Z',
      canceled_by: target.member.userId,
    });
    await epicWith(target, { position: 'a3', deleted_at: '2026-10-21T00:00:00.000Z' });
    await createEpic(target.organization, target.otherWorkspace.id, target.admin.userId!, { position: 'a4' });
    await taskIn(target, (await storyIn(target, completed.id)).id, { points: 5 });
    const body = await read(target);
    expect(body.epics.map((epic) => epic.id)).toEqual([open.id]);
  });

  test('エピックの残りは、バックログの木のエピックの points_done と points_all から引いた値と同じ', async () => {
    const target = await createTarget();
    const epic = await epicWith(target);
    const story = await storyIn(target, epic.id);
    await taskIn(target, story.id, { points: 3, completed_at: '2026-10-21T00:00:00.000Z' });
    await taskIn(target, story.id, { points: 5 });
    await taskIn(target, story.id, { points: 1 });
    const { backlogTree } = await import('../src/shared/operations/task/index.ts');
    const tree = await post(app, backlogTree, {
      slug: target.slug,
      token: target.member.token,
      body: { workspace_id: target.workspace.id },
      env: testEnv,
    });
    const treeEpic = ((await tree.json()) as { epics: { id: string; points_done: number; points_all: number }[] })
      .epics[0]!;
    const row = (await read(target)).epics[0]!;
    expect([row.points_done, row.points_all]).toEqual([treeEpic.points_done, treeEpic.points_all]);
    expect(row.points_all - row.points_done).toBe(6);
  });
});

describe('plan-summary の読み取り', () => {
  test('別のワークスペースの ID と別の組織の ID は 404', async () => {
    const target = await createTarget();
    const other = await createTarget();
    const foreign = await post(app, planSummary, {
      slug: target.slug,
      token: target.member.token,
      body: { workspace_id: other.workspace.id },
      env: testEnv,
    });
    expect(foreign.status).toBe(404);
    // 閉じたワークスペースでも読める
    const closed = await createTarget({ closed: true });
    expect((await read(closed)).lanes).toEqual([]);
  });

  test('ワークスペースの今日と週の始まりを返す', async () => {
    const target = await createTarget();
    const body = await read(target);
    expect(body.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(body.week_start).toBeGreaterThanOrEqual(0);
    expect(body.week_start).toBeLessThanOrEqual(6);
  });
});
