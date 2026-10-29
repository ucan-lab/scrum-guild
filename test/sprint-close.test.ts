// スプリントの終了（sprint-close）の振る舞いと、終えた後に中身を変える操作の断り。
// 組織の分離と権限の種類ごとの許可と拒否は、一覧を回す test/operation-registry.test.ts が確かめる。ここでは要の場面だけを重ねて見る
import { env } from 'cloudflare:workers';
import { generateNKeysBetween } from 'fractional-indexing';
import { afterEach, describe, expect, test } from 'vitest';
import { parseDevNow, setFixedNow } from '../src/shared/clock.ts';
import {
  sprintClose,
  sprintList,
  sprintTaskAdd,
  sprintTaskRemove,
  taskColumnMove,
} from '../src/shared/operations/sprint/index.ts';
import { taskComplete, taskReopen } from '../src/shared/operations/task/index.ts';
import { createApp } from '../src/server/app.ts';
import { orgDb, verifyWorkspace } from '../src/server/db/index.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import { sprintCloseOperation } from '../src/server/operations/sprint-close.ts';
import { createBoardColumn, createSprint, createSprintEntry, createTask } from './factories.ts';
import { errorCodeOf, post } from './operations/harness.ts';
import { createTarget, testEnv, type Person, type Target } from './operations/world.ts';

const app = createApp(implementedOperations);

afterEach(() => setFixedNow(undefined));

const DEV_NOW = '2026-10-26T10:00:00+09:00';
const frozenEnv: Env = Object.assign({}, testEnv, { PUBLIC_ORIGIN: 'http://localhost:8787', DEV_NOW });
// 日本時間の午前 1 時。UTC ではまだ前の日（UTC で今日を数えると 2026-10-25 になる）
const EARLY_NOW = '2026-10-26T01:00:00+09:00';

const ACTIVE_RANGE = { start_on: '2026-10-19', end_on: '2026-11-01' };
const ACTIVE_LABEL = '2026-10-19〜2026-11-01';
const NEXT_RANGE = { start_on: '2026-11-02', end_on: '2026-11-15' };
const NEXT_LABEL = '2026-11-02〜2026-11-15';
const GOAL = '新しい依頼を3件終える';
const COMPLETED_AT = '2026-10-21T00:00:00.000Z';

type Board = { first: string; second: string; done: string };
type Db = ReturnType<typeof orgDb>;

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

// スプリントに入ったタスク（入った行も作る）
async function taskIn(
  target: Target,
  sprintId: string,
  columnId: string,
  position: string,
  overrides: Parameters<typeof createTask>[3] = {},
) {
  const task = await createTask(target.organization, target.workspace.id, target.member.userId!, {
    sprint_id: sprintId,
    column_id: columnId,
    column_position: position,
    ...overrides,
  });
  await createSprintEntry(target.organization, target.workspace.id, sprintId, task.id, target.member.userId!);
  return task;
}

// 進行中のスプリント（ゴールあり）に、列の順で a、c（出発前）、b（遂行中）の未完了と、完了の列の d。
// 先のスプリントには、出発前の列に a5 の e が既に入っている
async function setup(options: { goal?: string | null } = {}) {
  const target = await createTarget();
  const board = await createBoard(target);
  const active = await createSprint(target.organization, target.workspace.id, {
    ...ACTIVE_RANGE,
    status: 'active',
    goal: options.goal === undefined ? GOAL : options.goal,
    started_at: '2026-10-19T00:00:00.000Z',
    started_by: target.leader.userId,
  });
  const next = await createSprint(target.organization, target.workspace.id, NEXT_RANGE);
  const a = await taskIn(target, active.id, board.first, 'a0', { title: '見積もりを送る' });
  const c = await taskIn(target, active.id, board.first, 'a1', { title: '請求書を直す' });
  const b = await taskIn(target, active.id, board.second, 'a0', { title: '議事録をまとめる' });
  const d = await taskIn(target, active.id, board.done, 'a0', {
    title: '仕様を確かめる',
    completed_at: COMPLETED_AT,
    completed_by: target.member.userId,
  });
  const e = await taskIn(target, next.id, board.first, 'a5', { title: '先の準備をする' });
  return { target, board, active, next, a, b, c, d, e };
}

// 時計を止めた環境で呼ぶ（持ち越し先の最終日は今日と比べるので、実際の日付に依らないようにする）
function close(
  target: Target,
  sprintId: string,
  body: Record<string, unknown> = {},
  person: Person = target.leader,
  callEnv: Env = frozenEnv,
) {
  return post(app, sprintClose, {
    slug: target.slug,
    token: person.token,
    body: { workspace_id: target.workspace.id, sprint_id: sprintId, carry_sprint_id: null, ...body },
    env: callEnv,
  });
}

