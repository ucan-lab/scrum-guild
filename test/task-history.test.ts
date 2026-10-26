// タスクの変更の履歴（task-history）の振る舞い。
// 組織の分離と権限の種類ごとの許可と拒否は、一覧を回す test/operation-registry.test.ts が確かめる
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, test } from 'vitest';
import { setFixedNow } from '../src/shared/clock.ts';
import {
  taskAssign,
  taskComplete,
  taskCreate,
  taskDelete,
  taskHistory,
  taskMove,
  taskUpdate,
  type TaskHistoryEntry,
} from '../src/shared/operations/task/index.ts';
import type { AnyOperationDefinition } from '../src/shared/operations/define.ts';
import { createApp } from '../src/server/app.ts';
import { orgDb } from '../src/server/db/index.ts';
import { queryPlanForTest } from '../src/server/db/testing.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import { changesOf, taskHistoryStatement } from '../src/server/operations/task-history.ts';
import { AT, createStory, createTask, uuidv7 } from './factories.ts';
import { errorCodeOf, post } from './operations/harness.ts';
import { createTarget, testEnv, type Person, type Target } from './operations/world.ts';

const app = createApp(implementedOperations);

type HistoryBody = {
  entries: TaskHistoryEntry[];
  next: { created_at: string; id: string } | null;
  timezone: string;
};

afterEach(() => setFixedNow(undefined));

// 開発用の時計（DEV_NOW）を置いた環境。操作ごとに時刻をずらし、履歴の created_at を並べる
function at(second: number): Env {
  const devNow = `2026-10-26T10:00:${String(second).padStart(2, '0')}+09:00`;
  return Object.assign({}, testEnv, { PUBLIC_ORIGIN: 'http://localhost:8787', DEV_NOW: devNow });
}

async function call(
  target: Target,
  definition: AnyOperationDefinition,
  body: Record<string, unknown>,
  person: Person,
  requestEnv?: Env,
) {
  const res = await post(app, definition, {
    slug: target.slug,
    token: person.token,
    body: { workspace_id: target.workspace.id, ...body },
    ...(requestEnv === undefined ? {} : { env: requestEnv }),
  });
  expect(res.status, definition.name).toBe(200);
  return res.json();
}

function history(target: Target, taskId: string, before?: HistoryBody['next'], person: Person = target.member) {
  return post(app, taskHistory, {
    slug: target.slug,
    token: person.token,
    body: { workspace_id: target.workspace.id, task_id: taskId, ...(before ? { before } : {}) },
  });
}

