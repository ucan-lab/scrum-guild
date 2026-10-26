// タスクの詳細の読み取り、変更、削除の振る舞い。
// 組織の分離と権限の種類ごとの許可と拒否は、一覧を回す test/operation-registry.test.ts が確かめる
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, test } from 'vitest';
import { setFixedNow } from '../src/shared/clock.ts';
import { backlogTree, taskComplete, taskDelete, taskDetail, taskUpdate } from '../src/shared/operations/task/index.ts';
import { createApp } from '../src/server/app.ts';
import { orgDb, verifyWorkspace } from '../src/server/db/index.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import { taskDeleteOperation, taskUpdateOperation } from '../src/server/operations/task-edit.ts';
import { createStory, createTask } from './factories.ts';
import { errorCodeOf, post } from './operations/harness.ts';
import { createPerson, createTarget, testEnv, type Person, type Target } from './operations/world.ts';

const app = createApp(implementedOperations);

type Detail = {
  id: string;
  title: string;
  body_md: string | null;
  points: number | null;
  due_on: string | null;
  link_url: string | null;
  assignee: { id: string; name: string; left: boolean } | null;
  is_imported: boolean;
  completed_at: string | null;
  can_delete: boolean;
};

// 開発用の時計（DEV_NOW）を置いた環境。リクエストごとに時計が環境の値に合わされるので、setFixedNow だけでは止まらない
// （リクエストの最初に、DEV_NOW が無ければ本物の時計に戻される。src/server/dev-clock.ts）。
// DEV_NOW は、ループバックの公開 URL のときだけ使える
const FROZEN_AT = '2026-10-26T10:00:00+09:00';
const FROZEN_ISO = '2026-10-26T01:00:00.000Z';
function frozenEnv(devNow: string = FROZEN_AT): Env {
  return Object.assign({}, testEnv, { PUBLIC_ORIGIN: 'http://localhost:8787', DEV_NOW: devNow });
}

function detail(target: Target, taskId: string, person: Person = target.member, requestEnv?: Env) {
  return post(app, taskDetail, {
    slug: target.slug,
    token: person.token,
    body: { workspace_id: target.workspace.id, task_id: taskId },
    ...(requestEnv === undefined ? {} : { env: requestEnv }),
  });
}

function update(
  target: Target,
  taskId: string,
  body: Record<string, unknown>,
  person: Person = target.member,
  requestEnv?: Env,
) {
  return post(app, taskUpdate, {
    slug: target.slug,
    token: person.token,
    body: { workspace_id: target.workspace.id, task_id: taskId, ...body },
    ...(requestEnv === undefined ? {} : { env: requestEnv }),
  });
}