// 開発用の時計（DEV_NOW）を止めた、ループバックの公開 URL の環境
function envAt(devNow: string): Env {
  return Object.assign({}, testEnv, { PUBLIC_ORIGIN: 'http://localhost:8787', DEV_NOW: devNow });
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

async function reasonOf(res: Response): Promise<unknown> {
  return ((await res.json()) as { error?: { details?: { reason?: unknown } } }).error?.details?.reason;
}

async function sprintRow(target: Target, sprintId: string) {
  const db = orgDb(env, target.organization.verified);
  return db.first(
    db.statement((q) =>
      q.selectFrom('sprints').selectAll().where('id', '=', sprintId).where('workspace_id', '=', target.workspace.id),
    ),
  );
}

async function updateSprint(target: Target, sprintId: string, values: { start_on: string; end_on: string }) {
  const db = orgDb(env, target.organization.verified);
  await db.run(
    db.statement((q) =>
      q.updateTable('sprints').set(values).where('id', '=', sprintId).where('workspace_id', '=', target.workspace.id),
    ),
  );
}

async function taskRow(target: Target, taskId: string) {
  const db = orgDb(env, target.organization.verified);
  return db.first(
    db.statement((q) =>
      q.selectFrom('tasks').selectAll().where('id', '=', taskId).where('workspace_id', '=', target.workspace.id),
    ),
  );
}

// このタスクの入った行（入った順）
async function entriesOf(target: Target, taskId: string) {
  const db = orgDb(env, target.organization.verified);
  return db.rows(
    db.statement((q) =>
      q
        .selectFrom('sprint_entries')
        .selectAll()
        .where('task_id', '=', taskId)
        .where('workspace_id', '=', target.workspace.id)
        .orderBy('added_at')
        .orderBy('id'),
    ),
  );
}

// このスプリントかタスクの変更の履歴（書いた順）
async function logsOf(target: Target, entityId: string) {
  const db = orgDb(env, target.organization.verified);
  const rows = await db.rows(
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
  return rows.map((row) => ({ action: row.action, changes: JSON.parse(row.changes_json) as unknown }));
}

async function countLogs(target: Target): Promise<number> {
  const db = orgDb(env, target.organization.verified);
  const rows = await db.rows(
    db.statement((q) => q.selectFrom('change_logs').select('id').where('organization_id', '=', target.organization.id)),
  );
  return rows.length;
}

describe('sprint-close: 持ち越し先が次のスプリント', () => {
  test('未完了のタスクを列の順のまま先頭の列の末尾へ移し、行、履歴、スプリントを書く', async () => {
    const { target, active, next, a, b, c, d, e } = await setup();

    const res = await close(target, active.id, { carry_sprint_id: next.id, is_goal_achieved: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      sprint_id: active.id,
      carried_count: 3,
      carry_to: { id: next.id, name: null, ...NEXT_RANGE },
    });

    const closed = await sprintRow(target, active.id);
    expect(closed).toMatchObject({ status: 'closed', closed_by: target.leader.userId, is_goal_achieved: 1 });
    const closedAt = closed!.closed_at!;
    expect(closedAt).not.toBeNull();
    expect(await logsOf(target, active.id)).toEqual([
      { action: 'update', changes: { status: ['active', 'closed'], is_goal_achieved: [null, true] } },
    ]);

    // 持ち越したタスクは、元の列の順（出発前の a、c、遂行中の b）で、先のスプリントの先頭の列の末尾（e の後ろ）に並ぶ
    const moved = await Promise.all([a, c, b].map((task) => taskRow(target, task.id)));
    for (const row of moved)
      expect(row).toMatchObject({ sprint_id: next.id, column_id: (await taskRow(target, e.id))!.column_id });
    const positions = moved.map((row) => row!.column_position!);
    expect(positions[0]! > 'a5').toBe(true);
    expect(positions[0]! < positions[1]!).toBe(true);
    expect(positions[1]! < positions[2]!).toBe(true);
    expect(await taskRow(target, e.id)).toMatchObject({ sprint_id: next.id, column_position: 'a5' });

    for (const task of [a, b, c]) {
      const entries = await entriesOf(target, task.id);
      expect(entries).toHaveLength(2);
      expect(entries[0]).toMatchObject({ sprint_id: active.id, ended_at: closedAt, outcome: 'carried_over' });
      expect(entries[1]).toMatchObject({
        sprint_id: next.id,
        added_at: closedAt,
        added_by: target.leader.userId,
        ended_at: null,
        outcome: null,
      });
      expect(await logsOf(target, task.id)).toEqual([
        {
          action: 'update',
          changes: {
            sprint: [
              { id: active.id, name: ACTIVE_LABEL },
              { id: next.id, name: NEXT_LABEL },
            ],
          },
        },
      ]);
    }

    // 完了したタスクは、終えたスプリントの完了の列に残り、行は completed で閉じる。履歴は書かない
    expect(await taskRow(target, d.id)).toMatchObject({ sprint_id: active.id, completed_at: COMPLETED_AT });
    const doneEntries = await entriesOf(target, d.id);
    expect(doneEntries).toHaveLength(1);
    expect(doneEntries[0]).toMatchObject({ sprint_id: active.id, ended_at: closedAt, outcome: 'completed' });
    expect(await logsOf(target, d.id)).toEqual([]);
    // 先のスプリントに元からいたタスクの行は閉じない
    expect(await entriesOf(target, e.id)).toMatchObject([{ sprint_id: next.id, ended_at: null }]);
  });

  test('先のスプリントが空なら、先頭の列の先頭の位置から並べる', async () => {
    const { target, board, active, a, b, c } = await setup();
    const empty = await createSprint(target.organization, target.workspace.id, {
      start_on: '2026-11-16',
      end_on: '2026-11-29',
    });
    expect((await close(target, active.id, { carry_sprint_id: empty.id, is_goal_achieved: false })).status).toBe(200);
    const rows = await Promise.all([a, c, b].map((task) => taskRow(target, task.id)));
    for (const row of rows) expect(row).toMatchObject({ sprint_id: empty.id, column_id: board.first });
    const positions = rows.map((row) => row!.column_position!);
    expect([...positions].sort()).toEqual(positions);
    expect(new Set(positions).size).toBe(3);
    expect(await sprintRow(target, active.id)).toMatchObject({ is_goal_achieved: 0 });
  });
});

describe('sprint-close: 持ち越し先がバックログ', () => {
  test('未完了のタスクのスプリント、列、位置を空にし、行を carried_over で閉じて、新しい行は足さない', async () => {
    const { target, active, a, b, c, d } = await setup();

    const res = await close(target, active.id, { carry_sprint_id: null, is_goal_achieved: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sprint_id: active.id, carried_count: 3, carry_to: null });

    const closedAt = (await sprintRow(target, active.id))!.closed_at!;
    for (const task of [a, b, c]) {
      expect(await taskRow(target, task.id)).toMatchObject({ sprint_id: null, column_id: null, column_position: null });
      const entries = await entriesOf(target, task.id);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ ended_at: closedAt, outcome: 'carried_over' });
      expect(await logsOf(target, task.id)).toEqual([
        { action: 'update', changes: { sprint: [{ id: active.id, name: ACTIVE_LABEL }, null] } },
      ]);
    }
    expect((await entriesOf(target, d.id))[0]).toMatchObject({ outcome: 'completed', ended_at: closedAt });
    expect(await taskRow(target, d.id)).toMatchObject({ sprint_id: active.id });
  });

  test('未完了のタスクが無いスプリントも、持ち越し先を問わず終えられる', async () => {
    const target = await createTarget();
    await createBoard(target);
    const active = await createSprint(target.organization, target.workspace.id, { ...ACTIVE_RANGE, status: 'active' });
    const next = await createSprint(target.organization, target.workspace.id, NEXT_RANGE);
    const res = await close(target, active.id, { carry_sprint_id: next.id });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ carried_count: 0, carry_to: { id: next.id } });
    expect(await sprintRow(target, active.id)).toMatchObject({ status: 'closed', is_goal_achieved: null });
    expect(await logsOf(target, active.id)).toEqual([{ action: 'update', changes: { status: ['active', 'closed'] } }]);
  });
});

