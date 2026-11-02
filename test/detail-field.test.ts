// タスクの決まった欄（detail_fields）の定義の操作（detail-field-list、create、update、move、delete）の振る舞い。
// 組織の分離と権限の種類ごとの許可と拒否は、一覧を回す test/operation-registry.test.ts が確かめる
import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import { DETAIL_FIELDS_PER_WORKSPACE } from '../src/shared/definition.ts';
import type { AnyOperationDefinition } from '../src/shared/operations/define.ts';
import {
  detailFieldCreate,
  detailFieldDelete,
  detailFieldList,
  detailFieldMove,
  detailFieldUpdate,
} from '../src/shared/operations/definition/index.ts';
import { createApp } from '../src/server/app.ts';
import { orgDb } from '../src/server/db/index.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import { createDetailField, createTask, createTaskFieldValue } from './factories.ts';
import { post } from './operations/harness.ts';
import { createTarget, type Person, type Target } from './operations/world.ts';

const app = createApp(implementedOperations);

type ErrorBody = { error: { code: string; details?: { reason?: string } } };
type Field = { id: string; name: string };

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

async function list(target: Target): Promise<Field[]> {
  const res = await call<{ fields: Field[] }>(detailFieldList, target, {}, target.member);
  expect(res.status).toBe(200);
  return res.body.fields;
}

async function create(target: Target, name: string): Promise<Field> {
  const res = await call<{ field: Field }>(detailFieldCreate, target, { name });
  expect(res.status).toBe(200);
  return res.body.field;
}

async function logsOf(target: Target, entityId: string) {
  const db = orgDb(env, target.organization.verified);
  const rows = await db.rows(
    db.statement((q) =>
      q
        .selectFrom('change_logs')
        .select(['entity_type', 'action', 'changes_json', 'workspace_id'])
        .where('organization_id', '=', target.organization.id)
        .where('entity_id', '=', entityId)
        .orderBy('created_at')
        .orderBy('id'),
    ),
  );
  return rows.map((row) => ({ ...row, changes: JSON.parse(row.changes_json) as Record<string, unknown> }));
}

