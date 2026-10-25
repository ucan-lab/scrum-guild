// タスクとストーリーの移動（並べ替えと親の移動）の振る舞い。
// 組織の分離と権限の種類ごとの許可と拒否は、一覧を回す test/operation-registry.test.ts が確かめる
import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import { storyMove } from '../src/shared/operations/story/index.ts';
import { taskMove } from '../src/shared/operations/task/index.ts';
import { createApp } from '../src/server/app.ts';
import { orgDb, verifyWorkspace } from '../src/server/db/index.ts';
import { envWithD1Hooks } from '../src/server/db/testing.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import { MAX_TIES } from '../src/server/operations/move-position.ts';
import { taskMoveOperation } from '../src/server/operations/task.ts';
import { createCategory, createEpic, createStory, createTask } from './factories.ts';
import { errorCodeOf, post } from './operations/harness.ts';
import { createTarget, testEnv, type Person, type Target } from './operations/world.ts';

const app = createApp(implementedOperations);

function moveTask(
  target: Target,
  body: Record<string, unknown>,
  person: Person = target.member,
  requestEnv: Env = testEnv,
) {
  return post(app, taskMove, {
    slug: target.slug,
    token: person.token,
    body: { workspace_id: target.workspace.id, ...body },
    env: requestEnv,
  });
}

// 応答のエラーの code と、409 の理由（details.reason）
async function errorOf(res: Response) {
  const body = (await res.json()) as { error: { code: string; details?: { reason?: string } } };
  return { code: body.error.code, reason: body.error.details?.reason };
}

// 読んでから書くまでに別の要求が割り込んだ状況を作る。match に当たる問い合わせが答えた直後に、一度だけ change を流す
function racing(match: (sql: string) => boolean, change: () => Promise<void>): Env {
  let done = false;
  return envWithD1Hooks(testEnv, {
    afterQuery: async (sql) => {
      if (done || !match(sql)) return;
      done = true;
      await change();
    },
  });
}

// 移すタスクの読み取り（今の親の題を結ぶ）と、直前の行の読み取り
const readsMovingTask = (sql: string) => sql.includes('"story_title"');
const readsAfterRow = (sql: string) =>
  sql.startsWith('select "tasks"."id", "tasks"."position" from "tasks"') &&
  sql.includes('"tasks"."id" = ?') &&
  !sql.includes('order by');

async function updateTask(target: Target, id: string, values: Record<string, unknown>) {
  const db = orgDb(env, target.organization.verified);
  await db.run(
    db.statement((q) =>
      q.updateTable('tasks').set(values).where('id', '=', id).where('workspace_id', '=', target.workspace.id),
    ),
  );
}

function moveStory(target: Target, body: Record<string, unknown>, person: Person = target.member) {
  return post(app, storyMove, {
    slug: target.slug,
    token: person.token,
    body: { workspace_id: target.workspace.id, ...body },
  });
}

// 親の配下（null は親なし）の、削除していないバックログのタスクの id。position、id の順
async function taskOrder(target: Target, storyId: string | null) {
  const db = orgDb(env, target.organization.verified);
  const rows = await db.rows(
    db.statement((q) =>
      q
        .selectFrom('tasks')
        .select(['id', 'position'])
        .where('workspace_id', '=', target.workspace.id)
        .where('tray', '=', 'backlog')
        .where('story_id', storyId === null ? 'is' : '=', storyId)
        .where('deleted_at', 'is', null)
        .orderBy('position')
        .orderBy('id'),
    ),
  );
  return rows.map((row) => row.id);
}

async function storyOrder(target: Target, epicId: string | null) {
  const db = orgDb(env, target.organization.verified);
  const rows = await db.rows(
    db.statement((q) =>
      q
        .selectFrom('stories')
        .select(['id', 'position'])
        .where('workspace_id', '=', target.workspace.id)
        .where('epic_id', epicId === null ? 'is' : '=', epicId)
        .where('deleted_at', 'is', null)
        .orderBy('position')
        .orderBy('id'),
    ),
  );
  return rows.map((row) => row.id);
}