describe('sprint-close: ゴールの達成', () => {
  test('ゴールのあるスプリントは達成の真偽が要る。無ければ 400 で、何も書かない', async () => {
    const { target, active, a } = await setup();
    const res = await close(target, active.id, { is_goal_achieved: null });
    expect(res.status).toBe(400);
    expect(await errorCodeOf(res)).toBe('invalid_input');
    expect(await sprintRow(target, active.id)).toMatchObject({ status: 'active', closed_at: null });
    expect(await taskRow(target, a.id)).toMatchObject({ sprint_id: active.id });
    expect(await countLogs(target)).toBe(0);
  });

  test('ゴールのないスプリントに達成を送ると 400。送らなければ終えられ、達成は空のまま', async () => {
    const { target, active } = await setup({ goal: null });
    const res = await close(target, active.id, { is_goal_achieved: true });
    expect(res.status).toBe(400);
    expect(await errorCodeOf(res)).toBe('invalid_input');
    expect(await sprintRow(target, active.id)).toMatchObject({ status: 'active' });

    expect((await close(target, active.id)).status).toBe(200);
    expect(await sprintRow(target, active.id)).toMatchObject({ status: 'closed', is_goal_achieved: null });
  });

  test('達成しなかったことは 0 として残り、履歴は false', async () => {
    const { target, active } = await setup();
    expect((await close(target, active.id, { is_goal_achieved: false })).status).toBe(200);
    expect(await sprintRow(target, active.id)).toMatchObject({ is_goal_achieved: 0 });
    expect(await logsOf(target, active.id)).toEqual([
      { action: 'update', changes: { status: ['active', 'closed'], is_goal_achieved: [null, false] } },
    ]);
  });
});

