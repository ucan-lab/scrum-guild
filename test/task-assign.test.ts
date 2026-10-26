// タスクの担当の変更（task-assign）と、詳細（task-detail）が返す担当の振る舞い。
// 組織の分離と権限の種類ごとの許可と拒否は、一覧を回す test/operation-registry.test.ts が確かめる
import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import { taskAssign, taskComplete, taskDetail } from '../src/shared/operations/task/index.ts';
import { createApp } from '../src/server/app.ts';
import { orgDb, verifyWorkspace } from '../src/server/db/index.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import { taskAssignOperation } from '../src/server/operations/task-edit.ts';
import { createMembership, createTask, createUser } from './factories.ts';
import { errorCodeOf, post } from './operations/harness.ts';
import { createPerson, createTarget, type Person, type Target } from './operations/world.ts';

const app = createApp(implementedOperations);

type Assignee = { id: string; name: string; left: boolean } | null;

function assign(target: Target, taskId: string, assigneeUserId: string | null, person: Person = target.member) {
  return post(app, taskAssign, {
    slug: target.slug,
    token: person.token,
    body: { workspace_id: target.workspace.id, task_id: taskId, assignee_user_id: assigneeUserId },
  });
}

async function assigneeInDetail(target: Target, taskId: string): Promise<Assignee> {
  const res = await post(app, taskDetail, {
    slug: target.slug,
    token: target.member.token,
    body: { workspace_id: target.workspace.id, task_id: taskId },
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { task: { assignee: Assignee } }).task.assignee;
}

async function rowOf(target: Target, taskId: string) {
  const db = orgDb(env, target.organization.verified);
  return db.first(
    db.statement((q) =>
      q.selectFrom('tasks').selectAll().where('id', '=', taskId).where('workspace_id', '=', target.workspace.id),
    ),
  );
}

async function logsOf(target: Target, taskId: string) {
  const db = orgDb(env, target.organization.verified);
  return db.rows(
    db.statement((q) =>
      q
        .selectFrom('change_logs')
        .selectAll()
        .where('entity_type', '=', 'task')
        .where('entity_id', '=', taskId)
        .where('organization_id', '=', target.organization.id)
        .orderBy('created_at')
        .orderBy('id'),
    ),
  );
}

async function rename(target: Target, person: Person, name: string) {
  const db = orgDb(env, target.organization.verified);
  await db.run(
    db.statement((q) =>
      q
        .updateTable('users')
        .set({ name })
        .where('id', '=', person.userId!)
        .where('organization_id', '=', target.organization.id),
    ),
  );
}

// ワークスペースから抜けた（今の所属の行に left_at を書く）
async function leave(target: Target, person: Person) {
  const db = orgDb(env, target.organization.verified);
  await db.run(
    db.statement((q) =>
      q
        .updateTable('memberships')
        .set({ left_at: '2026-10-24T00:00:00.000Z', left_on: '2026-10-24' })
        .where('workspace_id', '=', target.workspace.id)
        .where('user_id', '=', person.userId!)
        .where('left_at', 'is', null),
    ),
  );
}

async function disable(target: Target, person: Person) {
  const db = orgDb(env, target.organization.verified);
  await db.run(
    db.statement((q) =>
      q
        .updateTable('users')
        .set({ disabled_at: '2026-10-24T00:00:00.000Z' })
        .where('id', '=', person.userId!)
        .where('organization_id', '=', target.organization.id),
    ),
  );
}

// 名前で見分けられるように、メンバーとリーダーに別の名前を付けた対象
async function namedTarget(options: { closed?: boolean } = {}) {
  const target = await createTarget(options);
  await rename(target, target.member, '若葉 湊');
  await rename(target, target.leader, '朝霧 楓');
  return target;
}

function seeded(target: Target, overrides: Parameters<typeof createTask>[3] = {}) {
  return createTask(target.organization, target.workspace.id, target.admin.userId!, overrides);
}

describe('task-assign', () => {
  test('担当を割り当てると、今日やるの印を消し、そのときの名前で履歴に残す', async () => {
    const target = await namedTarget();
    const task = await seeded(target, { today_on: '2026-10-25' });
    const res = await assign(target, task.id, target.member.userId);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { task: { id: string; assignee: Assignee } };
    expect(body.task.id).toBe(task.id);
    expect(body.task.assignee).toEqual({ id: target.member.userId, name: '若葉 湊', left: false });
    const row = (await rowOf(target, task.id))!;
    expect(row).toMatchObject({ assignee_user_id: target.member.userId, today_on: null });
    expect(row.updated_at).not.toBe(task.updated_at);
    const logs = await logsOf(target, task.id);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ action: 'update', actor_user_id: target.member.userId });
    expect(JSON.parse(logs[0]!.changes_json)).toEqual({
      assignee: [null, { id: target.member.userId, name: '若葉 湊' }],
      today_on: ['2026-10-25', null],
    });
  });

  test('担当を替え、外せる。履歴の名前は、後で名前が変わっても、そのときのまま', async () => {
    const target = await namedTarget();
    const task = await seeded(target, { assignee_user_id: target.member.userId });
    const changed = await assign(target, task.id, target.leader.userId, target.leader);
    expect(changed.status).toBe(200);
    expect(((await changed.json()) as { task: { assignee: Assignee } }).task.assignee).toEqual({
      id: target.leader.userId,
      name: '朝霧 楓',
      left: false,
    });
    const removed = await assign(target, task.id, null);
    expect(removed.status).toBe(200);
    expect(((await removed.json()) as { task: { assignee: Assignee } }).task.assignee).toBeNull();
    expect((await rowOf(target, task.id))!.assignee_user_id).toBeNull();

    await rename(target, target.member, '若葉 湊（改名）');
    await rename(target, target.leader, '朝霧 楓（改名）');
    const changes = (await logsOf(target, task.id)).map((log) => JSON.parse(log.changes_json));
    // 今日やるの印が無かったので、today_on は残さない
    expect(changes).toEqual([
      {
        assignee: [
          { id: target.member.userId, name: '若葉 湊' },
          { id: target.leader.userId, name: '朝霧 楓' },
        ],
      },
      { assignee: [{ id: target.leader.userId, name: '朝霧 楓' }, null] },
    ]);
  });

  test('今と同じ担当を送ったら何も書かず、履歴も残さず、今日やるの印も消さない', async () => {
    const target = await namedTarget();
    const task = await seeded(target, { assignee_user_id: target.member.userId, today_on: '2026-10-25' });
    const res = await assign(target, task.id, target.member.userId);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { task: { assignee: Assignee } }).task.assignee).toMatchObject({
      id: target.member.userId,
    });
    expect(await rowOf(target, task.id)).toEqual(task);
    // 担当なしのタスクに null を送っても同じ
    const unassigned = await seeded(target, { today_on: '2026-10-25' });
    expect((await assign(target, unassigned.id, null)).status).toBe(200);
    expect(await rowOf(target, unassigned.id)).toEqual(unassigned);
    expect(await logsOf(target, task.id)).toEqual([]);
    expect(await logsOf(target, unassigned.id)).toEqual([]);
  });

  test('担当にできない人（別のワークスペースの人、Google で待っている人、所属していない管理者、抜けた人、無効にされた人、別の組織の人）は 404 で、何も書かない', async () => {
    const target = await namedTarget();
    const foreign = await createTarget();
    const left = await createPerson({
      organization: target.organization,
      membership: { workspaceId: target.workspace.id, role: 'member' },
    });
    await leave(target, left);
    const disabled = await createPerson({
      organization: target.organization,
      disabled: true,
      membership: { workspaceId: target.workspace.id, role: 'member' },
    });
    // Google で待っている行（login_subject が空）。メンバーの一覧（member-list）が候補に出さない人
    const waiting = await createUser(target.organization, {
      login_provider: 'google',
      login_subject: null,
      login_email: 'waiting@example.com',
      claim_token_hash: 'a'.repeat(64),
      claim_expires_at: '2099-01-01T00:00:00.000Z',
      name: 'waiting@example.com',
    });
    await createMembership(target.organization, target.workspace.id, waiting.id, { role: 'member' });
    const task = await seeded(target, { today_on: '2026-10-25' });
    for (const userId of [
      target.bystander.userId,
      waiting.id,
      target.admin.userId,
      left.userId,
      disabled.userId,
      foreign.member.userId,
      '019a0000-0000-7000-8000-00000000ffff',
    ]) {
      const res = await assign(target, task.id, userId);
      expect(res.status, String(userId)).toBe(404);
      expect(await errorCodeOf(res)).toBe('not_found');
    }
    expect(await rowOf(target, task.id)).toEqual(task);
    expect(await logsOf(target, task.id)).toEqual([]);
  });

  test('別の組織・別のワークスペース・削除済み・存在しないタスクは 404 で、何も書かない', async () => {
    const target = await namedTarget();
    const foreign = await createTarget();
    const foreignTask = await createTask(foreign.organization, foreign.workspace.id, foreign.admin.userId!);
    const elsewhere = await createTask(target.organization, target.otherWorkspace.id, target.admin.userId!);
    const deleted = await seeded(target, { deleted_at: '2026-10-21T00:00:00.000Z' });
    for (const id of [foreignTask.id, elsewhere.id, deleted.id, '019a0000-0000-7000-8000-00000000ffff']) {
      for (const userId of [target.member.userId, null]) {
        const res = await assign(target, id, userId);
        expect(res.status, id).toBe(404);
        expect(await errorCodeOf(res)).toBe('not_found');
      }
    }
    expect((await rowOf(foreign, foreignTask.id))!.assignee_user_id).toBeNull();
    expect((await rowOf({ ...target, workspace: target.otherWorkspace }, elsewhere.id))!.assignee_user_id).toBeNull();
  });

  test('完了したタスクの担当は 409 の conflict で替えられず、何も書かない。同じ担当を送るだけなら断らない', async () => {
    const target = await namedTarget();
    const task = await seeded(target, { assignee_user_id: target.member.userId, points: 3 });
    const completed = await post(app, taskComplete, {
      slug: target.slug,
      token: target.member.token,
      body: { workspace_id: target.workspace.id, task_id: task.id },
    });
    expect(completed.status).toBe(200);
    const before = await rowOf(target, task.id);
    const logsBefore = await logsOf(target, task.id);
    for (const userId of [target.leader.userId, null]) {
      const res = await assign(target, task.id, userId);
      expect(res.status).toBe(409);
      expect(await errorCodeOf(res)).toBe('conflict');
    }
    expect(await rowOf(target, task.id)).toEqual(before);
    expect(await logsOf(target, task.id)).toEqual(logsBefore);
    expect((await assign(target, task.id, target.member.userId)).status).toBe(200);
  });

  test('取り込んだタスクの担当は替えられる', async () => {
    const target = await namedTarget();
    const task = await seeded(target, { is_imported: 1, created_by: null });
    expect((await assign(target, task.id, target.leader.userId)).status).toBe(200);
    expect((await rowOf(target, task.id))!.assignee_user_id).toBe(target.leader.userId);
  });

  test('閉じたワークスペースでは、同じ担当を送っても 409 の workspace_closed で、何も書かない', async () => {
    const target = await namedTarget({ closed: true });
    const task = await seeded(target, { assignee_user_id: target.member.userId });
    for (const userId of [target.leader.userId, null, target.member.userId]) {
      const res = await assign(target, task.id, userId, target.admin);
      expect(res.status).toBe(409);
      expect(await errorCodeOf(res)).toBe('workspace_closed');
    }
    expect(await rowOf(target, task.id)).toEqual(task);
    expect(await logsOf(target, task.id)).toEqual([]);
  });

  test('閉じたワークスペースの完了したタスクは、conflict でなく 409 の workspace_closed', async () => {
    const target = await namedTarget({ closed: true });
    const task = await seeded(target, {
      assignee_user_id: target.member.userId,
      completed_at: '2026-10-21T00:00:00.000Z',
      completed_by: target.member.userId,
    });
    for (const userId of [target.leader.userId, null]) {
      const res = await assign(target, task.id, userId, target.admin);
      expect(res.status).toBe(409);
      expect(await errorCodeOf(res)).toBe('workspace_closed');
    }
    // 登録の関数の手前の検査を通った後（読んでから閉じた）を想定し、処理を直に呼んでも同じ答えになる
    const db = orgDb(env, target.organization.verified);
    const actor = {
      accountId: target.member.accountId,
      userId: target.member.userId,
      isAdmin: false,
      invitedOnly: false,
    };
    const workspace = await verifyWorkspace(db, actor, target.workspace.id);
    const context = {
      db,
      actor,
      workspace,
      input: { workspace_id: target.workspace.id, task_id: task.id, assignee_user_id: target.leader.userId },
      defer: () => {},
    } as never;
    await expect(taskAssignOperation.handler(context)).rejects.toMatchObject({
      status: 409,
      code: 'workspace_closed',
    });
    expect(await rowOf(target, task.id)).toEqual(task);
    expect(await logsOf(target, task.id)).toEqual([]);
  });

  describe('読んでから書くまでの競合', () => {
    // 処理を直に呼び、タスクの行を返した読み取りの直後に race を呼ぶ（n は何回目の読み取りか）
    async function runWithRace(
      target: Target,
      input: { task_id: string; assignee_user_id: string | null },
      race: (n: number) => Promise<void>,
    ) {
      const db = orgDb(env, target.organization.verified);
      const actor = {
        accountId: target.member.accountId,
        userId: target.member.userId,
        isAdmin: false,
        invitedOnly: false,
      };
      const workspace = await verifyWorkspace(db, actor, target.workspace.id);
      let reads = 0;
      const racing = new Proxy(db, {
        get(base, key) {
          const value = Reflect.get(base, key, base);
          if (typeof value !== 'function') return value;
          if (key !== 'first') return value.bind(base);
          return async (...args: unknown[]) => {
            const result = await (value as (...a: unknown[]) => Promise<unknown>).apply(base, args);
            if ((result as { title?: string } | undefined)?.title !== undefined) await race(++reads);
            return result;
          };
        },
      });
      const context = {
        db: racing,
        actor,
        workspace,
        input: { workspace_id: target.workspace.id, ...input },
        defer: () => {},
      } as never;
      return taskAssignOperation.handler(context);
    }

    test('読んだ後に別の要求が担当を替えたら、読み直して、正しい「前」で履歴に残す', async () => {
      const target = await namedTarget();
      const task = await seeded(target);
      const result = (await runWithRace(
        target,
        { task_id: task.id, assignee_user_id: target.member.userId },
        async (n) => {
          if (n === 1) expect((await assign(target, task.id, target.leader.userId, target.leader)).status).toBe(200);
        },
      )) as { task: { assignee: Assignee } };
      expect(result.task.assignee).toMatchObject({ id: target.member.userId });
      const changes = (await logsOf(target, task.id)).map((log) => JSON.parse(log.changes_json));
      expect(changes).toEqual([
        { assignee: [null, { id: target.leader.userId, name: '朝霧 楓' }] },
        {
          assignee: [
            { id: target.leader.userId, name: '朝霧 楓' },
            { id: target.member.userId, name: '若葉 湊' },
          ],
        },
      ]);
    });

    test('読んだ後に新しい担当がワークスペースを抜けたら、404 で何も書かない', async () => {
      const target = await namedTarget();
      const task = await seeded(target);
      await expect(
        runWithRace(target, { task_id: task.id, assignee_user_id: target.leader.userId }, async (n) => {
          if (n === 1) await leave(target, target.leader);
        }),
      ).rejects.toMatchObject({ status: 404, code: 'not_found' });
      expect(await rowOf(target, task.id)).toEqual(task);
      expect(await logsOf(target, task.id)).toEqual([]);
    });

    test('読んだ後に完了にされたら、409 の conflict で何も書かない', async () => {
      const target = await namedTarget();
      const task = await seeded(target, { points: 2 });
      await expect(
        runWithRace(target, { task_id: task.id, assignee_user_id: target.leader.userId }, async (n) => {
          if (n !== 1) return;
          const res = await post(app, taskComplete, {
            slug: target.slug,
            token: target.leader.token,
            body: { workspace_id: target.workspace.id, task_id: task.id },
          });
          expect(res.status).toBe(200);
        }),
      ).rejects.toMatchObject({ status: 409, code: 'conflict' });
      expect((await rowOf(target, task.id))!.assignee_user_id).toBeNull();
      expect((await logsOf(target, task.id)).filter((log) => log.action === 'update')).toEqual([]);
    });
  });
});