async function rowOf(target: Target, table: 'tasks' | 'stories', id: string) {
  const db = orgDb(env, target.organization.verified);
  return db.first(
    db.statement((q) =>
      q
        .selectFrom(table)
        .select(['id', 'position', 'category_id', 'updated_at'])
        .where('id', '=', id)
        .where('workspace_id', '=', target.workspace.id),
    ),
  );
}

async function logsOf(target: Target, entityId: string) {
  const db = orgDb(env, target.organization.verified);
  return db.rows(
    db.statement((q) =>
      q
        .selectFrom('change_logs')
        .selectAll()
        .where('entity_id', '=', entityId)
        .where('organization_id', '=', target.organization.id),
    ),
  );
}

// 親なしのタスクを、指した位置の順に作る
async function rootTasks(target: Target, positions: readonly string[], storyId: string | null = null) {
  const ids: string[] = [];
  for (const position of positions) {
    const task = await createTask(target.organization, target.workspace.id, target.admin.userId!, {
      position,
      story_id: storyId,
    });
    ids.push(task.id);
  }
  return ids;
}

describe('task-move の並べ替え', () => {
  test('先頭、途中、末尾へ移せる。親が変わらなければ履歴を書かない', async () => {
    const target = await createTarget();
    const [a, b, c, d] = await rootTasks(target, ['a0', 'a1', 'a2', 'a3']);

    // 先頭へ
    let res = await moveTask(target, { task_id: c, story_id: null, after_task_id: null });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ task_id: c, story_id: null });
    expect(await taskOrder(target, null)).toEqual([c, a, b, d]);

    // 途中（a の直後）
    res = await moveTask(target, { task_id: c, story_id: null, after_task_id: a });
    expect(res.status).toBe(200);
    expect(await taskOrder(target, null)).toEqual([a, c, b, d]);

    // 末尾（直前の行を省く）
    res = await moveTask(target, { task_id: a, story_id: null });
    expect(res.status).toBe(200);
    expect(await taskOrder(target, null)).toEqual([c, b, d, a]);

    // 最後の行の直後
    res = await moveTask(target, { task_id: c, story_id: null, after_task_id: a });
    expect(res.status).toBe(200);
    expect(await taskOrder(target, null)).toEqual([b, d, a, c]);

    for (const id of [a!, b!, c!, d!]) expect(await logsOf(target, id)).toEqual([]);
  });

  test('完了したタスクも並びに残っているので、直前の行に指せる', async () => {
    const target = await createTarget();
    const [a, b] = await rootTasks(target, ['a0', 'a1']);
    const done = await createTask(target.organization, target.workspace.id, target.admin.userId!, {
      position: 'a2',
      completed_at: '2026-10-21T00:00:00.000Z',
      completed_by: target.admin.userId,
    });
    const res = await moveTask(target, { task_id: a, story_id: null, after_task_id: done.id });
    expect(res.status).toBe(200);
    expect(await taskOrder(target, null)).toEqual([b, done.id, a]);
  });

  test('直前の行と同じ値の行が続くときは、移す行と一緒に振り直す', async () => {
    const target = await createTarget();
    const [head] = await rootTasks(target, ['a0']);
    // 同時に作った行と同じく、同じ値の3行。並びは id の順
    const ties = (await rootTasks(target, ['a1', 'a1', 'a1'])).sort();
    const [tail, moving] = await rootTasks(target, ['a2', 'a3']);

    const res = await moveTask(target, { task_id: moving, story_id: null, after_task_id: ties[0] });
    expect(res.status).toBe(200);
    expect(await taskOrder(target, null)).toEqual([head, ties[0], moving, ties[1], ties[2], tail]);

    // 振り直した行は、直前の行の値と次の値の間で、互いに違う値になる
    const positions = await Promise.all(
      [ties[0]!, moving!, ties[1]!, ties[2]!].map((id) => rowOf(target, 'tasks', id)),
    );
    const values = positions.map((row) => row!.position);
    expect(values[0]).toBe('a1');
    expect(new Set(values).size).toBe(4);
    for (const value of values.slice(1)) {
      expect(value > 'a1').toBe(true);
      expect(value < 'a2').toBe(true);
    }
  });

  test('同じ値の行が末尾にあっても、直後に入れられる', async () => {
    const target = await createTarget();
    const [moving] = await rootTasks(target, ['a0']);
    const ties = (await rootTasks(target, ['a1', 'a1'])).sort();
    const res = await moveTask(target, { task_id: moving, story_id: null, after_task_id: ties[0] });
    expect(res.status).toBe(200);
    expect(await taskOrder(target, null)).toEqual([ties[0], moving, ties[1]]);
  });

  test('同じ値の行の先頭の前（先頭）にも入れられる', async () => {
    const target = await createTarget();
    const ties = (await rootTasks(target, ['a0', 'a0'])).sort();
    const [moving] = await rootTasks(target, ['a1']);
    const res = await moveTask(target, { task_id: moving, story_id: null, after_task_id: null });
    expect(res.status).toBe(200);
    expect(await taskOrder(target, null)).toEqual([moving, ...ties]);
  });
});

