// タスクの作成、バックログの木、完了の振る舞い。
// 組織の分離と権限の種類ごとの許可と拒否は、一覧を回す test/operation-registry.test.ts が確かめる
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, test } from 'vitest';
import { setFixedNow } from '../src/shared/clock.ts';
import { XP_TASK_COMPLETED, XP_TASK_CREATED } from '../src/shared/experience.ts';
import { backlogTree, taskComplete, taskCreate } from '../src/shared/operations/task/index.ts';
import { createApp } from '../src/server/app.ts';
import { orgDb, verifyWorkspace } from '../src/server/db/index.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import { taskCompleteOperation, taskCreateOperation } from '../src/server/operations/task.ts';
import { createCategory, createMembership, createStory, createTask, createWorkspace, uuidv7 } from './factories.ts';
import { errorCodeOf, post } from './operations/harness.ts';
import { createPerson, createTarget, testEnv, type Person, type Target } from './operations/world.ts';

const app = createApp(implementedOperations);

afterEach(() => {
  setFixedNow(undefined);
});

// 開発用の時計（DEV_NOW）が使える、ループバックの公開 URL の環境
function devEnv(devNow: string): Env {
  return Object.assign({}, testEnv, { PUBLIC_ORIGIN: 'http://localhost:8787', DEV_NOW: devNow });
}

const DEV_NOW = '2026-10-26T10:00:00+09:00';
const DEV_NOW_ISO = '2026-10-26T01:00:00.000Z';

function complete(target: Target, person: Person, taskId: string, options: { env?: Env; workspaceId?: string } = {}) {
  return post(app, taskComplete, {
    slug: target.slug,
    token: person.token,
    body: { workspace_id: options.workspaceId ?? target.workspace.id, task_id: taskId },
    ...(options.env === undefined ? {} : { env: options.env }),
  });
}

// 完了の文が書く4表の、このタスクの行
async function recordsOf(target: Target, taskId: string) {
  const db = orgDb(env, target.organization.verified);
  const workspaceId = target.workspace.id;
  const [tasks, completions, grants, logs] = await db.batch([
    db.statement((q) =>
      q.selectFrom('tasks').selectAll().where('id', '=', taskId).where('workspace_id', '=', workspaceId),
    ),
    db.statement((q) =>
      q.selectFrom('completions').selectAll().where('task_id', '=', taskId).where('workspace_id', '=', workspaceId),
    ),
    db.statement((q) =>
      q
        .selectFrom('xp_grants')
        .selectAll()
        .where('task_id', '=', taskId)
        .where('workspace_id', '=', workspaceId)
        .orderBy('amount'),
    ),
    db.statement((q) =>
      q
        .selectFrom('change_logs')
        .selectAll()
        .where('entity_id', '=', taskId)
        .where('organization_id', '=', target.organization.id),
    ),
  ] as const);
  return { task: tasks.rows[0], completions: completions.rows, grants: grants.rows, logs: logs.rows };
}

describe('task-create', () => {
  test('バックログの末尾に、手で作ったタスクとして書き、変更の履歴を残す', async () => {
    const target = await createTarget();
    const first = await post(app, taskCreate, {
      slug: target.slug,
      token: target.member.token,
      body: { workspace_id: target.workspace.id, title: '  見積もりを送る  ', points: 3 },
    });
    expect(first.status).toBe(200);
    const { task } = (await first.json()) as { task: { id: string; title: string; points: number | null } };
    expect(task).toMatchObject({ title: '見積もりを送る', points: 3, assignee: null });

    const second = await post(app, taskCreate, {
      slug: target.slug,
      token: target.member.token,
      body: { workspace_id: target.workspace.id, title: '請求書を出す' },
    });
    const secondTask = ((await second.json()) as { task: { id: string; points: number | null } }).task;
    // ポイントを省くと未見積もり
    expect(secondTask.points).toBeNull();

    const one = await recordsOf(target, task.id);
    expect(one.task).toMatchObject({
      workspace_id: target.workspace.id,
      is_imported: 0,
      tray: 'backlog',
      story_id: null,
      title: '見積もりを送る',
      points: 3,
      assignee_user_id: null,
      created_by: target.member.userId,
      completed_at: null,
      deleted_at: null,
    });
    const two = await recordsOf(target, secondTask.id);
    expect(two.task!.position > one.task!.position).toBe(true);
    // 起票では経験値も完了の記録も書かない
    expect(one.completions).toEqual([]);
    expect(one.grants).toEqual([]);
    expect(one.logs).toHaveLength(1);
    expect(one.logs[0]).toMatchObject({
      workspace_id: target.workspace.id,
      actor_user_id: target.member.userId,
      entity_type: 'task',
      action: 'create',
    });
  });

  test('担当は、そのワークスペースに今所属している人だけ。ほかの人は 404 で、何も書かない', async () => {
    const target = await createTarget();
    const others = [
      // 同じ組織で、別のワークスペースだけに所属する人
      target.bystander.userId!,
      // 存在しない ID
      '019a0000-0000-7000-8000-00000000ffff',
    ];
    // 所属を外れた人
    const left = await createPerson({ organization: target.organization });
    await createMembership(target.organization, target.workspace.id, left.userId!, {
      left_at: '2026-10-21T00:00:00.000Z',
      left_on: '2026-10-21',
    });
    // ほかの組織の人
    const foreign = await createTarget();
    for (const assignee of [...others, left.userId!, foreign.member.userId!]) {
      const res = await post(app, taskCreate, {
        slug: target.slug,
        token: target.member.token,
        body: { workspace_id: target.workspace.id, title: 'x', assignee_user_id: assignee },
      });
      expect(res.status).toBe(404);
      expect(await errorCodeOf(res)).toBe('not_found');
    }
    const list = await post(app, backlogTree, {
      slug: target.slug,
      token: target.member.token,
      body: { workspace_id: target.workspace.id },
    });
    expect(((await list.json()) as { tasks: unknown[] }).tasks).toEqual([]);

    const ok = await post(app, taskCreate, {
      slug: target.slug,
      token: target.member.token,
      body: { workspace_id: target.workspace.id, title: 'x', assignee_user_id: target.leader.userId },
    });
    expect(ok.status).toBe(200);
    const { task } = (await ok.json()) as { task: { id: string; assignee: { id: string } | null } };
    expect(task.assignee?.id).toBe(target.leader.userId);
    expect((await recordsOf(target, task.id)).task!.assignee_user_id).toBe(target.leader.userId);
  });

  test('所属は残っていても、無効にした人は担当に指せない。404 で、何も書かない', async () => {
    const target = await createTarget();
    const disabled = await createPerson({
      organization: target.organization,
      disabled: true,
      membership: { workspaceId: target.workspace.id, role: 'member' },
    });
    const res = await post(app, taskCreate, {
      slug: target.slug,
      token: target.member.token,
      body: { workspace_id: target.workspace.id, title: 'x', assignee_user_id: disabled.userId },
    });
    expect(res.status).toBe(404);
    expect(await errorCodeOf(res)).toBe('not_found');

    const db = orgDb(env, target.organization.verified);
    const tasks = await db.rows(
      db.statement((q) => q.selectFrom('tasks').select('id').where('workspace_id', '=', target.workspace.id)),
    );
    const logs = await db.rows(
      db.statement((q) =>
        q
          .selectFrom('change_logs')
          .select('id')
          .where('organization_id', '=', target.organization.id)
          .where('workspace_id', '=', target.workspace.id),
      ),
    );
    expect(tasks).toEqual([]);
    expect(logs).toEqual([]);
  });

  test.each([
    ['タイトルが空', { title: '   ' }],
    ['タイトルが201字', { title: 'あ'.repeat(201) }],
    ['タイトルに制御文字', { title: 'a\nb' }],
    ['ポイントが4', { title: 'x', points: 4 }],
    ['ポイントが文字列', { title: 'x', points: '3' }],
    ['ポイントが-1', { title: 'x', points: -1 }],
  ])('%s は 400', async (_name, body) => {
    const target = await createTarget();
    const res = await post(app, taskCreate, {
      slug: target.slug,
      token: target.member.token,
      body: { workspace_id: target.workspace.id, ...body },
    });
    expect(res.status).toBe(400);
    expect(await errorCodeOf(res)).toBe('invalid_input');
  });

  test('ポイントは未設定、0、1、2、3、5、8、13 を受け付ける。200字のタイトルも通る', async () => {
    const target = await createTarget();
    for (const points of [null, 0, 1, 2, 3, 5, 8, 13]) {
      const res = await post(app, taskCreate, {
        slug: target.slug,
        token: target.member.token,
        body: { workspace_id: target.workspace.id, title: 'あ'.repeat(200), points },
      });
      expect(res.status, String(points)).toBe(200);
    }
  });
});