describe('task-detail の担当', () => {
  test('担当なしは null。担当は名前と、今所属しているか（left）を返す', async () => {
    const target = await namedTarget();
    const unassigned = await seeded(target);
    expect(await assigneeInDetail(target, unassigned.id)).toBeNull();
    const task = await seeded(target, { assignee_user_id: target.leader.userId });
    expect(await assigneeInDetail(target, task.id)).toEqual({ id: target.leader.userId, name: '朝霧 楓', left: false });
  });

  test('抜けた人、無効にされた人、別のワークスペースだけに所属する人が担当なら、名前を残して left が真', async () => {
    const target = await namedTarget();
    const left = await createPerson({
      organization: target.organization,
      membership: { workspaceId: target.workspace.id, role: 'member' },
    });
    await rename(target, left, '抜けた 人');
    const disabledPerson = await createPerson({
      organization: target.organization,
      membership: { workspaceId: target.workspace.id, role: 'member' },
    });
    const leftTask = await seeded(target);
    const disabledTask = await seeded(target);
    expect((await assign(target, leftTask.id, left.userId)).status).toBe(200);
    expect((await assign(target, disabledTask.id, disabledPerson.userId)).status).toBe(200);
    await leave(target, left);
    await disable(target, disabledPerson);
    expect(await assigneeInDetail(target, leftTask.id)).toEqual({ id: left.userId, name: '抜けた 人', left: true });
    expect(await assigneeInDetail(target, disabledTask.id)).toMatchObject({ id: disabledPerson.userId, left: true });
    const elsewhere = await seeded(target, { assignee_user_id: target.bystander.userId });
    expect(await assigneeInDetail(target, elsewhere.id)).toMatchObject({ id: target.bystander.userId, left: true });
    // 抜けた人の担当は外せる
    expect((await assign(target, leftTask.id, null)).status).toBe(200);
    expect(await assigneeInDetail(target, leftTask.id)).toBeNull();
  });
});
