// 区分とリポジトリの定義の操作と、エピック、ストーリー、タスクに振る操作の振る舞い。
// 組織の分離と権限の種類ごとの許可と拒否は、一覧を回す test/operation-registry.test.ts が確かめる
import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import { DEFINITIONS_PER_WORKSPACE } from '../src/shared/definition.ts';
import type { AnyOperationDefinition } from '../src/shared/operations/define.ts';
import {
  categoryCreate,
  categoryDelete,
  categoryMove,
  categoryRepositoryList,
  categoryUpdate,
  repositoryCreate,
  repositoryDelete,
  repositoryMove,
  repositoryUpdate,
} from '../src/shared/operations/definition/index.ts';
import { epicCreate, epicUpdate } from '../src/shared/operations/epic/index.ts';
import { storyCreate, storyGet, storyUpdate } from '../src/shared/operations/story/index.ts';
import {
  backlogTree,
  taskComplete,
  taskCreate,
  taskDetail,
  taskHistory,
  taskMove,
  taskUpdate,
} from '../src/shared/operations/task/index.ts';
import { createApp } from '../src/server/app.ts';
import { orgDb } from '../src/server/db/index.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import { createCategory, createEpic, createRepository, createStory, createTask } from './factories.ts';
import { post } from './operations/harness.ts';
import { createTarget, type Person, type Target } from './operations/world.ts';

const app = createApp(implementedOperations);

type ErrorBody = { error: { code: string; details?: { reason?: string } } };

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

async function list(target: Target) {
  const res = await call<{
    categories: { id: string; name: string; is_billed_monthly: boolean }[];
    repositories: { id: string; name: string }[];
  }>(categoryRepositoryList, target, {}, target.member);
  expect(res.status).toBe(200);
  return res.body;
}

async function logsOf(target: Target, entityType: string, entityId: string) {
  const db = orgDb(env, target.organization.verified);
  const rows = await db.rows(
    db.statement((q) =>
      q
        .selectFrom('change_logs')
        .select(['action', 'changes_json', 'workspace_id'])
        .where('organization_id', '=', target.organization.id)
        .where('entity_type', '=', entityType)
        .where('entity_id', '=', entityId)
        .orderBy('created_at')
        .orderBy('id'),
    ),
  );
  return rows.map((row) => ({ ...row, changes: JSON.parse(row.changes_json) as Record<string, unknown> }));
}

async function categoryIdOf(target: Target, table: 'epics' | 'stories' | 'tasks', id: string) {
  const db = orgDb(env, target.organization.verified);
  const row = await db.first(
    db.statement((q) =>
      q
        .selectFrom(table as 'tasks')
        .select('category_id')
        .where('id', '=', id)
        .where('workspace_id', '=', target.workspace.id),
    ),
  );
  return row?.category_id;
}