describe('task-create の親のストーリー', () => {
  function create(target: Target, body: Record<string, unknown>, person: Person = target.member) {
    return post(app, taskCreate, {
      slug: target.slug,
      token: person.token,
      body: { workspace_id: target.workspace.id, title: '見積もりを送る', ...body },
    });
  }

  async function tasksUnder(target: Target, storyId: string | null) {
    const db = orgDb(env, target.organization.verified);
    return db.rows(
      db.statement((q) =>
        q
          .selectFrom('tasks')
          .select(['id', 'story_id', 'position'])
          .where('workspace_id', '=', target.workspace.id)
          .where('story_id', storyId === null ? 'is' : '=', storyId)
          .orderBy('position'),
      ),
    );
  }

  test('ストーリーの下に、配下の末尾の position で作り、履歴に親を残す。親のないタスクの並びには入らない', async () => {
    const target = await createTarget();
    const story = await createStory(target.organization, target.workspace.id, target.admin.userId!, { title: '親' });
    const other = await createStory(target.organization, target.workspace.id, target.admin.userId!, { title: '別' });
    await createTask(target.organization, target.workspace.id, target.admin.userId!, {
      story_id: other.id,
      position: 'a5',
    });
    const first = await create(target, { story_id: story.id });
    const second = await create(target, { story_id: story.id, title: '請求書を出す' });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const firstId = ((await first.json()) as { task: { id: string } }).task.id;
    const secondId = ((await second.json()) as { task: { id: string } }).task.id;

    // 別のストーリーの position の影響を受けず、親ごとに a0 から並ぶ
    const under = await tasksUnder(target, story.id);
    expect(under.map((row) => row.id)).toEqual([firstId, secondId]);
    expect(under[0]!.position).toBe('a0');
    expect(under[1]!.position > under[0]!.position).toBe(true);
    expect(await tasksUnder(target, null)).toEqual([]);

    const logs = (await recordsOf(target, firstId)).logs;
    expect(JSON.parse(logs[0]!.changes_json)).toMatchObject({ story: [null, { id: story.id, title: '親' }] });
  });

  test('ストーリーを指さなければ、今までどおり親のないタスクの末尾', async () => {
    const target = await createTarget();
    const story = await createStory(target.organization, target.workspace.id, target.admin.userId!);
    await createTask(target.organization, target.workspace.id, target.admin.userId!, {
      story_id: story.id,
      position: 'a9',
    });
    const res = await create(target, {});
    const id = ((await res.json()) as { task: { id: string } }).task.id;
    expect((await tasksUnder(target, null)).map((row) => row.id)).toEqual([id]);
    expect((await recordsOf(target, id)).task!.position).toBe('a0');
  });

  test('別の組織・別のワークスペース・削除済み・存在しないストーリーは 404 で、何も書かない', async () => {
    const target = await createTarget();
    const foreign = await createTarget();
    const adminId = target.admin.userId!;
    const ids = [
      (await createStory(foreign.organization, foreign.workspace.id, foreign.admin.userId!)).id,
      (await createStory(target.organization, target.otherWorkspace.id, adminId)).id,
      (
        await createStory(target.organization, target.workspace.id, adminId, {
          deleted_at: '2026-10-21T00:00:00.000Z',
        })
      ).id,
      '019a0000-0000-7000-8000-00000000ffff',
    ];
    for (const id of ids) {
      const res = await create(target, { story_id: id });
      expect(res.status, id).toBe(404);
      expect(await errorCodeOf(res)).toBe('not_found');
    }
    const db = orgDb(env, target.organization.verified);
    expect(
      await db.rows(
        db.statement((q) => q.selectFrom('tasks').select('id').where('workspace_id', '=', target.workspace.id)),
      ),
    ).toEqual([]);
  });

  test('完了したストーリーは 409 の conflict で、何も書かない', async () => {
    const target = await createTarget();
    const done = await createStory(target.organization, target.workspace.id, target.admin.userId!, {
      completed_at: '2026-10-21T00:00:00.000Z',
      completed_by: target.admin.userId,
    });
    const res = await create(target, { story_id: done.id });
    expect(res.status).toBe(409);
    expect(await errorCodeOf(res)).toBe('conflict');
    expect(await tasksUnder(target, done.id)).toEqual([]);
  });

  test('読んだ後に親が完了したか削除されたら、書く文の条件で止まり 409 か 404 になる', async () => {
    for (const [change, status] of [
      [{ completed_at: '2026-10-22T00:00:00.000Z' }, 409],
      [{ deleted_at: '2026-10-22T00:00:00.000Z' }, 404],
    ] as const) {
      const target = await createTarget();
      const story = await createStory(target.organization, target.workspace.id, target.admin.userId!);
      const db = orgDb(env, target.organization.verified);
      const actor = {
        accountId: target.member.accountId,
        userId: target.member.userId,
        isAdmin: false,
        invitedOnly: false,
      };
      const verified = await verifyWorkspace(db, actor, target.workspace.id);
      // 親を読んだ後に、別の要求が親を変えた状況を作る。親の読み取りだけを先に通すため、変更は読み取りの後に起きるよう
      // 操作の db を差し替えて、最初の stories の読み取りの直後に書く
      let injected = false;
      const spied = new Proxy(db, {
        get(base, key) {
          // 入口は #private を持つので、メソッドは本物の入口に結んで返す
          const value = Reflect.get(base, key, base);
          if (typeof value !== 'function') return value;
          if (key !== 'first') return value.bind(base);
          return async (...args: unknown[]) => {
            const result = await (value as (...a: unknown[]) => Promise<unknown>).apply(base, args);
            if (!injected && (result as { title?: string } | undefined)?.title !== undefined) {
              injected = true;
              await base.run(
                base.statement((q) =>
                  q
                    .updateTable('stories')
                    .set(change)
                    .where('id', '=', story.id)
                    .where('workspace_id', '=', target.workspace.id),
                ),
              );
            }
            return result;
          };
        },
      });
      const context = {
        db: spied,
        actor,
        workspace: verified,
        input: {
          workspace_id: target.workspace.id,
          title: 'x',
          points: null,
          assignee_user_id: null,
          story_id: story.id,
        },
        defer: () => {},
      } as never;
      await expect(taskCreateOperation.handler(context)).rejects.toMatchObject({ status });
      expect(await tasksUnder(target, story.id)).toEqual([]);
    }
  });

  test('閉じたワークスペースでは 409 の workspace_closed', async () => {
    const target = await createTarget({ closed: true });
    const story = await createStory(target.organization, target.workspace.id, target.admin.userId!);
    const res = await create(target, { story_id: story.id }, target.admin);
    expect(res.status).toBe(409);
    expect(await errorCodeOf(res)).toBe('workspace_closed');
  });
});

