// タスクのスプリントへの出し入れ（sprint-task-add、sprint-task-remove）と、スプリントに入ったタスクで動きが変わる操作
// （task-complete、sprint-delete、task-delete、story-delete、backlog-tree、task-detail、sprint-list、task-history）の振る舞い。
// 組織の分離と権限の種類ごとの許可と拒否は、一覧を回す test/operation-registry.test.ts が確かめる。ここでは要の場面だけを重ねて見る
import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import { sprintDelete, sprintList, sprintTaskAdd, sprintTaskRemove } from '../src/shared/operations/sprint/index.ts';
import { storyDelete } from '../src/shared/operations/story/index.ts';
import { backlogTree, taskComplete, taskDelete, taskDetail, taskHistory } from '../src/shared/operations/task/index.ts';
import { createApp } from '../src/server/app.ts';
import { orgDb } from '../src/server/db/index.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import {
  createBoardColumn,
  createOrganization,
  createSprint,
  createSprintEntry,
  createStory,
  createTask,
  createUser,
  createWorkspace,
} from './factories.ts';
import { errorCodeOf, post } from './operations/harness.ts';
import { createTarget, type Person, type Target } from './operations/world.ts';

const app = createApp(implementedOperations);

type Board = { first: string; second: string; done: string };

// ワークスペースの作成と同じ形の列（完了でない列を2つと完了の列）。完了の列は position を使わないので、先頭に来ないことも確かめる
async function createBoard(target: Target): Promise<Board> {
  const done = await createBoardColumn(target.organization, target.workspace.id, {
    name: null,
    is_done: 1,
    position: 'Zz',
  });
  const second = await createBoardColumn(target.organization, target.workspace.id, { name: '遂行中', position: 'a1' });
  const first = await createBoardColumn(target.organization, target.workspace.id, { name: '出発前', position: 'a0' });
  return { first: first.id, second: second.id, done: done.id };
}

async function setup() {
  const target = await createTarget();
  const board = await createBoard(target);
  const sprint = await createSprint(target.organization, target.workspace.id, { name: '第15回' });
  return { target, board, sprint };
}

function add(target: Target, sprintId: string, taskIds: string[], person: Person = target.member) {
  return post(app, sprintTaskAdd, {
    slug: target.slug,
    token: person.token,
    body: { workspace_id: target.workspace.id, sprint_id: sprintId, task_ids: taskIds },
  });
}

function remove(target: Target, sprintId: string, taskId: string, person: Person = target.member) {
  return post(app, sprintTaskRemove, {
    slug: target.slug,
    token: person.token,
    body: { workspace_id: target.workspace.id, sprint_id: sprintId, task_id: taskId },
  });
}

function call(
  target: Target,
  definition: Parameters<typeof post>[1],
  body: Record<string, unknown>,
  person: Person = target.member,
) {
  return post(app, definition, {
    slug: target.slug,
    token: person.token,
    body: { workspace_id: target.workspace.id, ...body },
  });
}

// このタスクの行と、入った行（古い順）、変更の履歴（古い順）、完了の記録
async function stateOf(target: Target, taskId: string) {
  const db = orgDb(env, target.organization.verified);
  const [tasks, entries, logs, completions] = await db.batch([
    db.statement((q) =>
      q.selectFrom('tasks').selectAll().where('id', '=', taskId).where('workspace_id', '=', target.workspace.id),
    ),
    db.statement((q) =>
      q.selectFrom('sprint_entries').selectAll().where('task_id', '=', taskId).orderBy('added_at').orderBy('id'),
    ),
    db.statement((q) =>
      q
        .selectFrom('change_logs')
        .selectAll()
        .where('entity_id', '=', taskId)
        .where('organization_id', '=', target.organization.id)
        .orderBy('created_at')
        .orderBy('id'),
    ),
    db.statement((q) =>
      q
        .selectFrom('completions')
        .selectAll()
        .where('task_id', '=', taskId)
        .where('workspace_id', '=', target.workspace.id),
    ),
  ] as const);
  return { task: tasks.rows[0]!, entries: entries.rows, logs: logs.rows, completions: completions.rows };
}