function remove(target: Target, taskId: string, person: Person = target.member, requestEnv?: Env) {
  return post(app, taskDelete, {
    slug: target.slug,
    token: person.token,
    body: { workspace_id: target.workspace.id, task_id: taskId },
    ...(requestEnv === undefined ? {} : { env: requestEnv }),
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
      assignee: null,
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

  test('期日の印を決める、ワークスペースのタイムゾーンでの今日と週の始まりを返す（止めた時計で）', async () => {
    // UTC では 2026-10-26 の 20:00 だが、東京ではもう 10-27。ブラウザの時計やタイムゾーンでなく、ワークスペースの値で決まる
    const frozen = frozenEnv('2026-10-27T05:00:00+09:00');
    try {
      const target = await createTarget();
      const task = await createTask(target.organization, target.workspace.id, target.member.userId!, {
        due_on: '2026-10-26',
      });
      const body = (await (await detail(target, task.id, target.member, frozen)).json()) as {
        today: string;
        week_start: number;
      };
      expect(body.today).toBe('2026-10-27');
      // ワークスペースの既定（月曜始まり）
      expect(body.week_start).toBe(1);
      // 別のタイムゾーンのワークスペースでは、その値になる
      const other = await createTarget();
      const db = orgDb(env, other.organization.verified);
      await db.run(
        db.statement((q) =>
          q
            .updateTable('workspaces')
            .set({ timezone: 'America/Los_Angeles', week_start: 0 })
            .where('id', '=', other.workspace.id)
            .where('organization_id', '=', other.organization.id),
        ),
      );
      const otherTask = await createTask(other.organization, other.workspace.id, other.member.userId!);
      const otherBody = (await (await detail(other, otherTask.id, other.member, frozen)).json()) as {
        today: string;
        week_start: number;
      };
      expect(otherBody).toMatchObject({ today: '2026-10-26', week_start: 0 });
    } finally {
      setFixedNow(undefined);
    }
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

// 処理を直に呼び、タスクを読む文が答えを返した直後に race を呼ぶ（n は何回目の読み取りか）。
// 「同じ値を読んだ2つの要求が、順に書く」状況を、読み取りの後に別の要求を挟んで作る
async function runWithRace(
  target: Target,
  person: Person,
  operation: { handler: (context: never) => Promise<unknown> },
  input: Record<string, unknown>,
  race: (n: number, db: ReturnType<typeof orgDb>) => Promise<void>,
) {
  const db = orgDb(env, target.organization.verified);
  const actor = actorOf(person);
  const workspace = await verifyWorkspace(db, actor, target.workspace.id);
  let reads = 0;
  const racing = new Proxy(db, {
    get(base, key) {
      // 入口は #private を持つので、メソッドは本物の入口に結んで返す
      const value = Reflect.get(base, key, base);
      if (typeof value !== 'function') return value;
      if (key !== 'first') return value.bind(base);
      return async (...args: unknown[]) => {
        const result = await (value as (...a: unknown[]) => Promise<unknown>).apply(base, args);
        // タスクの行を返した読み取りだけを数える（閉じたかどうかの読み取りは数えない）
        if ((result as { title?: string } | undefined)?.title !== undefined) await race(++reads, base);
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
  return operation.handler(context);
}

describe('履歴の二重書き（止めた時計で、同じ時刻に競った要求）', () => {
  afterEach(() => setFixedNow(undefined));

  test('同じ値を書く2つの更新が競っても、履歴は1行だけ', async () => {
    const frozen = frozenEnv();
    // 処理を直に呼ぶ要求 B も、競う要求 A も、同じ時刻（FROZEN_ISO）で書く
    setFixedNow(new Date(FROZEN_ISO));
    const target = await createTarget();
    const task = await createTask(target.organization, target.workspace.id, target.admin.userId!, { title: '元' });
    // 要求 B は「元」を読んだ。書く前に、要求 A が同じ時刻に同じ値へ変える。B の更新は通らず、読み直すと変える欄が無い
    const result = (await runWithRace(
      target,
      target.member,
      taskUpdateOperation,
      { task_id: task.id, title: '新' },
      async (n) => {
        if (n === 1) expect((await update(target, task.id, { title: '新' }, target.leader, frozen)).status).toBe(200);
      },
    )) as { task: Detail };
    expect(result.task.title).toBe('新');
    const logs = await logsOf(target, task.id);
    expect(logs).toHaveLength(1);
    // 時計が止まっていた（行の更新日時が、止めた時刻）
    expect((await rowOf(target, task.id))!.updated_at).toBe(FROZEN_ISO);
    expect(logs[0]).toMatchObject({ actor_user_id: target.leader.userId });
    expect(JSON.parse(logs[0]!.changes_json)).toEqual({ title: ['元', '新'] });
  });

  test('先に削除した要求があれば、同じ時刻の削除は 404 で、履歴は1行だけ', async () => {
    const frozen = frozenEnv();
    setFixedNow(new Date(FROZEN_ISO));
    const target = await createTarget();
    const task = await createTask(target.organization, target.workspace.id, target.member.userId!);
    await expect(
      runWithRace(target, target.member, taskDeleteOperation, { task_id: task.id }, async (n) => {
        if (n === 1) expect((await remove(target, task.id, target.leader, frozen)).status).toBe(200);
      }),
    ).rejects.toMatchObject({ status: 404, code: 'not_found' });
    const logs = await logsOf(target, task.id);
    expect(logs).toHaveLength(1);
    expect((await rowOf(target, task.id))!.deleted_at).toBe(FROZEN_ISO);
    expect(logs[0]).toMatchObject({ action: 'delete', actor_user_id: target.leader.userId });
  });

  test('読んだ後に削除された更新は 404 で、更新の履歴を書かない', async () => {
    const target = await createTarget();
    const task = await createTask(target.organization, target.workspace.id, target.member.userId!);
    await expect(
      runWithRace(target, target.member, taskUpdateOperation, { task_id: task.id, title: '書き換える' }, async (n) => {
        if (n === 1) expect((await remove(target, task.id, target.leader)).status).toBe(200);
      }),
    ).rejects.toMatchObject({ status: 404, code: 'not_found' });
    expect((await logsOf(target, task.id)).map((log) => log.action)).toEqual(['delete']);
  });

  test('負け続けてやり直しが尽きたら 409 の conflict で、自分の履歴は書かない', async () => {
    const target = await createTarget();
    const task = await createTask(target.organization, target.workspace.id, target.admin.userId!, { title: '元' });
    await expect(
      runWithRace(target, target.member, taskUpdateOperation, { task_id: task.id, title: '自分の値' }, async (n) => {
        // 1周に2回読む（書く前の読み取りと、書けなかった後の存在の確かめ）ので、書く前の読み取り（奇数回）のたびに、別の要求が違う値へ変える
        if (n % 2 === 0) return;
        expect((await update(target, task.id, { title: `別の値 ${n}` }, target.leader)).status).toBe(200);
      }),
    ).rejects.toMatchObject({ status: 409, code: 'conflict' });
    const titles = (await logsOf(target, task.id)).map((log) => JSON.parse(log.changes_json).title[1]);
    expect(titles).toEqual(['別の値 1', '別の値 3', '別の値 5']);
  });

  test.each([
    ['更新', taskUpdateOperation, { title: '書き換える' }],
    ['削除', taskDeleteOperation, {}],
  ] as const)(
    '読んだ後にワークスペースが閉じたら、%s は何も書かず 409 の workspace_closed',
    async (_name, operation, extra) => {
      const target = await createTarget();
      const task = await createTask(target.organization, target.workspace.id, target.member.userId!);
      await expect(
        runWithRace(target, target.member, operation, { task_id: task.id, ...extra }, async (n, db) => {
          if (n !== 1) return;
          await db.run(
            db.statement((q) =>
              q
                .updateTable('workspaces')
                .set({ closed_at: '2026-10-22T00:00:00.000Z' })
                .where('id', '=', target.workspace.id)
                .where('organization_id', '=', target.organization.id),
            ),
          );
        }),
      ).rejects.toMatchObject({ status: 409, code: 'workspace_closed' });
      expect(await rowOf(target, task.id)).toEqual(task);
      expect(await logsOf(target, task.id)).toEqual([]);
    },
  );
});

describe('task-update の空の値', () => {
  test('空の本文と空白だけのリンクは null になり、履歴は [前, null]', async () => {
    const target = await createTarget();
    const task = await createTask(target.organization, target.workspace.id, target.admin.userId!, {
      body_md: '元の本文',
      link_url: 'https://example.com/old',
    });
    const res = await update(target, task.id, { body_md: '', link_url: ' ' });
    expect(res.status).toBe(200);
    expect(await rowOf(target, task.id)).toMatchObject({ body_md: null, link_url: null });
    expect(JSON.parse((await logsOf(target, task.id))[0]!.changes_json)).toEqual({
      body_md: ['元の本文', null],
      link_url: ['https://example.com/old', null],
    });
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
    // 同じ組織の別のワークスペースのタスク
    const elsewhere = await createTask(target.organization, target.otherWorkspace.id, target.member.userId!);
    for (const id of [foreignTask.id, gone.id, elsewhere.id]) {
      const res = await remove(target, id, target.member);
      expect(res.status, id).toBe(404);
      expect(await errorCodeOf(res)).toBe('not_found');
    }
    expect((await rowOf(foreign, foreignTask.id))!.deleted_at).toBeNull();
    expect((await rowOf({ ...target, workspace: target.otherWorkspace }, elsewhere.id))!.deleted_at).toBeNull();
    // 削除済みを続けて削除しても、履歴は増えない
    expect(await logsOf(target, gone.id)).toEqual([]);
  });

  test('取り込んだタスクは、権限があっても 409 の conflict で削除できず、can_delete も偽。何も書かない', async () => {
    const target = await createTarget();
    const task = await createTask(target.organization, target.workspace.id, target.admin.userId!, {
      is_imported: 1,
      created_by: null,
    });
    for (const person of [target.leader, target.admin]) {
      const res = await remove(target, task.id, person);
      expect(res.status).toBe(409);
      expect(await errorCodeOf(res)).toBe('conflict');
      expect(((await (await detail(target, task.id, person)).json()) as { task: Detail }).task.can_delete).toBe(false);
    }
    expect(await rowOf(target, task.id)).toEqual(task);
    expect(await logsOf(target, task.id)).toEqual([]);
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