describe('sprint-close: 断るもの', () => {
  test('2回目の終了と、始まっていないスプリントは 409 の not_active で、何も書かない', async () => {
    const { target, active, next } = await setup();
    expect((await close(target, active.id, { is_goal_achieved: true })).status).toBe(200);
    const before = await countLogs(target);

    const again = await close(target, active.id, { is_goal_achieved: true });
    expect(again.status).toBe(409);
    expect(await errorCodeOf(again.clone())).toBe('conflict');
    expect(await reasonOf(again)).toBe('not_active');

    const planned = await close(target, next.id);
    expect(planned.status).toBe(409);
    expect(await reasonOf(planned)).toBe('not_active');
    expect(await sprintRow(target, next.id)).toMatchObject({ status: 'planned' });
    expect(await countLogs(target)).toBe(before);
  });

  test('持ち越し先が先のスプリントでないか、最終日より前に始まるなら 409 の carry_target で、何も書かない', async () => {
    const { target, active, a } = await setup();
    const earlier = await createSprint(target.organization, target.workspace.id, {
      start_on: '2026-10-05',
      end_on: '2026-10-18',
    });
    const closedOne = await createSprint(target.organization, target.workspace.id, {
      start_on: '2026-11-16',
      end_on: '2026-11-29',
      status: 'closed',
    });
    for (const carry of [earlier.id, closedOne.id, active.id]) {
      const res = await close(target, active.id, { carry_sprint_id: carry, is_goal_achieved: true });
      expect(res.status).toBe(409);
      expect(await errorCodeOf(res.clone())).toBe('conflict');
      expect(await reasonOf(res)).toBe('carry_target');
    }
    expect(await sprintRow(target, active.id)).toMatchObject({ status: 'active' });
    expect(await taskRow(target, a.id)).toMatchObject({ sprint_id: active.id });
    expect(await countLogs(target)).toBe(0);
  });

  test('持ち越し先の最終日がワークスペースの今日より前なら 409 の carry_target。今日以降なら持ち越せる', async () => {
    const { target, active, next, a } = await setup();
    const today = envAt('2026-11-20T10:00:00+09:00');
    // next は 11-02〜11-15 で、今日（11-20）より前に終わっている。始められないスプリントには持ち越せない
    const past = await close(target, active.id, { carry_sprint_id: next.id, is_goal_achieved: true }, undefined, today);
    expect(past.status).toBe(409);
    expect(await errorCodeOf(past.clone())).toBe('conflict');
    expect(await reasonOf(past)).toBe('carry_target');
    expect(await sprintRow(target, active.id)).toMatchObject({ status: 'active' });
    expect(await taskRow(target, a.id)).toMatchObject({ sprint_id: active.id });
    expect(await countLogs(target)).toBe(0);

    // 最終日が今日の日（11-20）までは持ち越せる
    const latest = await createSprint(target.organization, target.workspace.id, {
      start_on: '2026-11-16',
      end_on: '2026-11-20',
    });
    const res = await close(
      target,
      active.id,
      { carry_sprint_id: latest.id, is_goal_achieved: true },
      undefined,
      today,
    );
    expect(res.status).toBe(200);
    expect(await taskRow(target, a.id)).toMatchObject({ sprint_id: latest.id });
  });

  test('別の組織、別のワークスペース、削除したスプリントは 404（終えるものも持ち越し先も）', async () => {
    const { target, active, next } = await setup();
    const other = await createTarget();
    const otherActive = await createSprint(other.organization, other.workspace.id, { status: 'active' });
    const otherNext = await createSprint(other.organization, other.workspace.id, NEXT_RANGE);
    const elsewhereActive = await createSprint(target.organization, target.otherWorkspace.id, { status: 'active' });
    const elsewhereNext = await createSprint(target.organization, target.otherWorkspace.id, NEXT_RANGE);
    const gone = await createSprint(target.organization, target.workspace.id, {
      start_on: '2026-11-16',
      end_on: '2026-11-29',
      deleted_at: '2026-10-22T00:00:00.000Z',
    });

    for (const sprintId of [otherActive.id, elsewhereActive.id, gone.id]) {
      expect((await close(target, sprintId)).status).toBe(404);
    }
    for (const carry of [otherNext.id, elsewhereNext.id, gone.id]) {
      expect((await close(target, active.id, { carry_sprint_id: carry, is_goal_achieved: true })).status).toBe(404);
    }
    expect(await sprintRow(target, active.id)).toMatchObject({ status: 'active' });
    expect(await sprintRow(other, otherActive.id)).toMatchObject({ status: 'active' });
    expect(await sprintRow(target, next.id)).toMatchObject({ status: 'planned' });
    expect(await sprintRow({ ...target, workspace: target.otherWorkspace }, elsewhereActive.id)).toMatchObject({
      status: 'active',
    });
  });

  test('閉じたワークスペースは 409 の workspace_closed', async () => {
    const target = await createTarget({ closed: true });
    await createBoard(target);
    const active = await createSprint(target.organization, target.workspace.id, { ...ACTIVE_RANGE, status: 'active' });
    const res = await close(target, active.id);
    expect(res.status).toBe(409);
    expect(await errorCodeOf(res)).toBe('workspace_closed');
    expect(await sprintRow(target, active.id)).toMatchObject({ status: 'active' });
  });

  test('メンバーは 403、リーダーでない一般の人も終えられない', async () => {
    const { target, active } = await setup();
    const res = await close(target, active.id, { is_goal_achieved: true }, target.member);
    expect(res.status).toBe(403);
    expect(await errorCodeOf(res)).toBe('forbidden');
    expect(await sprintRow(target, active.id)).toMatchObject({ status: 'active' });
    // 管理者は通る
    expect((await close(target, active.id, { is_goal_achieved: true }, target.admin)).status).toBe(200);
  });
});