describe('backlog-tree', () => {
  function tree(target: Target, person: Person = target.member) {
    return post(app, backlogTree, {
      slug: target.slug,
      token: person.token,
      body: { workspace_id: target.workspace.id },
    });
  }

  type TreeBody = {
    today: string;
    week_start: number;
    stories: {
      id: string;
      title: string;
      acceptance_criteria_md: string | null;
      body_md: string | null;
      due_on: string | null;
      link_url: string | null;
      tasks: { id: string; points: number | null; due_on: string | null; assignee: { id: string } | null }[];
      completed_task_count: number;
      points_done: number;
      points_all: number;
    }[];
    tasks: { id: string }[];
    completed_count: number;
  };

  test('親のないストーリーを position の順に、配下の未完了のタスクと、完了の件数とポイントの合計つきで返す', async () => {
    const target = await createTarget();
    const adminId = target.admin.userId!;
    const workspaceId = target.workspace.id;
    const { organization } = target;
    const second = await createStory(organization, workspaceId, adminId, { title: '二番目', position: 'a1' });
    const first = await createStory(organization, workspaceId, adminId, {
      title: '一番目',
      position: 'a0',
      acceptance_criteria_md: '- 条件',
      body_md: '本文',
      due_on: '2026-10-30',
      link_url: 'https://example.com/a',
    });
    const b = await createTask(organization, workspaceId, adminId, {
      story_id: first.id,
      position: 'a1',
      points: 3,
      due_on: '2026-10-28',
      assignee_user_id: target.leader.userId,
    });
    const a = await createTask(organization, workspaceId, adminId, { story_id: first.id, position: 'a0', points: 2 });
    // 完了は件数とポイントに入り、行は返さない。未見積もりは 0
    for (const points of [5, null]) {
      await createTask(organization, workspaceId, adminId, {
        story_id: first.id,
        points,
        completed_at: '2026-10-21T00:00:00.000Z',
        completed_by: adminId,
      });
    }
    // 削除したタスクは数えない
    await createTask(organization, workspaceId, adminId, {
      story_id: first.id,
      points: 13,
      deleted_at: '2026-10-21T00:00:00.000Z',
    });
    await createTask(organization, workspaceId, adminId, {
      story_id: first.id,
      points: 8,
      completed_at: '2026-10-21T00:00:00.000Z',
      completed_by: adminId,
      deleted_at: '2026-10-21T00:00:00.000Z',
    });
    // 削除したストーリー、別のワークスペースのストーリーは返さない
    await createStory(organization, workspaceId, adminId, { deleted_at: '2026-10-21T00:00:00.000Z' });
    const elsewhere = await createStory(organization, target.otherWorkspace.id, adminId);
    await createTask(organization, target.otherWorkspace.id, adminId, { story_id: elsewhere.id, points: 8 });

    const res = await tree(target);
    expect(res.status).toBe(200);
    const body = (await res.json()) as TreeBody;
    expect(body.stories.map((story) => story.id)).toEqual([first.id, second.id]);
    expect(body.stories[0]).toMatchObject({
      title: '一番目',
      acceptance_criteria_md: '- 条件',
      body_md: '本文',
      due_on: '2026-10-30',
      link_url: 'https://example.com/a',
      completed_task_count: 2,
      points_done: 5,
      points_all: 10,
    });
    expect(body.stories[0]!.tasks.map((task) => task.id)).toEqual([a.id, b.id]);
    expect(body.stories[0]!.tasks[1]).toMatchObject({ points: 3, due_on: '2026-10-28' });
    expect(body.stories[0]!.tasks[1]).toHaveProperty('assignee.id', target.leader.userId);
    // 配下の無いストーリーは 0
    expect(body.stories[1]).toMatchObject({ tasks: [], completed_task_count: 0, points_done: 0, points_all: 0 });
    // ストーリーの下のタスクは、親のないタスクの段にも件数にも入らない
    expect(body.tasks).toEqual([]);
    expect(body.completed_count).toBe(0);
  });

  test('今日の日付はワークスペースのタイムゾーンで、週の始まりと一緒に返す', async () => {
    const target = await createTarget();
    const sunday = await createWorkspace(target.organization, target.admin.userId!, {
      timezone: 'Pacific/Auckland',
      week_start: 0,
    });
    await createMembership(target.organization, sunday.id, target.member.userId!);
    // UTC では 10-25 の 20:00。ニュージーランドでは 10-26 の翌朝 09:00
    const env2 = devEnv('2026-10-26T09:00:00+13:00');
    const res = await post(app, backlogTree, {
      slug: target.slug,
      token: target.member.token,
      body: { workspace_id: sunday.id },
      env: env2,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as TreeBody;
    expect(body.today).toBe('2026-10-26');
    expect(body.week_start).toBe(0);

    const tokyo = await tree(target);
    expect(((await tokyo.json()) as TreeBody).week_start).toBe(1);
  });

  test('未完了で親のないバックログのタスクを position の順に返し、完了したものは件数だけ返す', async () => {
    const target = await createTarget();
    const adminId = target.admin.userId!;
    const workspaceId = target.workspace.id;
    const { organization } = target;
    const c = await createTask(organization, workspaceId, adminId, { title: 'c', position: 'a2' });
    const a = await createTask(organization, workspaceId, adminId, {
      title: 'a',
      position: 'a0',
      points: 5,
      assignee_user_id: target.leader.userId,
    });
    const b = await createTask(organization, workspaceId, adminId, { title: 'b', position: 'a1', points: 0 });
    // 数えるのは完了した親なしのタスクだけ
    await createTask(organization, workspaceId, adminId, {
      title: 'done',
      position: 'a3',
      completed_at: '2026-10-21T00:00:00.000Z',
      completed_by: adminId,
    });
    // 削除、ほかのワークスペース、受信箱のタスクは含めない
    await createTask(organization, workspaceId, adminId, { title: 'deleted', deleted_at: '2026-10-21T00:00:00.000Z' });
    await createTask(organization, workspaceId, adminId, {
      title: 'deleted-done',
      completed_at: '2026-10-21T00:00:00.000Z',
      completed_by: adminId,
      deleted_at: '2026-10-21T00:00:00.000Z',
    });
    await createTask(organization, target.otherWorkspace.id, adminId, { title: 'other' });
    await createTask(organization, workspaceId, adminId, {
      title: 'inbox',
      is_imported: 1,
      tray: 'inbox',
      created_by: null,
    });

    // ストーリーの下のタスクは、親のないタスクの段にも件数にも入らない
    const story = await createStory(organization, workspaceId, adminId);
    await createTask(organization, workspaceId, adminId, { title: 'under', story_id: story.id });
    await createTask(organization, workspaceId, adminId, {
      title: 'under-done',
      story_id: story.id,
      completed_at: '2026-10-21T00:00:00.000Z',
      completed_by: adminId,
    });

    const res = await tree(target);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tasks: { id: string; title: string }[]; completed_count: number };
    expect(body.tasks.map((task) => task.id)).toEqual([a.id, b.id, c.id]);
    expect(body.tasks[0]).toMatchObject({ title: 'a', points: 5 });
    expect(body.tasks[0]).toHaveProperty('assignee.id', target.leader.userId);
    expect(body.tasks[1]).toMatchObject({ points: 0, assignee: null });
    expect(body.completed_count).toBe(1);
  });
});

describe('task-complete', () => {
  test('tasks、completions、xp_grants、change_logs を書く。ポイント3なら起票 10 と完了 30 の2行', async () => {
    const target = await createTarget();
    const task = await createTask(target.organization, target.workspace.id, target.leader.userId!, { points: 3 });

    const res = await complete(target, target.member, task.id);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { task_id: string; completed_at: string };
    expect(body.task_id).toBe(task.id);

    const records = await recordsOf(target, task.id);
    expect(records.task).toMatchObject({ completed_at: body.completed_at, completed_by: target.member.userId });
    expect(records.task!.updated_at).toBe(body.completed_at);
    expect(records.completions).toHaveLength(1);
    const completion = records.completions[0]!;
    expect(completion).toMatchObject({
      workspace_id: target.workspace.id,
      task_id: task.id,
      completed_at: body.completed_at,
      completed_by: target.member.userId,
      points: 3,
      assignee_user_id: null,
      sprint_id: null,
      category_id: null,
      billing_month: null,
    });
    // 起票は作った人（リーダー）へ、完了は担当がいないので完了にした人へ
    expect(records.grants).toHaveLength(2);
    expect(records.grants[0]).toMatchObject({
      action: 'task_created',
      user_id: target.leader.userId,
      amount: XP_TASK_CREATED,
      completion_id: completion.id,
      dedupe_key: `task_created:${completion.id}`,
      confirmed_at: body.completed_at,
    });
    expect(records.grants[1]).toMatchObject({
      action: 'task_completed',
      user_id: target.member.userId,
      amount: XP_TASK_COMPLETED,
      completion_id: completion.id,
      dedupe_key: `task_completed:${completion.id}`,
    });
    expect([XP_TASK_CREATED, XP_TASK_COMPLETED]).toEqual([10, 30]);
    expect(records.logs).toHaveLength(1);
    expect(records.logs[0]).toMatchObject({
      workspace_id: target.workspace.id,
      actor_user_id: target.member.userId,
      entity_type: 'task',
      action: 'complete',
      created_at: body.completed_at,
    });
    expect(JSON.parse(records.logs[0]!.changes_json)).toEqual({
      completed_at: [null, body.completed_at],
      completed_by: [null, { id: target.member.userId, name: '星野 澪' }],
    });
  });

  test.each([
    ['ポイントが未設定', null],
    ['ポイントが0', 0],
  ])('%s のタスクの完了では、xp_grants は0行で、完了の記録と履歴は書く', async (_name, points) => {
    const target = await createTarget();
    const task = await createTask(target.organization, target.workspace.id, target.admin.userId!, { points });
    expect((await complete(target, target.member, task.id)).status).toBe(200);

    const records = await recordsOf(target, task.id);
    expect(records.grants).toEqual([]);
    expect(records.completions).toHaveLength(1);
    expect(records.completions[0]!.points).toBe(points);
    expect(records.logs).toHaveLength(1);
  });

  test('担当のいるタスクの完了の経験値は担当者へ、起票の経験値は作った人へ付く', async () => {
    const target = await createTarget();
    // 作った人（メンバー）、担当（リーダー）、完了にした人（所属していない管理者）が全員違う
    const task = await createTask(target.organization, target.workspace.id, target.member.userId!, {
      points: 1,
      assignee_user_id: target.leader.userId,
    });
    expect((await complete(target, target.admin, task.id)).status).toBe(200);

    const records = await recordsOf(target, task.id);
    expect(records.completions[0]).toMatchObject({
      completed_by: target.admin.userId,
      assignee_user_id: target.leader.userId,
    });
    expect(records.grants.map((grant) => [grant.action, grant.user_id])).toEqual([
      ['task_created', target.member.userId],
      ['task_completed', target.leader.userId],
    ]);
  });

  describe('所属していない人には経験値を付けない', () => {
    test('担当のいないタスクを、所属していない管理者が完了にすると、完了の経験値は誰にも付かない', async () => {
      const target = await createTarget();
      const task = await createTask(target.organization, target.workspace.id, target.leader.userId!, { points: 3 });
      expect((await complete(target, target.admin, task.id)).status).toBe(200);

      const records = await recordsOf(target, task.id);
      // 完了の記録は書く。起票の経験値は作った人（所属している）へ付く
      expect(records.completions).toHaveLength(1);
      expect(records.grants.map((grant) => [grant.action, grant.user_id])).toEqual([
        ['task_created', target.leader.userId],
      ]);
    });

    test('所属していない管理者が作ったタスクには、起票の経験値が付かない', async () => {
      const target = await createTarget();
      const task = await createTask(target.organization, target.workspace.id, target.admin.userId!, { points: 3 });
      expect((await complete(target, target.member, task.id)).status).toBe(200);

      const records = await recordsOf(target, task.id);
      expect(records.grants.map((grant) => [grant.action, grant.user_id])).toEqual([
        ['task_completed', target.member.userId],
      ]);
    });

    test('担当が所属を外れていると、完了の経験値は誰にも付かない', async () => {
      const target = await createTarget();
      const left = await createPerson({ organization: target.organization });
      await createMembership(target.organization, target.workspace.id, left.userId!, {
        left_at: '2026-10-21T00:00:00.000Z',
        left_on: '2026-10-21',
      });
      const task = await createTask(target.organization, target.workspace.id, target.leader.userId!, {
        points: 3,
        assignee_user_id: left.userId,
      });
      expect((await complete(target, target.member, task.id)).status).toBe(200);

      const records = await recordsOf(target, task.id);
      expect(records.grants.map((grant) => [grant.action, grant.user_id])).toEqual([
        ['task_created', target.leader.userId],
      ]);
    });
  });

  test('作った人のいない（取り込んだ）タスクには、起票の経験値を付けない', async () => {
    const target = await createTarget();
    const task = await createTask(target.organization, target.workspace.id, target.admin.userId!, {
      points: 2,
      is_imported: 1,
      created_by: null,
    });
    expect((await complete(target, target.member, task.id)).status).toBe(200);

    const records = await recordsOf(target, task.id);
    expect(records.grants.map((grant) => [grant.action, grant.user_id, grant.amount])).toEqual([
      ['task_completed', target.member.userId, XP_TASK_COMPLETED],
    ]);
  });

  test('すでに完了のタスクは 409 の conflict で、何も増えない', async () => {
    const target = await createTarget();
    const task = await createTask(target.organization, target.workspace.id, target.admin.userId!, { points: 3 });
    expect((await complete(target, target.member, task.id)).status).toBe(200);
    const before = await recordsOf(target, task.id);

    const again = await complete(target, target.leader, task.id);
    expect(again.status).toBe(409);
    expect(await errorCodeOf(again)).toBe('conflict');

    const after = await recordsOf(target, task.id);
    expect(after.task).toEqual(before.task);
    expect(after.completions).toEqual(before.completions);
    expect(after.grants).toEqual(before.grants);
    expect(after.logs).toEqual(before.logs);
  });

  test('2つの要求が同時に同じタスクを完了にすると、遅れた方が 409 で、completions と xp_grants は1組だけ', async () => {
    const target = await createTarget();
    const task = await createTask(target.organization, target.workspace.id, target.leader.userId!, { points: 3 });

    const results = await Promise.all([
      complete(target, target.member, task.id),
      complete(target, target.leader, task.id),
    ]);
    expect(results.map((res) => res.status).sort()).toEqual([200, 409]);
    const loser = results.find((res) => res.status === 409)!;
    expect(await errorCodeOf(loser)).toBe('conflict');

    const records = await recordsOf(target, task.id);
    expect(records.completions).toHaveLength(1);
    expect(records.grants.map((grant) => grant.action)).toEqual(['task_created', 'task_completed']);
    expect(records.logs).toHaveLength(1);
    // 勝った方の人に付く
    const winner = results[0]!.status === 200 ? target.member : target.leader;
    expect(records.task!.completed_by).toBe(winner.userId);
    expect(records.completions[0]!.completed_by).toBe(winner.userId);
    expect(records.grants[1]!.user_id).toBe(winner.userId);
  });

  test('同じ人が同じ開発用の日時で2回完了にしても、2回目は 409 で、記録は1組だけ', async () => {
    const target = await createTarget();
    const frozen = devEnv(DEV_NOW);
    const task = await createTask(target.organization, target.workspace.id, target.leader.userId!, { points: 3 });

    const first = await complete(target, target.member, task.id, { env: frozen });
    expect(first.status).toBe(200);
    // 時計が止まっているので、2回目の完了日時と完了にした人は1回目と同じ
    const second = await complete(target, target.member, task.id, { env: frozen });
    expect(second.status).toBe(409);
    expect(await errorCodeOf(second)).toBe('conflict');

    // 2つの要求を同時に送っても同じ
    const other = await createTask(target.organization, target.workspace.id, target.leader.userId!, { points: 3 });
    const both = await Promise.all([
      complete(target, target.member, other.id, { env: frozen }),
      complete(target, target.member, other.id, { env: frozen }),
    ]);
    expect(both.map((res) => res.status).sort()).toEqual([200, 409]);

    for (const id of [task.id, other.id]) {
      const records = await recordsOf(target, id);
      expect(records.completions).toHaveLength(1);
      expect(records.grants).toHaveLength(2);
      expect(records.logs).toHaveLength(1);
      expect(records.task!.completed_at).toBe(DEV_NOW_ISO);
    }
  });

  test('開発用の日時（DEV_NOW）を置くと、完了日時がその値で書かれる', async () => {
    const target = await createTarget();
    const task = await createTask(target.organization, target.workspace.id, target.leader.userId!, { points: 1 });

    const res = await complete(target, target.member, task.id, { env: devEnv(DEV_NOW) });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { completed_at: string }).completed_at).toBe(DEV_NOW_ISO);

    const records = await recordsOf(target, task.id);
    expect(records.task!.completed_at).toBe(DEV_NOW_ISO);
    expect(records.completions[0]!.completed_at).toBe(DEV_NOW_ISO);
    expect(records.grants.map((grant) => grant.confirmed_at)).toEqual([DEV_NOW_ISO, DEV_NOW_ISO]);
    expect(records.logs[0]!.created_at).toBe(DEV_NOW_ISO);
  });

  describe('計上月', () => {
    // 東京の 2026-11-01 05:00。UTC では 10 月のまま
    const NEAR_MONTH_END = '2026-11-01T05:00:00+09:00';

    test('月ごとに計上する区分のタスクでは、完了した月（ワークスペースのタイムゾーン）が入る', async () => {
      const target = await createTarget();
      const category = await createCategory(target.organization, target.workspace.id, { is_billed_monthly: 1 });
      const task = await createTask(target.organization, target.workspace.id, target.admin.userId!, {
        category_id: category.id,
      });

      expect((await complete(target, target.member, task.id, { env: devEnv(NEAR_MONTH_END) })).status).toBe(200);
      const completion = (await recordsOf(target, task.id)).completions[0]!;
      expect(completion.billing_month).toBe('2026-11');
      expect(completion.category_id).toBe(category.id);
    });

    test('ワークスペースのタイムゾーンで月が決まる', async () => {
      const target = await createTarget();
      const utc = await createWorkspace(target.organization, target.admin.userId!, { timezone: 'UTC' });
      await createMembership(target.organization, utc.id, target.member.userId!);
      const category = await createCategory(target.organization, utc.id, { is_billed_monthly: 1 });
      const task = await createTask(target.organization, utc.id, target.admin.userId!, { category_id: category.id });

      const res = await complete({ ...target, workspace: utc }, target.member, task.id, {
        env: devEnv(NEAR_MONTH_END),
      });
      expect(res.status).toBe(200);
      expect((await recordsOf({ ...target, workspace: utc }, task.id)).completions[0]!.billing_month).toBe('2026-10');
    });

    test('区分の無いタスクと、月ごとに計上しない区分のタスクでは空', async () => {
      const target = await createTarget();
      const plain = await createCategory(target.organization, target.workspace.id, { is_billed_monthly: 0 });
      const withCategory = await createTask(target.organization, target.workspace.id, target.admin.userId!, {
        category_id: plain.id,
      });
      const withoutCategory = await createTask(target.organization, target.workspace.id, target.admin.userId!);

      for (const task of [withCategory, withoutCategory]) {
        expect((await complete(target, target.member, task.id, { env: devEnv(NEAR_MONTH_END) })).status).toBe(200);
        expect((await recordsOf(target, task.id)).completions[0]!.billing_month).toBeNull();
      }
      expect((await recordsOf(target, withCategory.id)).completions[0]!.category_id).toBe(plain.id);
    });

    test('別のワークスペースの区分は結ばれていても使わない', async () => {
      const target = await createTarget();
      const foreign = await createCategory(target.organization, target.otherWorkspace.id, { is_billed_monthly: 1 });
      const task = await createTask(target.organization, target.workspace.id, target.admin.userId!, {
        category_id: foreign.id,
      });
      expect((await complete(target, target.member, task.id)).status).toBe(200);
      expect((await recordsOf(target, task.id)).completions[0]!.billing_month).toBeNull();
    });
  });

  describe('無いタスク', () => {
    test('別の組織のタスクの ID は 404 で、そのタスクには何も書かない', async () => {
      const target = await createTarget();
      const foreign = await createTarget();
      const task = await createTask(foreign.organization, foreign.workspace.id, foreign.admin.userId!, { points: 3 });

      const res = await complete(target, target.member, task.id);
      expect(res.status).toBe(404);
      expect(await errorCodeOf(res)).toBe('not_found');

      const records = await recordsOf(foreign, task.id);
      expect(records.task!.completed_at).toBeNull();
      expect(records.completions).toEqual([]);
      expect(records.grants).toEqual([]);
      expect(records.logs).toEqual([]);
    });

    test('同じ組織の別のワークスペースのタスク、論理削除したタスク、存在しない ID は 404', async () => {
      const target = await createTarget();
      const adminId = target.admin.userId!;
      const elsewhere = await createTask(target.organization, target.otherWorkspace.id, adminId, { points: 3 });
      const deleted = await createTask(target.organization, target.workspace.id, adminId, {
        points: 3,
        deleted_at: '2026-10-21T00:00:00.000Z',
      });
      for (const id of [elsewhere.id, deleted.id, '019a0000-0000-7000-8000-00000000ffff']) {
        const res = await complete(target, target.member, id);
        expect(res.status, id).toBe(404);
        expect(await errorCodeOf(res)).toBe('not_found');
      }
      expect(
        (await recordsOf({ ...target, workspace: target.otherWorkspace }, elsewhere.id)).task!.completed_at,
      ).toBeNull();
      expect((await recordsOf(target, deleted.id)).completions).toEqual([]);
    });

    test('受信箱のタスクは、この版の完了の対象外で、404 になり何も書かれない', async () => {
      const target = await createTarget();
      const inbox = await createTask(target.organization, target.workspace.id, target.admin.userId!, {
        points: 3,
        is_imported: 1,
        tray: 'inbox',
        created_by: null,
      });
      const res = await complete(target, target.member, inbox.id);
      expect(res.status).toBe(404);
      expect(await errorCodeOf(res)).toBe('not_found');

      const records = await recordsOf(target, inbox.id);
      expect(records.task!.completed_at).toBeNull();
      expect(records.task!.completed_by).toBeNull();
      expect(records.completions).toEqual([]);
      expect(records.grants).toEqual([]);
      expect(records.logs).toEqual([]);
    });
  });

  describe('ストーリーの下のタスク', () => {
    test('完了にでき、完了の記録と経験値を書く。もう一度は 409 の conflict', async () => {
      const target = await createTarget();
      const adminId = target.admin.userId!;
      const story = await createStory(target.organization, target.workspace.id, adminId);
      const task = await createTask(target.organization, target.workspace.id, target.leader.userId!, {
        points: 3,
        story_id: story.id,
      });
      expect((await complete(target, target.member, task.id)).status).toBe(200);

      const records = await recordsOf(target, task.id);
      expect(records.task!.completed_by).toBe(target.member.userId);
      expect(records.completions).toHaveLength(1);
      expect(records.completions[0]).toMatchObject({ points: 3, category_id: null, billing_month: null });
      expect(records.grants).toHaveLength(2);
      expect(records.logs).toHaveLength(1);

      const again = await complete(target, target.leader, task.id);
      expect(again.status).toBe(409);
      expect(await errorCodeOf(again)).toBe('conflict');
      // 完了の合計は、読み直すと変わる
      const tree = await post(app, backlogTree, {
        slug: target.slug,
        token: target.member.token,
        body: { workspace_id: target.workspace.id },
      });
      const body = (await tree.json()) as {
        stories: { tasks: unknown[]; completed_task_count: number; points_done: number; points_all: number }[];
      };
      expect(body.stories[0]).toMatchObject({ tasks: [], completed_task_count: 1, points_done: 3, points_all: 3 });
    });

    describe('区分の引き継ぎ（エピック、ストーリー、タスクの順に最初に入っているもの）', () => {
      // 月ごとに計上する区分は、完了した月が billing_month に入る。区分を見分けるため、名前の違う区分を3つ作る
      async function setup(
        target: Target,
        categories: { epic?: boolean; story?: boolean; task?: boolean },
        options: { epicWorkspaceId?: string } = {},
      ) {
        const { organization } = target;
        const workspaceId = target.workspace.id;
        const adminId = target.admin.userId!;
        const epicCategory = await createCategory(organization, workspaceId, {
          name: 'エピックの区分',
          is_billed_monthly: 1,
        });
        const storyCategory = await createCategory(organization, workspaceId, { name: 'ストーリーの区分' });
        const taskCategory = await createCategory(organization, workspaceId, { name: 'タスクの区分' });
        const db = orgDb(env, organization.verified);
        const epicId = uuidv7();
        await db.run(
          db.statement((q) =>
            q.insertInto('epics').values({
              id: epicId,
              workspace_id: options.epicWorkspaceId ?? workspaceId,
              title: '会員ポイント制度を公開する',
              body_md: null,
              category_id: categories.epic ? epicCategory.id : null,
              due_on: null,
              link_url: null,
              reward_tier: 'small',
              requester_user_id: adminId,
              created_by: adminId,
              completed_at: null,
              completed_by: null,
              canceled_at: null,
              canceled_by: null,
              position: 'a0',
              deleted_at: null,
              created_at: '2026-10-20T00:00:00.000Z',
              updated_at: '2026-10-20T00:00:00.000Z',
            }),
          ),
        );
        const story = await createStory(organization, workspaceId, adminId, {
          epic_id: epicId,
          category_id: categories.story ? storyCategory.id : null,
        });
        const task = await createTask(organization, workspaceId, adminId, {
          story_id: story.id,
          category_id: categories.task ? taskCategory.id : null,
        });
        return { epicCategory, storyCategory, taskCategory, task };
      }

      test.each([
        ['3つ入っていればエピックの区分', { epic: true, story: true, task: true }, 'epicCategory'],
        ['エピックが空ならストーリーの区分', { story: true, task: true }, 'storyCategory'],
        ['ストーリーも空ならタスクの区分', { task: true }, 'taskCategory'],
      ] as const)('%s', async (_name, categories, expected) => {
        const target = await createTarget();
        const made = await setup(target, categories);
        expect((await complete(target, target.member, made.task.id, { env: devEnv(DEV_NOW) })).status).toBe(200);
        const completion = (await recordsOf(target, made.task.id)).completions[0]!;
        expect(completion.category_id).toBe(made[expected].id);
        // 月ごとに計上するのはエピックの区分だけ。引き継いだ区分で判定する
        expect(completion.billing_month).toBe(expected === 'epicCategory' ? '2026-10' : null);
      });

      test('どこにも区分が無ければ空', async () => {
        const target = await createTarget();
        const made = await setup(target, {});
        expect((await complete(target, target.member, made.task.id)).status).toBe(200);
        expect((await recordsOf(target, made.task.id)).completions[0]).toMatchObject({
          category_id: null,
          billing_month: null,
        });
      });

      test('別のワークスペースのエピックは結ばれていても、区分を引き継がない', async () => {
        const target = await createTarget();
        const made = await setup(target, { epic: true, task: true }, { epicWorkspaceId: target.otherWorkspace.id });
        expect((await complete(target, target.member, made.task.id)).status).toBe(200);
        expect((await recordsOf(target, made.task.id)).completions[0]!.category_id).toBe(made.taskCategory.id);
      });
    });

    test('別の組織のストーリーの下のタスクは 404', async () => {
      const target = await createTarget();
      const foreign = await createTarget();
      const story = await createStory(foreign.organization, foreign.workspace.id, foreign.admin.userId!);
      const task = await createTask(foreign.organization, foreign.workspace.id, foreign.admin.userId!, {
        story_id: story.id,
      });
      const res = await complete(target, target.member, task.id);
      expect(res.status).toBe(404);
      expect((await recordsOf(foreign, task.id)).task!.completed_at).toBeNull();
    });
  });

  test('閉じたワークスペースでは 409 の workspace_closed で、何も書かない', async () => {
    const target = await createTarget({ closed: true });
    const task = await createTask(target.organization, target.workspace.id, target.admin.userId!, { points: 3 });
    const res = await complete(target, target.admin, task.id);
    expect(res.status).toBe(409);
    expect(await errorCodeOf(res)).toBe('workspace_closed');
    expect((await recordsOf(target, task.id)).completions).toEqual([]);

    const created = await post(app, taskCreate, {
      slug: target.slug,
      token: target.admin.token,
      body: { workspace_id: target.workspace.id, title: 'x' },
    });
    expect(created.status).toBe(409);
    expect(await errorCodeOf(created)).toBe('workspace_closed');
    // 読み取りは通る
    const list = await post(app, backlogTree, {
      slug: target.slug,
      token: target.admin.token,
      body: { workspace_id: target.workspace.id },
    });
    expect(list.status).toBe(200);
  });

  describe('読んでから書くまでにワークスペースが閉じたとき', () => {
    // 登録の関数が閉じていないと見た後に閉じた状況を、確かめたワークスペースを持ったまま閉じて作る
    async function staleContext<Input>(target: Target, person: Person, input: Input) {
      const db = orgDb(env, target.organization.verified);
      const actor = { accountId: person.accountId, userId: person.userId, isAdmin: false, invitedOnly: false };
      const workspace = await verifyWorkspace(db, actor, target.workspace.id);
      expect(workspace?.closed).toBe(false);
      await db.run(
        db.statement((q) =>
          q
            .updateTable('workspaces')
            .set({ closed_at: '2026-10-22T00:00:00.000Z' })
            .where('id', '=', target.workspace.id)
            .where('organization_id', '=', target.organization.id),
        ),
      );
      return { db, actor, workspace, input, defer: () => {} } as never;
    }

    test('task-complete は何も書かず、409 の workspace_closed になる', async () => {
      const target = await createTarget();
      const task = await createTask(target.organization, target.workspace.id, target.leader.userId!, { points: 3 });
      const context = await staleContext(target, target.member, {
        workspace_id: target.workspace.id,
        task_id: task.id,
      });

      await expect(taskCompleteOperation.handler(context)).rejects.toMatchObject({
        status: 409,
        code: 'workspace_closed',
      });
      const records = await recordsOf(target, task.id);
      expect(records.task!.completed_at).toBeNull();
      expect(records.completions).toEqual([]);
      expect(records.grants).toEqual([]);
      expect(records.logs).toEqual([]);
    });

    test('task-create は何も書かず、409 の workspace_closed になる', async () => {
      const target = await createTarget();
      const context = await staleContext(target, target.member, {
        workspace_id: target.workspace.id,
        title: '見積もりを送る',
        points: 3,
        assignee_user_id: null,
        story_id: null,
      });

      await expect(taskCreateOperation.handler(context)).rejects.toMatchObject({
        status: 409,
        code: 'workspace_closed',
      });
      const db = orgDb(env, target.organization.verified);
      const tasks = await db.rows(
        db.statement((q) => q.selectFrom('tasks').select('id').where('workspace_id', '=', target.workspace.id)),
      );
      const logs = await db.rows(
        db.statement((q) =>
          q.selectFrom('change_logs').select('id').where('organization_id', '=', target.organization.id),
        ),
      );
      expect(tasks).toEqual([]);
      expect(logs).toEqual([]);
    });
  });

  test('所属していないワークスペースのタスクは、管理者以外は完了にできない（403）', async () => {
    const target = await createTarget();
    const task = await createTask(target.organization, target.workspace.id, target.admin.userId!);
    const res = await complete(target, target.bystander, task.id);
    expect(res.status).toBe(403);
    expect((await recordsOf(target, task.id)).task!.completed_at).toBeNull();
  });
});

