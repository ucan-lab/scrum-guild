// スプリントを始める（sprint-start）、スプリントの画面の読み取り（sprint-board）、カードの列の移動と並べ替え（task-column-move）。
// 組織の分離と権限の種類ごとの許可と拒否は、一覧を回す test/operation-registry.test.ts が確かめる。ここでは要の場面だけを重ねて見る
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, test } from 'vitest';
import { setFixedNow } from '../src/shared/clock.ts';
import { sprintBoard, sprintStart, taskColumnMove } from '../src/shared/operations/sprint/index.ts';
import { taskComplete } from '../src/shared/operations/task/index.ts';
import { createApp } from '../src/server/app.ts';
import { orgDb } from '../src/server/db/index.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import { createBoardColumn, createSprint, createSprintEntry, createStory, createTask } from './factories.ts';
import { errorCodeOf, post } from './operations/harness.ts';
import { createTarget, testEnv, type Person, type Target } from './operations/world.ts';

const app = createApp(implementedOperations);

afterEach(() => {
  setFixedNow(undefined);
});

// 開発用の時計（DEV_NOW）が使える、ループバックの公開 URL の環境。始める操作は最終日を今日と比べるので、時計を止めて呼ぶ。
// 2026-10-26 10:00（日本時間）の今日は 2026-10-26
const DEV_NOW = '2026-10-26T10:00:00+09:00';
function clockEnv(devNow: string): Env {
  return Object.assign({}, testEnv, { PUBLIC_ORIGIN: 'http://localhost:8787', DEV_NOW: devNow });
}

function call(
  target: Target,
  definition: Parameters<typeof post>[1],
  body: Record<string, unknown>,
  person: Person = target.member,
  devNow: string = DEV_NOW,
) {
  return post(app, definition, {
    slug: target.slug,
    token: person.token,
    body: { workspace_id: target.workspace.id, ...body },
    env: clockEnv(devNow),
  });
}

async function setTimezone(target: Target, timezone: string) {
  const db = orgDb(env, target.organization.verified);
  await db.run(
    db.statement((q) =>
      q
        .updateTable('workspaces')
        .set({ timezone })
        .where('id', '=', target.workspace.id)
        .where('organization_id', '=', target.organization.id),
    ),
  );
}

async function reasonOf(res: Response): Promise<unknown> {
  const body = (await res.json()) as { error?: { details?: { reason?: unknown } } };
  return body.error?.details?.reason;
}

// ワークスペースの作成と同じ形の列（完了でない列を2つと完了の列）
async function createBoard(target: Target) {
  const done = await createBoardColumn(target.organization, target.workspace.id, {
    name: null,
    is_done: 1,
    position: 'Zz',
  });
  const second = await createBoardColumn(target.organization, target.workspace.id, { name: '遂行中', position: 'a1' });
  const first = await createBoardColumn(target.organization, target.workspace.id, { name: '出発前', position: 'a0' });
  return { first, second, done };
}

async function setup() {
  const target = await createTarget();
  const board = await createBoard(target);
  return { target, board };
}

async function activeSprintWith(target: Target, overrides = {}) {
  return createSprint(target.organization, target.workspace.id, { status: 'active', ...overrides });
}

async function card(target: Target, sprintId: string, columnId: string, position: string, overrides = {}) {
  const task = await createTask(target.organization, target.workspace.id, target.member.userId!, {
    sprint_id: sprintId,
    column_id: columnId,
    column_position: position,
    ...overrides,
  });
  await createSprintEntry(target.organization, target.workspace.id, sprintId, task.id, target.member.userId!);
  return task;
}

async function sprintRow(target: Target, sprintId: string) {
  const db = orgDb(env, target.organization.verified);
  return db.first(db.statement((q) => q.selectFrom('sprints').selectAll().where('id', '=', sprintId)));
}

async function activeCount(target: Target): Promise<number> {
  const db = orgDb(env, target.organization.verified);
  const rows = await db.rows(
    db.statement((q) =>
      q
        .selectFrom('sprints')
        .select('id')
        .where('workspace_id', '=', target.workspace.id)
        .where('status', '=', 'active'),
    ),
  );
  return rows.length;
}

async function logsOf(target: Target, entityId: string) {
  const db = orgDb(env, target.organization.verified);
  return db.rows(
    db.statement((q) =>
      q
        .selectFrom('change_logs')
        .selectAll()
        .where('entity_id', '=', entityId)
        .where('organization_id', '=', target.organization.id)
        .orderBy('created_at')
        .orderBy('id'),
    ),
  );
}