describe('sprint-close: 終えた後の中身', () => {
  test('入れる、外す、列を移す、完了、戻すは、どれも終えたスプリントを断る', async () => {
    const { target, board, active, d } = await setup();
    expect((await close(target, active.id, { is_goal_achieved: true })).status).toBe(200);
    const before = await countLogs(target);
    const loose = await createTask(target.organization, target.workspace.id, target.member.userId!);

    const add = await call(target, sprintTaskAdd, { sprint_id: active.id, task_ids: [loose.id] });
    expect(add.status).toBe(409);
    expect(await reasonOf(add)).toBe('closed');

    const remove = await call(target, sprintTaskRemove, { sprint_id: active.id, task_id: d.id });
    expect(remove.status).toBe(409);
    expect(await reasonOf(remove)).toBe('closed');

    // 完了したタスクの移動は断る
    const moveDone = await call(target, taskColumnMove, { task_id: d.id, column_id: board.first });
    expect(moveDone.status).toBe(409);

    // 終えたスプリントに未完了のタスクが残っていても（終了は持ち越すので、ふつうは無い。直に作る）、
    // 動かす操作は進行中でないスプリントとして断り（not_active）、完了にする操作は終了したスプリントの分岐で断る
    const left = await taskIn(target, active.id, board.first, 'a9', { title: '終えた後に残ったタスク' });
    const move = await call(target, taskColumnMove, { task_id: left.id, column_id: board.second });
    expect(move.status).toBe(409);
    expect(await errorCodeOf(move.clone())).toBe('conflict');
    expect(await reasonOf(move)).toBe('not_active');
    const complete = await call(target, taskComplete, { task_id: left.id });
    expect(complete.status).toBe(409);
    expect(await errorCodeOf(complete.clone())).toBe('conflict');
    expect(await reasonOf(complete)).toBeUndefined();
    expect(await taskRow(target, left.id)).toMatchObject({
      sprint_id: active.id,
      column_id: board.first,
      completed_at: null,
    });
    const completeDone = await call(target, taskComplete, { task_id: d.id });
    expect(completeDone.status).toBe(409);

    const reopen = await call(target, taskReopen, { task_id: d.id });
    expect(reopen.status).toBe(409);
    expect(await reasonOf(reopen)).toBe('sprint_closed');

    expect(await taskRow(target, d.id)).toMatchObject({
      sprint_id: active.id,
      column_id: board.done,
      completed_at: COMPLETED_AT,
    });
    expect((await entriesOf(target, d.id))[0]).toMatchObject({ outcome: 'completed' });
    expect(await countLogs(target)).toBe(before);
  });

  test('sprint-list は終えたスプリントを返さず、today を返す', async () => {
    const { target, active, next } = await setup();
    expect((await close(target, active.id, { carry_sprint_id: next.id, is_goal_achieved: true })).status).toBe(200);
    const res = await post(app, sprintList, {
      slug: target.slug,
      token: target.member.token,
      body: { workspace_id: target.workspace.id },
      env: frozenEnv,
    });
    const body = (await res.json()) as { sprints: { id: string; tasks: unknown[] }[]; today: string };
    expect(body.today).toBe('2026-10-26');
    expect(body.sprints.map((sprint) => sprint.id)).toEqual([next.id]);
    expect(body.sprints[0]!.tasks).toHaveLength(4);
  });

  test('today はワークスペースのタイムゾーンで数える（日本時間の午前 1 時は UTC ではまだ前の日）', async () => {
    const { target } = await setup();
    const res = await post(app, sprintList, {
      slug: target.slug,
      token: target.member.token,
      body: { workspace_id: target.workspace.id },
      env: envAt(EARLY_NOW),
    });
    expect(((await res.json()) as { today: string }).today).toBe('2026-10-26');
  });
});