describe('category-create と一覧', () => {
  test('リーダーが名前と月ごとに計上するかを指して足すと、末尾に並び、変更の履歴が残る。名前の前後の空白は落とす', async () => {
    const target = await createTarget();
    const first = await call<{ category: { id: string; name: string; is_billed_monthly: boolean } }>(
      categoryCreate,
      target,
      { name: '  保守  ' },
    );
    expect(first.status).toBe(200);
    expect(first.body.category).toMatchObject({ name: '保守', is_billed_monthly: false });
    const second = await call<{ category: { id: string } }>(categoryCreate, target, {
      name: '追加案件',
      is_billed_monthly: true,
    });
    expect(second.status).toBe(200);
    expect((await list(target)).categories).toEqual([
      { id: first.body.category.id, name: '保守', is_billed_monthly: false },
      { id: second.body.category.id, name: '追加案件', is_billed_monthly: true },
    ]);
    expect(await logsOf(target, 'category', second.body.category.id)).toMatchObject([
      {
        action: 'create',
        workspace_id: target.workspace.id,
        changes: { name: [null, '追加案件'], is_billed_monthly: [null, 1] },
      },
    ]);
    // 管理者も足せる
    expect((await call(categoryCreate, target, { name: '社内' }, target.admin)).status).toBe(200);
  });

  test('同じワークスペースの削除していない同じ名前は 409 の duplicate_name。削除した名前と、別のワークスペースの名前は使える', async () => {
    const target = await createTarget();
    await createCategory(target.organization, target.workspace.id, { name: '保守' });
    await createCategory(target.organization, target.workspace.id, {
      name: '旧案件',
      deleted_at: '2026-10-21T00:00:00.000Z',
    });
    await createCategory(target.organization, target.otherWorkspace.id, { name: '別' });
    const duplicate = await call<ErrorBody>(categoryCreate, target, { name: '保守' });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error).toMatchObject({ code: 'conflict', details: { reason: 'duplicate_name' } });
    expect((await call(categoryCreate, target, { name: '旧案件' })).status).toBe(200);
    expect((await call(categoryCreate, target, { name: '別' })).status).toBe(200);
    // 同時に同じ名前を足しても、1つしか入らない
    const results = await Promise.all([
      call(categoryCreate, target, { name: '同時' }),
      call(categoryCreate, target, { name: '同時' }),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
    expect((await list(target)).categories.filter((category) => category.name === '同時')).toHaveLength(1);
  });

  test(`削除していない区分が ${DEFINITIONS_PER_WORKSPACE} 件あれば 409 の limit。削除したものは数えない`, async () => {
    const target = await createTarget();
    for (let index = 0; index < DEFINITIONS_PER_WORKSPACE; index++) {
      await createCategory(target.organization, target.workspace.id, { name: `区分 ${index}` });
    }
    const over = await call<ErrorBody>(categoryCreate, target, { name: '超える' });
    expect(over.status).toBe(409);
    expect(over.body.error).toMatchObject({ code: 'conflict', details: { reason: 'limit' } });
    const { categories } = await list(target);
    expect((await call(categoryDelete, target, { category_id: categories[0]!.id })).status).toBe(200);
    expect((await call(categoryCreate, target, { name: '超える' })).status).toBe(200);
  });

  test('空の名前と 51 字の名前は 400。閉じたワークスペースは 409 の workspace_closed', async () => {
    const target = await createTarget();
    expect((await call(categoryCreate, target, { name: '   ' })).status).toBe(400);
    expect((await call(categoryCreate, target, { name: 'あ'.repeat(51) })).status).toBe(400);
    expect((await call(categoryCreate, target, { name: 'あ'.repeat(50) })).status).toBe(200);
    const closed = await createTarget({ closed: true });
    const res = await call<ErrorBody>(categoryCreate, closed, { name: '保守' }, closed.admin);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('workspace_closed');
    // 閉じたワークスペースでも一覧は読める
    expect((await call(categoryRepositoryList, closed, {}, closed.admin)).status).toBe(200);
  });

  test('一般のメンバーは足せない（403）が、一覧は読める', async () => {
    const target = await createTarget();
    expect((await call(categoryCreate, target, { name: '保守' }, target.member)).status).toBe(403);
    expect((await call(repositoryCreate, target, { name: 'shop-api' }, target.member)).status).toBe(403);
    expect((await call(categoryRepositoryList, target, {}, target.member)).status).toBe(200);
  });
});

describe('category-update', () => {
  test('名前と月ごとに計上するかを変え、変えた欄だけを履歴に残す。同じ名前は 409 の duplicate_name', async () => {
    const target = await createTarget();
    const category = await createCategory(target.organization, target.workspace.id, { name: '保守' });
    await createCategory(target.organization, target.workspace.id, { name: '追加案件' });
    const renamed = await call<{ category: unknown }>(categoryUpdate, target, {
      category_id: category.id,
      name: '保守運用',
      is_billed_monthly: true,
    });
    expect(renamed.status).toBe(200);
    expect(renamed.body.category).toEqual({ id: category.id, name: '保守運用', is_billed_monthly: true });
    expect(await logsOf(target, 'category', category.id)).toMatchObject([
      { action: 'update', changes: { name: ['保守', '保守運用'], is_billed_monthly: [0, 1] } },
    ]);
    const duplicate = await call<ErrorBody>(categoryUpdate, target, { category_id: category.id, name: '追加案件' });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.details?.reason).toBe('duplicate_name');
    // 同じ値を送るだけなら何も書かない
    expect((await call(categoryUpdate, target, { category_id: category.id, name: '保守運用' })).status).toBe(200);
    expect(await logsOf(target, 'category', category.id)).toHaveLength(1);
  });

  test('月ごとに計上するかを切り替えても、すでにある完了の記録の計上月は変えない', async () => {
    const target = await createTarget();
    const category = await createCategory(target.organization, target.workspace.id, {
      name: '保守',
      is_billed_monthly: 1,
    });
    const task = await createTask(target.organization, target.workspace.id, target.member.userId!, {
      category_id: category.id,
      points: 2,
    });
    expect((await call(taskComplete, target, { task_id: task.id }, target.member)).status).toBe(200);
    expect((await call(categoryUpdate, target, { category_id: category.id, is_billed_monthly: false })).status).toBe(
      200,
    );
    const db = orgDb(env, target.organization.verified);
    const completion = await db.first(
      db.statement((q) =>
        q
          .selectFrom('completions')
          .select(['category_id', 'billing_month'])
          .where('task_id', '=', task.id)
          .where('workspace_id', '=', target.workspace.id),
      ),
    );
    expect(completion?.category_id).toBe(category.id);
    expect(completion?.billing_month).toMatch(/^\d{4}-\d{2}$/);
  });

  test('無い区分（削除済み、別のワークスペース、別の組織）は 404', async () => {
    const target = await createTarget();
    const other = await createTarget();
    const deleted = await createCategory(target.organization, target.workspace.id, {
      deleted_at: '2026-10-21T00:00:00.000Z',
    });
    const elsewhere = await createCategory(target.organization, target.otherWorkspace.id);
    const foreign = await createCategory(other.organization, other.workspace.id);
    for (const id of [deleted.id, elsewhere.id, foreign.id]) {
      expect((await call(categoryUpdate, target, { category_id: id, name: '改名' })).status).toBe(404);
      expect((await call(categoryDelete, target, { category_id: id })).status).toBe(404);
      expect((await call(categoryMove, target, { category_id: id, after_category_id: null })).status).toBe(404);
    }
  });
});