function sprintChanges(log: { changes_json: string } | undefined) {
  return (JSON.parse(log?.changes_json ?? '{}') as { sprint?: unknown }).sprint;
}

// スプリントに入ったタスク（入った行も作る）
async function taskInSprint(target: Target, sprintId: string, columnId: string, overrides = {}) {
  const task = await createTask(target.organization, target.workspace.id, target.member.userId!, {
    sprint_id: sprintId,
    column_id: columnId,
    column_position: 'a0',
    ...overrides,
  });
  await createSprintEntry(target.organization, sprintId, task.id, target.member.userId!);
  return task;
}

describe('sprint-task-add', () => {
  test('先頭の列の末尾に置き、入った行と変更の履歴を残す。名前の無いスプリントは期間を名前にする', async () => {
    const { target, board } = await setup();
    const sprint = await createSprint(target.organization, target.workspace.id, {
      start_on: '2026-11-16',
      end_on: '2026-11-29',
    });
    const task = await createTask(target.organization, target.workspace.id, target.member.userId!);

    const res = await add(target, sprint.id, [task.id]);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ added: 1, skipped: { completed: 0, unavailable: 0, already: 0 } });

    const state = await stateOf(target, task.id);
    expect(state.task).toMatchObject({ sprint_id: sprint.id, column_id: board.first });
    expect(state.task.column_position).not.toBeNull();
    expect(state.entries).toHaveLength(1);
    expect(state.entries[0]).toMatchObject({
      sprint_id: sprint.id,
      added_by: target.member.userId,
      ended_at: null,
      outcome: null,
    });
    expect(state.logs).toHaveLength(1);
    expect(state.logs[0]).toMatchObject({ entity_type: 'task', action: 'update', actor_user_id: target.member.userId });
    expect(sprintChanges(state.logs[0])).toEqual([null, { id: sprint.id, name: '2026-11-16〜2026-11-29' }]);
  });

  test('まとめて入れると送った順に並び、先に入っていたタスクの後ろに置く', async () => {
    const { target, board, sprint } = await setup();
    const existing = await taskInSprint(target, sprint.id, board.first, { column_position: 'a5' });
    const tasks = [];
    for (let i = 0; i < 3; i++) {
      tasks.push(await createTask(target.organization, target.workspace.id, target.member.userId!));
    }
    const ids = [tasks[2]!.id, tasks[0]!.id, tasks[1]!.id];
    const res = await add(target, sprint.id, ids);
    expect(((await res.json()) as { added: number }).added).toBe(3);

    const listed = await call(target, sprintList, {});
    const body = (await listed.json()) as { sprints: { id: string; tasks: { id: string }[] }[] };
    expect(body.sprints.find((row) => row.id === sprint.id)!.tasks.map((row) => row.id)).toEqual([existing.id, ...ids]);
  });

  test('別のスプリントに入っているタスクは、前の行を removed で閉じて移し、履歴に前後を残す', async () => {
    const { target, board, sprint } = await setup();
    const later = await createSprint(target.organization, target.workspace.id, {
      start_on: '2026-11-16',
      end_on: '2026-11-29',
      name: '第16回',
    });
    const task = await taskInSprint(target, sprint.id, board.second);

    const res = await add(target, later.id, [task.id]);
    expect(res.status).toBe(200);
    const state = await stateOf(target, task.id);
    expect(state.task).toMatchObject({ sprint_id: later.id, column_id: board.first });
    expect(state.entries).toHaveLength(2);
    expect(state.entries[0]).toMatchObject({ sprint_id: sprint.id, outcome: 'removed' });
    expect(state.entries[0]!.ended_at).not.toBeNull();
    expect(state.entries[1]).toMatchObject({ sprint_id: later.id, ended_at: null, outcome: null });
    expect(sprintChanges(state.logs.at(-1))).toEqual([
      { id: sprint.id, name: '第15回' },
      { id: later.id, name: '第16回' },
    ]);
  });

  test('同じスプリントに既に入っているタスクは何も書かずに飛ばす', async () => {
    const { target, board, sprint } = await setup();
    const task = await taskInSprint(target, sprint.id, board.second);
    const res = await add(target, sprint.id, [task.id]);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ added: 0, skipped: { completed: 0, unavailable: 0, already: 1 } });
    const state = await stateOf(target, task.id);
    expect(state.task.column_id).toBe(board.second);
    expect(state.entries).toHaveLength(1);
    expect(state.logs).toEqual([]);
  });

  test('まとめて入れるときは入れられるものだけを入れ、飛ばした件数を理由ごとに返す', async () => {
    const { target, board, sprint } = await setup();
    const open = await createTask(target.organization, target.workspace.id, target.member.userId!);
    const done = await createTask(target.organization, target.workspace.id, target.member.userId!, {
      completed_at: '2026-10-21T00:00:00.000Z',
      completed_by: target.member.userId,
    });
    const deleted = await createTask(target.organization, target.workspace.id, target.member.userId!, {
      deleted_at: '2026-10-21T00:00:00.000Z',
    });
    const inbox = await createTask(target.organization, target.workspace.id, target.member.userId!, {
      is_imported: 1,
      tray: 'inbox',
      created_by: null,
    });
    const elsewhere = await createTask(target.organization, target.otherWorkspace.id, target.admin.userId!);
    const already = await taskInSprint(target, sprint.id, board.first);
    const otherOrganization = await createOrganization();
    const stranger = await createUser(otherOrganization);
    const foreignWorkspace = await createWorkspace(otherOrganization, stranger.id);
    const foreign = await createTask(otherOrganization, foreignWorkspace.id, stranger.id);

    const res = await add(target, sprint.id, [
      open.id,
      done.id,
      deleted.id,
      inbox.id,
      elsewhere.id,
      already.id,
      foreign.id,
      '01a00000-0000-7000-8000-000000000000',
    ]);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ added: 1, skipped: { completed: 1, unavailable: 5, already: 1 } });
    expect((await stateOf(target, open.id)).task.sprint_id).toBe(sprint.id);
    for (const skipped of [done, deleted, inbox]) {
      const state = await stateOf(target, skipped.id);
      expect(state.task.sprint_id).toBeNull();
      expect(state.entries).toEqual([]);
      expect(state.logs).toEqual([]);
    }
  });

  test('1件も入らなければ1件のときと同じエラーで、何も書かない', async () => {
    const { target, sprint } = await setup();
    const done = await createTask(target.organization, target.workspace.id, target.member.userId!, {
      completed_at: '2026-10-21T00:00:00.000Z',
      completed_by: target.member.userId,
    });
    const deleted = await createTask(target.organization, target.workspace.id, target.member.userId!, {
      deleted_at: '2026-10-21T00:00:00.000Z',
    });

    const completedRes = await add(target, sprint.id, [done.id]);
    expect(completedRes.status).toBe(409);
    expect(await completedRes.json()).toMatchObject({ error: { code: 'conflict', details: { reason: 'completed' } } });

    const goneRes = await add(target, sprint.id, [deleted.id, done.id]);
    expect(goneRes.status).toBe(404);

    expect((await stateOf(target, done.id)).entries).toEqual([]);
  });

  test('終了したスプリントへは 409 の closed、削除したスプリントと別の組織のスプリントは 404', async () => {
    const { target } = await setup();
    const task = await createTask(target.organization, target.workspace.id, target.member.userId!);
    const closed = await createSprint(target.organization, target.workspace.id, {
      start_on: '2026-10-05',
      end_on: '2026-10-18',
      status: 'closed',
    });
    const deleted = await createSprint(target.organization, target.workspace.id, {
      deleted_at: '2026-10-21T00:00:00.000Z',
    });
    const other = await createTarget();
    const foreign = await createSprint(other.organization, other.workspace.id);

    const closedRes = await add(target, closed.id, [task.id]);
    expect(closedRes.status).toBe(409);
    expect(await closedRes.json()).toMatchObject({ error: { code: 'conflict', details: { reason: 'closed' } } });
    expect((await add(target, deleted.id, [task.id])).status).toBe(404);
    expect((await add(target, foreign.id, [task.id])).status).toBe(404);
    const state = await stateOf(target, task.id);
    expect(state.task.sprint_id).toBeNull();
    expect(state.entries).toEqual([]);
    expect(state.logs).toEqual([]);
  });

  test('進行中のスプリントにも入れられる', async () => {
    const { target, board } = await setup();
    const active = await createSprint(target.organization, target.workspace.id, {
      start_on: '2026-10-19',
      end_on: '2026-11-01',
      status: 'active',
    });
    const task = await createTask(target.organization, target.workspace.id, target.member.userId!);
    expect((await add(target, active.id, [task.id])).status).toBe(200);
    expect((await stateOf(target, task.id)).task).toMatchObject({ sprint_id: active.id, column_id: board.first });
  });

  test('所属していない一般の人は 403、閉じたワークスペースは 409 の workspace_closed', async () => {
    const { target, sprint } = await setup();
    const task = await createTask(target.organization, target.workspace.id, target.member.userId!);
    expect((await add(target, sprint.id, [task.id], target.bystander)).status).toBe(403);

    const closedTarget = await createTarget({ closed: true });
    await createBoard(closedTarget);
    const closedSprint = await createSprint(closedTarget.organization, closedTarget.workspace.id);
    const closedTask = await createTask(
      closedTarget.organization,
      closedTarget.workspace.id,
      closedTarget.admin.userId!,
    );
    const res = await add(closedTarget, closedSprint.id, [closedTask.id]);
    expect(res.status).toBe(409);
    expect(await errorCodeOf(res)).toBe('workspace_closed');
  });
});