// 処理を直に呼び、db.batch() の n 回目の呼び出しが返った直後に race を走らせる（読んでから書くまでの割り込み）。
// 1回のやり直しは、読む batch() と書く batch() の2回なので、読む batch() は奇数回目
async function closeWithRace(
  target: Target,
  input: Record<string, unknown>,
  race: (readNumber: number, db: Db) => Promise<void>,
  devNow: string = DEV_NOW,
) {
  const parsed = parseDevNow(devNow);
  if (!parsed.ok) throw new Error('解釈できるはず');
  setFixedNow(parsed.at);
  const db = orgDb(env, target.organization.verified);
  const actor = {
    accountId: target.leader.accountId,
    userId: target.leader.userId,
    isAdmin: false,
    invitedOnly: false,
  };
  const workspace = await verifyWorkspace(db, actor, target.workspace.id);
  let calls = 0;
  const racing = new Proxy(db, {
    get(base, key) {
      const value = Reflect.get(base, key, base);
      if (typeof value !== 'function') return value;
      if (key !== 'batch') return value.bind(base);
      return async (...args: unknown[]) => {
        const result = await (value as (...a: unknown[]) => Promise<unknown>).apply(base, args);
        calls++;
        if (calls % 2 === 1) await race((calls + 1) / 2, base);
        return result;
      };
    },
  });
  const context = {
    db: racing,
    actor,
    workspace,
    input: { workspace_id: target.workspace.id, carry_sprint_id: null, is_goal_achieved: null, ...input },
    defer: () => {},
  } as never;
  return sprintCloseOperation.handler(context) as Promise<{ sprint_id: string; carried_count: number }>;
}