describe('category-move と repository-move', () => {
  test('先頭、指した行の直後、末尾へ並べ替える。直前の行が自分なら 400、無い行なら 404', async () => {
    const target = await createTarget();
    const a = await createCategory(target.organization, target.workspace.id, { name: 'A', position: 'a0' });
    const b = await createCategory(target.organization, target.workspace.id, { name: 'B', position: 'a1' });
    const c = await createCategory(target.organization, target.workspace.id, { name: 'C', position: 'a2' });
    const names = async () => (await list(target)).categories.map((category) => category.name);
    expect((await call(categoryMove, target, { category_id: c.id, after_category_id: null })).status).toBe(200);
    expect(await names()).toEqual(['C', 'A', 'B']);
    expect((await call(categoryMove, target, { category_id: c.id, after_category_id: a.id })).status).toBe(200);
    expect(await names()).toEqual(['A', 'C', 'B']);
    expect((await call(categoryMove, target, { category_id: a.id })).status).toBe(200);
    expect(await names()).toEqual(['C', 'B', 'A']);
    expect((await call(categoryMove, target, { category_id: b.id, after_category_id: b.id })).status).toBe(400);
    const elsewhere = await createCategory(target.organization, target.otherWorkspace.id);
    expect((await call(categoryMove, target, { category_id: b.id, after_category_id: elsewhere.id })).status).toBe(404);
    // 並べ替えは履歴に残さない
    expect(await logsOf(target, 'category', c.id)).toEqual([]);

    const r1 = await createRepository(target.organization, target.workspace.id, { name: 'shop-api', position: 'a0' });
    await createRepository(target.organization, target.workspace.id, { name: 'shop-web', position: 'a1' });
    expect((await call(repositoryMove, target, { repository_id: r1.id })).status).toBe(200);
    expect((await list(target)).repositories.map((repository) => repository.name)).toEqual(['shop-web', 'shop-api']);
  });
});