describe('sprint-task-remove', () => {
  test('行を removed で閉じ、スプリント、列、列の中の位置を空にして、履歴に [前, null] を残す', async () => {
    const { target, board, sprint } = await setup();
    const task = await taskInSprint(target, sprint.id, board.second);

    const res = await remove(target, sprint.id, task.id);
    expect(res.status).toBe(200);
    const state = await stateOf(target, task.id);
    expect(state.task).toMatchObject({ sprint_id: null, column_id: null, column_position: null });
    expect(state.entries[0]).toMatchObject({ outcome: 'removed' });
    expect(state.entries[0]!.ended_at).not.toBeNull();
    expect(sprintChanges(state.logs[0])).toEqual([{ id: sprint.id, name: '第15回' }, null]);

    // 続けて外すと、もうそのスプリントに入っていないので 404
    expect((await remove(target, sprint.id, task.id)).status).toBe(404);
  });

  test('完了したタスクは 409 の completed、終了したスプリントからは 409 の closed で、何も書かない', async () => {
    const { target, board } = await setup();
    const active = await createSprint(target.organization, target.workspace.id, {
      start_on: '2026-10-19',
      end_on: '2026-11-01',
      status: 'active',
    });
    const done = await taskInSprint(target, active.id, board.done, {
      completed_at: '2026-10-21T00:00:00.000Z',
      completed_by: target.member.userId,
    });
    const completedRes = await remove(target, active.id, done.id);
    expect(completedRes.status).toBe(409);
    expect(await completedRes.json()).toMatchObject({ error: { code: 'conflict', details: { reason: 'completed' } } });

    const closed = await createSprint(target.organization, target.workspace.id, {
      start_on: '2026-10-05',
      end_on: '2026-10-18',
      status: 'closed',
    });
    const left = await taskInSprint(target, closed.id, board.first);
    const closedRes = await remove(target, closed.id, left.id);
    expect(closedRes.status).toBe(409);
    expect(await closedRes.json()).toMatchObject({ error: { code: 'conflict', details: { reason: 'closed' } } });

    for (const task of [done, left]) {
      const state = await stateOf(target, task.id);
      expect(state.task.sprint_id).not.toBeNull();
      expect(state.entries[0]!.ended_at).toBeNull();
      expect(state.logs).toEqual([]);
    }
  });

  test('別の組織のスプリントとタスクは 404', async () => {
    const { target } = await setup();
    const other = await createTarget();
    const otherBoard = await createBoard(other);
    const otherSprint = await createSprint(other.organization, other.workspace.id);
    const otherTask = await taskInSprint(other, otherSprint.id, otherBoard.first);
    expect((await remove(target, otherSprint.id, otherTask.id)).status).toBe(404);
    expect((await stateOf(other, otherTask.id)).task.sprint_id).toBe(otherSprint.id);
  });
});

