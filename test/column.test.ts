// スプリントの列の操作（column-list、column-create、column-update、column-move、column-delete）の振る舞い。
// 組織の分離と権限の種類ごとの許可と拒否は、一覧を回す test/operation-registry.test.ts が確かめる。ここでは要の場面だけを重ねて見る
import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import { COLUMNS_PER_WORKSPACE, COLUMN_NAME_MAX_LENGTH } from '../src/shared/column.ts';
import {
  columnCreate,
  columnDelete,
  columnList,
  columnMove,
  columnUpdate,
} from '../src/shared/operations/column/index.ts';
import type { AnyOperationDefinition } from '../src/shared/operations/define.ts';
import { sprintBoard } from '../src/shared/operations/sprint/index.ts';
import { createApp } from '../src/server/app.ts';
import { orgDb, verifyWorkspace } from '../src/server/db/index.ts';
import { columnCreateOperation, columnDeleteOperation, columnMoveOperation } from '../src/server/operations/column.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import { createBoardColumn, createSprint, createSprintEntry, createTask, createWorkspace } from './factories.ts';
import { post } from './operations/harness.ts';
import { createTarget, type Person, type Target } from './operations/world.ts';

const app = createApp(implementedOperations);

type ErrorBody = { error: { code: string; details?: { reason?: string } } };
type ListedColumn = { id: string; name: string; is_done: boolean; task_count: number };

async function call<T = Record<string, unknown>>(
  definition: AnyOperationDefinition,
  target: Target,
  body: Record<string, unknown>,
  person: Person = target.leader,
): Promise<{ status: number; body: T }> {
  const res = await post(app, definition, {
    slug: target.slug,
    token: person.token,
    body: { workspace_id: target.workspace.id, ...body },
  });
  return { status: res.status, body: (await res.json()) as T };
}

async function list(target: Target, person: Person = target.member): Promise<ListedColumn[]> {
  const res = await call<{ columns: ListedColumn[] }>(columnList, target, {}, person);
  expect(res.status).toBe(200);
  return res.body.columns;
}

async function names(target: Target): Promise<string[]> {
  return (await list(target)).map((column) => (column.is_done ? '(完了)' : column.name));
}

// ワークスペースの作成と同じ形の列（完了でない列を3つと完了の列）。完了の列は position を使わないので、先頭に来ないことも確かめる
async function createBoard(target: Target) {
  const done = await createBoardColumn(target.organization, target.workspace.id, {
    name: null,
    is_done: 1,
    position: 'Zz',
  });
  const a = await createBoardColumn(target.organization, target.workspace.id, { name: '出発前', position: 'a0' });
  const b = await createBoardColumn(target.organization, target.workspace.id, { name: '遂行中', position: 'a1' });
  const c = await createBoardColumn(target.organization, target.workspace.id, { name: '査定中', position: 'a2' });
  return { done: done.id, a: a.id, b: b.id, c: c.id };
}

async function logsOf(target: Target, entityType: string, entityId: string) {
  const db = orgDb(env, target.organization.verified);
  const rows = await db.rows(
    db.statement((q) =>
      q
        .selectFrom('change_logs')
        .select(['action', 'changes_json', 'workspace_id', 'actor_user_id'])
        .where('organization_id', '=', target.organization.id)
        .where('entity_type', '=', entityType)
        .where('entity_id', '=', entityId)
        .orderBy('created_at')
        .orderBy('id'),
    ),
  );
  return rows.map((row) => ({ ...row, changes: JSON.parse(row.changes_json) as Record<string, unknown> }));
}

async function taskRow(target: Target, id: string) {
  const db = orgDb(env, target.organization.verified);
  return (await db.first(
    db.statement((q) =>
      q
        .selectFrom('tasks')
        .select(['id', 'sprint_id', 'column_id', 'column_position', 'updated_at'])
        .where('id', '=', id)
        .where('workspace_id', '=', target.workspace.id),
    ),
  ))!;
}

// 列にいるタスクの ID を、スプリントの中の並び（column_position、id）で返す
async function orderIn(target: Target, sprintId: string, columnId: string): Promise<string[]> {
  const db = orgDb(env, target.organization.verified);
  const rows = await db.rows(
    db.statement((q) =>
      q
        .selectFrom('tasks')
        .select('id')
        .where('workspace_id', '=', target.workspace.id)
        .where('sprint_id', '=', sprintId)
        .where('column_id', '=', columnId)
        .where('deleted_at', 'is', null)
        .orderBy('column_position')
        .orderBy('id'),
    ),
  );
  return rows.map((row) => row.id);
}

async function boardColumnRow(target: Target, id: string, workspaceId: string = target.workspace.id) {
  const db = orgDb(env, target.organization.verified);
  return (await db.first(
    db.statement((q) =>
      q.selectFrom('board_columns').selectAll().where('id', '=', id).where('workspace_id', '=', workspaceId),
    ),
  ))!;
}