describe('task-move の親の移動', () => {
  test('別のストーリーの下へ移すと末尾に置き、区分を空にして、履歴に親を残す。親なしへ戻すと親のないタスクの末尾', async () => {
    const target = await createTarget();
    const adminId = target.admin.userId!;
    const story = await createStory(target.organization, target.workspace.id, adminId, { title: '移す先' });
    const [under1, under2] = await rootTasks(target, ['a0', 'a1'], story.id);
    const category = await createCategory(target.organization, target.workspace.id);
    const moving = await createTask(target.organization, target.workspace.id, adminId, {
      position: 'a0',
      category_id: category.id,
    });
    const [root] = await rootTasks(target, ['a5']);

    let res = await moveTask(target, { task_id: moving.id, story_id: story.id });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ task_id: moving.id, story_id: story.id });
    expect(await taskOrder(target, story.id)).toEqual([under1, under2, moving.id]);
    expect(await taskOrder(target, null)).toEqual([root]);
    const row = await rowOf(target, 'tasks', moving.id);
    expect(row!.category_id).toBeNull();
    expect(row!.updated_at).not.toBe(moving.updated_at);

    let logs = await logsOf(target, moving.id);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      workspace_id: target.workspace.id,
      actor_user_id: target.member.userId,
      entity_type: 'task',
      action: 'update',
    });
    expect(JSON.parse(logs[0]!.changes_json)).toEqual({ story: [null, { id: story.id, title: '移す先' }] });

    // 親なしへ戻す。末尾に置く
    res = await moveTask(target, { task_id: moving.id, story_id: null });
    expect(res.status).toBe(200);
    expect(await taskOrder(target, null)).toEqual([root, moving.id]);
    logs = await logsOf(target, moving.id);
    expect(logs).toHaveLength(2);
    expect(logs.map((log) => JSON.parse(log.changes_json))).toContainEqual({
      story: [{ id: story.id, title: '移す先' }, null],
    });
  });

  test('ストーリーの下で、指した行の直後に置ける', async () => {
    const target = await createTarget();
    const story = await createStory(target.organization, target.workspace.id, target.admin.userId!);
    const [first, second] = await rootTasks(target, ['a0', 'a1'], story.id);
    const [moving] = await rootTasks(target, ['a0']);
    const res = await moveTask(target, { task_id: moving, story_id: story.id, after_task_id: first });
    expect(res.status).toBe(200);
    expect(await taskOrder(target, story.id)).toEqual([first, moving, second]);
  });

  test('完了したストーリーの下へは 409 の conflict で、何も書かない', async () => {
    const target = await createTarget();
    const done = await createStory(target.organization, target.workspace.id, target.admin.userId!, {
      completed_at: '2026-10-21T00:00:00.000Z',
      completed_by: target.admin.userId,
    });
    const [moving] = await rootTasks(target, ['a0']);
    const res = await moveTask(target, { task_id: moving, story_id: done.id });
    expect(res.status).toBe(409);
    expect(await errorOf(res)).toEqual({ code: 'conflict', reason: 'parent_completed' });
    expect(await taskOrder(target, done.id)).toEqual([]);
    expect(await logsOf(target, moving!)).toEqual([]);
  });
});