describe('detail-field-create と一覧', () => {
  test('リーダーが足すと末尾に並び、変更の履歴が残る。名前の前後の空白は落とす。管理者も足せる', async () => {
    const target = await createTarget();
    const first = await create(target, '  受け入れ基準  ');
    const second = await create(target, '影響範囲');
    expect(first.name).toBe('受け入れ基準');
    expect(await list(target)).toEqual([first, second]);
    expect(await logsOf(target, second.id)).toMatchObject([
      {
        entity_type: 'detail_field',
        action: 'create',
        workspace_id: target.workspace.id,
        changes: { name: [null, '影響範囲'] },
      },
    ]);
    expect((await call(detailFieldCreate, target, { name: '参考' }, target.admin)).status).toBe(200);
  });

  test('一般のメンバーは足せないが、一覧は読める', async () => {
    const target = await createTarget();
    expect((await call(detailFieldCreate, target, { name: '影響範囲' }, target.member)).status).toBe(403);
    expect(await list(target)).toEqual([]);
  });

  test('同じワークスペースの削除していない同じ名前は 409 の duplicate_name。削除した名前と別のワークスペースの名前は使える', async () => {
    const target = await createTarget();
    await createDetailField(target.organization, target.workspace.id, { name: '受け入れ基準' });
    await createDetailField(target.organization, target.workspace.id, {
      name: '旧欄',
      position: 'a1',
      deleted_at: '2026-10-21T00:00:00.000Z',
    });
    await createDetailField(target.organization, target.otherWorkspace.id, { name: '別' });
    const duplicate = await call<ErrorBody>(detailFieldCreate, target, { name: '受け入れ基準' });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error).toMatchObject({ code: 'conflict', details: { reason: 'duplicate_name' } });
    expect((await call(detailFieldCreate, target, { name: '旧欄' })).status).toBe(200);
    expect((await call(detailFieldCreate, target, { name: '別' })).status).toBe(200);
    // 同時に同じ名前を足しても、1つしか入らない
    const results = await Promise.all([
      call(detailFieldCreate, target, { name: '同時' }),
      call(detailFieldCreate, target, { name: '同時' }),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
  });

  test('削除していない欄が 10 件あれば 409 の limit。削除すれば足せる。同時に足しても超えない', async () => {
    const target = await createTarget();
    for (let index = 0; index < DETAIL_FIELDS_PER_WORKSPACE; index += 1) {
      await create(target, `欄 ${index}`);
    }
    const over = await call<ErrorBody>(detailFieldCreate, target, { name: '11 件目' });
    expect(over.status).toBe(409);
    expect(over.body.error).toMatchObject({ code: 'conflict', details: { reason: 'limit' } });
    const [first] = await list(target);
    expect((await call(detailFieldDelete, target, { field_id: first!.id })).status).toBe(200);
    // 1 件の空きに同時に足しても 1 つだけ入る
    const results = await Promise.all([
      call(detailFieldCreate, target, { name: '空き A' }),
      call(detailFieldCreate, target, { name: '空き B' }),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
    expect(await list(target)).toHaveLength(DETAIL_FIELDS_PER_WORKSPACE);
  });

  test('閉じたワークスペースへの操作は 409 の workspace_closed。一覧は読める', async () => {
    const closed = await createTarget({ closed: true });
    const field = await createDetailField(closed.organization, closed.workspace.id);
    const created = await call<ErrorBody>(detailFieldCreate, closed, { name: '追加' });
    expect(created.status).toBe(409);
    expect(created.body.error.code).toBe('workspace_closed');
    expect((await call(detailFieldUpdate, closed, { field_id: field.id, name: '改名' })).status).toBe(409);
    expect((await call(detailFieldMove, closed, { field_id: field.id })).status).toBe(409);
    expect((await call(detailFieldDelete, closed, { field_id: field.id })).status).toBe(409);
    expect(await list(closed)).toEqual([{ id: field.id, name: field.name }]);
  });

  test('名前が空、51 字、制御文字は 400', async () => {
    const target = await createTarget();
    for (const name of ['', '   ', 'あ'.repeat(51), '欄\u0000']) {
      expect((await call(detailFieldCreate, target, { name })).status, name).toBe(400);
    }
    expect((await call(detailFieldCreate, target, { name: 'あ'.repeat(50) })).status).toBe(200);
  });
});

describe('detail-field-update', () => {
  test('名前を変えると履歴が残り、値はそのまま。同じ名前は 409、同じ値なら何も書かない', async () => {
    const target = await createTarget();
    const field = await create(target, '受け入れ基準');
    const other = await create(target, '影響範囲');
    const task = await createTask(target.organization, target.workspace.id, target.member.userId!);
    await createTaskFieldValue(target.organization, task.id, field.id, target.member.userId!);

    const renamed = await call<{ field: Field }>(detailFieldUpdate, target, { field_id: field.id, name: '達成条件' });
    expect(renamed.status).toBe(200);
    expect(renamed.body.field).toEqual({ id: field.id, name: '達成条件' });
    expect(await logsOf(target, field.id)).toMatchObject([
      { action: 'create' },
      { action: 'update', entity_type: 'detail_field', changes: { name: ['受け入れ基準', '達成条件'] } },
    ]);
    const db = orgDb(env, target.organization.verified);
    const value = await db.first(
      db.statement((q) => q.selectFrom('task_field_values').select('field_id').where('task_id', '=', task.id)),
    );
    expect(value?.field_id).toBe(field.id);

    const duplicate = await call<ErrorBody>(detailFieldUpdate, target, { field_id: other.id, name: '達成条件' });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.details?.reason).toBe('duplicate_name');

    expect((await call(detailFieldUpdate, target, { field_id: field.id, name: '達成条件' })).status).toBe(200);
    expect(await logsOf(target, field.id)).toHaveLength(2);
  });

  test('無い欄、削除した欄、別のワークスペースの欄は 404', async () => {
    const target = await createTarget();
    const deleted = await createDetailField(target.organization, target.workspace.id, {
      deleted_at: '2026-10-21T00:00:00.000Z',
    });
    const elsewhere = await createDetailField(target.organization, target.otherWorkspace.id);
    for (const id of [deleted.id, elsewhere.id, crypto.randomUUID()]) {
      expect((await call(detailFieldUpdate, target, { field_id: id, name: '新しい名前' })).status).toBe(404);
      expect((await call(detailFieldMove, target, { field_id: id })).status).toBe(404);
      expect((await call(detailFieldDelete, target, { field_id: id })).status).toBe(404);
    }
  });
});

describe('detail-field-move', () => {
  test('先頭、直後、末尾へ並べ替える。履歴は残さない。自分自身の直後は 400、無い直前の欄は 404', async () => {
    const target = await createTarget();
    const a = await create(target, 'A');
    const b = await create(target, 'B');
    const c = await create(target, 'C');
    expect((await call(detailFieldMove, target, { field_id: c.id, after_field_id: null })).status).toBe(200);
    expect((await list(target)).map((field) => field.name)).toEqual(['C', 'A', 'B']);
    expect((await call(detailFieldMove, target, { field_id: c.id, after_field_id: a.id })).status).toBe(200);
    expect((await list(target)).map((field) => field.name)).toEqual(['A', 'C', 'B']);
    expect((await call(detailFieldMove, target, { field_id: a.id })).status).toBe(200);
    expect((await list(target)).map((field) => field.name)).toEqual(['C', 'B', 'A']);
    expect((await logsOf(target, b.id)).map((log) => log.action)).toEqual(['create']);

    expect((await call(detailFieldMove, target, { field_id: a.id, after_field_id: a.id })).status).toBe(400);
    const elsewhere = await createDetailField(target.organization, target.otherWorkspace.id);
    expect((await call(detailFieldMove, target, { field_id: a.id, after_field_id: elsewhere.id })).status).toBe(404);
  });
});

describe('detail-field-delete', () => {
  test('論理削除で、一覧から外れる。値の行は残り、履歴が残る。もう一度削除すると 404', async () => {
    const target = await createTarget();
    const field = await create(target, '受け入れ基準');
    const task = await createTask(target.organization, target.workspace.id, target.member.userId!);
    await createTaskFieldValue(target.organization, task.id, field.id, target.member.userId!);

    expect((await call(detailFieldDelete, target, { field_id: field.id })).status).toBe(200);
    expect(await list(target)).toEqual([]);
    const db = orgDb(env, target.organization.verified);
    const rows = await db.rows(
      db.statement((q) =>
        q
          .selectFrom('detail_fields')
          .innerJoin('task_field_values', 'task_field_values.field_id', 'detail_fields.id')
          .select(['detail_fields.deleted_at', 'task_field_values.value_md'])
          .where('detail_fields.id', '=', field.id),
      ),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.deleted_at).not.toBeNull();
    expect(await logsOf(target, field.id)).toMatchObject([{ action: 'create' }, { action: 'delete' }]);
    expect((await call(detailFieldDelete, target, { field_id: field.id })).status).toBe(404);
  });
});
