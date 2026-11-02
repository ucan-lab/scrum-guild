// タスクの決まった欄の値（task_field_values）の書き込み（task-field-set）と、未記入の判定（task-detail、backlog-tree、task-create）。
// 組織の分離と権限の種類ごとの許可と拒否は、一覧を回す test/operation-registry.test.ts が確かめる。
// 計画の画面の未記入の件数（plan-summary）は test/plan-summary.test.ts
import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import type { AnyOperationDefinition } from '../src/shared/operations/define.ts';
import {
  backlogTree,
  taskComplete,
  taskCreate,
  taskDetail,
  taskFieldSet,
  taskHistory,
} from '../src/shared/operations/task/index.ts';
import { detailFieldDelete, detailFieldList } from '../src/shared/operations/definition/index.ts';
import { planSummary } from '../src/shared/operations/sprint/index.ts';
import { createApp } from '../src/server/app.ts';
import { orgDb } from '../src/server/db/index.ts';
import { queryPlanForTest } from '../src/server/db/testing.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import { unfilledCountStatement } from '../src/server/operations/task.ts';
import {
  createBoardColumn,
  createDetailField,
  createSprint,
  createStory,
  createTask,
  createTaskFieldValue,
} from './factories.ts';
import { post } from './operations/harness.ts';
import { createTarget, type Person, type Target } from './operations/world.ts';

const app = createApp(implementedOperations);

type ErrorBody = { error: { code: string; details?: { reason?: string } } };
type SetBody = { field: { id: string; name: string; value_md: string | null }; unfilled: boolean };

async function call<T = Record<string, unknown>>(
  definition: AnyOperationDefinition,
  target: Target,
  body: Record<string, unknown>,
  person: Person = target.member,
): Promise<{ status: number; body: T }> {
  const res = await post(app, definition, {
    slug: target.slug,
    token: person.token,
    body: { workspace_id: target.workspace.id, ...body },
  });
  return { status: res.status, body: (await res.json()) as T };
}

const setField = (
  target: Target,
  taskId: string,
  fieldId: string,
  valueMd: string | null,
  readMd: string | null,
  person?: Person,
) =>
  call<SetBody & ErrorBody>(
    taskFieldSet,
    target,
    { task_id: taskId, field_id: fieldId, value_md: valueMd, read_md: readMd },
    person,
  );

async function storedValue(target: Target, taskId: string, fieldId: string) {
  const db = orgDb(env, target.organization.verified);
  return db.first(
    db.statement((q) =>
      q
        .selectFrom('task_field_values')
        .select(['value_md', 'updated_by'])
        .where('task_id', '=', taskId)
        .where('field_id', '=', fieldId),
    ),
  );
}

async function taskLogs(target: Target, taskId: string) {
  const db = orgDb(env, target.organization.verified);
  const rows = await db.rows(
    db.statement((q) =>
      q
        .selectFrom('change_logs')
        .select(['action', 'changes_json', 'actor_user_id', 'workspace_id'])
        .where('organization_id', '=', target.organization.id)
        .where('entity_type', '=', 'task')
        .where('entity_id', '=', taskId)
        .orderBy('created_at')
        .orderBy('id'),
    ),
  );
  return rows.map((row) => ({ ...row, changes: JSON.parse(row.changes_json) as Record<string, unknown> }));
}

// 1 つのワークスペースに欄を 2 つ（受け入れ基準と影響範囲）と、未完了のタスクを 1 つ
async function world(options: { closed?: boolean } = {}) {
  const target = await createTarget(options);
  const memberId = target.member.userId!;
  const criteria = await createDetailField(target.organization, target.workspace.id, { name: '受け入れ基準' });
  const impact = await createDetailField(target.organization, target.workspace.id, {
    name: '影響範囲',
    position: 'a1',
  });
  const task = await createTask(target.organization, target.workspace.id, memberId);
  return { target, memberId, criteria, impact, task };
}