describe('sprint-close: 読んだ後に別の要求が割り込む', () => {
  test('未完了のタスクが完了にされたら、読み直してやり直し、そのタスクは completed で閉じる', async () => {
    const { target, board, active, next, a, b, c } = await setup();
    const result = await closeWithRace(
      target,
      { sprint_id: active.id, carry_sprint_id: next.id, is_goal_achieved: true },
      async (n, db) => {
        if (n !== 1) return;
        await db.run(
          db.statement((q) =>
            q
              .updateTable('tasks')
              .set({ completed_at: COMPLETED_AT, completed_by: target.member.userId, column_id: board.done })
              .where('id', '=', b.id),
          ),
        );
      },
    );
    expect(result.carried_count).toBe(2);
    expect((await entriesOf(target, b.id))[0]).toMatchObject({ sprint_id: active.id, outcome: 'completed' });
    expect(await taskRow(target, b.id)).toMatchObject({ sprint_id: active.id });
    for (const task of [a, c]) expect(await taskRow(target, task.id)).toMatchObject({ sprint_id: next.id });
    expect(await logsOf(target, b.id)).toEqual([]);
  });

  test('未完了のタスクが入ったら、読み直してやり直し、そのタスクも持ち越す', async () => {
    const { target, board, active, next } = await setup();
    let added: string | undefined;
    const result = await closeWithRace(
      target,
      { sprint_id: active.id, carry_sprint_id: null, is_goal_achieved: true },
      async (n) => {
        if (n !== 1) return;
        added = (await taskIn(target, active.id, board.second, 'a1', { title: '途中で入った' })).id;
      },
    );
    expect(result.carried_count).toBe(4);
    expect(await taskRow(target, added!)).toMatchObject({ sprint_id: null });
    expect((await entriesOf(target, added!))[0]).toMatchObject({ outcome: 'carried_over' });
    expect(await sprintRow(target, next.id)).toMatchObject({ status: 'planned' });
  });

  test('3回続けて割り込まれたら 409 の conflict（changed）で、何も書かない', async () => {
    const { target, board, active } = await setup();
    const before = await countLogs(target);
    await expect(
      closeWithRace(target, { sprint_id: active.id, is_goal_achieved: true }, async (n) => {
        await taskIn(target, active.id, board.second, `a${n}`);
      }),
    ).rejects.toMatchObject({ status: 409, code: 'conflict', details: { reason: 'changed' } });
    expect(await sprintRow(target, active.id)).toMatchObject({ status: 'active' });
    expect(await countLogs(target)).toBe(before);
  });

  test('読んだ後に持ち越し先が削除されたら、やり直して 404', async () => {
    const { target, active, next, a } = await setup();
    await expect(
      closeWithRace(
        target,
        { sprint_id: active.id, carry_sprint_id: next.id, is_goal_achieved: true },
        async (n, db) => {
          if (n !== 1) return;
          await db.run(
            db.statement((q) => q.updateTable('sprints').set({ deleted_at: COMPLETED_AT }).where('id', '=', next.id)),
          );
        },
      ),
    ).rejects.toMatchObject({ status: 404 });
    expect(await sprintRow(target, active.id)).toMatchObject({ status: 'active' });
    expect(await taskRow(target, a.id)).toMatchObject({ sprint_id: active.id });
  });

  test('読んだ後に持ち越し先の期間が終えるスプリントより前に直されたら、409 の carry_target で、スプリントは active のまま', async () => {
    const { target, active, next, a } = await setup();
    await expect(
      closeWithRace(
        target,
        { sprint_id: active.id, carry_sprint_id: next.id, is_goal_achieved: true },
        async (n, db) => {
          if (n !== 1) return;
          await db.run(
            db.statement((q) =>
              q.updateTable('sprints').set({ start_on: '2026-10-05', end_on: '2026-10-18' }).where('id', '=', next.id),
            ),
          );
        },
      ),
    ).rejects.toMatchObject({ status: 409, code: 'conflict', details: { reason: 'carry_target' } });
    expect(await sprintRow(target, active.id)).toMatchObject({ status: 'active' });
    expect(await taskRow(target, a.id)).toMatchObject({ sprint_id: active.id });
    expect(await countLogs(target)).toBe(0);
  });

  test('読んだ後に持ち越し先の最終日が今日より前に直されても、書く文が断り、409 の carry_target', async () => {
    const { target, active, next, a } = await setup();
    // 今日は 2026-11-20。読んだときの持ち越し先は 11-16〜11-29（最終日は今日以降）
    await updateSprint(target, next.id, { start_on: '2026-11-16', end_on: '2026-11-29' });
    await expect(
      closeWithRace(
        target,
        { sprint_id: active.id, carry_sprint_id: next.id, is_goal_achieved: true },
        async (n, db) => {
          if (n !== 1) return;
          await db.run(
            db.statement((q) => q.updateTable('sprints').set({ end_on: '2026-11-19' }).where('id', '=', next.id)),
          );
        },
        '2026-11-20T10:00:00+09:00',
      ),
    ).rejects.toMatchObject({ status: 409, code: 'conflict', details: { reason: 'carry_target' } });
    expect(await sprintRow(target, active.id)).toMatchObject({ status: 'active' });
    expect(await taskRow(target, a.id)).toMatchObject({ sprint_id: active.id });
    expect(await countLogs(target)).toBe(0);
  });

  test('読んだ後に別の要求が先に終えたら、時計を止めていても二重に書かず、後の要求は 409 の not_active', async () => {
    const { target, active, next, a, d } = await setup();
    const parsed = parseDevNow(DEV_NOW);
    if (!parsed.ok) throw new Error('解釈できるはず');
    setFixedNow(parsed.at);

    await expect(
      closeWithRace(target, { sprint_id: active.id, carry_sprint_id: next.id, is_goal_achieved: true }, async (n) => {
        if (n !== 1) return;
        const first = await post(app, sprintClose, {
          slug: target.slug,
          token: target.leader.token,
          body: {
            workspace_id: target.workspace.id,
            sprint_id: active.id,
            carry_sprint_id: next.id,
            is_goal_achieved: true,
          },
          env: frozenEnv,
        });
        expect(first.status).toBe(200);
      }),
    ).rejects.toMatchObject({ status: 409, code: 'conflict', details: { reason: 'not_active' } });

    // 終了の記録は1つ。持ち越した履歴と行も1つずつ
    expect(await logsOf(target, active.id)).toHaveLength(1);
    expect(await logsOf(target, a.id)).toHaveLength(1);
    expect(await entriesOf(target, a.id)).toHaveLength(2);
    expect(await entriesOf(target, d.id)).toHaveLength(1);
  });
});