describe('task-move で断るもの', () => {
  test('完了したタスクは 409 の conflict', async () => {
    const target = await createTarget();
    const done = await createTask(target.organization, target.workspace.id, target.admin.userId!, {
      completed_at: '2026-10-21T00:00:00.000Z',
      completed_by: target.admin.userId,
    });
    const res = await moveTask(target, { task_id: done.id, story_id: null, after_task_id: null });
    expect(res.status).toBe(409);
    expect(await errorOf(res)).toEqual({ code: 'conflict', reason: 'task_completed' });
  });

  test('閉じたワークスペースでは 409 の workspace_closed', async () => {
    const target = await createTarget({ closed: true });
    const [a, b] = await rootTasks(target, ['a0', 'a1']);
    const res = await moveTask(target, { task_id: b, story_id: null, after_task_id: null }, target.admin);
    expect(res.status).toBe(409);
    expect(await errorCodeOf(res)).toBe('workspace_closed');
    expect(await taskOrder(target, null)).toEqual([a, b]);
  });

  test('直前の行が移す先に無ければ 404（別の親、削除済み、別の組織、存在しない）', async () => {
    const target = await createTarget();
    const foreign = await createTarget();
    const adminId = target.admin.userId!;
    const story = await createStory(target.organization, target.workspace.id, adminId);
    const [moving, rootRow] = await rootTasks(target, ['a0', 'a1']);
    const [underStory] = await rootTasks(target, ['a0'], story.id);
    const deleted = await createTask(target.organization, target.workspace.id, adminId, {
      position: 'a2',
      deleted_at: '2026-10-21T00:00:00.000Z',
    });
    const foreignTask = await createTask(foreign.organization, foreign.workspace.id, foreign.admin.userId!);
    for (const afterId of [underStory, deleted.id, foreignTask.id, '019a0000-0000-7000-8000-00000000ffff']) {
      const res = await moveTask(target, { task_id: moving, story_id: null, after_task_id: afterId });
      expect(res.status, afterId).toBe(404);
      expect(await errorCodeOf(res)).toBe('not_found');
    }
    // 親のないタスクを、ストーリーの下の行の直後へは指せない
    const res = await moveTask(target, { task_id: moving, story_id: story.id, after_task_id: rootRow });
    expect(res.status).toBe(404);
    expect(await taskOrder(target, null)).toEqual([moving, rootRow]);
  });

  test('直前の行に移すタスク自身を指すと 400 の invalid_input', async () => {
    const target = await createTarget();
    const [moving] = await rootTasks(target, ['a0']);
    const res = await moveTask(target, { task_id: moving, story_id: null, after_task_id: moving });
    expect(res.status).toBe(400);
    expect(await errorCodeOf(res)).toBe('invalid_input');
  });

  test('別の組織のタスクとストーリーは 404', async () => {
    const target = await createTarget();
    const foreign = await createTarget();
    const foreignTask = await createTask(foreign.organization, foreign.workspace.id, foreign.admin.userId!);
    const foreignStory = await createStory(foreign.organization, foreign.workspace.id, foreign.admin.userId!);
    const [own] = await rootTasks(target, ['a0']);

    let res = await moveTask(target, { task_id: foreignTask.id, story_id: null });
    expect(res.status).toBe(404);
    res = await moveTask(target, { task_id: own, story_id: foreignStory.id });
    expect(res.status).toBe(404);
    expect(await errorCodeOf(res)).toBe('not_found');
  });

  test('読んでから書くまでにワークスペースが閉じたら、何も書かず 409 の workspace_closed', async () => {
    const target = await createTarget();
    const [a, b] = await rootTasks(target, ['a0', 'a1']);
    const db = orgDb(env, target.organization.verified);
    const actor = {
      accountId: target.member.accountId,
      userId: target.member.userId,
      isAdmin: false,
      invitedOnly: false,
    };
    const workspace = await verifyWorkspace(db, actor, target.workspace.id);
    await db.run(
      db.statement((q) =>
        q
          .updateTable('workspaces')
          .set({ closed_at: '2026-10-22T00:00:00.000Z' })
          .where('id', '=', target.workspace.id)
          .where('organization_id', '=', target.organization.id),
      ),
    );
    const context = {
      db,
      actor,
      workspace,
      input: { workspace_id: target.workspace.id, task_id: b, story_id: null, after_task_id: null },
      defer: () => {},
    } as never;
    await expect(taskMoveOperation.handler(context)).rejects.toMatchObject({ status: 409, code: 'workspace_closed' });
    expect(await taskOrder(target, null)).toEqual([a, b]);
  });
});

