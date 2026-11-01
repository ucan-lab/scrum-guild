// タスクの今日やるの印を付け外す操作（task-today-mark）の振る舞い。
// 組織の分離と権限の種類ごとの許可と拒否は、一覧を回す test/operation-registry.test.ts が確かめる
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { taskComplete, taskTodayMark } from '../src/shared/operations/task/index.ts';
import { createApp } from '../src/server/app.ts';
import { orgDb, verifyWorkspace } from '../src/server/db/index.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import { taskTodayMarkOperation } from '../src/server/operations/task-today-mark.ts';
import { createMembership, createTask, createWorkspace } from './factories.ts';
import { errorCodeOf, post } from './operations/harness.ts';
import { createTarget, type Person, type Target } from './operations/world.ts';

const app = createApp(implementedOperations);

afterEach(() => {
  vi.useRealTimers();
});

type MarkBody = { task_id: string; today_on: string | null };

function mark(target: Target, taskId: string, marked: boolean, person: Person = target.member, workspaceId?: string) {
  return post(app, taskTodayMark, {
    slug: target.slug,
    token: person.token,
    body: { workspace_id: workspaceId ?? target.workspace.id, task_id: taskId, marked },
  });
}

async function rowOf(target: Target, taskId: string) {
  const db = orgDb(env, target.organization.verified);
  return db.first(db.statement((q) => q.selectFrom('tasks').selectAll().where('id', '=', taskId)));
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

async function reasonOf(res: Response): Promise<unknown> {
  const body = (await res.json()) as { error?: { details?: { reason?: unknown } } };
  return body.error?.details?.reason;
}

// 本人（メンバー）が担当するタスク
function mine(target: Target, overrides: Parameters<typeof createTask>[3] = {}) {
  return createTask(target.organization, target.workspace.id, target.admin.userId!, {
    assignee_user_id: target.member.userId,
    ...overrides,
  });
}

describe('task-today-mark', () => {
  test('印を付けると today_on にワークスペースのタイムゾーンの今日が入り、履歴に前と後を残す', async () => {
    const target = await createTarget();
    const task = await mine(target);
    const res = await mark(target, task.id, true);
    expect(res.status).toBe(200);
    const body = (await res.json()) as MarkBody;
    expect(body.task_id).toBe(task.id);
    expect(body.today_on).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const row = (await rowOf(target, task.id))!;
    expect(row.today_on).toBe(body.today_on);
    expect(row.updated_at).not.toBe(task.updated_at);
    const logs = await logsOf(target, task.id);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ action: 'update', actor_user_id: target.member.userId, entity_type: 'task' });
    expect(JSON.parse(logs[0]!.changes_json)).toEqual({ today_on: [null, body.today_on] });
  });

  test('印の日付は、ワークスペースのタイムゾーンの今日（東京は 11-01、ロサンゼルスはまだ 10-31）', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-01T03:00:00.000Z'));
    const target = await createTarget();
    const tokyo = await mine(target);
    const losAngeles = await createWorkspace(target.organization, target.admin.userId!, {
      timezone: 'America/Los_Angeles',
    });
    await createMembership(target.organization, losAngeles.id, target.member.userId!, { role: 'member' });
    const west = await createTask(target.organization, losAngeles.id, target.admin.userId!, {
      assignee_user_id: target.member.userId,
    });

    const tokyoRes = await mark(target, tokyo.id, true);
    expect(await tokyoRes.json()).toEqual({ task_id: tokyo.id, today_on: '2026-11-01' });
    const westRes = await mark(target, west.id, true, target.member, losAngeles.id);
    expect(await westRes.json()).toEqual({ task_id: west.id, today_on: '2026-10-31' });
  });

  test('印を外すと today_on が null になり、履歴に前の日付を残す', async () => {
    const target = await createTarget();
    const task = await mine(target, { today_on: '2026-10-25' });
    const res = await mark(target, task.id, false);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ task_id: task.id, today_on: null });
    expect((await rowOf(target, task.id))!.today_on).toBeNull();
    const logs = await logsOf(target, task.id);
    expect(logs).toHaveLength(1);
    expect(JSON.parse(logs[0]!.changes_json)).toEqual({ today_on: ['2026-10-25', null] });
  });

  test('すでにその状態なら何も書かず、履歴も残さず、今の値を返す。付いている印（持ち越し）は付け直しても日付を変えない', async () => {
    const target = await createTarget();
    const unmarked = await mine(target);
    const carried = await mine(target, { today_on: '2026-10-25' });

    const off = await mark(target, unmarked.id, false);
    expect(off.status).toBe(200);
    expect(await off.json()).toEqual({ task_id: unmarked.id, today_on: null });
    const on = await mark(target, carried.id, true);
    expect(on.status).toBe(200);
    expect(await on.json()).toEqual({ task_id: carried.id, today_on: '2026-10-25' });

    expect(await rowOf(target, unmarked.id)).toEqual(unmarked);
    expect(await rowOf(target, carried.id)).toEqual(carried);
    expect(await logsOf(target, unmarked.id)).toEqual([]);
    expect(await logsOf(target, carried.id)).toEqual([]);
  });

  test('付けて外して付け直せる。履歴は変わった回数だけ残る', async () => {
    const target = await createTarget();
    const task = await mine(target);
    for (const marked of [true, false, true]) expect((await mark(target, task.id, marked)).status).toBe(200);
    const logs = await logsOf(target, task.id);
    expect(
      logs.map((log) => (JSON.parse(log.changes_json) as { today_on: unknown[] }).today_on.map((v) => v !== null)),
    ).toEqual([
      [false, true],
      [true, false],
      [false, true],
    ]);
  });

  test('担当者本人でないタスク（ほかの人の担当、担当なし）は 409 の conflict、reason は not_assignee で、何も書かない', async () => {
    const target = await createTarget();
    const others = await createTask(target.organization, target.workspace.id, target.admin.userId!, {
      assignee_user_id: target.leader.userId,
      today_on: '2026-10-25',
    });
    const unassigned = await createTask(target.organization, target.workspace.id, target.admin.userId!);
    for (const task of [others, unassigned]) {
      for (const marked of [true, false]) {
        const res = await mark(target, task.id, marked);
        expect(res.status).toBe(409);
        expect(await errorCodeOf(res.clone())).toBe('conflict');
        expect(await reasonOf(res)).toBe('not_assignee');
      }
      expect(await rowOf(target, task.id)).toEqual(task);
      expect(await logsOf(target, task.id)).toEqual([]);
    }
  });

  test('完了したタスクは 409 の conflict、reason は completed で、付け外しとも何も書かない', async () => {
    const target = await createTarget();
    const task = await mine(target, { points: 2, today_on: '2026-10-25' });
    const completed = await post(app, taskComplete, {
      slug: target.slug,
      token: target.member.token,
      body: { workspace_id: target.workspace.id, task_id: task.id },
    });
    expect(completed.status).toBe(200);
    const before = await rowOf(target, task.id);
    const logsBefore = await logsOf(target, task.id);
    for (const marked of [true, false]) {
      const res = await mark(target, task.id, marked);
      expect(res.status).toBe(409);
      expect(await errorCodeOf(res.clone())).toBe('conflict');
      expect(await reasonOf(res)).toBe('completed');
    }
    expect(await rowOf(target, task.id)).toEqual(before);
    expect(await logsOf(target, task.id)).toEqual(logsBefore);
  });

  test('別の組織・別のワークスペース・削除済み・存在しないタスクは 404 で、何も書かない', async () => {
    const target = await createTarget();
    const foreign = await createTarget();
    const foreignTask = await createTask(foreign.organization, foreign.workspace.id, foreign.admin.userId!, {
      assignee_user_id: target.member.userId,
    });
    const elsewhere = await createTask(target.organization, target.otherWorkspace.id, target.admin.userId!, {
      assignee_user_id: target.member.userId,
    });
    const deleted = await mine(target, { deleted_at: '2026-10-21T00:00:00.000Z' });
    for (const id of [foreignTask.id, elsewhere.id, deleted.id, '019a0000-0000-7000-8000-00000000ffff']) {
      for (const marked of [true, false]) {
        const res = await mark(target, id, marked);
        expect(res.status, id).toBe(404);
        expect(await errorCodeOf(res)).toBe('not_found');
      }
    }
    expect((await rowOf(foreign, foreignTask.id))!.today_on).toBeNull();
    expect((await rowOf(target, elsewhere.id))!.today_on).toBeNull();
    expect(await logsOf(foreign, foreignTask.id)).toEqual([]);
  });

  test('所属しないワークスペース（別の組織のワークスペースの ID を含む）を指すと 404', async () => {
    const target = await createTarget();
    const foreign = await createTarget();
    const task = await mine(target);
    const elsewhere = await createTask(target.organization, target.otherWorkspace.id, target.admin.userId!, {
      assignee_user_id: target.bystander.userId,
    });
    // メンバーが所属しない、同じ組織のワークスペース。登録の関数が、操作の処理の前に 403 で断る
    const notMember = await mark(target, elsewhere.id, true, target.member, target.otherWorkspace.id);
    expect(notMember.status).toBe(403);
    expect(await errorCodeOf(notMember)).toBe('forbidden');
    // 別の組織のワークスペースの ID
    const foreignWorkspace = await mark(target, task.id, true, target.member, foreign.workspace.id);
    expect(foreignWorkspace.status).toBe(404);
    // ワークスペースに所属しない人が、そのワークスペースのタスクを指す（403）
    const outsider = await mark(target, task.id, true, target.bystander);
    expect(outsider.status).toBe(403);
    expect((await rowOf(target, task.id))!.today_on).toBeNull();
    expect((await rowOf(target, elsewhere.id))!.today_on).toBeNull();
  });

  test('閉じたワークスペースは 409 の workspace_closed で、すでにその状態でも何も書かない', async () => {
    const target = await createTarget({ closed: true });
    const unmarked = await mine(target);
    const marked = await mine(target, { today_on: '2026-10-25' });
    for (const [task, value] of [
      [unmarked, true],
      [unmarked, false],
      [marked, true],
      [marked, false],
    ] as const) {
      const res = await mark(target, task.id, value);
      expect(res.status).toBe(409);
      expect(await errorCodeOf(res)).toBe('workspace_closed');
    }
    expect(await rowOf(target, unmarked.id)).toEqual(unmarked);
    expect(await rowOf(target, marked.id)).toEqual(marked);
    expect(await logsOf(target, unmarked.id)).toEqual([]);
    expect(await logsOf(target, marked.id)).toEqual([]);
  });

  test('同時に同じ操作を送っても、印は 1 つで、履歴も 1 つ', async () => {
    const target = await createTarget();
    const task = await mine(target);
    const results = await Promise.all([
      mark(target, task.id, true),
      mark(target, task.id, true),
      mark(target, task.id, true),
    ]);
    const bodies: MarkBody[] = [];
    for (const res of results) {
      expect(res.status).toBe(200);
      bodies.push((await res.json()) as MarkBody);
    }
    const marked = (await rowOf(target, task.id))!.today_on;
    expect(marked).not.toBeNull();
    expect(bodies.map((body) => body.today_on)).toEqual([marked, marked, marked]);
    const logs = await logsOf(target, task.id);
    expect(logs).toHaveLength(1);
    expect(JSON.parse(logs[0]!.changes_json)).toEqual({ today_on: [null, marked] });

    const offs = await Promise.all([mark(target, task.id, false), mark(target, task.id, false)]);
    expect(offs.map((res) => res.status)).toEqual([200, 200]);
    expect((await rowOf(target, task.id))!.today_on).toBeNull();
    expect(await logsOf(target, task.id)).toHaveLength(2);
  });

  describe('読んでから書くまでの競合', () => {
    // 処理を直に呼び、タスクの状態を返した読み取りの直後に race を呼ぶ（n は何回目の読み取りか）
    async function runWithRace(
      target: Target,
      input: { task_id: string; marked: boolean },
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
            if (result !== undefined && 'today_on' in (result as object)) await race(++reads);
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
      return taskTodayMarkOperation.handler(context);
    }

    async function setRow(target: Target, taskId: string, values: Record<string, unknown>) {
      const db = orgDb(env, target.organization.verified);
      await db.run(
        db.statement((q) =>
          q
            .updateTable('tasks')
            .set(values as never)
            .where('id', '=', taskId)
            .where('workspace_id', '=', target.workspace.id),
        ),
      );
    }

    test('読んだ後に別の画面が先に同じ印を付けたら、読み直して何も書かず、履歴は 1 つ', async () => {
      const target = await createTarget();
      const task = await mine(target);
      const result = await runWithRace(target, { task_id: task.id, marked: true }, async (n) => {
        if (n === 1) expect((await mark(target, task.id, true)).status).toBe(200);
      });
      const marked = (await rowOf(target, task.id))!.today_on;
      expect(result).toEqual({ task_id: task.id, today_on: marked });
      expect(await logsOf(target, task.id)).toHaveLength(1);
    });

    test('読んだ後に別の画面が印の日付を替えたら、読み直して、正しい「前」で履歴に残す', async () => {
      const target = await createTarget();
      const task = await mine(target, { today_on: '2026-10-25' });
      const result = await runWithRace(target, { task_id: task.id, marked: false }, async (n) => {
        if (n === 1) await setRow(target, task.id, { today_on: '2026-10-26' });
      });
      expect(result).toEqual({ task_id: task.id, today_on: null });
      const logs = await logsOf(target, task.id);
      expect(logs).toHaveLength(1);
      expect(JSON.parse(logs[0]!.changes_json)).toEqual({ today_on: ['2026-10-26', null] });
    });

    test('読み直しのたびに負け続けたら、3 回で 409 の conflict にして、何も書かない', async () => {
      const target = await createTarget();
      const task = await mine(target, { today_on: '2026-10-25' });
      await expect(
        runWithRace(target, { task_id: task.id, marked: false }, async (n) => {
          await setRow(target, task.id, { today_on: `2026-10-${25 + n}` });
        }),
      ).rejects.toMatchObject({ status: 409, code: 'conflict' });
      expect((await rowOf(target, task.id))!.today_on).toBe('2026-10-28');
      expect(await logsOf(target, task.id)).toEqual([]);
    });

    test('読んだ後に完了にされたら、409 の conflict（completed）で何も書かない', async () => {
      const target = await createTarget();
      const task = await mine(target, { points: 2 });
      await expect(
        runWithRace(target, { task_id: task.id, marked: true }, async (n) => {
          if (n !== 1) return;
          const res = await post(app, taskComplete, {
            slug: target.slug,
            token: target.member.token,
            body: { workspace_id: target.workspace.id, task_id: task.id },
          });
          expect(res.status).toBe(200);
        }),
      ).rejects.toMatchObject({ status: 409, code: 'conflict', details: { reason: 'completed' } });
      expect((await rowOf(target, task.id))!.today_on).toBeNull();
      expect((await logsOf(target, task.id)).filter((log) => log.action === 'update')).toEqual([]);
    });

    test('読んだ後に担当を替えられたら、409 の conflict（not_assignee）で何も書かない', async () => {
      const target = await createTarget();
      const task = await mine(target);
      await expect(
        runWithRace(target, { task_id: task.id, marked: true }, async (n) => {
          if (n === 1) await setRow(target, task.id, { assignee_user_id: target.leader.userId });
        }),
      ).rejects.toMatchObject({ status: 409, code: 'conflict', details: { reason: 'not_assignee' } });
      expect((await rowOf(target, task.id))!.today_on).toBeNull();
      expect(await logsOf(target, task.id)).toEqual([]);
    });

    test('読んだ後にワークスペースが閉じたら、409 の workspace_closed で何も書かない', async () => {
      const target = await createTarget();
      const task = await mine(target);
      await expect(
        runWithRace(target, { task_id: task.id, marked: true }, async (n) => {
          if (n !== 1) return;
          const db = orgDb(env, target.organization.verified);
          await db.run(
            db.statement((q) =>
              q
                .updateTable('workspaces')
                .set({ closed_at: '2026-10-24T00:00:00.000Z' })
                .where('id', '=', target.workspace.id)
                .where('organization_id', '=', target.organization.id),
            ),
          );
        }),
      ).rejects.toMatchObject({ status: 409, code: 'workspace_closed' });
      expect((await rowOf(target, task.id))!.today_on).toBeNull();
      expect(await logsOf(target, task.id)).toEqual([]);
    });
  });
});