// 1文の bind の上限（100）と batch() の大きさに当たらないこと、持ち越す位置の書き込みが件数に比例することを、100 件を超える件数で確かめる
describe('sprint-close: 未完了のタスクが多いとき', () => {
  const BIG = 250;

  // 出発前と遂行中に半分ずつ、列の中の位置を振った未完了のタスクを BIG 件。期待する並び（列の順、列の中の位置の順）の ID を返す
  async function bigSetup() {
    const base = await setup({ goal: null });
    const { target, board, active } = base;
    const keys = generateNKeysBetween(null, null, BIG / 2);
    const made: { id: string; column: string; position: string }[] = [];
    for (let start = 0; start < BIG; start += 25) {
      const chunk = await Promise.all(
        Array.from({ length: 25 }, async (_, offset) => {
          const index = start + offset;
          const column = index % 2 === 0 ? board.first : board.second;
          const position = keys[Math.floor(index / 2)]!;
          const task = await taskIn(target, active.id, column, position, { title: `大量 ${index}` });
          return { id: task.id, column, position };
        }),
      );
      made.push(...chunk);
    }
    // setup が置く未完了の a、c（出発前）、b（遂行中）も含めた、終えるスプリントでの並び
    const all = [
      ...made.filter((task) => task.column === board.first),
      { id: base.a.id, column: board.first, position: 'a0' },
      { id: base.c.id, column: board.first, position: 'a1' },
      ...made.filter((task) => task.column === board.second),
      { id: base.b.id, column: board.second, position: 'a0' },
    ];
    const order = (column: string) =>
      all
        .filter((task) => task.column === column)
        .sort((x, y) => (x.position === y.position ? (x.id < y.id ? -1 : 1) : x.position < y.position ? -1 : 1))
        .map((task) => task.id);
    return { ...base, expected: [...order(board.first), ...order(board.second)] };
  }

  test('先のスプリントへ持ち越す: 件数、列の中の並び、行、履歴が件数どおり', { timeout: 120_000 }, async () => {
    const { target, board, active, next, e, expected } = await bigSetup();
    const total = expected.length;
    expect(total).toBe(BIG + 3);

    const startedAt = performance.now();
    const res = await close(target, active.id, { carry_sprint_id: next.id });
    const elapsed = Math.round(performance.now() - startedAt);
    // 件数に比例して遅くなる（相関副問い合わせで行ごとに位置を引くと2乗になる）ことへの目安。手元の実測は 253 件で 0.5 秒ほど
    expect(elapsed, `${total} 件の持ち越しに ${elapsed} ms`).toBeLessThan(10_000);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ sprint_id: active.id, carried_count: total });

    const db = orgDb(env, target.organization.verified);
    // 先のスプリントの先頭の列に、元の並びのまま末尾へ並ぶ（setup が置いた e の後ろ）。位置は重ならない
    const moved = await db.rows(
      db.statement((q) =>
        q
          .selectFrom('tasks')
          .select(['tasks.id', 'tasks.column_id', 'tasks.column_position'])
          .where('tasks.sprint_id', '=', next.id)
          .where('tasks.workspace_id', '=', target.workspace.id)
          .where('tasks.id', '!=', e.id)
          .orderBy('tasks.column_position')
          .orderBy('tasks.id'),
      ),
    );
    expect(moved.map((row) => row.id)).toEqual(expected);
    expect(new Set(moved.map((row) => row.column_position)).size).toBe(total);
    expect(moved.every((row) => row.column_id === board.first)).toBe(true);
    expect(moved[0]!.column_position! > 'a5').toBe(true);

    const entries = await db.rows(
      db.statement((q) =>
        q
          .selectFrom('sprint_entries')
          .select(['sprint_id', 'outcome', 'ended_at', 'task_id'])
          .where('workspace_id', '=', target.workspace.id),
      ),
    );
    expect(entries.filter((row) => row.sprint_id === active.id && row.outcome === 'carried_over')).toHaveLength(total);
    expect(entries.filter((row) => row.sprint_id === next.id && row.ended_at === null)).toHaveLength(total + 1);
    const logs = await db.rows(
      db.statement((q) =>
        q.selectFrom('change_logs').select(['entity_type']).where('organization_id', '=', target.organization.id),
      ),
    );
    expect(logs.filter((row) => row.entity_type === 'task')).toHaveLength(total);
    expect(logs.filter((row) => row.entity_type === 'sprint')).toHaveLength(1);
  });

  test('バックログへ戻す: 件数、行、履歴が件数どおり', { timeout: 120_000 }, async () => {
    const { target, active, expected } = await bigSetup();
    const total = expected.length;

    const startedAt = performance.now();
    const res = await close(target, active.id, { carry_sprint_id: null });
    const elapsed = Math.round(performance.now() - startedAt);
    expect(elapsed, `${total} 件の戻しに ${elapsed} ms`).toBeLessThan(10_000);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ sprint_id: active.id, carried_count: total, carry_to: null });

    const db = orgDb(env, target.organization.verified);
    const open = await db.rows(
      db.statement((q) =>
        q
          .selectFrom('tasks')
          .select('tasks.id')
          .where('tasks.workspace_id', '=', target.workspace.id)
          .where('tasks.sprint_id', 'is', null)
          .where('tasks.column_id', 'is', null)
          .where('tasks.column_position', 'is', null)
          .where('tasks.completed_at', 'is', null)
          .where('tasks.deleted_at', 'is', null)
          .where('tasks.title', 'like', '大量 %'),
      ),
    );
    expect(open).toHaveLength(BIG);
    const entries = await db.rows(
      db.statement((q) =>
        q
          .selectFrom('sprint_entries')
          .select(['sprint_id', 'outcome', 'ended_at'])
          .where('workspace_id', '=', target.workspace.id),
      ),
    );
    expect(entries.filter((row) => row.sprint_id === active.id && row.outcome === 'carried_over')).toHaveLength(total);
    expect(entries.filter((row) => row.ended_at === null && row.sprint_id !== active.id)).toHaveLength(1);
    const logs = await db.rows(
      db.statement((q) =>
        q.selectFrom('change_logs').select(['entity_type']).where('organization_id', '=', target.organization.id),
      ),
    );
    expect(logs.filter((row) => row.entity_type === 'task')).toHaveLength(total);
  });
});
