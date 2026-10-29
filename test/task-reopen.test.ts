// タスクの完了を戻す（task-reopen）の振る舞い（戻す列、経験値の打ち消し、完了の記録の削除、断る理由、競合、変更の履歴）と、
// 戻せるかの印（task-detail の reopenable、sprint-board のカードの reopenable）。
// 組織の分離と権限の種類ごとの許可と拒否は、一覧を回す test/operation-registry.test.ts が確かめる。ここでは要の場面だけを重ねて見る
import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import { XP_TASK_COMPLETED, XP_TASK_CREATED } from '../src/shared/experience.ts';
import { sprintBoard } from '../src/shared/operations/sprint/index.ts';
import { taskComplete, taskDetail, taskReopen } from '../src/shared/operations/task/index.ts';
import { createApp } from '../src/server/app.ts';
import { orgDb } from '../src/server/db/index.ts';
import { envWithD1Hooks } from '../src/server/db/testing.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import {
  createBoardColumn,
  createCompletion,
  createSprint,
  createSprintEntry,
  createStory,
  createTask,
  createXpGrant,
} from './factories.ts';
import { errorCodeOf, post } from './operations/harness.ts';
import { createTarget, testEnv, type Person, type Target } from './operations/world.ts';

const app = createApp(implementedOperations);

const COMPLETED_AT = '2026-10-21T00:00:00.000Z';

// 開発用の時計（DEV_NOW）で時刻を止めた、ループバックの公開 URL の環境
function clockAt(devNow: string): Env {
  return Object.assign({}, testEnv, { PUBLIC_ORIGIN: 'http://localhost:8787', DEV_NOW: devNow });
}

function call(
  target: Target,
  definition: Parameters<typeof post>[1],
  body: Record<string, unknown>,
  options: { person?: Person; env?: Env } = {},
) {
  const person = options.person ?? target.member;
  return post(app, definition, {
    slug: target.slug,
    token: person.token,
    body: { workspace_id: target.workspace.id, ...body },
    env: options.env ?? testEnv,
  });
}

const complete = (target: Target, taskId: string, options: { env?: Env } = {}) =>
  call(target, taskComplete, { task_id: taskId }, options);
const reopen = (target: Target, taskId: string, options: { env?: Env } = {}) =>
  call(target, taskReopen, { task_id: taskId }, options);

async function reasonOf(res: Response): Promise<unknown> {
  const body = (await res.json()) as { error?: { code?: string; details?: { reason?: unknown } } };
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
  const sprint = await createSprint(target.organization, target.workspace.id, { status: 'active' });
  return { target, board, sprint };
}

// スプリントのカード。作ったのはメンバー（起票の経験値はメンバーへ）で、ポイントは 2（経験値が付く）
async function card(target: Target, sprintId: string, columnId: string, position: string, overrides = {}) {
  const task = await createTask(target.organization, target.workspace.id, target.member.userId!, {
    sprint_id: sprintId,
    column_id: columnId,
    column_position: position,
    points: 2,
    ...overrides,
  });
  await createSprintEntry(target.organization, target.workspace.id, sprintId, task.id, target.member.userId!);
  return task;
}

async function taskRow(target: Target, taskId: string) {
  const db = orgDb(env, target.organization.verified);
  return db.first(
    db.statement((q) =>
      q.selectFrom('tasks').selectAll().where('id', '=', taskId).where('workspace_id', '=', target.workspace.id),
    ),
  );
}

async function completionsOf(target: Target, taskId: string) {
  const db = orgDb(env, target.organization.verified);
  return db.rows(
    db.statement((q) =>
      q
        .selectFrom('completions')
        .selectAll()
        .where('task_id', '=', taskId)
        .where('workspace_id', '=', target.workspace.id),
    ),
  );
}

async function grantsOf(target: Target, taskId: string) {
  const db = orgDb(env, target.organization.verified);
  return db.rows(
    db.statement((q) =>
      q
        .selectFrom('xp_grants')
        .selectAll()
        .where('task_id', '=', taskId)
        .where('workspace_id', '=', target.workspace.id)
        .orderBy('id'),
    ),
  );
}

const sumOf = (grants: { amount: number }[]) => grants.reduce((total, grant) => total + grant.amount, 0);