describe('task-field-set', () => {
  test('行が無い欄に書くと値が入り、履歴に欄の名前だけが残る（値の全文は入らない）', async () => {
    const { target, memberId, criteria, task } = await world();
    const text = '- 影響する画面を挙げてある\n- 確かめる手順がある';
    const res = await setField(target, task.id, criteria.id, text, null);
    expect(res.status).toBe(200);
    expect(res.body.field).toEqual({ id: criteria.id, name: '受け入れ基準', value_md: text });
    // もう 1 つの欄が未記入のまま
    expect(res.body.unfilled).toBe(true);
    expect(await storedValue(target, task.id, criteria.id)).toEqual({ value_md: text, updated_by: memberId });

    const logs = await taskLogs(target, task.id);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      action: 'update',
      actor_user_id: memberId,
      workspace_id: target.workspace.id,
      changes: { field: [null, { id: criteria.id, name: '受け入れ基準' }] },
    });
    expect(logs[0]?.changes_json).not.toContain('影響する画面');
  });

  test('読んだ値のままなら直せる。履歴は前後とも欄の名前だけ。全部の欄を書くと未記入でなくなる', async () => {
    const { target, criteria, impact, task } = await world();
    await setField(target, task.id, criteria.id, '一次', null);
    const edited = await setField(target, task.id, criteria.id, '二次', '一次');
    expect(edited.status).toBe(200);
    expect(edited.body.field.value_md).toBe('二次');
    expect((await taskLogs(target, task.id)).at(-1)?.changes).toEqual({
      field: [
        { id: criteria.id, name: '受け入れ基準' },
        { id: criteria.id, name: '受け入れ基準' },
      ],
    });
    const all = await setField(target, task.id, impact.id, '画面 A', null);
    expect(all.body.unfilled).toBe(false);
  });

  test('空（空白だけを含む）か null にすると行を消して未記入に戻り、履歴は「あり → なし」', async () => {
    const { target, criteria, impact, task } = await world();
    await setField(target, task.id, criteria.id, '一次', null);
    await setField(target, task.id, impact.id, '画面 A', null);
    const cleared = await setField(target, task.id, criteria.id, '  \n \n', '一次');
    expect(cleared.status).toBe(200);
    expect(cleared.body.field.value_md).toBeNull();
    expect(cleared.body.unfilled).toBe(true);
    expect(await storedValue(target, task.id, criteria.id)).toBeUndefined();
    expect((await taskLogs(target, task.id)).at(-1)?.changes).toEqual({
      field: [{ id: criteria.id, name: '受け入れ基準' }, null],
    });
    const nullCleared = await setField(target, task.id, impact.id, null, '画面 A');
    expect(nullCleared.status).toBe(200);
    expect(await storedValue(target, task.id, impact.id)).toBeUndefined();
  });

  test('値は本文と同じ正規化を通す（改行をそろえ、前後の空行と末尾の空白を落とす）', async () => {
    const { target, criteria, task } = await world();
    const res = await setField(target, task.id, criteria.id, '\r\n\r\n- 一つ目\r\n- 二つ目  \r\n\r\n', null);
    expect(res.status).toBe(200);
    expect(res.body.field.value_md).toBe('- 一つ目\n- 二つ目');
  });

  test('1 万字まで書け、1 万 1 字と見えない文字は 400', async () => {
    const { target, criteria, task } = await world();
    expect((await setField(target, task.id, criteria.id, 'あ'.repeat(10_001), null)).status).toBe(400);
    expect((await setField(target, task.id, criteria.id, '欄​', null)).status).toBe(400);
    expect((await setField(target, task.id, criteria.id, 'あ'.repeat(10_000), null)).status).toBe(200);
  });

  test('読んだ値と今の値が違うと 409 の changed で、上書きも削除もしない', async () => {
    const { target, criteria, task } = await world();
    await setField(target, task.id, criteria.id, '先に書かれた', null);

    // 行が無いと思って書く（同時に別の人が先に書いた）
    const insert = await setField(target, task.id, criteria.id, '自分の値', null);
    expect(insert.status).toBe(409);
    expect(insert.body.error).toMatchObject({ code: 'conflict', details: { reason: 'changed' } });
    // 古い値を読んで直す
    const update = await setField(target, task.id, criteria.id, '自分の値', '古い値');
    expect(update.status).toBe(409);
    expect(update.body.error.details?.reason).toBe('changed');
    // 古い値を読んで消す
    const remove = await setField(target, task.id, criteria.id, null, '古い値');
    expect(remove.status).toBe(409);
    expect(remove.body.error.details?.reason).toBe('changed');

    expect((await storedValue(target, task.id, criteria.id))?.value_md).toBe('先に書かれた');
    // 負けた書き込みは履歴を残さない
    expect(await taskLogs(target, task.id)).toHaveLength(1);

    // 読み直した値で書き直せる
    expect((await setField(target, task.id, criteria.id, '自分の値', '先に書かれた')).status).toBe(200);
  });

  test('同じ欄に同時に書くと、片方だけが通り、負けた方は 409 の changed', async () => {
    const { target, criteria, task } = await world();
    const inserts = await Promise.all([
      setField(target, task.id, criteria.id, 'A さんの値', null, target.member),
      setField(target, task.id, criteria.id, 'B さんの値', null, target.leader),
    ]);
    expect(inserts.map((result) => result.status).sort()).toEqual([200, 409]);
    const winner = (await storedValue(target, task.id, criteria.id))?.value_md;
    expect(['A さんの値', 'B さんの値']).toContain(winner);

    const updates = await Promise.all([
      setField(target, task.id, criteria.id, '更新 1', winner!, target.member),
      setField(target, task.id, criteria.id, '更新 2', winner!, target.leader),
    ]);
    expect(updates.map((result) => result.status).sort()).toEqual([200, 409]);
    expect((await taskLogs(target, task.id)).length).toBe(2);
  });

  test('読んだ値と同じ値を書くなら何も書かず、履歴も残さない', async () => {
    const { target, criteria, task } = await world();
    const none = await setField(target, task.id, criteria.id, null, null);
    expect(none.status).toBe(200);
    expect(none.body.field.value_md).toBeNull();
    await setField(target, task.id, criteria.id, '一次', null);
    const same = await setField(target, task.id, criteria.id, '一次', '一次');
    expect(same.status).toBe(200);
    expect(same.body.field.value_md).toBe('一次');
    expect(await taskLogs(target, task.id)).toHaveLength(1);
  });

  test('完了したタスクにも書ける。そのタスクは未記入にならない', async () => {
    const { target, criteria, task } = await world();
    expect((await call(taskComplete, target, { task_id: task.id })).status).toBe(200);
    const res = await setField(target, task.id, criteria.id, '完了後に書いた', null);
    expect(res.status).toBe(200);
    expect(res.body.unfilled).toBe(false);
  });

  test('削除した欄、無い欄、別のワークスペースと別の組織の欄とタスク、削除したタスクは 404', async () => {
    const { target, criteria, task } = await world();
    const deleted = await createDetailField(target.organization, target.workspace.id, {
      name: '旧欄',
      position: 'a2',
      deleted_at: '2026-10-21T00:00:00.000Z',
    });
    const elsewhereField = await createDetailField(target.organization, target.otherWorkspace.id);
    const elsewhereTask = await createTask(target.organization, target.otherWorkspace.id, target.bystander.userId!);
    const goneTask = await createTask(target.organization, target.workspace.id, target.member.userId!, {
      deleted_at: '2026-10-21T00:00:00.000Z',
    });
    const stranger = await createTarget();
    const strangerField = await createDetailField(stranger.organization, stranger.workspace.id);
    const strangerTask = await createTask(stranger.organization, stranger.workspace.id, stranger.member.userId!);

    const cases: [string, string][] = [
      [task.id, deleted.id],
      [task.id, elsewhereField.id],
      [task.id, crypto.randomUUID()],
      [task.id, strangerField.id],
      [elsewhereTask.id, criteria.id],
      [goneTask.id, criteria.id],
      [strangerTask.id, criteria.id],
      [crypto.randomUUID(), criteria.id],
    ];
    for (const [taskId, fieldId] of cases) {
      expect((await setField(target, taskId, fieldId, '値', null)).status, `${taskId} ${fieldId}`).toBe(404);
    }
    expect(await storedValue(target, task.id, deleted.id)).toBeUndefined();
  });

  test('閉じたワークスペースは 409 の workspace_closed', async () => {
    const { target, criteria, task } = await world({ closed: true });
    const res = await setField(target, task.id, criteria.id, '値', null);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('workspace_closed');
    expect(await storedValue(target, task.id, criteria.id)).toBeUndefined();
  });

  test('変更の履歴（task-history）は、欄の名前だけを返し、値の全文を含まない', async () => {
    const { target, criteria, task } = await world();
    await setField(target, task.id, criteria.id, '秘密のメモ', null);
    const res = await call<{
      entries: { action: string; changes: { field: string; before: unknown; after: unknown }[] }[];
    }>(taskHistory, target, { task_id: task.id });
    expect(res.status).toBe(200);
    expect(res.body.entries[0]).toMatchObject({
      action: 'update',
      changes: [{ field: 'field', before: null, after: { id: criteria.id, name: '受け入れ基準' } }],
    });
    expect(JSON.stringify(res.body)).not.toContain('秘密のメモ');
  });
});

