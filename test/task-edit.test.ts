// タスクの詳細の読み取り、変更、削除の振る舞い。
// 組織の分離と権限の種類ごとの許可と拒否は、一覧を回す test/operation-registry.test.ts が確かめる
import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import { backlogTree, taskComplete, taskDelete, taskDetail, taskUpdate } from '../src/shared/operations/task/index.ts';
import { createApp } from '../src/server/app.ts';
import { orgDb, verifyWorkspace } from '../src/server/db/index.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import { taskUpdateOperation } from '../src/server/operations/task-edit.ts';
import { createStory, createTask } from './factories.ts';
import { errorCodeOf, post } from './operations/harness.ts';
import { createPerson, createTarget, type Person, type Target } from './operations/world.ts';

const app = createApp(implementedOperations);

type Detail = {
  id: string;
  title: string;
  body_md: string | null;
  points: number | null;
  due_on: string | null;
  link_url: string | null;
  is_imported: boolean;
  completed_at: string | null;
  can_delete: boolean;
};

function detail(target: Target, taskId: string, person: Person = target.member) {
  return post(app, taskDetail, {
    slug: target.slug,
    token: person.token,
    body: { workspace_id: target.workspace.id, task_id: taskId },
  });
}

function update(target: Target, taskId: string, body: Record<string, unknown>, person: Person = target.member) {
  return post(app, taskUpdate, {
    slug: target.slug,
    token: person.token,
    body: { workspace_id: target.workspace.id, task_id: taskId, ...body },
  });
}

function remove(target: Target, taskId: string, person: Person = target.member) {
  return post(app, taskDelete, {
    slug: target.slug,
    token: person.token,
    body: { workspace_id: target.workspace.id, task_id: taskId },
  });
}

function actorOf(person: Person) {
  return { accountId: person.accountId, userId: person.userId, isAdmin: false, invitedOnly: false };
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
        .orderBy('created_at'),
    ),
  );
}

// 一般のメンバーが作って完了にしたタスク（完了の記録と経験値は、task-complete が書く。経験値はワークスペースに所属する人にだけ付く）
async function completedTask(target: Target, overrides: Parameters<typeof createTask>[3] = {}) {
  const task = await createTask(target.organization, target.workspace.id, target.member.userId!, {
    points: 3,
    ...overrides,
  });
  const res = await post(app, taskComplete, {
    slug: target.slug,
    token: target.member.token,
    body: { workspace_id: target.workspace.id, task_id: task.id },
  });
  expect(res.status).toBe(200);
  return task;
}

describe('task-detail', () => {
  test('引き出しが出す欄を返す。削除できるのは、作った人とリーダー、管理者', async () => {
    const target = await createTarget();
    const task = await createTask(target.organization, target.workspace.id, target.member.userId!, {
      title: '見積もりを送る',
      body_md: '## 手順\n- 送る',
      points: 5,
      due_on: '2026-10-30',
      link_url: 'https://example.com/spec',
    });
    const asCreator = (await (await detail(target, task.id, target.member)).json()) as { task: Detail };
    expect(asCreator.task).toEqual({
      id: task.id,
      title: '見積もりを送る',
      body_md: '## 手順\n- 送る',
      points: 5,
      due_on: '2026-10-30',
      link_url: 'https://example.com/spec',
      is_imported: false,
      completed_at: null,
      can_delete: true,
    });
    for (const person of [target.leader, target.admin]) {
      expect(((await (await detail(target, task.id, person)).json()) as { task: Detail }).task.can_delete).toBe(true);
    }
    const other = await createPerson({
      organization: target.organization,
      membership: { workspaceId: target.workspace.id, role: 'member' },
    });
    expect(((await (await detail(target, task.id, other)).json()) as { task: Detail }).task.can_delete).toBe(false);
  });

  test('別の組織・別のワークスペース・削除済み・存在しないタスクは 404', async () => {
    const target = await createTarget();
    const foreign = await createTarget();
    const adminId = target.admin.userId!;
    const foreignTask = await createTask(foreign.organization, foreign.workspace.id, foreign.admin.userId!);
    const elsewhere = await createTask(target.organization, target.otherWorkspace.id, adminId);
    const deleted = await createTask(target.organization, target.workspace.id, adminId, {
      deleted_at: '2026-10-21T00:00:00.000Z',
    });
    for (const id of [foreignTask.id, elsewhere.id, deleted.id, '019a0000-0000-7000-8000-00000000ffff']) {
      const res = await detail(target, id);
      expect(res.status, id).toBe(404);
      expect(await errorCodeOf(res)).toBe('not_found');
    }
  });

  test('閉じたワークスペースでも読める', async () => {
    const target = await createTarget({ closed: true });
    const task = await createTask(target.organization, target.workspace.id, target.admin.userId!);
    expect((await detail(target, task.id, target.admin)).status).toBe(200);
  });
});