async function logsOf(target: Target, taskId: string) {
  const db = orgDb(env, target.organization.verified);
  return db.rows(
    db.statement((q) =>
      q
        .selectFrom('change_logs')
        .selectAll()
        .where('entity_id', '=', taskId)
        .where('organization_id', '=', target.organization.id)
        .orderBy('created_at')
        .orderBy('id'),
    ),
  );
}

async function userName(target: Target, userId: string) {
  const db = orgDb(env, target.organization.verified);
  const row = await db.first(
    db.statement((q) =>
      q
        .selectFrom('users')
        .select('name')
        .where('id', '=', userId)
        .where('organization_id', '=', target.organization.id),
    ),
  );
  return row!.name;
}

// 列の中の並び（column_position、id の順）を題で返す
async function titlesIn(target: Target, sprintId: string, columnId: string) {
  const db = orgDb(env, target.organization.verified);
  const rows = await db.rows(
    db.statement((q) =>
      q
        .selectFrom('tasks')
        .select('title')
        .where('workspace_id', '=', target.workspace.id)
        .where('sprint_id', '=', sprintId)
        .where('column_id', '=', columnId)
        .orderBy('column_position')
        .orderBy('id'),
    ),
  );
  return rows.map((row) => row.title);
}

async function reopenableOf(target: Target, taskId: string) {
  const res = await call(target, taskDetail, { task_id: taskId });
  expect(res.status).toBe(200);
  return ((await res.json()) as { task: { reopenable: boolean } }).task.reopenable;
}