describe('story-move', () => {
  test('親のないストーリーを並べ替えても、履歴を書かない', async () => {
    const target = await createTarget();
    const adminId = target.admin.userId!;
    const ids: string[] = [];
    for (const position of ['a0', 'a1', 'a2']) {
      ids.push((await createStory(target.organization, target.workspace.id, adminId, { position })).id);
    }
    const [a, b, c] = ids;
    let res = await moveStory(target, { story_id: c, epic_id: null, after_story_id: null });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ story_id: c, epic_id: null });
    expect(await storyOrder(target, null)).toEqual([c, a, b]);
    res = await moveStory(target, { story_id: c, epic_id: null, after_story_id: a });
    expect(res.status).toBe(200);
    expect(await storyOrder(target, null)).toEqual([a, c, b]);
    res = await moveStory(target, { story_id: a, epic_id: null });
    expect(res.status).toBe(200);
    expect(await storyOrder(target, null)).toEqual([c, b, a]);
    for (const id of ids) expect(await logsOf(target, id)).toEqual([]);
  });

  test('同じ値のストーリーが続くときは、移す行と一緒に振り直す', async () => {
    const target = await createTarget();
    const adminId = target.admin.userId!;
    const ties: string[] = [];
    for (let i = 0; i < 3; i++) {
      ties.push((await createStory(target.organization, target.workspace.id, adminId, { position: 'a0' })).id);
    }
    ties.sort();
    const moving = await createStory(target.organization, target.workspace.id, adminId, { position: 'a1' });
    const res = await moveStory(target, { story_id: moving.id, epic_id: null, after_story_id: ties[0] });
    expect(res.status).toBe(200);
    expect(await storyOrder(target, null)).toEqual([ties[0], moving.id, ties[1], ties[2]]);
  });

  test('エピックの下へ移すと末尾に置き、区分を空にして履歴を残す。親なしへ戻すと最上段の末尾', async () => {
    const target = await createTarget();
    const adminId = target.admin.userId!;
    const epic = await createEpic(target.organization, target.workspace.id, adminId, { title: 'レイド' });
    const inEpic = await createStory(target.organization, target.workspace.id, adminId, {
      epic_id: epic.id,
      position: 'a0',
    });
    const category = await createCategory(target.organization, target.workspace.id);
    const moving = await createStory(target.organization, target.workspace.id, adminId, {
      position: 'a0',
      category_id: category.id,
    });
    const root = await createStory(target.organization, target.workspace.id, adminId, { position: 'a1' });

    let res = await moveStory(target, { story_id: moving.id, epic_id: epic.id });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ story_id: moving.id, epic_id: epic.id });
    expect(await storyOrder(target, epic.id)).toEqual([inEpic.id, moving.id]);
    expect((await rowOf(target, 'stories', moving.id))!.category_id).toBeNull();
    let logs = await logsOf(target, moving.id);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ entity_type: 'story', action: 'update', actor_user_id: target.member.userId });
    expect(JSON.parse(logs[0]!.changes_json)).toEqual({ epic: [null, { id: epic.id, title: 'レイド' }] });

    // エピックの下から親なしへ
    res = await moveStory(target, { story_id: inEpic.id, epic_id: null });
    expect(res.status).toBe(200);
    expect(await storyOrder(target, null)).toEqual([root.id, inEpic.id]);
    logs = await logsOf(target, inEpic.id);
    expect(JSON.parse(logs[0]!.changes_json)).toEqual({ epic: [{ id: epic.id, title: 'レイド' }, null] });
  });

  test('完了か中止したエピックの下へは 409 の conflict', async () => {
    const target = await createTarget();
    const adminId = target.admin.userId!;
    const moving = await createStory(target.organization, target.workspace.id, adminId);
    for (const overrides of [
      { completed_at: '2026-10-21T00:00:00.000Z', completed_by: adminId },
      { canceled_at: '2026-10-21T00:00:00.000Z', canceled_by: adminId },
    ]) {
      const epic = await createEpic(target.organization, target.workspace.id, adminId, overrides);
      const res = await moveStory(target, { story_id: moving.id, epic_id: epic.id });
      expect(res.status).toBe(409);
      expect(await errorOf(res)).toEqual({ code: 'conflict', reason: 'parent_completed' });
      expect(await storyOrder(target, epic.id)).toEqual([]);
    }
  });

  test('直前の行が移す先に無いか別の組織なら 404、自分自身なら 400、別の組織のストーリーとエピックは 404', async () => {
    const target = await createTarget();
    const foreign = await createTarget();
    const adminId = target.admin.userId!;
    const epic = await createEpic(target.organization, target.workspace.id, adminId);
    const inEpic = await createStory(target.organization, target.workspace.id, adminId, { epic_id: epic.id });
    const moving = await createStory(target.organization, target.workspace.id, adminId);
    const foreignStory = await createStory(foreign.organization, foreign.workspace.id, foreign.admin.userId!);
    const foreignEpic = await createEpic(foreign.organization, foreign.workspace.id, foreign.admin.userId!);

    for (const body of [
      { story_id: moving.id, epic_id: null, after_story_id: inEpic.id },
      { story_id: moving.id, epic_id: null, after_story_id: foreignStory.id },
      { story_id: foreignStory.id, epic_id: null },
      { story_id: moving.id, epic_id: foreignEpic.id },
    ]) {
      const res = await moveStory(target, body);
      expect(res.status, JSON.stringify(body)).toBe(404);
      expect(await errorCodeOf(res)).toBe('not_found');
    }
    const self = await moveStory(target, { story_id: moving.id, epic_id: null, after_story_id: moving.id });
    expect(self.status).toBe(400);
    expect(await errorCodeOf(self)).toBe('invalid_input');
  });

  test('閉じたワークスペースでは 409 の workspace_closed', async () => {
    const target = await createTarget({ closed: true });
    const story = await createStory(target.organization, target.workspace.id, target.admin.userId!);
    const res = await moveStory(target, { story_id: story.id, epic_id: null, after_story_id: null }, target.admin);
    expect(res.status).toBe(409);
    expect(await errorCodeOf(res)).toBe('workspace_closed');
  });

  test('完了したエピックの下でも、同じエピックの中の並べ替えはできる', async () => {
    const target = await createTarget();
    const adminId = target.admin.userId!;
    const epic = await createEpic(target.organization, target.workspace.id, adminId, {
      completed_at: '2026-10-21T00:00:00.000Z',
      completed_by: adminId,
    });
    const first = await createStory(target.organization, target.workspace.id, adminId, { epic_id: epic.id });
    const second = await createStory(target.organization, target.workspace.id, adminId, {
      epic_id: epic.id,
      position: 'a1',
    });
    const res = await moveStory(target, { story_id: second.id, epic_id: epic.id, after_story_id: null });
    expect(res.status).toBe(200);
    expect(await storyOrder(target, epic.id)).toEqual([second.id, first.id]);
  });
});