describe('スプリントの中の完了（task-complete）', () => {
  test('進行中のスプリントの中で完了すると、完了の列の末尾へ移り、完了の記録にスプリントと前の列が残る。行は開いたまま', async () => {
    const { target, board } = await setup();
    const active = await createSprint(target.organization, target.workspace.id, {
      start_on: '2026-10-19',
      end_on: '2026-11-01',
      status: 'active',
    });
    await taskInSprint(target, active.id, board.done, {
      completed_at: '2026-10-21T00:00:00.000Z',
      completed_by: target.member.userId,
      column_position: 'a3',
    });
    const task = await taskInSprint(target, active.id, board.second, { points: 3 });

    const res = await call(target, taskComplete, { task_id: task.id });
    expect(res.status).toBe(200);
    const state = await stateOf(target, task.id);
    expect(state.task).toMatchObject({ sprint_id: active.id, column_id: board.done });
    expect(state.task.completed_at).not.toBeNull();
    expect(state.task.column_position! > 'a3').toBe(true);
    expect(state.completions).toHaveLength(1);
    expect(state.completions[0]).toMatchObject({ sprint_id: active.id, previous_column_id: board.second });
    expect(state.entries).toHaveLength(1);
    expect(state.entries[0]).toMatchObject({ ended_at: null, outcome: null });
    expect(state.logs.map((log) => log.action)).toEqual(['complete']);
  });

  test('始まっていないスプリントの中で完了すると、スプリントから外れ、スプリントの外の完了になる', async () => {
    const { target, board, sprint } = await setup();
    const task = await taskInSprint(target, sprint.id, board.first, { points: 2 });

    const res = await call(target, taskComplete, { task_id: task.id });
    expect(res.status).toBe(200);
    const { completed_at: completedAt } = (await res.json()) as { completed_at: string };
    const state = await stateOf(target, task.id);
    expect(state.task).toMatchObject({ sprint_id: null, column_id: null, column_position: null });
    expect(state.completions[0]).toMatchObject({ sprint_id: null, previous_column_id: null });
    expect(state.entries[0]).toMatchObject({ ended_at: completedAt, outcome: 'removed' });
    expect(state.logs.map((log) => log.action).sort()).toEqual(['complete', 'update']);
    expect(sprintChanges(state.logs.find((log) => log.action === 'update'))).toEqual([
      { id: sprint.id, name: '第15回' },
      null,
    ]);
  });

  test('スプリントの外の完了は、完了の記録のスプリントと前の列が空', async () => {
    const { target } = await setup();
    const task = await createTask(target.organization, target.workspace.id, target.member.userId!);
    expect((await call(target, taskComplete, { task_id: task.id })).status).toBe(200);
    const state = await stateOf(target, task.id);
    expect(state.completions[0]).toMatchObject({ sprint_id: null, previous_column_id: null });
    expect(state.entries).toEqual([]);
  });
});