async function positionsIn(target: Target, sprintId: string, columnId: string): Promise<string[]> {
  const db = orgDb(env, target.organization.verified);
  const rows = await db.rows(
    db.statement((q) =>
      q
        .selectFrom('tasks')
        .select(['id', 'title'])
        .where('workspace_id', '=', target.workspace.id)
        .where('sprint_id', '=', sprintId)
        .where('column_id', '=', columnId)
        .orderBy('column_position')
        .orderBy('id'),
    ),
  );
  return rows.map((row) => row.title);
}

describe('sprint-start', () => {
  test('先のスプリントを進行中にして、ゴールと始めた人と日時を残し、変更の履歴を書く', async () => {
    const { target } = await setup();
    const sprint = await createSprint(target.organization, target.workspace.id, { name: '第15回' });

    const res = await call(
      target,
      sprintStart,
      { sprint_id: sprint.id, goal: '  新しい依頼を3件受ける\n' },
      target.leader,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      sprint: { id: sprint.id, status: 'active', goal: '新しい依頼を3件受ける', name: '第15回' },
    });

    const row = await sprintRow(target, sprint.id);
    expect(row).toMatchObject({ status: 'active', goal: '新しい依頼を3件受ける', started_by: target.leader.userId });
    expect(row?.started_at).not.toBeNull();
    const logs = await logsOf(target, sprint.id);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ entity_type: 'sprint', action: 'update' });
    expect(JSON.parse(logs[0]!.changes_json)).toEqual({
      status: ['planned', 'active'],
      goal: [null, '新しい依頼を3件受ける'],
    });
  });

  test('ゴールは空でも始められ、空白だけのゴールも空と同じ', async () => {
    const { target } = await setup();
    const withoutGoal = await createSprint(target.organization, target.workspace.id);
    const res = await call(target, sprintStart, { sprint_id: withoutGoal.id }, target.leader);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ sprint: { status: 'active', goal: null } });
    expect(JSON.parse((await logsOf(target, withoutGoal.id))[0]!.changes_json)).toEqual({
      status: ['planned', 'active'],
    });
  });

  test('空白だけのゴールは空と同じ', async () => {
    const { target } = await setup();
    const blank = await createSprint(target.organization, target.workspace.id);
    const res = await call(target, sprintStart, { sprint_id: blank.id, goal: '   ' }, target.leader);
    expect(res.status).toBe(200);
    expect((await sprintRow(target, blank.id))?.goal).toBeNull();
  });

  test('長すぎるゴールと見えない文字を含むゴールは 400', async () => {
    const { target } = await setup();
    const sprint = await createSprint(target.organization, target.workspace.id);
    const tooLong = await call(target, sprintStart, { sprint_id: sprint.id, goal: 'あ'.repeat(201) }, target.leader);
    expect(tooLong.status).toBe(400);
    const hidden = await call(target, sprintStart, { sprint_id: sprint.id, goal: '依頼​' }, target.leader);
    expect(hidden.status).toBe(400);
    expect((await sprintRow(target, sprint.id))?.status).toBe('planned');
  });

  test('進行中が既にあれば 409 の active_exists で、進行中は2つにならない', async () => {
    const { target } = await setup();
    await activeSprintWith(target);
    const next = await createSprint(target.organization, target.workspace.id, {
      start_on: '2026-12-01',
      end_on: '2026-12-14',
    });

    const res = await call(target, sprintStart, { sprint_id: next.id, goal: 'ゴール' }, target.leader);
    expect(res.status).toBe(409);
    expect(await errorCodeOf(res.clone())).toBe('conflict');
    expect(await reasonOf(res)).toBe('active_exists');
    expect(await activeCount(target)).toBe(1);
    expect(await sprintRow(target, next.id)).toMatchObject({ status: 'planned', goal: null });
    expect(await logsOf(target, next.id)).toHaveLength(0);
  });

  test('同時に2つのスプリントを始めても、片方だけが通る', async () => {
    const { target } = await setup();
    const a = await createSprint(target.organization, target.workspace.id);
    const b = await createSprint(target.organization, target.workspace.id, {
      start_on: '2026-12-01',
      end_on: '2026-12-14',
    });

    const [first, second] = await Promise.all([
      call(target, sprintStart, { sprint_id: a.id }, target.leader),
      call(target, sprintStart, { sprint_id: b.id }, target.leader),
    ]);
    expect([first.status, second.status].sort()).toEqual([200, 409]);
    const loser = first.status === 409 ? first : second;
    expect(await reasonOf(loser)).toBe('active_exists');
    expect(await activeCount(target)).toBe(1);
  });

  test('同じスプリントを同時に2回始めると、片方は 409 の started', async () => {
    const { target } = await setup();
    const sprint = await createSprint(target.organization, target.workspace.id);
    const [first, second] = await Promise.all([
      call(target, sprintStart, { sprint_id: sprint.id }, target.leader),
      call(target, sprintStart, { sprint_id: sprint.id }, target.leader),
    ]);
    expect([first.status, second.status].sort()).toEqual([200, 409]);
    const loser = first.status === 409 ? first : second;
    expect(await reasonOf(loser)).toBe('started');
    expect(await logsOf(target, sprint.id)).toHaveLength(1);
  });

  test('始まっているスプリントと終了したスプリントは 409 の started', async () => {
    const { target } = await setup();
    const closed = await createSprint(target.organization, target.workspace.id, { status: 'closed' });
    const res = await call(target, sprintStart, { sprint_id: closed.id }, target.leader);
    expect(res.status).toBe(409);
    expect(await reasonOf(res)).toBe('started');
    expect((await sprintRow(target, closed.id))?.status).toBe('closed');
  });

  test('最終日がワークスペースの今日より前なら 409 の ended で、何も変わらない。今日が最終日なら始められる', async () => {
    const { target } = await setup();
    // 今日は 2026-10-26（日本時間）。最終日が昨日
    const past = await createSprint(target.organization, target.workspace.id, {
      start_on: '2026-10-12',
      end_on: '2026-10-25',
    });
    const refused = await call(target, sprintStart, { sprint_id: past.id, goal: 'ゴール' }, target.leader);
    expect(refused.status).toBe(409);
    expect(await errorCodeOf(refused.clone())).toBe('conflict');
    expect(await reasonOf(refused)).toBe('ended');
    expect(await sprintRow(target, past.id)).toMatchObject({ status: 'planned', goal: null });
    expect(await logsOf(target, past.id)).toHaveLength(0);
    expect(await activeCount(target)).toBe(0);

    // 最終日が今日
    const lastDay = await createSprint(target.organization, target.workspace.id, {
      start_on: '2026-10-13',
      end_on: '2026-10-26',
    });
    expect((await call(target, sprintStart, { sprint_id: lastDay.id }, target.leader)).status).toBe(200);
    expect((await sprintRow(target, lastDay.id))?.status).toBe('active');
  });

  test('開始日が明日でも、開始日より前に始められる', async () => {
    const { target } = await setup();
    const future = await createSprint(target.organization, target.workspace.id, {
      start_on: '2026-10-27',
      end_on: '2026-11-09',
    });
    const res = await call(target, sprintStart, { sprint_id: future.id }, target.leader);
    expect(res.status).toBe(200);
    expect(await sprintRow(target, future.id)).toMatchObject({ status: 'active', start_on: '2026-10-27' });
  });

  test('今日はワークスペースのタイムゾーンで数える（UTC の日付とずれる時刻）', async () => {
    // 2026-10-26 20:00 UTC は、日本では 10-27 05:00（今日は 10-27）。最終日が 10-26 のスプリントは、UTC の日付なら通るが断る
    const tokyo = await setup();
    await setTimezone(tokyo.target, 'Asia/Tokyo');
    const endedInTokyo = await createSprint(tokyo.target.organization, tokyo.target.workspace.id, {
      start_on: '2026-10-13',
      end_on: '2026-10-26',
    });
    const refused = await call(
      tokyo.target,
      sprintStart,
      { sprint_id: endedInTokyo.id },
      tokyo.target.leader,
      '2026-10-26T20:00:00Z',
    );
    expect(refused.status).toBe(409);
    expect(await reasonOf(refused)).toBe('ended');

    // 2026-10-27 03:00 UTC は、ロサンゼルスでは 10-26 20:00（今日は 10-26）。最終日が 10-26 のスプリントは、UTC の日付なら断るが通る
    const la = await setup();
    await setTimezone(la.target, 'America/Los_Angeles');
    const lastDayInLa = await createSprint(la.target.organization, la.target.workspace.id, {
      start_on: '2026-10-13',
      end_on: '2026-10-26',
    });
    const started = await call(
      la.target,
      sprintStart,
      { sprint_id: lastDayInLa.id },
      la.target.leader,
      '2026-10-27T03:00:00Z',
    );
    expect(started.status).toBe(200);
  });

  test('削除したスプリントと無い ID は 404、メンバーは 403、閉じたワークスペースは 409', async () => {
    const { target } = await setup();
    const deleted = await createSprint(target.organization, target.workspace.id, {
      deleted_at: '2026-10-21T00:00:00.000Z',
    });
    expect((await call(target, sprintStart, { sprint_id: deleted.id }, target.leader)).status).toBe(404);
    expect(
      (await call(target, sprintStart, { sprint_id: '019a0000-0000-7000-8000-00000000ffff' }, target.leader)).status,
    ).toBe(404);

    const planned = await createSprint(target.organization, target.workspace.id, {
      start_on: '2026-12-01',
      end_on: '2026-12-14',
    });
    expect((await call(target, sprintStart, { sprint_id: planned.id }, target.member)).status).toBe(403);
    expect((await sprintRow(target, planned.id))?.status).toBe('planned');

    const closedTarget = await createTarget({ closed: true });
    const closedSprint = await createSprint(closedTarget.organization, closedTarget.workspace.id);
    const closedRes = await call(closedTarget, sprintStart, { sprint_id: closedSprint.id }, closedTarget.leader);
    expect(closedRes.status).toBe(409);
    expect(await errorCodeOf(closedRes)).toBe('workspace_closed');
  });
});