describe('task-move の親と直前の行の範囲', () => {
  test('完了したストーリーの下でも、同じストーリーの中の並べ替えはできる', async () => {
    const target = await createTarget();
    const done = await createStory(target.organization, target.workspace.id, target.admin.userId!, {
      completed_at: '2026-10-21T00:00:00.000Z',
      completed_by: target.admin.userId,
    });
    const [first, second] = await rootTasks(target, ['a0', 'a1'], done.id);
    const res = await moveTask(target, { task_id: second, story_id: done.id, after_task_id: null });
    expect(res.status).toBe(200);
    expect(await taskOrder(target, done.id)).toEqual([second, first]);
    expect(await logsOf(target, second!)).toEqual([]);
  });

  test('同じ組織の別のワークスペースの親と直前の行は 404', async () => {
    const target = await createTarget();
    const adminId = target.admin.userId!;
    const otherStory = await createStory(target.organization, target.otherWorkspace.id, adminId);
    const otherTask = await createTask(target.organization, target.otherWorkspace.id, adminId);
    const [moving] = await rootTasks(target, ['a0']);
    for (const body of [
      { task_id: moving, story_id: otherStory.id },
      { task_id: moving, story_id: null, after_task_id: otherTask.id },
    ]) {
      const res = await moveTask(target, body);
      expect(res.status, JSON.stringify(body)).toBe(404);
      expect(await errorCodeOf(res)).toBe('not_found');
    }
  });

  test('受信箱のタスクは 404', async () => {
    const target = await createTarget();
    const inbox = await createTask(target.organization, target.workspace.id, target.admin.userId!, {
      tray: 'inbox',
      is_imported: 1,
      created_by: null,
    });
    const res = await moveTask(target, { task_id: inbox.id, story_id: null });
    expect(res.status).toBe(404);
    expect(await errorCodeOf(res)).toBe('not_found');
  });

  test('同じ値の続きが上限を超えたら、振り直さず 409（ties）', async () => {
    const target = await createTarget();
    const ties = (
      await rootTasks(
        target,
        Array.from({ length: MAX_TIES + 2 }, () => 'a1'),
      )
    ).sort();
    const [moving] = await rootTasks(target, ['a2']);
    const res = await moveTask(target, { task_id: moving, story_id: null, after_task_id: ties[0] });
    expect(res.status).toBe(409);
    expect(await errorOf(res)).toEqual({ code: 'conflict', reason: 'ties' });
    expect((await rowOf(target, 'tasks', moving!))!.position).toBe('a2');
  });
});