describe('task-reopen', () => {
  test('進行中のスプリントで完了にしたカードを戻すと、前の列の末尾に戻り、記録を消し、経験値を打ち消し、履歴を残す', async () => {
    const { target, board, sprint } = await setup();
    await card(target, sprint.id, board.second.id, 'a0', { title: '先にいた札' });
    const task = await card(target, sprint.id, board.second.id, 'a1', { title: '戻す札' });

    expect((await complete(target, task.id)).status).toBe(200);
    // 完了の間に、同じ列の末尾へ別のカードが入った
    await card(target, sprint.id, board.second.id, 'a2', { title: '後から来た札' });
    const [completion] = await completionsOf(target, task.id);
    expect(completion).toMatchObject({ sprint_id: sprint.id, previous_column_id: board.second.id });
    const granted = await grantsOf(target, task.id);
    expect(sumOf(granted)).toBe(XP_TASK_CREATED + XP_TASK_COMPLETED);

    const res = await reopen(target, task.id);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ task_id: task.id, sprint_id: sprint.id, column_id: board.second.id });

    const row = await taskRow(target, task.id);
    expect(row).toMatchObject({
      completed_at: null,
      completed_by: null,
      sprint_id: sprint.id,
      column_id: board.second.id,
    });
    expect(await titlesIn(target, sprint.id, board.second.id)).toEqual(['先にいた札', '後から来た札', '戻す札']);
    expect(await completionsOf(target, task.id)).toEqual([]);

    // 打ち消しは元の行を写し、負の値で足す
    const grants = await grantsOf(target, task.id);
    expect(sumOf(grants)).toBe(0);
    const reversals = grants.filter((grant) => grant.reverses_grant_id !== null);
    expect(reversals).toHaveLength(granted.length);
    for (const original of granted) {
      expect(reversals.find((grant) => grant.reverses_grant_id === original.id)).toMatchObject({
        user_id: original.user_id,
        action: original.action,
        task_id: task.id,
        completion_id: completion!.id,
        amount: -original.amount,
        dedupe_key: `reversal:${original.id}`,
      });
    }

    const logs = await logsOf(target, task.id);
    const last = logs.at(-1)!;
    expect(last).toMatchObject({ action: 'reopen', entity_type: 'task', actor_user_id: target.member.userId });
    expect(JSON.parse(last.changes_json)).toEqual({
      completed_at: [completion!.completed_at, null],
      completed_by: [{ id: target.member.userId, name: await userName(target, target.member.userId!) }, null],
      column: [
        { id: board.done.id, name: null },
        { id: board.second.id, name: '遂行中' },
      ],
    });
  });

  test('完了の前の列が削除されていれば、先頭の完了でない列の末尾へ戻す', async () => {
    const { target, board, sprint } = await setup();
    await card(target, sprint.id, board.first.id, 'a0', { title: '先頭の札' });
    const task = await card(target, sprint.id, board.second.id, 'a0', { title: '戻す札' });
    expect((await complete(target, task.id)).status).toBe(200);
    const db = orgDb(env, target.organization.verified);
    await db.run(
      db.statement((q) =>
        q
          .updateTable('board_columns')
          .set({ deleted_at: '2026-10-22T00:00:00.000Z' })
          .where('id', '=', board.second.id)
          .where('workspace_id', '=', target.workspace.id),
      ),
    );

    const res = await reopen(target, task.id);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ column_id: board.first.id });
    expect(await titlesIn(target, sprint.id, board.first.id)).toEqual(['先頭の札', '戻す札']);
    const log = (await logsOf(target, task.id)).at(-1)!;
    expect(JSON.parse(log.changes_json).column).toEqual([
      { id: board.done.id, name: null },
      { id: board.first.id, name: '出発前' },
    ]);
  });

  test('完了の前の列が空の記録（前の版の完了）は、先頭の完了でない列へ戻す', async () => {
    const { target, board, sprint } = await setup();
    const task = await card(target, sprint.id, board.done.id, 'a0', {
      completed_at: COMPLETED_AT,
      completed_by: target.member.userId,
    });
    await createCompletion(target.organization, target.workspace.id, task.id, target.member.userId!, {
      completed_at: COMPLETED_AT,
      sprint_id: sprint.id,
    });
    const res = await reopen(target, task.id);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ column_id: board.first.id });
    expect(await completionsOf(target, task.id)).toEqual([]);
  });

  test('スプリントの外で完了したタスクは、列なしのまま戻し、履歴に列を残さない', async () => {
    const { target } = await setup();
    const task = await createTask(target.organization, target.workspace.id, target.member.userId!, { points: 3 });
    expect((await complete(target, task.id)).status).toBe(200);

    const res = await reopen(target, task.id);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ task_id: task.id, sprint_id: null, column_id: null });
    expect(await taskRow(target, task.id)).toMatchObject({ completed_at: null, sprint_id: null, column_id: null });
    expect(sumOf(await grantsOf(target, task.id))).toBe(0);
    expect(await completionsOf(target, task.id)).toEqual([]);
    const changes = JSON.parse((await logsOf(target, task.id)).at(-1)!.changes_json);
    expect(Object.keys(changes)).toEqual(['completed_at', 'completed_by']);
  });

  test('戻す記録は completed_at が今の完了と同じ行だけで、前の完了の記録と、別の完了の経験値には触れない', async () => {
    const { target } = await setup();
    const task = await createTask(target.organization, target.workspace.id, target.member.userId!, {
      completed_at: COMPLETED_AT,
      completed_by: target.member.userId,
    });
    const older = await createCompletion(target.organization, target.workspace.id, task.id, target.member.userId!, {
      completed_at: '2026-10-10T00:00:00.000Z',
    });
    const current = await createCompletion(target.organization, target.workspace.id, task.id, target.member.userId!, {
      completed_at: COMPLETED_AT,
    });
    const olderGrant = await createXpGrant(target.organization, target.workspace.id, target.member.userId!, {
      task_id: task.id,
      completion_id: older.id,
      action: 'task_completed',
      amount: 30,
    });
    // 所属を外れた人（管理者は所属していない）の分も取り消す
    const currentGrant = await createXpGrant(target.organization, target.workspace.id, target.admin.userId!, {
      task_id: task.id,
      completion_id: current.id,
      action: 'task_completed',
      amount: 30,
    });

    expect((await reopen(target, task.id)).status).toBe(200);
    expect((await completionsOf(target, task.id)).map((row) => row.id)).toEqual([older.id]);
    const grants = await grantsOf(target, task.id);
    expect(grants.filter((grant) => grant.reverses_grant_id !== null)).toMatchObject([
      { reverses_grant_id: currentGrant.id, user_id: target.admin.userId, amount: -30 },
    ]);
    expect(grants.some((grant) => grant.reverses_grant_id === olderGrant.id)).toBe(false);
  });

  test('終了したか削除したスプリントの中で完了したタスクは 409 の sprint_closed で、何も変わらない', async () => {
    const { target, board } = await setup();
    for (const overrides of [
      { status: 'closed' as const, start_on: '2026-09-01', end_on: '2026-09-14' },
      { status: 'planned' as const, start_on: '2026-12-01', end_on: '2026-12-14', deleted_at: COMPLETED_AT },
    ]) {
      const sprint = await createSprint(target.organization, target.workspace.id, overrides);
      const task = await card(target, sprint.id, board.done.id, 'a0', {
        completed_at: COMPLETED_AT,
        completed_by: target.member.userId,
      });
      await createCompletion(target.organization, target.workspace.id, task.id, target.member.userId!, {
        completed_at: COMPLETED_AT,
        sprint_id: sprint.id,
        previous_column_id: board.second.id,
      });
      const res = await reopen(target, task.id);
      expect(res.status).toBe(409);
      expect(await reasonOf(res)).toBe('sprint_closed');
      expect(await taskRow(target, task.id)).toMatchObject({ completed_at: COMPLETED_AT, column_id: board.done.id });
      expect(await completionsOf(target, task.id)).toHaveLength(1);
      expect(await logsOf(target, task.id)).toHaveLength(0);
      expect(await reopenableOf(target, task.id)).toBe(false);
    }
  });

  test('完了したストーリーの下のタスクは 409 の parent_completed で、詳細とスプリントの画面も戻せないと返す', async () => {
    const { target, board, sprint } = await setup();
    const story = await createStory(target.organization, target.workspace.id, target.member.userId!, {
      completed_at: COMPLETED_AT,
      completed_by: target.member.userId,
    });
    const task = await card(target, sprint.id, board.done.id, 'a0', {
      story_id: story.id,
      completed_at: COMPLETED_AT,
      completed_by: target.member.userId,
    });
    const open = await card(target, sprint.id, board.done.id, 'a1', {
      completed_at: COMPLETED_AT,
      completed_by: target.member.userId,
    });

    const res = await reopen(target, task.id);
    expect(res.status).toBe(409);
    expect(await reasonOf(res)).toBe('parent_completed');
    expect(await taskRow(target, task.id)).toMatchObject({ completed_at: COMPLETED_AT });
    expect(await reopenableOf(target, task.id)).toBe(false);
    expect(await reopenableOf(target, open.id)).toBe(true);

    const body = (await (await call(target, sprintBoard, {})).json()) as {
      columns: { tasks: { id: string; reopenable: boolean }[] }[];
    };
    const cards = body.columns.flatMap((column) => column.tasks);
    expect(cards.find((row) => row.id === task.id)?.reopenable).toBe(false);
    expect(cards.find((row) => row.id === open.id)?.reopenable).toBe(true);
  });

  test('完了していないタスクは 409 の not_completed で、詳細は戻せないと返す', async () => {
    const { target } = await setup();
    const task = await createTask(target.organization, target.workspace.id, target.member.userId!);
    const res = await reopen(target, task.id);
    expect(res.status).toBe(409);
    expect(await reasonOf(res)).toBe('not_completed');
    expect(await reopenableOf(target, task.id)).toBe(false);
  });

  test('別の組織のタスクを、自分のワークスペースの ID と組み合わせても 404 で、何も書かない', async () => {
    const { target } = await setup();
    const other = await createTarget();
    const task = await createTask(other.organization, other.workspace.id, other.member.userId!, {
      completed_at: COMPLETED_AT,
      completed_by: other.member.userId,
    });
    const res = await reopen(target, task.id);
    expect(res.status).toBe(404);
    const db = orgDb(env, other.organization.verified);
    const row = await db.first(
      db.statement((q) => q.selectFrom('tasks').select('completed_at').where('id', '=', task.id)),
    );
    expect(row?.completed_at).toBe(COMPLETED_AT);
  });

  test('閉じたワークスペースは 409 の workspace_closed で、詳細は戻せないと返す', async () => {
    const target = await createTarget({ closed: true });
    const task = await createTask(target.organization, target.workspace.id, target.member.userId!, {
      completed_at: COMPLETED_AT,
      completed_by: target.member.userId,
    });
    const res = await reopen(target, task.id);
    expect(res.status).toBe(409);
    expect(await errorCodeOf(res)).toBe('workspace_closed');
    expect(await reopenableOf(target, task.id)).toBe(false);
  });

  test('スプリントの外で完了したタスクは、詳細で戻せると返し、戻した後は戻せないと返す', async () => {
    const { target } = await setup();
    const task = await createTask(target.organization, target.workspace.id, target.member.userId!);
    expect((await complete(target, task.id)).status).toBe(200);
    expect(await reopenableOf(target, task.id)).toBe(true);
    expect((await reopen(target, task.id)).status).toBe(200);
    expect(await reopenableOf(target, task.id)).toBe(false);
  });

  test('2つの画面から同時に戻しても、通るのは1つで、記録の削除と打ち消しと履歴は1つずつ', async () => {
    const { target, board, sprint } = await setup();
    const task = await card(target, sprint.id, board.first.id, 'a0');
    expect((await complete(target, task.id)).status).toBe(200);
    const granted = await grantsOf(target, task.id);

    const results = await Promise.all([reopen(target, task.id), reopen(target, task.id)]);
    expect(results.map((res) => res.status).sort()).toEqual([200, 409]);
    const loser = results.find((res) => res.status === 409)!;
    expect(await reasonOf(loser)).toBe('not_completed');

    const grants = await grantsOf(target, task.id);
    expect(grants.filter((grant) => grant.reverses_grant_id !== null)).toHaveLength(granted.length);
    expect(sumOf(grants)).toBe(0);
    expect(await completionsOf(target, task.id)).toEqual([]);
    expect((await logsOf(target, task.id)).filter((log) => log.action === 'reopen')).toHaveLength(1);
  });

  test('2つの画面から同時に完了にしても、記録と経験値は1つずつで、戻すと打ち消しも1つずつ', async () => {
    const { target, board, sprint } = await setup();
    const task = await card(target, sprint.id, board.first.id, 'a0');
    const results = await Promise.all([complete(target, task.id), complete(target, task.id)]);
    expect(results.map((res) => res.status).sort()).toEqual([200, 409]);
    expect(await completionsOf(target, task.id)).toHaveLength(1);
    expect(await grantsOf(target, task.id)).toHaveLength(2);

    expect((await reopen(target, task.id)).status).toBe(200);
    const grants = await grantsOf(target, task.id);
    expect(grants).toHaveLength(4);
    expect(sumOf(grants)).toBe(0);
  });

  test('止めた時計で、完了、戻す、同じ時刻にもう一度完了にしても、記録と経験値が入り、もう一度戻すと新しい付与だけを打ち消す', async () => {
    const { target, board, sprint } = await setup();
    const task = await card(target, sprint.id, board.first.id, 'a0');
    const stopped = { env: clockAt('2026-10-26T10:00:00+09:00') };

    expect((await complete(target, task.id, stopped)).status).toBe(200);
    const first = await grantsOf(target, task.id);
    expect(first).toHaveLength(2);
    expect((await reopen(target, task.id, stopped)).status).toBe(200);

    expect((await complete(target, task.id, stopped)).status).toBe(200);
    const completions = await completionsOf(target, task.id);
    expect(completions).toHaveLength(1);
    const second = (await grantsOf(target, task.id)).filter(
      (grant) => grant.reverses_grant_id === null && grant.completion_id === completions[0]!.id,
    );
    expect(second).toHaveLength(2);
    expect(sumOf(await grantsOf(target, task.id))).toBe(XP_TASK_CREATED + XP_TASK_COMPLETED);

    expect((await reopen(target, task.id, stopped)).status).toBe(200);
    const grants = await grantsOf(target, task.id);
    expect(sumOf(grants)).toBe(0);
    // 元の付与は1回ずつだけ打ち消す（前の付与を2回打ち消さない）
    for (const original of [...first, ...second]) {
      expect(grants.filter((grant) => grant.reverses_grant_id === original.id)).toHaveLength(1);
    }
    expect(await completionsOf(target, task.id)).toEqual([]);
    // 止めた時計では履歴の時刻がそろい、id の順も書いた順にならないので、数だけを見る
    expect((await logsOf(target, task.id)).map((log) => log.action).sort()).toEqual([
      'complete',
      'complete',
      'reopen',
      'reopen',
    ]);
  });

  test('アーカイブした完了済みのタスクは、詳細で戻せないと返し、戻すのは 404', async () => {
    const { target } = await setup();
    // 取り込んだタスクを完了にした後、親を配下ごと削除するとアーカイブへ移る（tree-delete.ts）
    const task = await createTask(target.organization, target.workspace.id, target.member.userId!, {
      tray: 'archive',
      is_imported: 1,
      completed_at: COMPLETED_AT,
      completed_by: target.member.userId,
    });
    expect(await reopenableOf(target, task.id)).toBe(false);
    expect((await reopen(target, task.id)).status).toBe(404);
  });

  test('読んでから書くまでに、戻してから同じ時刻にもう一度完了にされたら（記録が替わった）、409 の changed で何も書かない', async () => {
    const { target } = await setup();
    const task = await createTask(target.organization, target.workspace.id, target.member.userId!, {
      completed_at: COMPLETED_AT,
      completed_by: target.member.userId,
    });
    const read = await createCompletion(target.organization, target.workspace.id, task.id, target.member.userId!, {
      completed_at: COMPLETED_AT,
    });
    let replaced: string | null = null;
    // 戻すタスクを読む batch() の直後に、別の要求が戻して、止めた時計の同じ時刻にもう一度完了にした状態へ替える
    const requestEnv = envWithD1Hooks(testEnv, {
      afterBatch: async (sqls) => {
        if (replaced !== null || sqls.length !== 3 || !sqls[1]!.includes('from "completions"')) return;
        const db = orgDb(env, target.organization.verified);
        await db.run(
          db.statement((q) =>
            q.deleteFrom('completions').where('id', '=', read.id).where('workspace_id', '=', target.workspace.id),
          ),
        );
        replaced = (
          await createCompletion(target.organization, target.workspace.id, task.id, target.member.userId!, {
            completed_at: COMPLETED_AT,
          })
        ).id;
      },
    });
    const res = await reopen(target, task.id, { env: requestEnv });
    expect(replaced).not.toBeNull();
    expect(res.status).toBe(409);
    expect(await reasonOf(res)).toBe('changed');
    expect(await taskRow(target, task.id)).toMatchObject({ completed_at: COMPLETED_AT });
    expect((await completionsOf(target, task.id)).map((row) => row.id)).toEqual([replaced]);
    expect(await logsOf(target, task.id)).toHaveLength(0);
  });

  test('記録の無い完了を読んだ後に、同じ時刻の記録が入っていたら、409 の changed で何も書かない', async () => {
    const { target } = await setup();
    const task = await createTask(target.organization, target.workspace.id, target.member.userId!, {
      completed_at: COMPLETED_AT,
      completed_by: target.member.userId,
    });
    let added = false;
    const requestEnv = envWithD1Hooks(testEnv, {
      afterBatch: async (sqls) => {
        if (added || sqls.length !== 3 || !sqls[1]!.includes('from "completions"')) return;
        added = true;
        await createCompletion(target.organization, target.workspace.id, task.id, target.member.userId!, {
          completed_at: COMPLETED_AT,
        });
      },
    });
    const res = await reopen(target, task.id, { env: requestEnv });
    expect(added).toBe(true);
    expect(res.status).toBe(409);
    expect(await reasonOf(res)).toBe('changed');
    expect(await taskRow(target, task.id)).toMatchObject({ completed_at: COMPLETED_AT });
    expect(await completionsOf(target, task.id)).toHaveLength(1);
  });

  test('完了でない列が1つも無ければ、409 の changed で何も書かない', async () => {
    const target = await createTarget();
    const done = await createBoardColumn(target.organization, target.workspace.id, {
      name: null,
      is_done: 1,
      position: 'Zz',
    });
    const sprint = await createSprint(target.organization, target.workspace.id, { status: 'active' });
    const task = await card(target, sprint.id, done.id, 'a0', {
      completed_at: COMPLETED_AT,
      completed_by: target.member.userId,
    });
    await createCompletion(target.organization, target.workspace.id, task.id, target.member.userId!, {
      completed_at: COMPLETED_AT,
      sprint_id: sprint.id,
    });
    const res = await reopen(target, task.id);
    expect(res.status).toBe(409);
    expect(await reasonOf(res)).toBe('changed');
    expect(await taskRow(target, task.id)).toMatchObject({ completed_at: COMPLETED_AT, column_id: done.id });
    expect(await completionsOf(target, task.id)).toHaveLength(1);
  });

  test('戻したカードは、スプリントの画面で戻した列に出る', async () => {
    const { target, board, sprint } = await setup();
    const task = await card(target, sprint.id, board.second.id, 'a0', { title: '戻す札' });
    expect((await complete(target, task.id)).status).toBe(200);
    expect((await reopen(target, task.id)).status).toBe(200);
    const body = (await (await call(target, sprintBoard, {})).json()) as {
      columns: { id: string; tasks: { id: string; completed_at: string | null; reopenable: boolean }[] }[];
    };
    const column = body.columns.find((row) => row.id === board.second.id)!;
    expect(column.tasks).toMatchObject([{ id: task.id, completed_at: null, reopenable: false }]);
  });
});