describe('sprint-board', () => {
  test('進行中のスプリントが無ければ sprint は null で列は空', async () => {
    const { target } = await setup();
    await createSprint(target.organization, target.workspace.id);
    const res = await call(target, sprintBoard, {});
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ sprint: null, columns: [] });
  });

  test('列を完了の列が最後になる順に並べ、カードを列の中の並びで返し、完了したカードは完了の列に置く', async () => {
    const { target, board } = await setup();
    const sprint = await activeSprintWith(target, { goal: '依頼を3件受ける' });
    const story = await createStory(target.organization, target.workspace.id, target.member.userId!, {
      title: '見積もりの整理',
    });
    await card(target, sprint.id, board.first.id, 'a1', { title: '二番目', story_id: story.id, points: 3 });
    await card(target, sprint.id, board.first.id, 'a0', { title: '先頭' });
    await card(target, sprint.id, board.second.id, 'a0', {
      title: '遂行中の札',
      assignee_user_id: target.member.userId,
    });
    await card(target, sprint.id, board.done.id, 'a0', {
      title: '終えた札',
      completed_at: '2026-10-21T00:00:00.000Z',
    });
    // 別のスプリントと削除したタスクは出ない
    const other = await createSprint(target.organization, target.workspace.id, {
      start_on: '2026-12-01',
      end_on: '2026-12-14',
    });
    await card(target, other.id, board.first.id, 'a0', { title: '先のスプリントの札' });
    await card(target, sprint.id, board.first.id, 'a2', { title: '消した札', deleted_at: '2026-10-21T00:00:00.000Z' });

    const res = await call(target, sprintBoard, {});
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      sprint: { id: string; goal: string };
      columns: {
        name: string | null;
        is_done: boolean;
        tasks: { title: string; story: unknown; assignee: unknown }[];
      }[];
    };
    expect(body.sprint).toMatchObject({ id: sprint.id, goal: '依頼を3件受ける', status: 'active' });
    expect(body.columns.map((column) => [column.name, column.is_done])).toEqual([
      ['出発前', false],
      ['遂行中', false],
      [null, true],
    ]);
    expect(body.columns.map((column) => column.tasks.map((task) => task.title))).toEqual([
      ['先頭', '二番目'],
      ['遂行中の札'],
      ['終えた札'],
    ]);
    expect(body.columns[0]!.tasks[1]!.story).toEqual({ id: story.id, title: '見積もりの整理' });
    expect(body.columns[1]!.tasks[0]!.assignee).toMatchObject({ id: target.member.userId });
  });

  test('task-complete で完了にしたカードは完了の列に出る', async () => {
    const { target, board } = await setup();
    const sprint = await activeSprintWith(target);
    const task = await card(target, sprint.id, board.first.id, 'a0', { title: '終わらせる札', points: 2 });

    expect((await call(target, taskComplete, { task_id: task.id })).status).toBe(200);
    const body = (await (await call(target, sprintBoard, {})).json()) as {
      columns: { is_done: boolean; tasks: { title: string; completed_at: string | null }[] }[];
    };
    expect(body.columns[0]!.tasks).toEqual([]);
    expect(body.columns[2]!.tasks[0]).toMatchObject({ title: '終わらせる札' });
    expect(body.columns[2]!.tasks[0]!.completed_at).not.toBeNull();
  });
});