describe('task-move で、読んでから書くまでに別の要求が割り込んだとき', () => {
  test('別の要求が先に親を移したら 409（changed）で、振り直しも履歴も書かない', async () => {
    const target = await createTarget();
    const story = await createStory(target.organization, target.workspace.id, target.admin.userId!);
    const [head] = await rootTasks(target, ['a0']);
    const ties = (await rootTasks(target, ['a1', 'a1'])).sort();
    const [moving] = await rootTasks(target, ['a2']);
    const raced = racing(readsMovingTask, () => updateTask(target, moving!, { story_id: story.id }));
    const res = await moveTask(
      target,
      { task_id: moving, story_id: null, after_task_id: ties[0] },
      target.member,
      raced,
    );
    expect(res.status).toBe(409);
    expect(await errorOf(res)).toEqual({ code: 'conflict', reason: 'changed' });
    // 同じ値の続きは振り直していない
    for (const id of ties) expect((await rowOf(target, 'tasks', id))!.position).toBe('a1');
    expect(await taskOrder(target, null)).toEqual([head, ...ties]);
    expect(await taskOrder(target, story.id)).toEqual([moving]);
    expect(await logsOf(target, moving!)).toEqual([]);
  });

  test('直前の行が動いていたら 409（changed）', async () => {
    const target = await createTarget();
    const [a, b, c] = await rootTasks(target, ['a0', 'a1', 'a2']);
    const raced = racing(readsAfterRow, () => updateTask(target, a!, { position: 'a5' }));
    const res = await moveTask(target, { task_id: c, story_id: null, after_task_id: a }, target.member, raced);
    expect(res.status).toBe(409);
    expect(await errorOf(res)).toEqual({ code: 'conflict', reason: 'changed' });
    expect(await taskOrder(target, null)).toEqual([b, c, a]);
  });

  test('直前の行が消えていたら 404', async () => {
    const target = await createTarget();
    const [a, b, c] = await rootTasks(target, ['a0', 'a1', 'a2']);
    const raced = racing(readsAfterRow, () => updateTask(target, a!, { deleted_at: '2026-10-22T00:00:00.000Z' }));
    const res = await moveTask(target, { task_id: c, story_id: null, after_task_id: a }, target.member, raced);
    expect(res.status).toBe(404);
    expect(await errorCodeOf(res)).toBe('not_found');
    expect(await taskOrder(target, null)).toEqual([b, c]);
  });
});