async function cardIn(
  target: Target,
  sprintId: string,
  columnId: string,
  position: string,
  overrides: Record<string, unknown> = {},
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

// 処理を直に呼び、db の method の nth 回目の呼び出しが返った直後に、1回だけ race を走らせる（読んでから書くまでの割り込み）。
// 登録の関数を通らないので、閉じたワークスペースなどの事前の確かめは掛からず、書く文の条件だけが効く
async function withRace(
  target: Target,
  operation: { handler: (context: never) => Promise<unknown> },
  input: Record<string, unknown>,
  race: { method: 'batch' | 'first'; nth: number; run: () => Promise<void> },
  person: Person = target.leader,
): Promise<unknown> {
  const db = orgDb(env, target.organization.verified);
  const actor = { accountId: person.accountId, userId: person.userId, isAdmin: false, invitedOnly: false };
  const workspace = await verifyWorkspace(db, actor, target.workspace.id);
  let calls = 0;
  const racing = new Proxy(db, {
    get(base, key) {
      const value = Reflect.get(base, key, base);
      if (typeof value !== 'function') return value;
      if (key !== race.method) return value.bind(base);
      return async (...args: unknown[]) => {
        const result = await (value as (...a: unknown[]) => Promise<unknown>).apply(base, args);
        if (++calls === race.nth) await race.run();
        return result;
      };
    },
  });
  return operation.handler({
    db: racing,
    actor,
    workspace,
    input: { workspace_id: target.workspace.id, ...input },
    defer: () => {},
  } as never);
}

async function closeWorkspace(target: Target): Promise<void> {
  const db = orgDb(env, target.organization.verified);
  await db.run(
    db.statement((q) =>
      q
        .updateTable('workspaces')
        .set({ closed_at: '2026-10-22T00:00:00.000Z' })
        .where('id', '=', target.workspace.id)
        .where('organization_id', '=', target.organization.id),
    ),
  );
}

function updateRow(table: 'sprints' | 'board_columns', target: Target, id: string, values: Record<string, unknown>) {
  const db = orgDb(env, target.organization.verified);
  return db.run(
    db.statement((q) =>
      q
        .updateTable(table as 'sprints')
        .set(values as never)
        .where('id', '=', id)
        .where('workspace_id', '=', target.workspace.id),
    ),
  );
}

describe('column-list', () => {
  test('メンバーも読める。完了の列は最後で name が空、削除した列は返さない。タスクの数は進行中と先のスプリントの未完了だけ数える', async () => {
    const target = await createTarget();
    const board = await createBoard(target);
    await createBoardColumn(target.organization, target.workspace.id, {
      name: '旧列',
      position: 'a3',
      deleted_at: '2026-10-21T00:00:00.000Z',
    });
    const active = await createSprint(target.organization, target.workspace.id, { status: 'active' });
    const closed = await createSprint(target.organization, target.workspace.id, {
      status: 'closed',
      start_on: '2026-10-01',
      end_on: '2026-10-14',
    });
    await cardIn(target, active.id, board.a, 'a0');
    await cardIn(target, active.id, board.a, 'a1');
    await cardIn(target, active.id, board.b, 'a0');
    // 数えない: 完了したタスク、削除したタスク、終了したスプリントのカード
    await cardIn(target, active.id, board.done, 'a0', { completed_at: '2026-10-22T00:00:00.000Z' });
    await cardIn(target, active.id, board.a, 'a2', { deleted_at: '2026-10-22T00:00:00.000Z' });
    await cardIn(target, closed.id, board.a, 'a0');

    const columns = await list(target);
    expect(columns).toEqual([
      { id: board.a, name: '出発前', is_done: false, task_count: 2 },
      { id: board.b, name: '遂行中', is_done: false, task_count: 1 },
      { id: board.c, name: '査定中', is_done: false, task_count: 0 },
      { id: board.done, name: '', is_done: true, task_count: 0 },
    ]);
  });

  test('別のワークスペースの列は返さない。閉じたワークスペースでも読める', async () => {
    const target = await createTarget();
    await createBoard(target);
    await createBoardColumn(target.organization, target.otherWorkspace.id, { name: '別の列' });
    expect(await names(target)).toEqual(['出発前', '遂行中', '査定中', '(完了)']);
    const closed = await createTarget({ closed: true });
    expect((await call(columnList, closed, {}, closed.admin)).status).toBe(200);
  });
});

describe('column-create', () => {
  test('リーダーが足すと完了以外の列の末尾に並び（完了の列は最後のまま）、変更の履歴が残る。名前の前後の空白は落とす', async () => {
    const target = await createTarget();
    await createBoard(target);
    const res = await call<{ column: ListedColumn }>(columnCreate, target, { name: '  確認待ち  ' });
    expect(res.status).toBe(200);
    expect(res.body.column).toMatchObject({ name: '確認待ち', is_done: false });
    expect(await names(target)).toEqual(['出発前', '遂行中', '査定中', '確認待ち', '(完了)']);
    expect(await logsOf(target, 'workspace', target.workspace.id)).toMatchObject([
      {
        action: 'update',
        workspace_id: target.workspace.id,
        actor_user_id: target.leader.userId,
        changes: { column: [null, { id: res.body.column.id, name: '確認待ち' }] },
      },
    ]);
    // 管理者も足せる
    expect((await call(columnCreate, target, { name: '公開待ち' }, target.admin)).status).toBe(200);
  });

  test('列が1つも無いワークスペースにも足せる', async () => {
    const target = await createTarget();
    expect((await call(columnCreate, target, { name: '最初' })).status).toBe(200);
    expect(await names(target)).toEqual(['最初']);
  });

  test('同じワークスペースの削除していない同じ名前は 409 の duplicate_name。削除した名前と別のワークスペースの名前は使え、同時に足しても1つだけ入る', async () => {
    const target = await createTarget();
    await createBoard(target);
    await createBoardColumn(target.organization, target.workspace.id, {
      name: '旧列',
      position: 'a3',
      deleted_at: '2026-10-21T00:00:00.000Z',
    });
    await createBoardColumn(target.organization, target.otherWorkspace.id, { name: '別' });
    const duplicate = await call<ErrorBody>(columnCreate, target, { name: '遂行中' });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error).toMatchObject({ code: 'conflict', details: { reason: 'duplicate_name' } });
    expect((await call(columnCreate, target, { name: '旧列' })).status).toBe(200);
    expect((await call(columnCreate, target, { name: '別' })).status).toBe(200);
    const results = await Promise.all([
      call(columnCreate, target, { name: '同時' }),
      call(columnCreate, target, { name: '同時' }),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
    expect((await names(target)).filter((name) => name === '同時')).toHaveLength(1);
  });

  test(`完了以外の列が ${COLUMNS_PER_WORKSPACE} 件あれば 409 の limit。完了の列と削除した列は数えず、同時に足しても上限を超えない`, async () => {
    const target = await createTarget();
    await createBoardColumn(target.organization, target.workspace.id, { name: null, is_done: 1, position: 'Zz' });
    await createBoardColumn(target.organization, target.workspace.id, {
      name: '旧列',
      position: 'a0',
      deleted_at: '2026-10-21T00:00:00.000Z',
    });
    for (let index = 0; index < COLUMNS_PER_WORKSPACE - 1; index++) {
      expect((await call(columnCreate, target, { name: `列 ${index}` })).status).toBe(200);
    }
    // あと1つ入る所へ、同時に2つ
    const results = await Promise.all([
      call<ErrorBody>(columnCreate, target, { name: '同時 A' }),
      call<ErrorBody>(columnCreate, target, { name: '同時 B' }),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
    expect(results.find((result) => result.status === 409)?.body.error.details?.reason).toBe('limit');
    const columns = await list(target);
    expect(columns.filter((column) => !column.is_done)).toHaveLength(COLUMNS_PER_WORKSPACE);
    // 1つ削除すると、また足せる
    const first = columns[0]!;
    expect((await call(columnDelete, target, { column_id: first.id })).status).toBe(200);
    expect((await call(columnCreate, target, { name: '超える' })).status).toBe(200);
  });

  test(`空の名前、見えない文字、${COLUMN_NAME_MAX_LENGTH + 1} 字の名前は 400。${COLUMN_NAME_MAX_LENGTH} 字は通る。閉じたワークスペースは 409 の workspace_closed`, async () => {
    const target = await createTarget();
    expect((await call(columnCreate, target, { name: '   ' })).status).toBe(400);
    expect((await call(columnCreate, target, { name: 'あ​い' })).status).toBe(400);
    expect((await call(columnCreate, target, { name: 'あ'.repeat(COLUMN_NAME_MAX_LENGTH + 1) })).status).toBe(400);
    expect((await call(columnCreate, target, { name: 'あ'.repeat(COLUMN_NAME_MAX_LENGTH) })).status).toBe(200);
    const closed = await createTarget({ closed: true });
    const res = await call<ErrorBody>(columnCreate, closed, { name: '確認待ち' }, closed.admin);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('workspace_closed');
  });

  test('一般のメンバーは足せず（403）、列の設定を変える4つの操作も断られる', async () => {
    const target = await createTarget();
    const board = await createBoard(target);
    expect((await call(columnCreate, target, { name: '確認待ち' }, target.member)).status).toBe(403);
    expect((await call(columnUpdate, target, { column_id: board.a, name: '直す' }, target.member)).status).toBe(403);
    expect((await call(columnMove, target, { column_id: board.a }, target.member)).status).toBe(403);
    expect((await call(columnDelete, target, { column_id: board.a }, target.member)).status).toBe(403);
    expect(await names(target)).toEqual(['出発前', '遂行中', '査定中', '(完了)']);
  });
});

describe('column-update', () => {
  test('名前を直し、前後の名前を履歴に残す。同じ名前を送るだけなら何も書かない', async () => {
    const target = await createTarget();
    const board = await createBoard(target);
    const res = await call<{ column: ListedColumn }>(columnUpdate, target, { column_id: board.b, name: ' 作業中 ' });
    expect(res.status).toBe(200);
    expect(res.body.column).toMatchObject({ id: board.b, name: '作業中', is_done: false });
    expect(await names(target)).toEqual(['出発前', '作業中', '査定中', '(完了)']);
    expect(await logsOf(target, 'workspace', target.workspace.id)).toMatchObject([
      {
        action: 'update',
        changes: {
          column: [
            { id: board.b, name: '遂行中' },
            { id: board.b, name: '作業中' },
          ],
        },
      },
    ]);
    expect((await call(columnUpdate, target, { column_id: board.b, name: '作業中' })).status).toBe(200);
    expect(await logsOf(target, 'workspace', target.workspace.id)).toHaveLength(1);
  });

  test('応答の task_count は、column-list と同じ数（タスクのある列を改名しても、名前を変えなくても）', async () => {
    const target = await createTarget();
    const board = await createBoard(target);
    const active = await createSprint(target.organization, target.workspace.id, { status: 'active' });
    await cardIn(target, active.id, board.b, 'a0');
    await cardIn(target, active.id, board.b, 'a1');
    const renamed = await call<{ column: ListedColumn }>(columnUpdate, target, { column_id: board.b, name: '作業中' });
    expect(renamed.body.column.task_count).toBe(2);
    const same = await call<{ column: ListedColumn }>(columnUpdate, target, { column_id: board.b, name: '作業中' });
    expect(same.body.column.task_count).toBe(2);
    const listed = (await list(target)).find((column) => column.id === board.b);
    expect(listed?.task_count).toBe(2);
    expect(renamed.body.column).toEqual(listed);
  });

  test('ほかの列と同じ名前は 409 の duplicate_name。自分の名前の付け直しは通る', async () => {
    const target = await createTarget();
    const board = await createBoard(target);
    const res = await call<ErrorBody>(columnUpdate, target, { column_id: board.b, name: '出発前' });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: 'conflict', details: { reason: 'duplicate_name' } });
    expect((await call(columnUpdate, target, { column_id: board.b, name: '遂行中' })).status).toBe(200);
    // 同時に別の列を同じ名前へ直しても、1つだけ通る
    const results = await Promise.all([
      call(columnUpdate, target, { column_id: board.a, name: '同時' }),
      call(columnUpdate, target, { column_id: board.c, name: '同時' }),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
  });

  test('完了の列、削除した列、別のワークスペースの列は 404。閉じたワークスペースは 409', async () => {
    const target = await createTarget();
    const board = await createBoard(target);
    const gone = await createBoardColumn(target.organization, target.workspace.id, {
      name: '旧列',
      position: 'a3',
      deleted_at: '2026-10-21T00:00:00.000Z',
    });
    const elsewhere = await createBoardColumn(target.organization, target.otherWorkspace.id, { name: '別の列' });
    for (const id of [board.done, gone.id, elsewhere.id]) {
      expect((await call(columnUpdate, target, { column_id: id, name: '直す' })).status).toBe(404);
    }
    expect(await boardColumnRow(target, board.done)).toMatchObject({ name: null, is_done: 1 });
    const closed = await createTarget({ closed: true });
    const closedBoard = await createBoard(closed);
    const res = await call<ErrorBody>(columnUpdate, closed, { column_id: closedBoard.a, name: '直す' }, closed.admin);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('workspace_closed');
  });
});

describe('column-move', () => {
  test('直前の列の直後、先頭、末尾へ動かせる。完了の列は常に最後のままで、履歴は残さない', async () => {
    const target = await createTarget();
    const board = await createBoard(target);
    expect((await call(columnMove, target, { column_id: board.c, after_column_id: null })).status).toBe(200);
    expect(await names(target)).toEqual(['査定中', '出発前', '遂行中', '(完了)']);
    expect((await call(columnMove, target, { column_id: board.c, after_column_id: board.a })).status).toBe(200);
    expect(await names(target)).toEqual(['出発前', '査定中', '遂行中', '(完了)']);
    expect((await call(columnMove, target, { column_id: board.a })).status).toBe(200);
    expect(await names(target)).toEqual(['査定中', '遂行中', '出発前', '(完了)']);
    expect(await logsOf(target, 'workspace', target.workspace.id)).toEqual([]);
  });

  test('完了の列は動かせず、直前にも指せない（404）。自分自身を指すと 400。無い列と別のワークスペースの列は 404', async () => {
    const target = await createTarget();
    const board = await createBoard(target);
    expect((await call(columnMove, target, { column_id: board.done, after_column_id: null })).status).toBe(404);
    expect((await call(columnMove, target, { column_id: board.a, after_column_id: board.done })).status).toBe(404);
    expect((await call(columnMove, target, { column_id: board.a, after_column_id: board.a })).status).toBe(400);
    const elsewhere = await createBoardColumn(target.organization, target.otherWorkspace.id, { name: '別の列' });
    expect((await call(columnMove, target, { column_id: elsewhere.id })).status).toBe(404);
    expect((await call(columnMove, target, { column_id: board.a, after_column_id: elsewhere.id })).status).toBe(404);
    expect(await names(target)).toEqual(['出発前', '遂行中', '査定中', '(完了)']);
  });

  test('別の組織の列を直前に指すと 404 で、並びは変わらない', async () => {
    const target = await createTarget();
    const other = await createTarget();
    const board = await createBoard(target);
    const otherBoard = await createBoard(other);
    expect((await call(columnMove, target, { column_id: board.a, after_column_id: otherBoard.b })).status).toBe(404);
    expect(await names(target)).toEqual(['出発前', '遂行中', '査定中', '(完了)']);
    expect(await names(other)).toEqual(['出発前', '遂行中', '査定中', '(完了)']);
  });

  test('同じ位置の列が並んでいる直後へ置いても、並びが壊れない', async () => {
    const target = await createTarget();
    await createBoardColumn(target.organization, target.workspace.id, { name: null, is_done: 1, position: 'Zz' });
    const a = await createBoardColumn(target.organization, target.workspace.id, { name: '甲', position: 'a0' });
    const b = await createBoardColumn(target.organization, target.workspace.id, { name: '乙', position: 'a0' });
    const c = await createBoardColumn(target.organization, target.workspace.id, { name: '丙', position: 'a1' });
    const order = (await list(target)).map((column) => column.id);
    const first = order[0]!;
    const second = order[1]!;
    expect((await call(columnMove, target, { column_id: c.id, after_column_id: first })).status).toBe(200);
    expect((await list(target)).map((column) => column.id).slice(0, 3)).toEqual([first, c.id, second]);
    expect([a.id, b.id]).toContain(first);
  });
});

describe('column-delete', () => {
  test('進行中と先のスプリントの未完了のタスクを、移し先の列のそのスプリントでの末尾へ、列の中の順を保って移す。終了したスプリントのカードと完了したタスクは変えない', async () => {
    const target = await createTarget();
    const board = await createBoard(target);
    const active = await createSprint(target.organization, target.workspace.id, { status: 'active' });
    const planned = await createSprint(target.organization, target.workspace.id, {
      start_on: '2030-01-07',
      end_on: '2030-01-20',
    });
    const closed = await createSprint(target.organization, target.workspace.id, {
      status: 'closed',
      start_on: '2026-10-01',
      end_on: '2026-10-14',
    });
    // 進行中: 消す列に2枚（位置の逆順に作る）、移し先に1枚、完了の列に1枚
    const second = await cardIn(target, active.id, board.a, 'a1');
    const first = await cardIn(target, active.id, board.a, 'a0');
    const resident = await cardIn(target, active.id, board.b, 'a0');
    const finished = await cardIn(target, active.id, board.done, 'a0', { completed_at: '2026-10-22T00:00:00.000Z' });
    // 先のスプリント: 消す列に1枚、移し先に1枚（位置は遠い）
    const plannedMoving = await cardIn(target, planned.id, board.a, 'a0');
    const plannedResident = await cardIn(target, planned.id, board.b, 'a5');
    // 終了したスプリント: 消す列を指したまま残る
    const archived = await cardIn(target, closed.id, board.a, 'a0');
    const archivedBefore = await taskRow(target, archived.id);
    // 別のワークスペースの同じ名前の列と、消す列にいない進行中のカード
    const untouched = await cardIn(target, active.id, board.c, 'a0');
    const untouchedBefore = await taskRow(target, untouched.id);

    const res = await call<{ column_id: string; moved_count: number }>(columnDelete, target, {
      column_id: board.a,
      target_column_id: board.b,
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ column_id: board.a, moved_count: 3 });

    expect(await orderIn(target, active.id, board.b)).toEqual([resident.id, first.id, second.id]);
    expect(await orderIn(target, planned.id, board.b)).toEqual([plannedResident.id, plannedMoving.id]);
    expect(await orderIn(target, active.id, board.a)).toEqual([]);
    expect((await taskRow(target, finished.id)).column_id).toBe(board.done);
    expect(await taskRow(target, archived.id)).toEqual(archivedBefore);
    expect((await taskRow(target, archived.id)).column_id).toBe(board.a);
    expect(await taskRow(target, untouched.id)).toEqual(untouchedBefore);
    expect(await boardColumnRow(target, board.a)).toMatchObject({ is_done: 0 });
    expect((await boardColumnRow(target, board.a)).deleted_at).not.toBeNull();
    expect(await names(target)).toEqual(['遂行中', '査定中', '(完了)']);

    // 移したタスクの履歴は task-column-move と同じ形
    for (const task of [first, second, plannedMoving]) {
      expect(await logsOf(target, 'task', task.id)).toMatchObject([
        {
          action: 'update',
          actor_user_id: target.leader.userId,
          changes: {
            column: [
              { id: board.a, name: '出発前' },
              { id: board.b, name: '遂行中' },
            ],
          },
        },
      ]);
    }
    for (const task of [resident, finished, archived, untouched]) {
      expect(await logsOf(target, 'task', task.id)).toEqual([]);
    }
    expect(await logsOf(target, 'workspace', target.workspace.id)).toMatchObject([
      {
        action: 'update',
        changes: {
          column: [{ id: board.a, name: '出発前' }, null],
          target_column: [null, { id: board.b, name: '遂行中' }],
        },
      },
    ]);
  });

  test('スプリントの画面は、移したカードを移し先の列に出す', async () => {
    const target = await createTarget();
    const board = await createBoard(target);
    const active = await createSprint(target.organization, target.workspace.id, { status: 'active' });
    const card = await cardIn(target, active.id, board.a, 'a0', { title: '見積もりを送る' });
    expect((await call(columnDelete, target, { column_id: board.a, target_column_id: board.c })).status).toBe(200);
    const res = await call<{ columns: { name: string; tasks: { id: string }[] }[] }>(
      sprintBoard,
      target,
      {},
      target.member,
    );
    expect(res.status).toBe(200);
    expect(res.body.columns.map((column) => column.tasks.map((task) => task.id))).toEqual([[], [card.id], []]);
    expect(res.body.columns.map((column) => column.name)).toEqual(['遂行中', '査定中', null]);
  });

  test('移すタスクが無ければ移し先は要らない。送っても通るが、移し先は履歴に書かない', async () => {
    const target = await createTarget();
    const board = await createBoard(target);
    const first = await call<{ moved_count: number }>(columnDelete, target, { column_id: board.a });
    expect(first.status).toBe(200);
    expect(first.body.moved_count).toBe(0);
    expect(await logsOf(target, 'workspace', target.workspace.id)).toMatchObject([
      { changes: { column: [{ id: board.a, name: '出発前' }, null] } },
    ]);
    const second = await call<{ moved_count: number }>(columnDelete, target, {
      column_id: board.b,
      target_column_id: board.c,
    });
    expect(second.status).toBe(200);
    expect(second.body.moved_count).toBe(0);
    expect(await names(target)).toEqual(['査定中', '(完了)']);
    const logs = await logsOf(target, 'workspace', target.workspace.id);
    expect(logs).toHaveLength(2);
    expect(logs[1]!.changes).toEqual({ column: [{ id: board.b, name: '遂行中' }, null] });
  });

  test('移すタスクがあるのに移し先が無ければ 409 の target_required。移し先が自分自身か完了の列なら 409 の target_invalid、無い列と別のワークスペースの列は 404。何も書かない', async () => {
    const target = await createTarget();
    const board = await createBoard(target);
    const active = await createSprint(target.organization, target.workspace.id, { status: 'active' });
    const card = await cardIn(target, active.id, board.a, 'a0');
    const gone = await createBoardColumn(target.organization, target.workspace.id, {
      name: '旧列',
      position: 'a3',
      deleted_at: '2026-10-21T00:00:00.000Z',
    });
    const elsewhere = await createBoardColumn(target.organization, target.otherWorkspace.id, { name: '別の列' });

    const required = await call<ErrorBody>(columnDelete, target, { column_id: board.a });
    expect(required.status).toBe(409);
    expect(required.body.error).toMatchObject({ code: 'conflict', details: { reason: 'target_required' } });
    for (const targetId of [board.a, board.done]) {
      const res = await call<ErrorBody>(columnDelete, target, { column_id: board.a, target_column_id: targetId });
      expect(res.status).toBe(409);
      expect(res.body.error).toMatchObject({ code: 'conflict', details: { reason: 'target_invalid' } });
    }
    for (const targetId of [gone.id, elsewhere.id]) {
      expect((await call(columnDelete, target, { column_id: board.a, target_column_id: targetId })).status).toBe(404);
    }
    expect((await boardColumnRow(target, board.a)).deleted_at).toBeNull();
    expect((await taskRow(target, card.id)).column_id).toBe(board.a);
    expect(await logsOf(target, 'workspace', target.workspace.id)).toEqual([]);
  });

  test('完了の列は 409 の done_column、完了以外で最後の1つは 409 の last_column。無い列と別のワークスペースの列は 404', async () => {
    const target = await createTarget();
    const board = await createBoard(target);
    const done = await call<ErrorBody>(columnDelete, target, { column_id: board.done, target_column_id: board.a });
    expect(done.status).toBe(409);
    expect(done.body.error).toMatchObject({ code: 'conflict', details: { reason: 'done_column' } });
    const elsewhere = await createBoardColumn(target.organization, target.otherWorkspace.id, { name: '別の列' });
    expect((await call(columnDelete, target, { column_id: elsewhere.id })).status).toBe(404);

    expect((await call(columnDelete, target, { column_id: board.a })).status).toBe(200);
    expect((await call(columnDelete, target, { column_id: board.b })).status).toBe(200);
    const last = await call<ErrorBody>(columnDelete, target, { column_id: board.c });
    expect(last.status).toBe(409);
    expect(last.body.error).toMatchObject({ code: 'conflict', details: { reason: 'last_column' } });
    // 削除済みの列は 404
    expect((await call(columnDelete, target, { column_id: board.a })).status).toBe(404);
    expect(await names(target)).toEqual(['査定中', '(完了)']);
  });

  test('同時に2つの列を消して、完了以外が0になる削除は止まる', async () => {
    const target = await createTarget();
    await createBoardColumn(target.organization, target.workspace.id, { name: null, is_done: 1, position: 'Zz' });
    const a = await createBoardColumn(target.organization, target.workspace.id, { name: '甲', position: 'a0' });
    const b = await createBoardColumn(target.organization, target.workspace.id, { name: '乙', position: 'a1' });
    const results = await Promise.all([
      call<ErrorBody>(columnDelete, target, { column_id: a.id }),
      call<ErrorBody>(columnDelete, target, { column_id: b.id }),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
    expect(results.find((result) => result.status === 409)?.body.error.details?.reason).toBe('last_column');
    expect((await list(target)).filter((column) => !column.is_done)).toHaveLength(1);
  });

  test('同時に、互いを移し先にして消しても、片方だけが通り、タスクは削除していない列に残る', async () => {
    const target = await createTarget();
    const board = await createBoard(target);
    const active = await createSprint(target.organization, target.workspace.id, { status: 'active' });
    const inA = await cardIn(target, active.id, board.a, 'a0');
    const inB = await cardIn(target, active.id, board.b, 'a0');
    const results = await Promise.all([
      call(columnDelete, target, { column_id: board.a, target_column_id: board.b }),
      call(columnDelete, target, { column_id: board.b, target_column_id: board.a }),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([200, 404]);
    const live = (await list(target)).filter((column) => !column.is_done).map((column) => column.id);
    for (const task of [inA, inB]) {
      expect(live).toContain((await taskRow(target, task.id)).column_id);
    }
  });

  test('読んでから書くまでに、消す列へタスクが入っても、読み直して一緒に移す', async () => {
    const target = await createTarget();
    const board = await createBoard(target);
    const active = await createSprint(target.organization, target.workspace.id, { status: 'active' });
    const early = await cardIn(target, active.id, board.a, 'a0');
    let late: Awaited<ReturnType<typeof cardIn>> | undefined;

    // 最初の読み取りの直後に、消す列へカードが入る
    const output = (await withRace(
      target,
      columnDeleteOperation,
      { column_id: board.a, target_column_id: board.b },
      {
        method: 'batch',
        nth: 1,
        run: async () => {
          late = await cardIn(target, active.id, board.a, 'a1');
        },
      },
    )) as { moved_count: number };
    expect(output.moved_count).toBe(2);
    expect(await orderIn(target, active.id, board.b)).toEqual([early.id, late!.id]);
    expect(await orderIn(target, active.id, board.a)).toEqual([]);
  });

  test('閉じたワークスペースは 409 の workspace_closed で、何も消さない', async () => {
    const target = await createTarget({ closed: true });
    const board = await createBoard(target);
    const res = await call<ErrorBody>(columnDelete, target, { column_id: board.a }, target.admin);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('workspace_closed');
    expect((await boardColumnRow(target, board.a)).deleted_at).toBeNull();
  });

  test('別の組織の人は、その組織の slug では 404。別の組織の列を移し先に指しても 404', async () => {
    const target = await createTarget();
    const other = await createTarget();
    const board = await createBoard(target);
    const otherBoard = await createBoard(other);
    const res = await post(app, columnDelete, {
      slug: target.slug,
      token: other.leader.token,
      body: { workspace_id: target.workspace.id, column_id: board.a },
    });
    expect(res.status).toBe(404);
    const active = await createSprint(target.organization, target.workspace.id, { status: 'active' });
    await cardIn(target, active.id, board.a, 'a0');
    const crossed = await call(columnDelete, target, { column_id: board.a, target_column_id: otherBoard.b });
    expect(crossed.status).toBe(404);
    expect((await boardColumnRow(target, board.a)).deleted_at).toBeNull();
  });

  test('別のワークスペースの同じ組織の列は、消す列にも移し先にもできない', async () => {
    const target = await createTarget();
    const board = await createBoard(target);
    const other = await createWorkspace(target.organization, target.admin.userId!);
    const elsewhere = await createBoardColumn(target.organization, other.id, { name: '別の列' });
    await createBoardColumn(target.organization, other.id, { name: '別の列 2', position: 'a1' });
    expect((await call(columnDelete, target, { column_id: elsewhere.id })).status).toBe(404);
    const active = await createSprint(target.organization, target.workspace.id, { status: 'active' });
    await cardIn(target, active.id, board.a, 'a0');
    expect((await call(columnDelete, target, { column_id: board.a, target_column_id: elsewhere.id })).status).toBe(404);
    expect((await boardColumnRow(target, elsewhere.id, other.id)).deleted_at).toBeNull();
  });
});

// 読んでから書くまでの間に別の要求が割り込んでも、書く文の条件が止めることを確かめる（登録の関数の確かめを通らない）
describe('読んでから書くまでの割り込み', () => {
  test('column-delete: 移し先が先に削除されたら 404 で、列もタスクも変わらない', async () => {
    const target = await createTarget();
    const board = await createBoard(target);
    const active = await createSprint(target.organization, target.workspace.id, { status: 'active' });
    const card = await cardIn(target, active.id, board.a, 'a0');
    await expect(
      withRace(
        target,
        columnDeleteOperation,
        { column_id: board.a, target_column_id: board.c },
        {
          method: 'batch',
          nth: 1,
          run: async () => {
            expect((await call(columnDelete, target, { column_id: board.c })).status).toBe(200);
          },
        },
      ),
    ).rejects.toMatchObject({ status: 404, code: 'not_found' });
    expect((await boardColumnRow(target, board.a)).deleted_at).toBeNull();
    expect((await taskRow(target, card.id)).column_id).toBe(board.a);
    expect(await logsOf(target, 'task', card.id)).toEqual([]);
  });

  test('column-delete: 読んだ直後にワークスペースが閉じたら 409 の workspace_closed で、列もタスクも変わらない', async () => {
    const target = await createTarget();
    const board = await createBoard(target);
    const active = await createSprint(target.organization, target.workspace.id, { status: 'active' });
    const card = await cardIn(target, active.id, board.a, 'a0');
    await expect(
      withRace(
        target,
        columnDeleteOperation,
        { column_id: board.a, target_column_id: board.b },
        { method: 'batch', nth: 1, run: () => closeWorkspace(target) },
      ),
    ).rejects.toMatchObject({ status: 409, code: 'workspace_closed' });
    expect((await boardColumnRow(target, board.a)).deleted_at).toBeNull();
    expect((await taskRow(target, card.id)).column_id).toBe(board.a);
    expect(await logsOf(target, 'workspace', target.workspace.id)).toEqual([]);
  });

  test('column-create: 読んだ直後にワークスペースが閉じたら 409 の workspace_closed で、列は増えない', async () => {
    const target = await createTarget();
    await createBoard(target);
    await expect(
      withRace(
        target,
        columnCreateOperation,
        { name: '確認待ち' },
        { method: 'first', nth: 1, run: () => closeWorkspace(target) },
      ),
    ).rejects.toMatchObject({ status: 409, code: 'workspace_closed' });
    expect(await names(target)).toEqual(['出発前', '遂行中', '査定中', '(完了)']);
    expect(await logsOf(target, 'workspace', target.workspace.id)).toEqual([]);
  });

  test('column-delete: 読んだ直後にスプリントが終了していたら、そのスプリントのカードは動かさず、履歴も書かない', async () => {
    const target = await createTarget();
    const board = await createBoard(target);
    const active = await createSprint(target.organization, target.workspace.id, { status: 'active' });
    const planned = await createSprint(target.organization, target.workspace.id, {
      start_on: '2030-01-07',
      end_on: '2030-01-20',
    });
    const inActive = await cardIn(target, active.id, board.a, 'a0');
    const inPlanned = await cardIn(target, planned.id, board.a, 'a0');
    const output = (await withRace(
      target,
      columnDeleteOperation,
      { column_id: board.a, target_column_id: board.b },
      {
        method: 'batch',
        nth: 1,
        run: async () => {
          await updateRow('sprints', target, active.id, { status: 'closed' });
        },
      },
    )) as { moved_count: number };
    expect(output.moved_count).toBe(1);
    expect((await taskRow(target, inPlanned.id)).column_id).toBe(board.b);
    expect((await taskRow(target, inActive.id)).column_id).toBe(board.a);
    expect(await logsOf(target, 'task', inActive.id)).toEqual([]);
    expect(await logsOf(target, 'task', inPlanned.id)).toHaveLength(1);
  });

  test('column-delete: 読んだ直後にタスクが別のスプリントへ移っていたら、そのカードは動かさない', async () => {
    const target = await createTarget();
    const board = await createBoard(target);
    const active = await createSprint(target.organization, target.workspace.id, { status: 'active' });
    const planned = await createSprint(target.organization, target.workspace.id, {
      start_on: '2030-01-07',
      end_on: '2030-01-20',
    });
    const card = await cardIn(target, active.id, board.a, 'a0');
    const db = orgDb(env, target.organization.verified);
    const output = (await withRace(
      target,
      columnDeleteOperation,
      { column_id: board.a, target_column_id: board.b },
      {
        method: 'batch',
        nth: 1,
        // 持ち越しの後のように、同じ列のまま別のスプリントに入る
        run: async () => {
          await db.run(
            db.statement((q) => q.updateTable('tasks').set({ sprint_id: planned.id }).where('id', '=', card.id)),
          );
        },
      },
    )) as { moved_count: number };
    expect(output.moved_count).toBe(0);
    expect((await taskRow(target, card.id)).column_id).toBe(board.a);
    expect(await logsOf(target, 'task', card.id)).toEqual([]);
  });

  test('column-move: 読んだ後に直前の列が動かされたら 409 の changed で、並びは動かさない', async () => {
    const target = await createTarget();
    const board = await createBoard(target);
    await expect(
      withRace(
        target,
        columnMoveOperation,
        { column_id: board.c, after_column_id: board.a },
        {
          method: 'batch',
          nth: 1,
          run: async () => {
            expect((await call(columnMove, target, { column_id: board.a })).status).toBe(200);
          },
        },
      ),
    ).rejects.toMatchObject({ status: 409, code: 'conflict', details: { reason: 'changed' } });
    expect(await names(target)).toEqual(['遂行中', '査定中', '出発前', '(完了)']);
  });

  test('column-move: 読んだ直後に動かす列が完了の列になっていたら、動かさない（404）', async () => {
    const target = await createTarget();
    const a = await createBoardColumn(target.organization, target.workspace.id, { name: '甲', position: 'a0' });
    const b = await createBoardColumn(target.organization, target.workspace.id, { name: '乙', position: 'a1' });
    await expect(
      withRace(
        target,
        columnMoveOperation,
        { column_id: a.id },
        {
          method: 'first',
          nth: 2,
          run: async () => {
            await updateRow('board_columns', target, a.id, { is_done: 1 });
          },
        },
      ),
    ).rejects.toMatchObject({ status: 404, code: 'not_found' });
    expect((await boardColumnRow(target, a.id)).position).toBe('a0');
    expect(b.position).toBe('a1');
  });
});