describe('スプリントとタスクの削除', () => {
  test('始まっていないスプリントを削除すると、入っていたタスクはバックログへ戻り、タスクごとの履歴が残る', async () => {
    const { target, board, sprint } = await setup();
    const first = await taskInSprint(target, sprint.id, board.first);
    const second = await taskInSprint(target, sprint.id, board.second);

    const res = await call(target, sprintDelete, { sprint_id: sprint.id }, target.leader);
    expect(res.status).toBe(200);
    for (const task of [first, second]) {
      const state = await stateOf(target, task.id);
      expect(state.task).toMatchObject({ sprint_id: null, column_id: null, column_position: null });
      expect(state.entries[0]).toMatchObject({ outcome: 'removed' });
      expect(state.entries[0]!.ended_at).not.toBeNull();
      expect(state.logs).toHaveLength(1);
      expect(sprintChanges(state.logs[0])).toEqual([{ id: sprint.id, name: '第15回' }, null]);
    }
  });

  test('始まったスプリントは削除できず、入っていたタスクもそのまま', async () => {
    const { target, board } = await setup();
    const active = await createSprint(target.organization, target.workspace.id, {
      start_on: '2026-10-19',
      end_on: '2026-11-01',
      status: 'active',
    });
    const task = await taskInSprint(target, active.id, board.first);
    expect((await call(target, sprintDelete, { sprint_id: active.id }, target.leader)).status).toBe(409);
    const state = await stateOf(target, task.id);
    expect(state.task.sprint_id).toBe(active.id);
    expect(state.entries[0]!.ended_at).toBeNull();
  });

  test('タスクを削除すると、入っていた行を removed で閉じ、スプリントを空にする', async () => {
    const { target, board, sprint } = await setup();
    const task = await taskInSprint(target, sprint.id, board.first);
    expect((await call(target, taskDelete, { task_id: task.id })).status).toBe(200);
    const state = await stateOf(target, task.id);
    expect(state.task.deleted_at).not.toBeNull();
    expect(state.task.sprint_id).toBeNull();
    expect(state.entries[0]).toMatchObject({ outcome: 'removed' });
  });

  test('ストーリーを配下ごと削除すると、配下のタスクの入っていた行を閉じる', async () => {
    const { target, board, sprint } = await setup();
    const story = await createStory(target.organization, target.workspace.id, target.member.userId!);
    const task = await taskInSprint(target, sprint.id, board.first, { story_id: story.id });
    const res = await call(target, storyDelete, { story_id: story.id, children: 'delete' });
    expect(res.status).toBe(200);
    const state = await stateOf(target, task.id);
    expect(state.task).toMatchObject({ sprint_id: null, column_id: null });
    expect(state.entries[0]).toMatchObject({ outcome: 'removed' });
  });
});