describe('未記入の判定', () => {
  test('task-detail は削除していない欄を並びの順に値つきで返し、値の無い欄があれば未記入。書いて全部そろえると偽になる', async () => {
    const { target, memberId, criteria, impact, task } = await world();
    const deleted = await createDetailField(target.organization, target.workspace.id, {
      name: '旧欄',
      position: 'a2',
      deleted_at: '2026-10-21T00:00:00.000Z',
    });
    await createTaskFieldValue(target.organization, task.id, deleted.id, memberId, { value_md: '旧欄の値' });
    await createTaskFieldValue(target.organization, task.id, criteria.id, memberId, { value_md: '基準を書いた' });

    const partly = await call<{ fields: unknown[]; unfilled: boolean }>(taskDetail, target, { task_id: task.id });
    expect(partly.status).toBe(200);
    expect(partly.body.fields).toEqual([
      { id: criteria.id, name: '受け入れ基準', value_md: '基準を書いた' },
      { id: impact.id, name: '影響範囲', value_md: null },
    ]);
    expect(partly.body.unfilled).toBe(true);

    await setField(target, task.id, impact.id, '画面 A', null);
    const filled = await call<{ unfilled: boolean }>(taskDetail, target, { task_id: task.id });
    expect(filled.body.unfilled).toBe(false);
  });

  test('完了したタスクは値が無くても未記入にならない。欄が 1 つも無ければ未記入にならない', async () => {
    const { target, task } = await world();
    await call(taskComplete, target, { task_id: task.id });
    const done = await call<{ unfilled: boolean; fields: unknown[] }>(taskDetail, target, { task_id: task.id });
    expect(done.body.unfilled).toBe(false);
    expect(done.body.fields).toHaveLength(2);

    const plain = await createTarget();
    const bare = await createTask(plain.organization, plain.workspace.id, plain.member.userId!);
    const none = await call<{ unfilled: boolean; fields: unknown[] }>(taskDetail, plain, { task_id: bare.id });
    expect(none.body).toMatchObject({ unfilled: false, fields: [] });
  });

  test('欄を削除すると、その欄は未記入の判定から外れる（値の行は残る）', async () => {
    const { target, memberId, criteria, impact, task } = await world();
    await createTaskFieldValue(target.organization, task.id, criteria.id, memberId);
    const before = await call<{ unfilled: boolean }>(taskDetail, target, { task_id: task.id });
    expect(before.body.unfilled).toBe(true);
    expect((await call(detailFieldDelete, target, { field_id: impact.id }, target.leader)).status).toBe(200);
    const after = await call<{ unfilled: boolean; fields: { id: string }[] }>(taskDetail, target, {
      task_id: task.id,
    });
    expect(after.body.unfilled).toBe(false);
    expect(after.body.fields.map((field) => field.id)).toEqual([criteria.id]);
  });

  test('backlog-tree は各タスクの未記入と、絞り込みに関わらないワークスペース全体の件数を返す。完了と削除したタスクは数えない', async () => {
    const { target, memberId, criteria, impact, task } = await world();
    const { organization } = target;
    const workspaceId = target.workspace.id;
    const story = await createStory(organization, workspaceId, memberId, { title: '決済の画面' });
    const inStory = await createTask(organization, workspaceId, memberId, {
      story_id: story.id,
      title: '入力欄を作る',
    });
    const filled = await createTask(organization, workspaceId, memberId, { title: '書き終えた', position: 'a1' });
    await createTaskFieldValue(organization, filled.id, criteria.id, memberId);
    await createTaskFieldValue(organization, filled.id, impact.id, memberId);
    await createTask(organization, workspaceId, memberId, {
      title: '終えた',
      completed_at: '2026-10-21T00:00:00.000Z',
      completed_by: memberId,
    });
    await createTask(organization, workspaceId, memberId, { title: '消した', deleted_at: '2026-10-21T00:00:00.000Z' });
    await createTask(organization, target.otherWorkspace.id, target.bystander.userId!, { title: '別のワークスペース' });

    type Tree = {
      tasks: { id: string; unfilled: boolean }[];
      stories: { tasks: { id: string; unfilled: boolean }[] }[];
      unfilled_count: number;
    };
    const all = await call<Tree>(backlogTree, target, {});
    expect(all.status).toBe(200);
    const rows = Object.fromEntries(
      [...all.body.tasks, ...all.body.stories.flatMap((s) => s.tasks)].map((row) => [row.id, row.unfilled]),
    );
    expect(rows[task.id]).toBe(true);
    expect(rows[inStory.id]).toBe(true);
    expect(rows[filled.id]).toBe(false);
    expect(Object.keys(rows)).toHaveLength(3);
    // 値の無いタスク 2 件。完了したタスク、削除したタスク、別のワークスペースのタスクは数えない
    expect(all.body.unfilled_count).toBe(2);

    // 絞り込みで行が減っても、件数はワークスペース全体のまま
    const filteredOut = await call<Tree>(backlogTree, target, { query: '書き終えた' });
    expect(filteredOut.body.tasks.map((row) => row.id)).toEqual([filled.id]);
    expect(filteredOut.body.unfilled_count).toBe(2);

    // 欄を全部削除すると、件数は 0 で、行の印も消える
    await call(detailFieldDelete, target, { field_id: criteria.id }, target.leader);
    await call(detailFieldDelete, target, { field_id: impact.id }, target.leader);
    const noFields = await call<Tree>(backlogTree, target, {});
    expect(noFields.body.unfilled_count).toBe(0);
    expect(noFields.body.tasks.every((row) => !row.unfilled)).toBe(true);
  });

  test('task-create が返す行は、欄があれば未記入、無ければ未記入でない', async () => {
    const { target } = await world();
    const created = await call<{ task: { unfilled: boolean } }>(taskCreate, target, { title: '新しいタスク' });
    expect(created.status).toBe(200);
    expect(created.body.task.unfilled).toBe(true);

    const plain = await createTarget();
    const bare = await call<{ task: { unfilled: boolean } }>(taskCreate, plain, { title: '新しいタスク' });
    expect(bare.body.task.unfilled).toBe(false);
  });

  test('別のワークスペースと別の組織の欄は、欄の一覧にも未記入の判定にも件数にも混ざらない', async () => {
    const target = await createTarget();
    const { organization } = target;
    const memberId = target.member.userId!;
    // 自分のワークスペースは欄が 0 件で、タスクが 1 件（スプリントに入っている）
    const task = await createTask(organization, target.workspace.id, memberId);
    const sprint = await createSprint(organization, target.workspace.id, { status: 'planned' });
    const column = await createBoardColumn(organization, target.workspace.id);
    await createTask(organization, target.workspace.id, memberId, {
      sprint_id: sprint.id,
      column_id: column.id,
      column_position: 'a0',
    });
    // 別のワークスペースと別の組織に、欄を 1 件ずつ
    await createDetailField(organization, target.otherWorkspace.id, { name: '別のワークスペースの欄' });
    const stranger = await createTarget();
    await createDetailField(stranger.organization, stranger.workspace.id, { name: '別の組織の欄' });

    const detail = await call<{ fields: unknown[]; unfilled: boolean }>(taskDetail, target, { task_id: task.id });
    expect(detail.body).toMatchObject({ fields: [], unfilled: false });
    const list = await call<{ fields: unknown[] }>(detailFieldList, target, {});
    expect(list.body.fields).toEqual([]);
    const tree = await call<{ tasks: { unfilled: boolean }[]; unfilled_count: number }>(backlogTree, target, {});
    expect(tree.body.unfilled_count).toBe(0);
    expect(tree.body.tasks.every((row) => !row.unfilled)).toBe(true);
    const plan = await call<{ lanes: { unfilled_count: number }[] }>(planSummary, target, {});
    expect(plan.body.lanes.map((lane) => lane.unfilled_count)).toEqual([0]);
  });

  test('印と件数の範囲は、完了していないバックログ（tray = backlog）のタスクだけ。受信箱のタスクは未記入にしない', async () => {
    const { target, criteria, task } = await world();
    const inbox = await createTask(target.organization, target.workspace.id, target.member.userId!, {
      is_imported: 1,
      tray: 'inbox',
    });
    const detail = await call<{ unfilled: boolean; in_backlog: boolean }>(taskDetail, target, { task_id: inbox.id });
    expect(detail.body.unfilled).toBe(false);
    // 引き出しの欄ごとの印も同じ範囲で決めるので、バックログのタスクかを返す
    expect(detail.body.in_backlog).toBe(false);
    const backlogDetail = await call<{ in_backlog: boolean }>(taskDetail, target, { task_id: task.id });
    expect(backlogDetail.body.in_backlog).toBe(true);
    // 受信箱のタスクにも書けるが、そのタスクは未記入にならない
    const set = await setField(target, inbox.id, criteria.id, '受信箱で書いた', null);
    expect(set.status).toBe(200);
    expect(set.body.unfilled).toBe(false);
    await setField(target, inbox.id, criteria.id, null, '受信箱で書いた');
    // 件数はバックログのタスクだけ（world のバックログのタスク 1 件）
    const tree = await call<{ unfilled_count: number }>(backlogTree, target, {});
    expect(tree.body.unfilled_count).toBe(1);
    expect(task.tray).toBe('backlog');
  });

  test('成功した書き込みを再送しても 200 で今の値を返し、履歴は 1 件のまま', async () => {
    const { target, criteria, task } = await world();
    const first = await setField(target, task.id, criteria.id, 'x', null);
    const again = await setField(target, task.id, criteria.id, 'x', null);
    expect(first.status).toBe(200);
    expect(again.status).toBe(200);
    expect(again.body.field.value_md).toBe('x');
    expect(await taskLogs(target, task.id)).toHaveLength(1);

    // 空にする書き込みの再送も同じ
    const cleared = await setField(target, task.id, criteria.id, null, 'x');
    const clearedAgain = await setField(target, task.id, criteria.id, null, 'x');
    expect(cleared.status).toBe(200);
    expect(clearedAgain.status).toBe(200);
    expect(clearedAgain.body.field.value_md).toBeNull();
    expect(await taskLogs(target, task.id)).toHaveLength(2);

    // 違う値が入っているときは、これまでどおり 409 の changed
    await setField(target, task.id, criteria.id, '別の人の値', null);
    expect((await setField(target, task.id, criteria.id, 'y', 'x')).status).toBe(409);
  });

  test('件数の文は、ワークスペースの未完了のタスクを tasks_workspace_tray で引く', async () => {
    const { target } = await world();
    const db = orgDb(env, target.organization.verified);
    const plan = (await queryPlanForTest(env, unfilledCountStatement(db, target.workspace.id))).join('\n');
    expect(plan).toMatch(/USING (COVERING )?INDEX tasks_workspace_tray/);
  });
});