describe('category-delete', () => {
  test('振っていたエピック、ストーリー、タスクは区分なしに戻り、それぞれ履歴が残る。完了の記録は元の区分と計上月のまま', async () => {
    const target = await createTarget();
    const adminId = target.admin.userId!;
    const category = await createCategory(target.organization, target.workspace.id, {
      name: '保守',
      is_billed_monthly: 1,
    });
    const keep = await createCategory(target.organization, target.workspace.id, { name: '追加案件' });
    const epic = await createEpic(target.organization, target.workspace.id, adminId, { category_id: category.id });
    const story = await createStory(target.organization, target.workspace.id, adminId, { category_id: category.id });
    const task = await createTask(target.organization, target.workspace.id, adminId, { category_id: category.id });
    const other = await createTask(target.organization, target.workspace.id, adminId, { category_id: keep.id });
    const done = await createTask(target.organization, target.workspace.id, adminId, {
      category_id: category.id,
      points: 3,
    });
    expect((await call(taskComplete, target, { task_id: done.id }, target.member)).status).toBe(200);
    const db = orgDb(env, target.organization.verified);
    const completionOf = () =>
      db.first(
        db.statement((q) =>
          q
            .selectFrom('completions')
            .select(['category_id', 'billing_month'])
            .where('task_id', '=', done.id)
            .where('workspace_id', '=', target.workspace.id),
        ),
      );
    const before = await completionOf();
    expect(before?.billing_month).not.toBeNull();

    const res = await call(categoryDelete, target, { category_id: category.id });
    expect(res.status).toBe(200);
    expect(await categoryIdOf(target, 'epics', epic.id)).toBeNull();
    expect(await categoryIdOf(target, 'stories', story.id)).toBeNull();
    expect(await categoryIdOf(target, 'tasks', task.id)).toBeNull();
    expect(await categoryIdOf(target, 'tasks', done.id)).toBeNull();
    expect(await categoryIdOf(target, 'tasks', other.id)).toBe(keep.id);
    expect(await completionOf()).toEqual(before);
    expect((await list(target)).categories.map((row) => row.name)).toEqual(['追加案件']);

    const cleared = { category: [{ id: category.id, name: '保守' }, null] };
    expect(await logsOf(target, 'epic', epic.id)).toMatchObject([{ action: 'update', changes: cleared }]);
    expect(await logsOf(target, 'story', story.id)).toMatchObject([{ action: 'update', changes: cleared }]);
    expect((await logsOf(target, 'task', task.id)).at(-1)).toMatchObject({ action: 'update', changes: cleared });
    expect((await logsOf(target, 'category', category.id)).at(-1)).toMatchObject({ action: 'delete' });
    // 引き出しの履歴にも、区分を外した行が出る
    const history = await call<{ entries: { changes: unknown[] }[] }>(
      taskHistory,
      target,
      { task_id: task.id },
      target.member,
    );
    expect(history.body.entries[0]?.changes).toEqual([
      { field: 'category', before: { id: category.id, name: '保守' }, after: null },
    ]);

    // 削除した区分は、もう振れない（404）。続けて削除しても 404
    expect((await call(taskUpdate, target, { task_id: task.id, category_id: category.id }, target.member)).status).toBe(
      404,
    );
    expect((await call(categoryDelete, target, { category_id: category.id })).status).toBe(404);
  });

  test('repository-delete は、振っていたタスクをリポジトリなしに戻し、履歴を残す', async () => {
    const target = await createTarget();
    const repository = await createRepository(target.organization, target.workspace.id, { name: 'shop-api' });
    const task = await createTask(target.organization, target.workspace.id, target.admin.userId!, {
      repository_id: repository.id,
    });
    expect((await call(repositoryDelete, target, { repository_id: repository.id })).status).toBe(200);
    const db = orgDb(env, target.organization.verified);
    const row = await db.first(
      db.statement((q) =>
        q
          .selectFrom('tasks')
          .select('repository_id')
          .where('id', '=', task.id)
          .where('workspace_id', '=', target.workspace.id),
      ),
    );
    expect(row?.repository_id).toBeNull();
    expect(await logsOf(target, 'task', task.id)).toMatchObject([
      { action: 'update', changes: { repository: [{ id: repository.id, name: 'shop-api' }, null] } },
    ]);
    expect((await list(target)).repositories).toEqual([]);
  });

  test('repository-create と repository-update も、同じ名前を 409 の duplicate_name で断る', async () => {
    const target = await createTarget();
    const created = await call<{ repository: { id: string; name: string } }>(repositoryCreate, target, {
      name: 'shop-api',
    });
    expect(created.status).toBe(200);
    const second = await call<{ repository: { id: string } }>(repositoryCreate, target, { name: 'shop-web' });
    const duplicate = await call<ErrorBody>(repositoryCreate, target, { name: 'shop-api' });
    expect(duplicate.body.error.details?.reason).toBe('duplicate_name');
    const rename = await call<ErrorBody>(repositoryUpdate, target, {
      repository_id: second.body.repository.id,
      name: 'shop-api',
    });
    expect(rename.status).toBe(409);
    expect(rename.body.error.details?.reason).toBe('duplicate_name');
  });
});