describe('入っているスプリントを読む', () => {
  test('バックログの木の行とタスクの詳細にスプリントが出て、木からも外れない', async () => {
    const { target, board, sprint } = await setup();
    const story = await createStory(target.organization, target.workspace.id, target.member.userId!);
    const under = await taskInSprint(target, sprint.id, board.first, { story_id: story.id });
    const root = await taskInSprint(target, sprint.id, board.first);
    const ref = { id: sprint.id, name: '第15回', start_on: sprint.start_on, end_on: sprint.end_on };

    const tree = (await (await call(target, backlogTree, {})).json()) as {
      stories: { tasks: { id: string; sprint: unknown }[] }[];
      tasks: { id: string; sprint: unknown }[];
    };
    expect(tree.stories[0]!.tasks.find((task) => task.id === under.id)!.sprint).toEqual(ref);
    expect(tree.tasks.find((task) => task.id === root.id)!.sprint).toEqual(ref);

    const detail = (await (await call(target, taskDetail, { task_id: root.id })).json()) as {
      task: { sprint: unknown };
    };
    expect(detail.task.sprint).toEqual(ref);
  });

  test('変更の履歴（task-history）は、入れたと外したをスプリントの欄で返す', async () => {
    const { target, sprint } = await setup();
    const task = await createTask(target.organization, target.workspace.id, target.member.userId!);
    await add(target, sprint.id, [task.id]);
    await remove(target, sprint.id, task.id);
    const res = await call(target, taskHistory, { task_id: task.id });
    const body = (await res.json()) as { entries: { changes: unknown[] }[] };
    const ref = { id: sprint.id, name: '第15回' };
    expect(body.entries.map((entry) => entry.changes)).toEqual(
      expect.arrayContaining([
        [{ field: 'sprint', before: null, after: ref }],
        [{ field: 'sprint', before: ref, after: null }],
      ]),
    );
  });
});