async function historyBody(target: Target, taskId: string, before?: HistoryBody['next']): Promise<HistoryBody> {
  const res = await history(target, taskId, before);
  expect(res.status).toBe(200);
  return (await res.json()) as HistoryBody;
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

// 履歴の行を直に入れる（形の合わない値や、件数の多い履歴を作るため）
async function insertLogs(
  target: Target,
  rows: readonly {
    entity_id: string;
    changes_json?: string;
    created_at?: string;
    entity_type?: string;
    workspace_id?: string;
    actor_user_id?: string | null;
    id?: string;
  }[],
) {
  const db = orgDb(env, target.organization.verified);
  await db.batch(
    rows.map((row) =>
      db.statement((q) =>
        q.insertInto('change_logs').values({
          id: row.id ?? uuidv7(),
          organization_id: target.organization.id,
          workspace_id: row.workspace_id ?? target.workspace.id,
          actor_user_id: row.actor_user_id === undefined ? target.admin.userId : row.actor_user_id,
          operator: null,
          entity_type: row.entity_type ?? 'task',
          entity_id: row.entity_id,
          action: 'update',
          changes_json: row.changes_json ?? '{"points":[1,2]}',
          created_at: row.created_at ?? AT,
        }),
      ),
    ),
  );
}

describe('task-history', () => {
  test('作成、変更、移動、担当、完了を新しい順に、変えた人の今の名前と、そのときの値で返す。削除した後は 404', async () => {
    const target = await createTarget();
    await rename(target, target.member, '若葉 湊');
    await rename(target, target.leader, '朝霧 楓');
    const parent = await createStory(target.organization, target.workspace.id, target.admin.userId!, {
      title: '見積もりの準備',
    });
    const other = await createStory(target.organization, target.workspace.id, target.admin.userId!, {
      title: '請求の準備',
    });

    const created = (await call(
      target,
      taskCreate,
      { title: '見積もりを送る', points: 3, assignee_user_id: target.member.userId, story_id: parent.id },
      target.member,
      at(1),
    )) as { task: { id: string } };
    const taskId = created.task.id;
    await call(target, taskUpdate, { task_id: taskId, points: 5, body_md: '秘密の本文' }, target.member, at(2));
    await call(target, taskMove, { task_id: taskId, story_id: other.id }, target.member, at(3));
    await call(target, taskAssign, { task_id: taskId, assignee_user_id: target.leader.userId }, target.member, at(4));
    await call(target, taskComplete, { task_id: taskId }, target.leader, at(5));
    // 後で名前を変えても、値はそのときの名前のまま。変えた人は今の名前
    await rename(target, target.member, '若葉 湊（改名）');
    await rename(target, target.leader, '朝霧 楓（改名）');

    const res = await history(target, taskId);
    expect(res.status).toBe(200);
    const text = await res.clone().text();
    expect(text).not.toContain('秘密の本文');
    const body = (await res.json()) as HistoryBody;
    expect(body.timezone).toBe('Asia/Tokyo');
    expect(body.next).toBeNull();

    const member = { id: target.member.userId!, name: '若葉 湊（改名）' };
    const leader = { id: target.leader.userId!, name: '朝霧 楓（改名）' };
    expect(body.entries.map(({ action, actor, changes }) => ({ action, actor, changes }))).toEqual([
      {
        action: 'complete',
        actor: leader,
        changes: [
          { field: 'completed_at', before: null, after: '2026-10-26T01:00:05.000Z' },
          { field: 'completed_by', before: null, after: { id: target.leader.userId!, name: '朝霧 楓' } },
        ],
      },
      {
        action: 'update',
        actor: member,
        changes: [
          {
            field: 'assignee',
            before: { id: target.member.userId!, name: '若葉 湊' },
            after: { id: target.leader.userId!, name: '朝霧 楓' },
          },
        ],
      },
      {
        action: 'update',
        actor: member,
        changes: [
          {
            field: 'story',
            before: { id: parent.id, name: '見積もりの準備' },
            after: { id: other.id, name: '請求の準備' },
          },
        ],
      },
      {
        action: 'update',
        actor: member,
        changes: [
          { field: 'points', before: 3, after: 5 },
          // 本文は値を返さず、変えたことだけを返す
          { field: 'body_md', before: null, after: null },
        ],
      },
      {
        action: 'create',
        actor: member,
        changes: [
          { field: 'title', before: null, after: '見積もりを送る' },
          { field: 'points', before: null, after: 3 },
          { field: 'assignee', before: null, after: { id: target.member.userId!, name: '若葉 湊' } },
          { field: 'story', before: null, after: { id: parent.id, name: '見積もりの準備' } },
        ],
      },
    ]);
    expect(body.entries.map((entry) => entry.created_at)).toEqual([
      '2026-10-26T01:00:05.000Z',
      '2026-10-26T01:00:04.000Z',
      '2026-10-26T01:00:03.000Z',
      '2026-10-26T01:00:02.000Z',
      '2026-10-26T01:00:01.000Z',
    ]);

    // 削除したタスクは画面から隠すので、履歴も読めない（削除の履歴はリーダーと管理者の画面で見る）
    await call(target, taskDelete, { task_id: taskId }, target.member, at(6));
    const gone = await history(target, taskId);
    expect(gone.status).toBe(404);
    expect(await errorCodeOf(gone)).toBe('not_found');
  });

  test('1回 50 件まで返し、同じ時刻の行が続いても next で漏れなく重ならずに続きを読める', async () => {
    const target = await createTarget();
    const task = await createTask(target.organization, target.workspace.id, target.admin.userId!);
    // 120 件。半分は同じ時刻にして、時刻の境目で切れるページを作る
    const rows = Array.from({ length: 120 }, (_, i) => ({
      entity_id: task.id,
      created_at: i < 60 ? AT : `2026-10-20T00:${String(Math.floor(i / 2)).padStart(2, '0')}:00.000Z`,
    }));
    await insertLogs(target, rows);

    const seen: TaskHistoryEntry[] = [];
    const sizes: number[] = [];
    let before: HistoryBody['next'] = null;
    for (let page = 0; page < 5; page++) {
      const body: HistoryBody = await historyBody(target, task.id, before);
      sizes.push(body.entries.length);
      seen.push(...body.entries);
      before = body.next;
      if (before === null) break;
    }
    expect(sizes).toEqual([50, 50, 20]);
    expect(new Set(seen.map((entry) => entry.id)).size).toBe(120);
    // 新しい順（created_at の降順、同じなら id の降順）
    const sorted = [...seen].sort((a, b) =>
      a.created_at === b.created_at ? (a.id < b.id ? 1 : -1) : a.created_at < b.created_at ? 1 : -1,
    );
    expect(seen.map((entry) => entry.id)).toEqual(sorted.map((entry) => entry.id));
  });

  test('ちょうど 50 件なら next は null', async () => {
    const target = await createTarget();
    const task = await createTask(target.organization, target.workspace.id, target.admin.userId!);
    await insertLogs(
      target,
      Array.from({ length: 50 }, () => ({ entity_id: task.id })),
    );
    const body = await historyBody(target, task.id);
    expect(body.entries).toHaveLength(50);
    expect(body.next).toBeNull();
  });

  test('ほかのタスク、ほかの種類、ほかのワークスペースの行は返さない。変えた人の無い行は actor が null', async () => {
    const target = await createTarget();
    const task = await createTask(target.organization, target.workspace.id, target.admin.userId!);
    await insertLogs(target, [
      { entity_id: task.id, actor_user_id: null, id: '019a0000-0000-7000-8000-000000000001' },
      { entity_id: task.id, entity_type: 'story' },
      { entity_id: task.id, workspace_id: target.otherWorkspace.id },
      { entity_id: '019a0000-0000-7000-8000-00000000aaaa' },
    ]);
    const body = await historyBody(target, task.id);
    expect(body.entries.map((entry) => ({ id: entry.id, actor: entry.actor }))).toEqual([
      { id: '019a0000-0000-7000-8000-000000000001', actor: null },
    ]);
  });

  test('読めない JSON は変更なしとして扱う（列は json_valid で守るが、読む側も落ちない）', () => {
    expect(changesOf('not json')).toEqual([]);
    expect(changesOf('')).toEqual([]);
  });

  test('オブジェクトでない changes_json は変更なし、形の合わない値は null、知らない欄は名前だけを、保存した順で返す', async () => {
    const target = await createTarget();
    const task = await createTask(target.organization, target.workspace.id, target.admin.userId!);
    await insertLogs(target, [
      { entity_id: task.id, created_at: '2026-10-20T00:00:01.000Z', changes_json: '"text"' },
      { entity_id: task.id, created_at: '2026-10-20T00:00:02.000Z', changes_json: '[1,2]' },
      { entity_id: task.id, created_at: '2026-10-20T00:00:02.500Z', changes_json: '{"points":5,"title":[1]}' },
      {
        entity_id: task.id,
        created_at: '2026-10-20T00:00:03.000Z',
        changes_json: JSON.stringify({
          title: 'bad',
          points: ['x', 5],
          mystery: [1, 2],
          assignee: [{ id: 1 }, { id: 'u1', name: '若葉 湊', extra: true }],
          story: [null, { id: 's1', title: '親' }],
          due_on: [3, '2026-10-30'],
          body_md: ['前の本文', '後の本文'],
        }),
      },
    ]);
    const body = await historyBody(target, task.id);
    expect(body.entries.map((entry) => entry.changes)).toEqual([
      [
        { field: 'title', before: null, after: null },
        { field: 'points', before: null, after: 5 },
        { field: 'mystery', before: null, after: null },
        { field: 'assignee', before: null, after: { id: 'u1', name: '若葉 湊' } },
        { field: 'story', before: null, after: { id: 's1', name: '親' } },
        { field: 'due_on', before: null, after: '2026-10-30' },
        { field: 'body_md', before: null, after: null },
      ],
      [
        { field: 'points', before: null, after: null },
        { field: 'title', before: null, after: null },
      ],
      [],
      [],
    ]);
  });

  test('別の組織・別のワークスペース・存在しないタスクは 404', async () => {
    const target = await createTarget();
    const foreign = await createTarget();
    const foreignTask = await createTask(foreign.organization, foreign.workspace.id, foreign.admin.userId!);
    const elsewhere = await createTask(target.organization, target.otherWorkspace.id, target.admin.userId!);
    await insertLogs(foreign, [{ entity_id: foreignTask.id }]);
    await insertLogs(target, [{ entity_id: elsewhere.id, workspace_id: target.otherWorkspace.id }]);
    for (const id of [foreignTask.id, elsewhere.id, '019a0000-0000-7000-8000-00000000ffff']) {
      const res = await history(target, id);
      expect(res.status, id).toBe(404);
      expect(await errorCodeOf(res)).toBe('not_found');
    }
  });

  test('閉じたワークスペースのタスクも読める。削除したタスクは、リーダーと管理者にも 404', async () => {
    const target = await createTarget({ closed: true });
    const task = await createTask(target.organization, target.workspace.id, target.admin.userId!);
    await insertLogs(target, [{ entity_id: task.id }]);
    const body = await historyBody(target, task.id);
    expect(body.entries).toHaveLength(1);

    const deleted = await createTask(target.organization, target.workspace.id, target.admin.userId!, {
      deleted_at: '2026-10-21T00:00:00.000Z',
    });
    await insertLogs(target, [{ entity_id: deleted.id }]);
    for (const person of [target.member, target.leader, target.admin]) {
      const res = await history(target, deleted.id, undefined, person);
      expect(res.status).toBe(404);
      expect(await errorCodeOf(res)).toBe('not_found');
    }
  });

  test('履歴を読む文は、続きを読むときも、索引 change_logs_entity でそのタスクの行だけを引く', async () => {
    const target = await createTarget();
    const db = orgDb(env, target.organization.verified);
    const first = (await queryPlanForTest(env, taskHistoryStatement(db, target.workspace.id, 'x'))).join('\n');
    expect(first).toMatch(/SEARCH change_logs USING INDEX change_logs_entity \(entity_type=\? AND entity_id=\?\)/);
    expect(first).not.toMatch(/SCAN change_logs\b/);
    const next = (
      await queryPlanForTest(
        env,
        taskHistoryStatement(db, target.workspace.id, 'x', {
          created_at: AT,
          id: '019a0000-0000-7000-8000-000000000001',
        }),
      )
    ).join('\n');
    expect(next).toMatch(/SEARCH change_logs USING INDEX change_logs_entity \(entity_type=\? AND entity_id=\?/);
    expect(next).not.toMatch(/SCAN change_logs\b/);
  });

  test('長い本文は、応答に本文を含めず、欄の名前と並びを残す', async () => {
    const target = await createTarget();
    const task = await createTask(target.organization, target.workspace.id, target.admin.userId!);
    const body = '本'.repeat(10_000);
    await insertLogs(target, [
      {
        entity_id: task.id,
        changes_json: JSON.stringify({ points: [1, 2], body_md: [body, `${body}改`], title: ['a', 'b'] }),
      },
    ]);
    const res = await history(target, task.id);
    expect(res.status).toBe(200);
    const text = await res.clone().text();
    expect(text).not.toContain('本本');
    expect(((await res.json()) as HistoryBody).entries[0]!.changes).toEqual([
      { field: 'points', before: 1, after: 2 },
      { field: 'body_md', before: null, after: null },
      { field: 'title', before: 'a', after: 'b' },
    ]);
  });

  test('同じ entity_id でも別の組織の行は返さない。別の組織の人を指す変えた人は null', async () => {
    const target = await createTarget();
    const foreign = await createTarget();
    const task = await createTask(target.organization, target.workspace.id, target.admin.userId!);
    await insertLogs(foreign, [{ entity_id: task.id, workspace_id: target.workspace.id }]);
    await insertLogs(target, [{ entity_id: task.id, actor_user_id: foreign.admin.userId }]);
    const body = await historyBody(target, task.id);
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0]!.actor).toBeNull();
  });

  test('名前が空か、親のタイトルが null でも、ID があれば値を落とさず名前を空で返す', async () => {
    const target = await createTarget();
    const task = await createTask(target.organization, target.workspace.id, target.admin.userId!);
    await insertLogs(target, [
      {
        entity_id: task.id,
        changes_json: JSON.stringify({
          assignee: [{ id: 'u1', name: '' }, null],
          story: [{ id: 's1', title: null }, null],
        }),
      },
    ]);
    const body = await historyBody(target, task.id);
    expect(body.entries[0]!.changes).toEqual([
      { field: 'assignee', before: { id: 'u1', name: '' }, after: null },
      { field: 'story', before: { id: 's1', name: '' }, after: null },
    ]);
  });
});