describe('タスク、ストーリー、エピックに振る', () => {
  test('task-create でリポジトリと区分を振れる。親と一緒に区分を送ると 409 の has_parent、別の組織の ID は 404', async () => {
    const target = await createTarget();
    const other = await createTarget();
    const category = await createCategory(target.organization, target.workspace.id, { name: '保守' });
    const repository = await createRepository(target.organization, target.workspace.id, { name: 'shop-api' });
    const created = await call<{ task: { id: string; category: unknown; repository: unknown } }>(
      taskCreate,
      target,
      { title: '見積もりを送る', category_id: category.id, repository_id: repository.id },
      target.member,
    );
    expect(created.status).toBe(200);
    expect(created.body.task).toMatchObject({
      category: { id: category.id, name: '保守' },
      repository: { id: repository.id, name: 'shop-api' },
    });
    expect((await logsOf(target, 'task', created.body.task.id))[0]?.changes).toMatchObject({
      category: [null, { id: category.id, name: '保守' }],
      repository: [null, { id: repository.id, name: 'shop-api' }],
    });

    const story = await createStory(target.organization, target.workspace.id, target.admin.userId!);
    const withParent = await call<ErrorBody>(
      taskCreate,
      target,
      { title: 'x', story_id: story.id, category_id: category.id },
      target.member,
    );
    expect(withParent.status).toBe(409);
    expect(withParent.body.error.details?.reason).toBe('has_parent');
    // 親の下でもリポジトリは振れる
    expect(
      (await call(taskCreate, target, { title: 'x', story_id: story.id, repository_id: repository.id }, target.member))
        .status,
    ).toBe(200);

    const foreignCategory = await createCategory(other.organization, other.workspace.id);
    const foreignRepository = await createRepository(other.organization, other.workspace.id);
    const elsewhere = await createCategory(target.organization, target.otherWorkspace.id);
    for (const body of [
      { category_id: foreignCategory.id },
      { repository_id: foreignRepository.id },
      { category_id: elsewhere.id },
    ]) {
      expect((await call(taskCreate, target, { title: 'x', ...body }, target.member)).status).toBe(404);
    }
  });

  test('task-update で区分とリポジトリを直し、履歴を残す。親のあるタスクの区分は 409 の has_parent、別の組織は 404', async () => {
    const target = await createTarget();
    const other = await createTarget();
    const category = await createCategory(target.organization, target.workspace.id, { name: '保守' });
    const next = await createCategory(target.organization, target.workspace.id, { name: '追加案件' });
    const repository = await createRepository(target.organization, target.workspace.id, { name: 'shop-api' });
    const task = await createTask(target.organization, target.workspace.id, target.member.userId!, {
      category_id: category.id,
    });
    const res = await call<{ task: { category: unknown; repository: unknown } }>(
      taskUpdate,
      target,
      { task_id: task.id, category_id: next.id, repository_id: repository.id },
      target.member,
    );
    expect(res.status).toBe(200);
    expect(res.body.task).toMatchObject({
      category: { id: next.id, name: '追加案件', inherited: false },
      repository: { id: repository.id, name: 'shop-api' },
    });
    expect(await logsOf(target, 'task', task.id)).toMatchObject([
      {
        action: 'update',
        changes: {
          category: [
            { id: category.id, name: '保守' },
            { id: next.id, name: '追加案件' },
          ],
          repository: [null, { id: repository.id, name: 'shop-api' }],
        },
      },
    ]);
    // 外す
    const cleared = await call<{ task: { category: unknown; repository: unknown } }>(
      taskUpdate,
      target,
      { task_id: task.id, category_id: null, repository_id: null },
      target.member,
    );
    expect(cleared.body.task).toMatchObject({ category: null, repository: null });

    const story = await createStory(target.organization, target.workspace.id, target.admin.userId!, {
      category_id: category.id,
    });
    const child = await createTask(target.organization, target.workspace.id, target.member.userId!, {
      story_id: story.id,
    });
    const conflict = await call<ErrorBody>(
      taskUpdate,
      target,
      { task_id: child.id, category_id: next.id },
      target.member,
    );
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.details?.reason).toBe('has_parent');
    // 親のあるタスクの区分は、親から引き継いで出る
    const detail = await call<{ task: { category: unknown; story_id: string } }>(
      taskDetail,
      target,
      { task_id: child.id },
      target.member,
    );
    expect(detail.body.task).toMatchObject({
      story_id: story.id,
      category: { id: category.id, name: '保守', inherited: true },
    });

    const foreign = await createRepository(other.organization, other.workspace.id);
    expect(
      (await call(taskUpdate, target, { task_id: task.id, repository_id: foreign.id }, target.member)).status,
    ).toBe(404);
  });

  test('task-move で親の下へ移すと区分が空になり、引き継いだ区分が出る', async () => {
    const target = await createTarget();
    const own = await createCategory(target.organization, target.workspace.id, { name: '保守' });
    const parentCategory = await createCategory(target.organization, target.workspace.id, { name: '追加案件' });
    const story = await createStory(target.organization, target.workspace.id, target.admin.userId!, {
      category_id: parentCategory.id,
    });
    const task = await createTask(target.organization, target.workspace.id, target.member.userId!, {
      category_id: own.id,
    });
    expect((await call(taskMove, target, { task_id: task.id, story_id: story.id }, target.member)).status).toBe(200);
    expect(await categoryIdOf(target, 'tasks', task.id)).toBeNull();
    const detail = await call<{ task: { category: unknown } }>(taskDetail, target, { task_id: task.id }, target.member);
    expect(detail.body.task.category).toEqual({ id: parentCategory.id, name: '追加案件', inherited: true });
  });

  test('ストーリーとエピックに区分を振れる。エピックの下のストーリーへの区分は 409 の has_parent', async () => {
    const target = await createTarget();
    const category = await createCategory(target.organization, target.workspace.id, { name: '保守' });
    const epic = await call<{ epic: { id: string; category_id: string | null } }>(
      epicCreate,
      target,
      { title: '会員ランク', category_id: category.id },
      target.member,
    );
    expect(epic.status).toBe(200);
    expect(epic.body.epic.category_id).toBe(category.id);
    expect(
      (await call(epicUpdate, target, { epic_id: epic.body.epic.id, category_id: null }, target.member)).status,
    ).toBe(200);
    expect(await logsOf(target, 'epic', epic.body.epic.id)).toMatchObject([
      { action: 'create', changes: { category: [null, { id: category.id, name: '保守' }] } },
      { action: 'update', changes: { category: [{ id: category.id, name: '保守' }, null] } },
    ]);

    const story = await call<{ story: { id: string; category: unknown } }>(
      storyCreate,
      target,
      { title: '見積もりを整える', category_id: category.id },
      target.member,
    );
    expect(story.body.story.category).toEqual({ id: category.id, name: '保守', inherited: false });
    expect(
      (await call(storyUpdate, target, { story_id: story.body.story.id, category_id: null }, target.member)).status,
    ).toBe(200);

    const parent = await createEpic(target.organization, target.workspace.id, target.admin.userId!, {
      category_id: category.id,
    });
    const child = await createStory(target.organization, target.workspace.id, target.admin.userId!, {
      epic_id: parent.id,
    });
    const conflict = await call<ErrorBody>(
      storyUpdate,
      target,
      { story_id: child.id, category_id: category.id },
      target.member,
    );
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.details?.reason).toBe('has_parent');
    const got = await call<{ story: unknown }>(storyGet, target, { story_id: child.id }, target.member);
    expect(got.body.story).toMatchObject({ epic_id: parent.id, category: { id: category.id, inherited: true } });
  });

  test('backlog-tree は、行ごとに引き継ぎを解いた区分と、タスクのリポジトリを返す', async () => {
    const target = await createTarget();
    const adminId = target.admin.userId!;
    const epicCategory = await createCategory(target.organization, target.workspace.id, { name: '追加案件' });
    const own = await createCategory(target.organization, target.workspace.id, { name: '保守' });
    const repository = await createRepository(target.organization, target.workspace.id, { name: 'shop-api' });
    const epic = await createEpic(target.organization, target.workspace.id, adminId, { category_id: epicCategory.id });
    const underEpic = await createStory(target.organization, target.workspace.id, adminId, { epic_id: epic.id });
    const rootStory = await createStory(target.organization, target.workspace.id, adminId, { category_id: own.id });
    await createTask(target.organization, target.workspace.id, adminId, {
      story_id: underEpic.id,
      repository_id: repository.id,
      title: '配下',
    });
    await createTask(target.organization, target.workspace.id, adminId, {
      category_id: own.id,
      title: '親なし',
    });
    const res = await call<{
      epics: {
        category: unknown;
        stories: { category: unknown; tasks: { category: unknown; repository: unknown }[] }[];
      }[];
      stories: { id: string; category: unknown }[];
      tasks: { category: unknown; repository: unknown }[];
    }>(backlogTree, target, {}, target.member);
    expect(res.status).toBe(200);
    const inherited = { id: epicCategory.id, name: '追加案件' };
    expect(res.body.epics[0]?.category).toEqual(inherited);
    expect(res.body.epics[0]?.stories[0]?.category).toEqual(inherited);
    expect(res.body.epics[0]?.stories[0]?.tasks[0]).toMatchObject({
      category: inherited,
      repository: { id: repository.id, name: 'shop-api' },
    });
    expect(res.body.stories.find((story) => story.id === rootStory.id)?.category).toEqual({ id: own.id, name: '保守' });
    expect(res.body.tasks[0]).toMatchObject({ category: { id: own.id, name: '保守' }, repository: null });
  });
});