describe('task-update', () => {
  async function seeded(target: Target, overrides: Parameters<typeof createTask>[3] = {}) {
    return createTask(target.organization, target.workspace.id, target.admin.userId!, {
      title: '元のタイトル',
      body_md: '元の本文',
      points: 2,
      due_on: '2026-10-28',
      ...overrides,
    });
  }

  test('5つの欄を直し、変わった列だけを前と後で履歴に残す', async () => {
    const target = await createTarget();
    const task = await seeded(target);
    const res = await update(target, task.id, {
      title: '  新しいタイトル  ',
      points: 8,
      due_on: null,
      link_url: ' HTTPS://Example.com/spec ',
      body_md: '\n新しい本文\n',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { task: Detail };
    expect(body.task).toMatchObject({
      id: task.id,
      title: '新しいタイトル',
      points: 8,
      due_on: null,
      link_url: 'https://example.com/spec',
      body_md: '新しい本文',
    });
    expect(await rowOf(target, task.id)).toMatchObject({
      title: '新しいタイトル',
      points: 8,
      due_on: null,
      link_url: 'https://example.com/spec',
      body_md: '新しい本文',
    });
    const logs = await logsOf(target, task.id);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ action: 'update', actor_user_id: target.member.userId });
    expect(JSON.parse(logs[0]!.changes_json)).toEqual({
      title: ['元のタイトル', '新しいタイトル'],
      points: [2, 8],
      due_on: ['2026-10-28', null],
      link_url: [null, 'https://example.com/spec'],
      body_md: ['元の本文', '新しい本文'],
    });
  });

  test('送った欄のうち今の値と違うものだけを書き、送らない欄と同じ値の欄は触らない', async () => {
    const target = await createTarget();
    const task = await seeded(target);
    const res = await update(target, task.id, { title: '元のタイトル', points: 13 });
    expect(res.status).toBe(200);
    const after = (await rowOf(target, task.id))!;
    expect(after).toMatchObject({ title: '元のタイトル', points: 13, due_on: '2026-10-28', body_md: '元の本文' });
    const logs = await logsOf(target, task.id);
    expect(JSON.parse(logs[0]!.changes_json)).toEqual({ points: [2, 13] });
  });

  test('ポイントは未設定に戻せる', async () => {
    const target = await createTarget();
    const task = await seeded(target);
    expect((await update(target, task.id, { points: null })).status).toBe(200);
    expect((await rowOf(target, task.id))!.points).toBeNull();
    expect(JSON.parse((await logsOf(target, task.id))[0]!.changes_json)).toEqual({ points: [2, null] });
  });

  test('変わる欄が無い要求は何も書かず、履歴も残さない', async () => {
    const target = await createTarget();
    const task = await seeded(target);
    const res = await update(target, task.id, { title: '元のタイトル', points: 2, body_md: '元の本文' });
    expect(res.status).toBe(200);
    expect(await rowOf(target, task.id)).toEqual(task);
    expect(await logsOf(target, task.id)).toEqual([]);
    const empty = await update(target, task.id, {});
    expect(empty.status).toBe(200);
    expect(await logsOf(target, task.id)).toEqual([]);
  });

  describe('完了したタスクのポイント', () => {
    test('直す要求は 409 の conflict で、何も書かない。経験値の元の値と履歴は動かない', async () => {
      const target = await createTarget();
      const task = await completedTask(target);
      const before = await rowOf(target, task.id);
      const logsBefore = await logsOf(target, task.id);
      const res = await update(target, task.id, { points: 13 });
      expect(res.status).toBe(409);
      expect(await errorCodeOf(res)).toBe('conflict');
      expect(await rowOf(target, task.id)).toEqual(before);
      expect(await logsOf(target, task.id)).toEqual(logsBefore);
      // ポイントと一緒に送った別の欄も書かない（要求ごと断る）
      const mixed = await update(target, task.id, { points: 13, title: '書き換える' });
      expect(mixed.status).toBe(409);
      expect((await rowOf(target, task.id))!.title).toBe(task.title);
    });

    test('同じ値のポイントを送るだけなら断らない', async () => {
      const target = await createTarget();
      const task = await completedTask(target);
      expect((await update(target, task.id, { points: 3 })).status).toBe(200);
    });

    test('ほかの属性は完了の後も直せる', async () => {
      const target = await createTarget();
      const task = await completedTask(target);
      const res = await update(target, task.id, { title: '直した', due_on: '2026-11-01', body_md: '後から書いた' });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { task: Detail };
      expect(body.task).toMatchObject({ title: '直した', points: 3, due_on: '2026-11-01' });
      expect(body.task.completed_at).not.toBeNull();
    });

    test('読んだ後に完了にされたら、ポイントを書く文の条件で止まり、409 の conflict', async () => {
      const target = await createTarget();
      const task = await seeded(target);
      const db = orgDb(env, target.organization.verified);
      const actor = actorOf(target.member);
      const workspace = await verifyWorkspace(db, actor, target.workspace.id);
      let reads = 0;
      const racing = new Proxy(db, {
        get(base, key) {
          const value = Reflect.get(base, key, base);
          if (typeof value !== 'function') return value;
          if (key !== 'first') return value.bind(base);
          return async (...args: unknown[]) => {
            const result = await (value as (...a: unknown[]) => Promise<unknown>).apply(base, args);
            // タスクを読んだ直後に、別の要求が完了にする
            if ((result as { title?: string } | undefined)?.title !== undefined && ++reads === 1) {
              const res = await post(app, taskComplete, {
                slug: target.slug,
                token: target.leader.token,
                body: { workspace_id: target.workspace.id, task_id: task.id },
              });
              expect(res.status).toBe(200);
            }
            return result;
          };
        },
      });
      const context = {
        db: racing,
        actor,
        workspace,
        input: { workspace_id: target.workspace.id, task_id: task.id, points: 13 },
        defer: () => {},
      } as never;
      await expect(taskUpdateOperation.handler(context)).rejects.toMatchObject({ status: 409, code: 'conflict' });
      expect((await rowOf(target, task.id))!.points).toBe(2);
      expect((await logsOf(target, task.id)).filter((log) => log.action === 'update')).toEqual([]);
    });
  });

  describe('取り込んだタスク', () => {
    test('リンクを直す要求は 409 の conflict で、何も書かない', async () => {
      const target = await createTarget();
      const task = await seeded(target, { is_imported: 1, created_by: null });
      const res = await update(target, task.id, { link_url: 'https://example.com/x' });
      expect(res.status).toBe(409);
      expect(await errorCodeOf(res)).toBe('conflict');
      expect(await rowOf(target, task.id)).toEqual(task);
      expect(await logsOf(target, task.id)).toEqual([]);
    });

    test('タイトルを直す要求も 409。ポイント、期日、本文は直せる', async () => {
      const target = await createTarget();
      const task = await seeded(target, { is_imported: 1, created_by: null });
      expect((await update(target, task.id, { title: '書き換える' })).status).toBe(409);
      expect((await rowOf(target, task.id))!.title).toBe('元のタイトル');
      const ok = await update(target, task.id, { points: 5, due_on: '2026-11-02', body_md: 'メモ' });
      expect(ok.status).toBe(200);
      expect(((await ok.json()) as { task: Detail }).task.is_imported).toBe(true);
    });
  });

  test('同時に別の欄を直しても、両方が残る', async () => {
    const target = await createTarget();
    const task = await seeded(target);
    const results = await Promise.all([
      update(target, task.id, { title: 'Aのタイトル' }, target.member),
      update(target, task.id, { due_on: '2026-12-01' }, target.leader),
    ]);
    expect(results.map((res) => res.status)).toEqual([200, 200]);
    expect(await rowOf(target, task.id)).toMatchObject({ title: 'Aのタイトル', due_on: '2026-12-01' });
    expect(await logsOf(target, task.id)).toHaveLength(2);
  });

  test('別の組織・別のワークスペース・削除済み・存在しないタスクは 404 で、何も書かない', async () => {
    const target = await createTarget();
    const foreign = await createTarget();
    const adminId = target.admin.userId!;
    const foreignTask = await createTask(foreign.organization, foreign.workspace.id, foreign.admin.userId!);
    const elsewhere = await createTask(target.organization, target.otherWorkspace.id, adminId);
    const deleted = await createTask(target.organization, target.workspace.id, adminId, {
      deleted_at: '2026-10-21T00:00:00.000Z',
    });
    for (const id of [foreignTask.id, elsewhere.id, deleted.id, '019a0000-0000-7000-8000-00000000ffff']) {
      const res = await update(target, id, { title: '書き換える' });
      expect(res.status, id).toBe(404);
      expect(await errorCodeOf(res)).toBe('not_found');
    }
    expect((await rowOf(foreign, foreignTask.id))!.title).toBe(foreignTask.title);
    expect((await rowOf({ ...target, workspace: target.otherWorkspace }, elsewhere.id))!.title).toBe(elsewhere.title);
  });

  test.each([
    ['タイトルが空', { title: ' ' }],
    ['タイトルが null', { title: null }],
    ['ポイントが表に無い値', { points: 4 }],
    ['期日が暦に無い', { due_on: '2026-13-01' }],
    ['リンクが ftp', { link_url: 'ftp://example.com' }],
    ['本文が1万字を超える', { body_md: 'あ'.repeat(10_001) }],
  ])('%s は 400', async (_name, body) => {
    const target = await createTarget();
    const task = await seeded(target);
    const res = await update(target, task.id, body);
    expect(res.status).toBe(400);
    expect(await errorCodeOf(res)).toBe('invalid_input');
    expect(await rowOf(target, task.id)).toEqual(task);
  });

  test('閉じたワークスペースでは 409 の workspace_closed で、何も書かない', async () => {
    const target = await createTarget({ closed: true });
    const task = await seeded(target);
    const res = await update(target, task.id, { title: '書き換える' }, target.admin);
    expect(res.status).toBe(409);
    expect(await errorCodeOf(res)).toBe('workspace_closed');
    expect(await rowOf(target, task.id)).toEqual(task);
    expect(await logsOf(target, task.id)).toEqual([]);
  });
});