describe('完了の経験値をまとめて見る', () => {
  test('同じワークスペースの2つのタスクを別の人が完了にしても、経験値は人ごとに分かれる', async () => {
    const target = await createTarget();
    const author = await createPerson({
      organization: target.organization,
      membership: { workspaceId: target.workspace.id, role: 'member' },
    });
    const adminId = author.userId!;
    const first = await createTask(target.organization, target.workspace.id, adminId, { points: 2 });
    const second = await createTask(target.organization, target.workspace.id, adminId, { points: 8 });
    await complete(target, target.member, first.id);
    await complete(target, target.leader, second.id);

    const db = orgDb(env, target.organization.verified);
    const rows = await db.rows(
      db.statement((q) =>
        q
          .selectFrom('xp_grants')
          .select(['user_id', (eb) => eb.fn.sum<number>('amount').as('total')])
          .where('workspace_id', '=', target.workspace.id)
          .groupBy('user_id'),
      ),
    );
    const totals = new Map(rows.map((row) => [row.user_id, Number(row.total)]));
    expect(totals.get(adminId)).toBe(XP_TASK_CREATED * 2);
    expect(totals.get(target.member.userId!)).toBe(XP_TASK_COMPLETED);
    expect(totals.get(target.leader.userId!)).toBe(XP_TASK_COMPLETED);
  });
});