describe('task-column-move', () => {
  test('隣の列の末尾へ移し、列の移動を {"column": [前, 後]} で履歴に残す', async () => {
    const { target, board } = await setup();
    const sprint = await activeSprintWith(target);
    const moving = await card(target, sprint.id, board.first.id, 'a0', { title: '動かす' });
    await card(target, sprint.id, board.second.id, 'a0', { title: '先にいる' });

    const res = await call(target, taskColumnMove, { task_id: moving.id, column_id: board.second.id });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ task_id: moving.id, column_id: board.second.id });
    expect(await positionsIn(target, sprint.id, board.second.id)).toEqual(['先にいる', '動かす']);
    expect(await positionsIn(target, sprint.id, board.first.id)).toEqual([]);

    const logs = await logsOf(target, moving.id);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ entity_type: 'task', action: 'update', actor_user_id: target.member.userId });
    expect(JSON.parse(logs[0]!.changes_json)).toEqual({
      column: [
        { id: board.first.id, name: '出発前' },
        { id: board.second.id, name: '遂行中' },
      ],
    });
  });

  test('移す先の列の先頭と、指したカードの直後に置ける', async () => {
    const { target, board } = await setup();
    const sprint = await activeSprintWith(target);
    const moving = await card(target, sprint.id, board.first.id, 'a0', { title: '動かす' });
    const one = await card(target, sprint.id, board.second.id, 'a0', { title: '一' });
    await card(target, sprint.id, board.second.id, 'a1', { title: '二' });

    expect(
      (await call(target, taskColumnMove, { task_id: moving.id, column_id: board.second.id, after_task_id: null }))
        .status,
    ).toBe(200);
    expect(await positionsIn(target, sprint.id, board.second.id)).toEqual(['動かす', '一', '二']);

    expect(
      (await call(target, taskColumnMove, { task_id: moving.id, column_id: board.second.id, after_task_id: one.id }))
        .status,
    ).toBe(200);
    expect(await positionsIn(target, sprint.id, board.second.id)).toEqual(['一', '動かす', '二']);
  });

  test('列の中の並べ替えは位置だけを変え、履歴を残さない', async () => {
    const { target, board } = await setup();
    const sprint = await activeSprintWith(target);
    const a = await card(target, sprint.id, board.first.id, 'a0', { title: 'A' });
    const b = await card(target, sprint.id, board.first.id, 'a1', { title: 'B' });
    await card(target, sprint.id, board.first.id, 'a2', { title: 'C' });

    expect(
      (await call(target, taskColumnMove, { task_id: a.id, column_id: board.first.id, after_task_id: b.id })).status,
    ).toBe(200);
    expect(await positionsIn(target, sprint.id, board.first.id)).toEqual(['B', 'A', 'C']);
    expect(await logsOf(target, a.id)).toHaveLength(0);

    expect((await call(target, taskColumnMove, { task_id: a.id, column_id: board.first.id })).status).toBe(200);
    expect(await positionsIn(target, sprint.id, board.first.id)).toEqual(['B', 'C', 'A']);
    expect(
      (await call(target, taskColumnMove, { task_id: a.id, column_id: board.first.id, after_task_id: null })).status,
    ).toBe(200);
    expect(await positionsIn(target, sprint.id, board.first.id)).toEqual(['A', 'B', 'C']);
  });

  test('直前のカードと同じ位置のカードがいても、移すカードの直後に並ぶ', async () => {
    const { target, board } = await setup();
    const sprint = await activeSprintWith(target);
    const moving = await card(target, sprint.id, board.first.id, 'a0', { title: '動かす' });
    const tieA = await card(target, sprint.id, board.second.id, 'a0', { title: '同時A' });
    const tieB = await card(target, sprint.id, board.second.id, 'a0', { title: '同時B' });
    await card(target, sprint.id, board.second.id, 'a1', { title: '次' });
    // 同じ位置のカードは id の順に並ぶ。id が小さい方を直前に指す
    const [earlier, later] = tieA.id < tieB.id ? [tieA, tieB] : [tieB, tieA];

    const res = await call(target, taskColumnMove, {
      task_id: moving.id,
      column_id: board.second.id,
      after_task_id: earlier.id,
    });
    expect(res.status).toBe(200);
    expect(await positionsIn(target, sprint.id, board.second.id)).toEqual([earlier.title, '動かす', later.title, '次']);
  });

  test('完了の列へは移せず、409 の done_column で何も変わらない', async () => {
    const { target, board } = await setup();
    const sprint = await activeSprintWith(target);
    const task = await card(target, sprint.id, board.first.id, 'a0');

    const res = await call(target, taskColumnMove, { task_id: task.id, column_id: board.done.id });
    expect(res.status).toBe(409);
    expect(await errorCodeOf(res.clone())).toBe('conflict');
    expect(await reasonOf(res)).toBe('done_column');
    const db = orgDb(env, target.organization.verified);
    const row = await db.first(db.statement((q) => q.selectFrom('tasks').selectAll().where('id', '=', task.id)));
    expect(row).toMatchObject({ column_id: board.first.id, column_position: 'a0', completed_at: null });
    expect(await logsOf(target, task.id)).toHaveLength(0);
  });

  test('完了したカードは動かせない（409 の task_completed）', async () => {
    const { target, board } = await setup();
    const sprint = await activeSprintWith(target);
    const task = await card(target, sprint.id, board.done.id, 'a0', { completed_at: '2026-10-21T00:00:00.000Z' });
    const res = await call(target, taskColumnMove, { task_id: task.id, column_id: board.first.id });
    expect(res.status).toBe(409);
    expect(await reasonOf(res)).toBe('task_completed');
  });

  test('進行中でないスプリントのカードは 409 の not_active、スプリントに入っていないタスクは 404', async () => {
    const { target, board } = await setup();
    const planned = await createSprint(target.organization, target.workspace.id);
    const inPlanned = await card(target, planned.id, board.first.id, 'a0');
    const res = await call(target, taskColumnMove, { task_id: inPlanned.id, column_id: board.second.id });
    expect(res.status).toBe(409);
    expect(await reasonOf(res)).toBe('not_active');

    const loose = await createTask(target.organization, target.workspace.id, target.member.userId!);
    expect((await call(target, taskColumnMove, { task_id: loose.id, column_id: board.second.id })).status).toBe(404);
  });

  test('無い列と削除した列は 404、直前のカードが移す先の列に無いか自分自身なら 404 と 400', async () => {
    const { target, board } = await setup();
    const sprint = await activeSprintWith(target);
    const task = await card(target, sprint.id, board.first.id, 'a0');
    const elsewhere = await card(target, sprint.id, board.first.id, 'a1');
    const gone = await createBoardColumn(target.organization, target.workspace.id, {
      name: '消えた列',
      deleted_at: '2026-10-21T00:00:00.000Z',
    });

    expect((await call(target, taskColumnMove, { task_id: task.id, column_id: gone.id })).status).toBe(404);
    expect(
      (await call(target, taskColumnMove, { task_id: task.id, column_id: '019a0000-0000-7000-8000-00000000ffff' }))
        .status,
    ).toBe(404);
    expect(
      (
        await call(target, taskColumnMove, {
          task_id: task.id,
          column_id: board.second.id,
          after_task_id: elsewhere.id,
        })
      ).status,
    ).toBe(404);
    expect(
      (await call(target, taskColumnMove, { task_id: task.id, column_id: board.second.id, after_task_id: task.id }))
        .status,
    ).toBe(400);
    expect(await positionsIn(target, sprint.id, board.first.id)).toHaveLength(2);
  });

  test('別のワークスペースの列とタスクは動かせない（404）', async () => {
    const { target, board } = await setup();
    const sprint = await activeSprintWith(target);
    const task = await card(target, sprint.id, board.first.id, 'a0');
    const foreignColumn = await createBoardColumn(target.organization, target.otherWorkspace.id, { name: '別の列' });
    expect((await call(target, taskColumnMove, { task_id: task.id, column_id: foreignColumn.id })).status).toBe(404);
  });

  test('閉じたワークスペースは 409 の workspace_closed', async () => {
    const target = await createTarget({ closed: true });
    const board = await createBoard(target);
    const sprint = await activeSprintWith(target);
    const task = await card(target, sprint.id, board.first.id, 'a0');
    const res = await call(target, taskColumnMove, { task_id: task.id, column_id: board.second.id });
    expect(res.status).toBe(409);
    expect(await errorCodeOf(res)).toBe('workspace_closed');
  });
});