describe('task-delete', () => {
  test('作った人は削除できる。論理削除で、削除の履歴を残し、木と詳細から消える', async () => {
    const target = await createTarget();
    const task = await createTask(target.organization, target.workspace.id, target.member.userId!);
    const res = await remove(target, task.id, target.member);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ task_id: task.id });
    const row = (await rowOf(target, task.id))!;
    expect(row.deleted_at).not.toBeNull();
    expect(row.updated_at).toBe(row.deleted_at);
    const logs = await logsOf(target, task.id);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ action: 'delete', actor_user_id: target.member.userId });
    expect(JSON.parse(logs[0]!.changes_json)).toEqual({ deleted_at: [null, row.deleted_at] });

    expect((await detail(target, task.id)).status).toBe(404);
    const tree = (await (
      await post(app, backlogTree, {
        slug: target.slug,
        token: target.member.token,
        body: { workspace_id: target.workspace.id },
      })
    ).json()) as { tasks: { id: string }[] };
    expect(tree.tasks.map((entry) => entry.id)).not.toContain(task.id);
  });

  test('リーダーと管理者は、人が作ったタスクも削除できる', async () => {
    const target = await createTarget();
    for (const person of [target.leader, target.admin]) {
      const task = await createTask(target.organization, target.workspace.id, target.member.userId!);
      expect((await remove(target, task.id, person)).status).toBe(200);
      expect((await rowOf(target, task.id))!.deleted_at).not.toBeNull();
    }
  });

  test('作った人でもリーダーでもない人は 403 の forbidden で、何も書かない', async () => {
    const target = await createTarget();
    const task = await createTask(target.organization, target.workspace.id, target.leader.userId!);
    const res = await remove(target, task.id, target.member);
    expect(res.status).toBe(403);
    expect(await errorCodeOf(res)).toBe('forbidden');
    expect((await rowOf(target, task.id))!.deleted_at).toBeNull();
    expect(await logsOf(target, task.id)).toEqual([]);
  });

  test('存在しないタスクは、権限より先に 404。別の組織のタスクと削除済みも 404', async () => {
    const target = await createTarget();
    const foreign = await createTarget();
    const foreignTask = await createTask(foreign.organization, foreign.workspace.id, foreign.admin.userId!);
    const gone = await createTask(target.organization, target.workspace.id, target.member.userId!, {
      deleted_at: '2026-10-21T00:00:00.000Z',
    });
    for (const id of [foreignTask.id, gone.id]) {
      const res = await remove(target, id, target.member);
      expect(res.status, id).toBe(404);
      expect(await errorCodeOf(res)).toBe('not_found');
    }
    expect((await rowOf(foreign, foreignTask.id))!.deleted_at).toBeNull();
    // 削除済みを続けて削除しても、履歴は増えない
    expect(await logsOf(target, gone.id)).toEqual([]);
  });

  test('経験値の付いたタスクも論理削除で、完了の記録と経験値は残る。ストーリーの合計からは外れる', async () => {
    const target = await createTarget();
    const story = await createStory(target.organization, target.workspace.id, target.admin.userId!);
    const task = await completedTask(target, { story_id: story.id });
    const db = orgDb(env, target.organization.verified);
    const countOf = async (table: 'completions' | 'xp_grants') =>
      (
        await db.rows(
          db.statement((q) =>
            q
              .selectFrom(table)
              .select('id')
              .where('task_id', '=', task.id)
              .where('workspace_id', '=', target.workspace.id),
          ),
        )
      ).length;
    const completions = await countOf('completions');
    const grants = await countOf('xp_grants');
    expect(completions).toBe(1);
    expect(grants).toBe(2);

    expect((await remove(target, task.id, target.admin)).status).toBe(200);
    expect(await countOf('completions')).toBe(completions);
    expect(await countOf('xp_grants')).toBe(grants);
    const tree = (await (
      await post(app, backlogTree, {
        slug: target.slug,
        token: target.admin.token,
        body: { workspace_id: target.workspace.id },
      })
    ).json()) as { stories: { id: string; points_all: number; completed_task_count: number }[] };
    expect(tree.stories.find((entry) => entry.id === story.id)).toMatchObject({
      points_all: 0,
      completed_task_count: 0,
    });
  });

  test('閉じたワークスペースでは 409 の workspace_closed で、何も書かない', async () => {
    const target = await createTarget({ closed: true });
    const task = await createTask(target.organization, target.workspace.id, target.admin.userId!);
    const res = await remove(target, task.id, target.admin);
    expect(res.status).toBe(409);
    expect(await errorCodeOf(res)).toBe('workspace_closed');
    expect((await rowOf(target, task.id))!.deleted_at).toBeNull();
    expect(await logsOf(target, task.id)).toEqual([]);
  });
});
