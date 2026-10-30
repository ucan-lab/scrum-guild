// エピックとストーリーの削除（epic-delete、story-delete）と、ダイアログが読む削除の可否と配下の件数（epic-get、story-get）。
// 組織の分離と権限の種類ごとの許可と拒否は、一覧を回す test/operation-registry.test.ts が確かめる
import { env } from 'cloudflare:workers';
import { generateKeyBetween } from 'fractional-indexing';
import { describe, expect, test } from 'vitest';
import { epicDelete, epicGet } from '../src/shared/operations/epic/index.ts';
import { storyDelete, storyGet } from '../src/shared/operations/story/index.ts';
import { backlogTree, taskComplete } from '../src/shared/operations/task/index.ts';
import { createApp } from '../src/server/app.ts';
import { orgDb } from '../src/server/db/index.ts';
import { envWithD1Hooks, queryPlanForTest } from '../src/server/db/testing.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import { deleteStatements } from '../src/server/operations/tree-delete.ts';
import { AT, createCategory, createEpic, createSprint, createStory, createTask, uuidv7 } from './factories.ts';
import { errorCodeOf, post } from './operations/harness.ts';
import { createPerson, createTarget, testEnv, type Person, type Target } from './operations/world.ts';

const app = createApp(implementedOperations);

type Mode = 'keep' | 'delete';

function removeEpic(target: Target, epicId: string, children: Mode, person: Person = target.member, requestEnv?: Env) {
  return post(app, epicDelete, {
    slug: target.slug,
    token: person.token,
    body: { workspace_id: target.workspace.id, epic_id: epicId, children },
    ...(requestEnv === undefined ? {} : { env: requestEnv }),
  });
}

function removeStory(
  target: Target,
  storyId: string,
  children: Mode,
  person: Person = target.member,
  requestEnv?: Env,
) {
  return post(app, storyDelete, {
    slug: target.slug,
    token: person.token,
    body: { workspace_id: target.workspace.id, story_id: storyId, children },
    ...(requestEnv === undefined ? {} : { env: requestEnv }),
  });
}

function dbOf(target: Target) {
  return orgDb(env, target.organization.verified);
}

async function storyRow(target: Target, id: string) {
  const db = dbOf(target);
  return (await db.first(
    db.statement((q) =>
      q.selectFrom('stories').selectAll().where('id', '=', id).where('workspace_id', '=', target.workspace.id),
    ),
  ))!;
}

async function taskRow(target: Target, id: string) {
  const db = dbOf(target);
  return (await db.first(
    db.statement((q) =>
      q.selectFrom('tasks').selectAll().where('id', '=', id).where('workspace_id', '=', target.workspace.id),
    ),
  ))!;
}

async function epicRow(target: Target, id: string) {
  const db = dbOf(target);
  return (await db.first(
    db.statement((q) =>
      q.selectFrom('epics').selectAll().where('id', '=', id).where('workspace_id', '=', target.workspace.id),
    ),
  ))!;
}

async function logsOf(target: Target, entityType: string, entityId: string) {
  const db = dbOf(target);
  const rows = await db.rows(
    db.statement((q) =>
      q
        .selectFrom('change_logs')
        .selectAll()
        .where('entity_type', '=', entityType)
        .where('entity_id', '=', entityId)
        .where('organization_id', '=', target.organization.id)
        .orderBy('created_at')
        .orderBy('id'),
    ),
  );
  return rows.map((row) => ({ ...row, changes: JSON.parse(row.changes_json) as Record<string, unknown> }));
}

async function allLogs(target: Target) {
  const db = dbOf(target);
  return db.rows(
    db.statement((q) =>
      q.selectFrom('change_logs').select(['id']).where('organization_id', '=', target.organization.id),
    ),
  );
}

// 位置が fractional-indexing の鍵として使え（前後に値を作れる）、並びが文字列の比較で昇順であること
function expectOrderedKeys(keys: readonly string[]): void {
  for (let i = 0; i < keys.length; i++) {
    expect(() => generateKeyBetween(keys[i]!, null)).not.toThrow();
    if (i > 0) {
      expect(keys[i - 1]! < keys[i]!).toBe(true);
      expect(() => generateKeyBetween(keys[i - 1]!, keys[i]!)).not.toThrow();
    }
  }
}

// 一般のメンバーが作って完了にしたタスク（完了の記録と経験値は task-complete が書く）
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
  return taskRow(target, task.id);
}

async function countRecords(target: Target, taskId: string) {
  const db = dbOf(target);
  const [completions, grants] = await db.batch([
    db.statement((q) =>
      q
        .selectFrom('completions')
        .select('id')
        .where('task_id', '=', taskId)
        .where('workspace_id', '=', target.workspace.id),
    ),
    db.statement((q) =>
      q
        .selectFrom('xp_grants')
        .select('id')
        .where('task_id', '=', taskId)
        .where('workspace_id', '=', target.workspace.id),
    ),
  ] as const);
  return { completions: completions.rows.length, grants: grants.rows.length };
}

// 取り込んだタスク（手で作ったタスクの CHECK を外れる列を埋める）
function imported(overrides: Parameters<typeof createTask>[3] = {}): Parameters<typeof createTask>[3] {
  return { is_imported: 1, created_by: null, ...overrides };
}

async function createColumn(target: Target) {
  const db = dbOf(target);
  const id = uuidv7();
  await db.run(
    db.statement((q) =>
      q.insertInto('board_columns').values({
        id,
        workspace_id: target.workspace.id,
        name: '出発前',
        is_done: 0,
        position: 'a0',
        created_at: AT,
        updated_at: AT,
      }),
    ),
  );
  return id;
}

describe('epic-delete（配下を残す）', () => {
  test('配下のストーリーを親なしの末尾へ元の並びで移し、エピックの区分を写す。その下のタスクはストーリーの下のまま', async () => {
    const target = await createTarget();
    const ws = target.workspace.id;
    const me = target.member.userId!;
    const category = await createCategory(target.organization, ws, { name: '新規開発' });
    const epic = await createEpic(target.organization, ws, me, { category_id: category.id, title: '会員ランク' });
    // 元の並び: second（a0、id が小さい）、tie（a0、id が大きい）、first（a1）。完了したストーリーも含む
    const second = await createStory(target.organization, ws, me, { epic_id: epic.id, position: 'a0' });
    const tie = await createStory(target.organization, ws, me, { epic_id: epic.id, position: 'a0' });
    const first = await createStory(target.organization, ws, me, {
      epic_id: epic.id,
      position: 'a1',
      completed_at: '2026-10-21T00:00:00.000Z',
      completed_by: me,
    });
    // 親のないストーリー（移す先）。末尾は a5
    const orphanA = await createStory(target.organization, ws, me, { position: 'Zz' });
    const orphanB = await createStory(target.organization, ws, me, { position: 'a5' });
    // 削除したストーリーは並びに数えない
    await createStory(target.organization, ws, me, { position: 'z9', deleted_at: '2026-10-21T00:00:00.000Z' });
    const task = await createTask(target.organization, ws, me, { story_id: first.id });

    const res = await removeEpic(target, epic.id, 'keep');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ epic_id: epic.id });

    const deleted = await epicRow(target, epic.id);
    expect(deleted.deleted_at).not.toBeNull();
    expect(deleted.updated_at).toBe(deleted.deleted_at);
    const moved = [await storyRow(target, second.id), await storyRow(target, tie.id), await storyRow(target, first.id)];
    for (const row of moved) {
      expect(row.epic_id).toBeNull();
      expect(row.category_id).toBe(category.id);
      expect(row.deleted_at).toBeNull();
      expect(row.updated_at).toBe(deleted.deleted_at);
    }
    // 完了したストーリーは完了のまま
    expect(moved[2]!.completed_at).toBe('2026-10-21T00:00:00.000Z');
    expect(moved.map((row) => row.position)).toEqual(['a5' + '1V', 'a5' + '2V', 'a5' + '3V']);
    expectOrderedKeys(['a5', ...moved.map((row) => row.position)]);
    expect((await taskRow(target, task.id)).story_id).toBe(first.id);

    // バックログの木で、親のないストーリーの末尾に元の並びで出る。区分はストーリー自身の区分になる
    const tree = (await (
      await post(app, backlogTree, { slug: target.slug, token: target.member.token, body: { workspace_id: ws } })
    ).json()) as { epics: { id: string }[]; stories: { id: string; category: { id: string } | null }[] };
    expect(tree.epics.map((row) => row.id)).not.toContain(epic.id);
    expect(tree.stories.map((row) => row.id)).toEqual([orphanA.id, orphanB.id, second.id, tie.id, first.id]);
    expect(tree.stories.find((row) => row.id === second.id)?.category).toEqual({ id: category.id, name: '新規開発' });

    // 履歴: エピックの削除と、ストーリーごとの親と区分の変更
    const epicLogs = await logsOf(target, 'epic', epic.id);
    expect(epicLogs).toHaveLength(1);
    expect(epicLogs[0]).toMatchObject({ action: 'delete', actor_user_id: me, workspace_id: ws });
    expect(epicLogs[0]!.changes).toEqual({ deleted_at: [null, deleted.deleted_at] });
    for (const story of [second, tie, first]) {
      const logs = await logsOf(target, 'story', story.id);
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatchObject({ action: 'update', actor_user_id: me, created_at: deleted.deleted_at });
      expect(logs[0]!.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(logs[0]!.changes).toEqual({
        epic: [{ id: epic.id, title: '会員ランク' }, null],
        category: [null, { id: category.id, name: '新規開発' }],
      });
    }
    // 子の履歴の ID は行ごとに違う
    const ids = new Set((await allLogs(target)).map((row) => row.id));
    expect(ids.size).toBe((await allLogs(target)).length);
  });

  test('移す先が空なら a0 を基準に振る。区分の無いエピックは、ストーリーの区分を変えず、履歴に区分を残さない', async () => {
    const target = await createTarget();
    const ws = target.workspace.id;
    const me = target.member.userId!;
    const own = await createCategory(target.organization, ws, { name: '保守' });
    const epic = await createEpic(target.organization, ws, me, { title: '棚卸し' });
    // エピックの下のストーリーは区分を持たないのが決まりだが、持っていても消さない（集計の区分を変えない）
    const story = await createStory(target.organization, ws, me, { epic_id: epic.id, category_id: own.id });
    const plain = await createStory(target.organization, ws, me, { epic_id: epic.id, position: 'a1' });

    expect((await removeEpic(target, epic.id, 'keep')).status).toBe(200);
    const rows = [await storyRow(target, story.id), await storyRow(target, plain.id)];
    expect(rows.map((row) => row.position)).toEqual(['a01V', 'a02V']);
    expectOrderedKeys(rows.map((row) => row.position));
    expect(rows.map((row) => row.category_id)).toEqual([own.id, null]);
    for (const row of rows) {
      const logs = await logsOf(target, 'story', row.id);
      expect(logs.map((log) => log.changes)).toEqual([{ epic: [{ id: epic.id, title: '棚卸し' }, null] }]);
    }
  });

  test('エピックの区分が削除されていれば写さない（引き継いで見えていた区分も無かった）', async () => {
    const target = await createTarget();
    const ws = target.workspace.id;
    const me = target.member.userId!;
    const gone = await createCategory(target.organization, ws, { deleted_at: '2026-10-21T00:00:00.000Z' });
    const epic = await createEpic(target.organization, ws, me, { category_id: gone.id });
    const story = await createStory(target.organization, ws, me, { epic_id: epic.id });
    expect((await removeEpic(target, epic.id, 'keep')).status).toBe(200);
    expect((await storyRow(target, story.id)).category_id).toBeNull();
    expect(Object.keys((await logsOf(target, 'story', story.id))[0]!.changes)).toEqual(['epic']);
  });
});

describe('story-delete（配下を残す）', () => {
  test('配下のタスクを親なしの末尾へ元の並びで移し、親のエピックの区分を写す。完了したタスクも移す', async () => {
    const target = await createTarget();
    const ws = target.workspace.id;
    const me = target.member.userId!;
    const category = await createCategory(target.organization, ws, { name: '新規開発' });
    const epic = await createEpic(target.organization, ws, me, { category_id: category.id });
    const story = await createStory(target.organization, ws, me, { epic_id: epic.id, title: '登録の画面' });
    const later = await createTask(target.organization, ws, me, { story_id: story.id, position: 'a2' });
    const done = await completedTask(target, { story_id: story.id, position: 'a1' });
    const orphan = await createTask(target.organization, ws, me, { position: 'b00' });
    // 受信箱とアーカイブのタスクは、親のないタスクの並びに数えない
    await createTask(target.organization, ws, me, imported({ tray: 'archive', position: 'b01' }));
    const records = await countRecords(target, done.id);

    const res = await removeStory(target, story.id, 'keep');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ story_id: story.id });
    const deleted = await storyRow(target, story.id);
    expect(deleted.deleted_at).not.toBeNull();

    const rows = [await taskRow(target, done.id), await taskRow(target, later.id)];
    for (const row of rows) {
      expect(row.story_id).toBeNull();
      expect(row.category_id).toBe(category.id);
      expect(row.deleted_at).toBeNull();
      expect(row.tray).toBe('backlog');
    }
    expect(rows[0]!.completed_at).toBe(done.completed_at);
    expect(rows.map((row) => row.position)).toEqual(['b001V', 'b002V']);
    expectOrderedKeys([orphan.position, ...rows.map((row) => row.position)]);
    // 完了の記録と経験値は残る
    expect(await countRecords(target, done.id)).toEqual(records);

    for (const row of rows) {
      const logs = (await logsOf(target, 'task', row.id)).filter((log) => log.created_at === deleted.deleted_at);
      expect(logs).toHaveLength(1);
      expect(logs[0]!.action).toBe('update');
      expect(logs[0]!.changes).toEqual({
        story: [{ id: story.id, title: '登録の画面' }, null],
        category: [null, { id: category.id, name: '新規開発' }],
      });
    }
    const storyLogs = await logsOf(target, 'story', story.id);
    expect(storyLogs.map((log) => [log.action, log.changes])).toEqual([
      ['delete', { deleted_at: [null, deleted.deleted_at] }],
    ]);
  });

  test('親のないストーリーは自身の区分を写す。区分の無いストーリーは、タスクの区分を変えない', async () => {
    const target = await createTarget();
    const ws = target.workspace.id;
    const me = target.member.userId!;
    const category = await createCategory(target.organization, ws, { name: '保守' });
    const own = await createStory(target.organization, ws, me, { category_id: category.id });
    const t1 = await createTask(target.organization, ws, me, { story_id: own.id });
    const bare = await createStory(target.organization, ws, me, { title: '区分なし' });
    const t2 = await createTask(target.organization, ws, me, { story_id: bare.id });

    expect((await removeStory(target, own.id, 'keep')).status).toBe(200);
    expect((await taskRow(target, t1.id)).category_id).toBe(category.id);
    expect((await removeStory(target, bare.id, 'keep', target.leader)).status).toBe(200);
    const row = await taskRow(target, t2.id);
    expect(row.category_id).toBeNull();
    expect(row.story_id).toBeNull();
    // 2回目の振り分けは、1回目に振った行の後ろへ続く
    expect(row.position > (await taskRow(target, t1.id)).position).toBe(true);
    expectOrderedKeys([(await taskRow(target, t1.id)).position, row.position]);
    expect((await logsOf(target, 'task', t2.id)).map((log) => log.changes)).toEqual([
      { story: [{ id: bare.id, title: '区分なし' }, null] },
    ]);
  });

  test('配下が無いストーリーも削除できる', async () => {
    const target = await createTarget();
    const story = await createStory(target.organization, target.workspace.id, target.member.userId!);
    for (const mode of ['keep', 'delete'] as const) {
      const row = await createStory(target.organization, target.workspace.id, target.member.userId!);
      expect((await removeStory(target, row.id, mode)).status).toBe(200);
      expect((await storyRow(target, row.id)).deleted_at).not.toBeNull();
    }
    expect((await storyRow(target, story.id)).deleted_at).toBeNull();
  });
});

describe('まとめて削除', () => {
  test('エピック: 配下のストーリーとタスク（完了したものも）を論理削除し、取り込んだタスクはアーカイブの末尾へ移す', async () => {
    const target = await createTarget();
    const ws = target.workspace.id;
    const me = target.member.userId!;
    const epic = await createEpic(target.organization, ws, me);
    const s1 = await createStory(target.organization, ws, me, { epic_id: epic.id, title: '一覧', position: 'a0' });
    const s2 = await createStory(target.organization, ws, me, {
      epic_id: epic.id,
      title: '詳細',
      position: 'a1',
      completed_at: '2026-10-21T00:00:00.000Z',
      completed_by: me,
    });
    const manual = await createTask(target.organization, ws, me, { story_id: s1.id });
    const done = await completedTask(target, { story_id: s2.id });
    const records = await countRecords(target, done.id);
    // 取り込んだタスク。s2 の下のもの（スプリントの列に入っている）と、s1 の下の2件（a1、a0）。並びは s1 の a0、a1、s2 の順
    const sprint = await createSprint(target.organization, ws);
    const columnId = await createColumn(target);
    const inSprint = await createTask(
      target.organization,
      ws,
      me,
      imported({ story_id: s2.id, sprint_id: sprint.id, column_id: columnId, column_position: 'a0' }),
    );
    const importedLater = await createTask(target.organization, ws, me, imported({ story_id: s1.id, position: 'a1' }));
    const importedFirst = await createTask(target.organization, ws, me, imported({ story_id: s1.id, position: 'a0' }));
    // アーカイブにあるタスク（移す先）
    await createTask(target.organization, ws, me, imported({ tray: 'archive', position: 'c000' }));
    // 関わらないストーリーとタスク
    const other = await createStory(target.organization, ws, me);
    const otherTask = await createTask(target.organization, ws, me, { story_id: other.id });

    const res = await removeEpic(target, epic.id, 'delete', target.leader);
    expect(res.status).toBe(200);
    const deletedAt = (await epicRow(target, epic.id)).deleted_at!;
    expect(deletedAt).not.toBeNull();
    for (const id of [s1.id, s2.id]) expect((await storyRow(target, id)).deleted_at).toBe(deletedAt);
    for (const id of [manual.id, done.id]) expect((await taskRow(target, id)).deleted_at).toBe(deletedAt);
    expect(await countRecords(target, done.id)).toEqual(records);

    const archived = [
      await taskRow(target, importedFirst.id),
      await taskRow(target, importedLater.id),
      await taskRow(target, inSprint.id),
    ];
    for (const row of archived) {
      expect(row).toMatchObject({
        tray: 'archive',
        story_id: null,
        sprint_id: null,
        column_id: null,
        column_position: null,
        deleted_at: null,
        updated_at: deletedAt,
      });
    }
    expect(archived.map((row) => row.position)).toEqual(['c0001V', 'c0002V', 'c0003V']);
    expectOrderedKeys(['c000', ...archived.map((row) => row.position)]);

    expect((await storyRow(target, other.id)).deleted_at).toBeNull();
    expect((await taskRow(target, otherTask.id)).deleted_at).toBeNull();

    // 履歴
    for (const id of [s1.id, s2.id]) {
      expect((await logsOf(target, 'story', id)).map((log) => [log.action, log.changes])).toEqual([
        ['delete', { deleted_at: [null, deletedAt] }],
      ]);
    }
    for (const id of [manual.id, done.id]) {
      const logs = (await logsOf(target, 'task', id)).filter((log) => log.created_at === deletedAt);
      expect(logs.map((log) => [log.action, log.changes])).toEqual([['delete', { deleted_at: [null, deletedAt] }]]);
    }
    const archiveLog = await logsOf(target, 'task', inSprint.id);
    expect(archiveLog.map((log) => [log.action, log.changes])).toEqual([
      ['update', { story: [{ id: s2.id, title: '詳細' }, null], tray: ['backlog', 'archive'] }],
    ]);
    expect((await logsOf(target, 'epic', epic.id)).map((log) => [log.action, log.actor_user_id])).toEqual([
      ['delete', target.leader.userId],
    ]);
    expect(await logsOf(target, 'task', otherTask.id)).toEqual([]);
  });

  test('ストーリー: 配下のタスクを論理削除し、取り込んだタスクをアーカイブへ移す。アーカイブが空なら a0 を基準に振る', async () => {
    const target = await createTarget();
    const ws = target.workspace.id;
    const me = target.member.userId!;
    const story = await createStory(target.organization, ws, me, { title: '検索' });
    const manual = await createTask(target.organization, ws, me, { story_id: story.id });
    const fromSource = await createTask(target.organization, ws, me, imported({ story_id: story.id }));

    expect((await removeStory(target, story.id, 'delete', target.admin)).status).toBe(200);
    const deletedAt = (await storyRow(target, story.id)).deleted_at!;
    expect((await taskRow(target, manual.id)).deleted_at).toBe(deletedAt);
    expect(await taskRow(target, fromSource.id)).toMatchObject({
      tray: 'archive',
      story_id: null,
      position: 'a01V',
      deleted_at: null,
    });
    expect((await logsOf(target, 'task', fromSource.id)).map((log) => log.changes)).toEqual([
      { story: [{ id: story.id, title: '検索' }, null], tray: ['backlog', 'archive'] },
    ]);
    expect((await logsOf(target, 'story', story.id)).map((log) => [log.action, log.actor_user_id])).toEqual([
      ['delete', target.admin.userId],
    ]);
  });
});

describe('権限と断るもの', () => {
  test('作った人、リーダー、管理者は削除できる。ほかのメンバーは 403 の forbidden で、何も書かない', async () => {
    const target = await createTarget();
    const ws = target.workspace.id;
    const other = await createPerson({
      organization: target.organization,
      membership: { workspaceId: ws, role: 'member' },
    });
    for (const person of [target.member, target.leader, target.admin]) {
      const epic = await createEpic(target.organization, ws, target.member.userId!);
      expect((await removeEpic(target, epic.id, 'keep', person)).status).toBe(200);
      const story = await createStory(target.organization, ws, target.member.userId!);
      expect((await removeStory(target, story.id, 'delete', person)).status).toBe(200);
    }
    const epic = await createEpic(target.organization, ws, target.member.userId!);
    const child = await createStory(target.organization, ws, target.member.userId!, { epic_id: epic.id });
    const task = await createTask(target.organization, ws, target.member.userId!, { story_id: child.id });
    const before = (await allLogs(target)).length;
    for (const mode of ['keep', 'delete'] as const) {
      const epicRes = await removeEpic(target, epic.id, mode, other);
      expect(epicRes.status).toBe(403);
      expect(await errorCodeOf(epicRes)).toBe('forbidden');
      const storyRes = await removeStory(target, child.id, mode, other);
      expect(storyRes.status).toBe(403);
      expect(await errorCodeOf(storyRes)).toBe('forbidden');
    }
    expect((await epicRow(target, epic.id)).deleted_at).toBeNull();
    expect(await storyRow(target, child.id)).toMatchObject({ deleted_at: null, epic_id: epic.id });
    expect(await taskRow(target, task.id)).toMatchObject({ deleted_at: null, story_id: child.id });
    expect((await allLogs(target)).length).toBe(before);
  });

  test('別の組織、別のワークスペース、削除済みは、権限より先に 404 で、何も書かない', async () => {
    const target = await createTarget();
    const foreign = await createTarget();
    const ws = target.workspace.id;
    const foreignEpic = await createEpic(foreign.organization, foreign.workspace.id, foreign.admin.userId!);
    const foreignStory = await createStory(foreign.organization, foreign.workspace.id, foreign.admin.userId!);
    const elsewhereEpic = await createEpic(target.organization, target.otherWorkspace.id, target.admin.userId!);
    const elsewhereStory = await createStory(target.organization, target.otherWorkspace.id, target.admin.userId!);
    const goneEpic = await createEpic(target.organization, ws, target.leader.userId!, {
      deleted_at: '2026-10-21T00:00:00.000Z',
    });
    const goneStory = await createStory(target.organization, ws, target.leader.userId!, {
      deleted_at: '2026-10-21T00:00:00.000Z',
    });
    // 削除済みのエピックの下に残ったストーリー（keep で動かさない）
    const strayStory = await createStory(target.organization, ws, target.leader.userId!, { epic_id: goneEpic.id });
    for (const id of [foreignEpic.id, elsewhereEpic.id, goneEpic.id]) {
      const res = await removeEpic(target, id, 'keep', target.member);
      expect(res.status, id).toBe(404);
      expect(await errorCodeOf(res)).toBe('not_found');
    }
    for (const id of [foreignStory.id, elsewhereStory.id, goneStory.id]) {
      const res = await removeStory(target, id, 'delete', target.member);
      expect(res.status, id).toBe(404);
      expect(await errorCodeOf(res)).toBe('not_found');
    }
    expect((await storyRow(target, strayStory.id)).epic_id).toBe(goneEpic.id);
    expect(await allLogs(target)).toEqual([]);
    expect(await allLogs(foreign)).toEqual([]);
  });

  test('閉じたワークスペースは 409 の workspace_closed で、何も書かない', async () => {
    const target = await createTarget({ closed: true });
    const ws = target.workspace.id;
    const epic = await createEpic(target.organization, ws, target.admin.userId!);
    const story = await createStory(target.organization, ws, target.admin.userId!, { epic_id: epic.id });
    for (const mode of ['keep', 'delete'] as const) {
      const epicRes = await removeEpic(target, epic.id, mode, target.admin);
      expect(epicRes.status).toBe(409);
      expect(await errorCodeOf(epicRes)).toBe('workspace_closed');
      const storyRes = await removeStory(target, story.id, mode, target.admin);
      expect(storyRes.status).toBe(409);
      expect(await errorCodeOf(storyRes)).toBe('workspace_closed');
    }
    expect((await epicRow(target, epic.id)).deleted_at).toBeNull();
    expect(await storyRow(target, story.id)).toMatchObject({ deleted_at: null, epic_id: epic.id });
    expect(await allLogs(target)).toEqual([]);
  });

  test('配下の扱いは必須で、ほかの値は 400', async () => {
    const target = await createTarget();
    const epic = await createEpic(target.organization, target.workspace.id, target.member.userId!);
    for (const body of [
      { workspace_id: target.workspace.id, epic_id: epic.id },
      { workspace_id: target.workspace.id, epic_id: epic.id, children: 'archive' },
    ]) {
      const res = await post(app, epicDelete, { slug: target.slug, token: target.member.token, body });
      expect(res.status).toBe(400);
    }
    expect((await epicRow(target, epic.id)).deleted_at).toBeNull();
  });

  test('読んでから書くまでに別の要求が先に削除していたら 404 で、配下も履歴も書かない', async () => {
    const target = await createTarget();
    const ws = target.workspace.id;
    const epic = await createEpic(target.organization, ws, target.member.userId!);
    const story = await createStory(target.organization, ws, target.member.userId!, { epic_id: epic.id });
    let done = false;
    const racing = envWithD1Hooks(testEnv, {
      afterQuery: async (sql) => {
        if (done || !sql.startsWith('select "epics"."id", "epics"."created_by" from "epics"')) return;
        done = true;
        const db = dbOf(target);
        await db.run(
          db.statement((q) =>
            q
              .updateTable('epics')
              .set({ deleted_at: '2026-10-21T00:00:00.000Z' })
              .where('id', '=', epic.id)
              .where('workspace_id', '=', ws),
          ),
        );
      },
    });
    const res = await removeEpic(target, epic.id, 'keep', target.member, racing);
    expect(done).toBe(true);
    expect(res.status).toBe(404);
    expect((await storyRow(target, story.id)).epic_id).toBe(epic.id);
    expect(await allLogs(target)).toEqual([]);
  });

  // 根を読んだ直後に、別の要求が根を削除するか、ワークスペースを閉じる
  const rootRead = {
    epic: 'select "epics"."id", "epics"."created_by" from "epics"',
    story: 'select "stories"."id", "stories"."created_by" from "stories"',
  } as const;
  test.each([
    ['epic', 'delete', 'deleted', 404, 'not_found'],
    ['story', 'keep', 'deleted', 404, 'not_found'],
    ['story', 'delete', 'deleted', 404, 'not_found'],
    ['epic', 'keep', 'closed', 409, 'workspace_closed'],
    ['epic', 'delete', 'closed', 409, 'workspace_closed'],
    ['story', 'keep', 'closed', 409, 'workspace_closed'],
    ['story', 'delete', 'closed', 409, 'workspace_closed'],
  ] as const)(
    '%s を %s で消す要求の、読んでから書くまでに %s なら %i で、配下も履歴も書かない',
    async (kind, mode, change, status, code) => {
      const target = await createTarget();
      const ws = target.workspace.id;
      const me = target.member.userId!;
      const epic = await createEpic(target.organization, ws, me);
      const story = await createStory(target.organization, ws, me, { epic_id: epic.id });
      const task = await createTask(target.organization, ws, me, { story_id: story.id });
      const fromSource = await createTask(target.organization, ws, me, imported({ story_id: story.id }));
      let done = false;
      const racing = envWithD1Hooks(testEnv, {
        afterQuery: async (sql) => {
          if (done || !sql.startsWith(rootRead[kind])) return;
          done = true;
          const db = dbOf(target);
          if (change === 'closed') {
            await db.run(
              db.statement((q) =>
                q
                  .updateTable('workspaces')
                  .set({ closed_at: '2026-10-21T00:00:00.000Z' })
                  .where('id', '=', ws)
                  .where('organization_id', '=', target.organization.id),
              ),
            );
          } else {
            await db.run(
              db.statement((q) =>
                q
                  .updateTable(kind === 'epic' ? 'epics' : ('stories' as 'epics'))
                  .set({ deleted_at: '2026-10-21T00:00:00.000Z' })
                  .where('id', '=', kind === 'epic' ? epic.id : story.id)
                  .where('workspace_id', '=', ws),
              ),
            );
          }
        },
      });
      const res =
        kind === 'epic'
          ? await removeEpic(target, epic.id, mode, target.member, racing)
          : await removeStory(target, story.id, mode, target.member, racing);
      expect(done).toBe(true);
      expect(res.status).toBe(status);
      expect(await errorCodeOf(res)).toBe(code);
      expect(await storyRow(target, story.id)).toMatchObject({ epic_id: epic.id });
      expect(await taskRow(target, task.id)).toMatchObject({ story_id: story.id, deleted_at: null });
      expect(await taskRow(target, fromSource.id)).toMatchObject({ story_id: story.id, tray: 'backlog' });
      expect(await allLogs(target)).toEqual([]);
    },
  );
});

describe('一般のメンバーのまとめて削除', () => {
  async function setup() {
    const target = await createTarget();
    const other = await createPerson({
      organization: target.organization,
      membership: { workspaceId: target.workspace.id, role: 'member' },
    });
    return { target, ws: target.workspace.id, me: target.member.userId!, other };
  }

  test('他の人の作った配下（ストーリー、その下のタスク、ストーリーのタスク。完了したものも）があれば 403 の forbidden で、何も書かない', async () => {
    const { target, ws, me, other } = await setup();
    // エピックの下に他の人のストーリー
    const e1 = await createEpic(target.organization, ws, me);
    await createStory(target.organization, ws, other.userId!, { epic_id: e1.id });
    // エピックの下の自分のストーリーの、他の人の完了したタスク
    const e2 = await createEpic(target.organization, ws, me);
    const s2 = await createStory(target.organization, ws, me, { epic_id: e2.id });
    await createTask(target.organization, ws, other.userId!, {
      story_id: s2.id,
      completed_at: '2026-10-21T00:00:00.000Z',
      completed_by: other.userId!,
    });
    // ストーリーの下の他の人のタスク
    const s3 = await createStory(target.organization, ws, me);
    await createTask(target.organization, ws, other.userId!, { story_id: s3.id });

    for (const res of [
      await removeEpic(target, e1.id, 'delete'),
      await removeEpic(target, e2.id, 'delete'),
      await removeStory(target, s3.id, 'delete'),
    ]) {
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ error: { code: 'forbidden', details: { reason: 'others_children' } } });
    }
    expect((await epicRow(target, e1.id)).deleted_at).toBeNull();
    expect((await epicRow(target, e2.id)).deleted_at).toBeNull();
    expect((await storyRow(target, s3.id)).deleted_at).toBeNull();
    expect(await allLogs(target)).toEqual([]);
    // 配下を残すなら、同じ人でも消せる
    expect((await removeStory(target, s3.id, 'keep')).status).toBe(200);
  });

  test('配下がすべて自分の作ったものなら通す。取り込んだタスクと削除した他の人の配下は数えない', async () => {
    const { target, ws, me, other } = await setup();
    const epic = await createEpic(target.organization, ws, me);
    const story = await createStory(target.organization, ws, me, { epic_id: epic.id });
    const mine = await createTask(target.organization, ws, me, { story_id: story.id });
    const fromSource = await createTask(target.organization, ws, me, imported({ story_id: story.id }));
    await createTask(target.organization, ws, other.userId!, {
      story_id: story.id,
      deleted_at: '2026-10-21T00:00:00.000Z',
    });
    await createStory(target.organization, ws, other.userId!, {
      epic_id: epic.id,
      deleted_at: '2026-10-21T00:00:00.000Z',
    });
    expect((await removeEpic(target, epic.id, 'delete')).status).toBe(200);
    expect((await storyRow(target, story.id)).deleted_at).not.toBeNull();
    expect((await taskRow(target, mine.id)).deleted_at).not.toBeNull();
    expect((await taskRow(target, fromSource.id)).tray).toBe('archive');
  });

  test('リーダーと管理者は、他の人の作った配下があってもまとめて削除できる', async () => {
    const { target, ws, me, other } = await setup();
    for (const person of [target.leader, target.admin]) {
      const epic = await createEpic(target.organization, ws, me);
      const story = await createStory(target.organization, ws, other.userId!, { epic_id: epic.id });
      await createTask(target.organization, ws, other.userId!, { story_id: story.id });
      expect((await removeEpic(target, epic.id, 'delete', person)).status).toBe(200);
      expect((await storyRow(target, story.id)).deleted_at).not.toBeNull();
    }
  });

  test.each(['epic', 'story'] as const)(
    '%s: 読んでから書くまでに他の人のタスクが配下へ移されたら 403 で、何も書かない',
    async (kind) => {
      const { target, ws, me, other } = await setup();
      const epic = await createEpic(target.organization, ws, me);
      const story = await createStory(target.organization, ws, me, { epic_id: kind === 'epic' ? epic.id : null });
      const mine = await createTask(target.organization, ws, me, { story_id: story.id });
      const theirs = await createTask(target.organization, ws, other.userId!);
      // 他の人の作った配下を探す読み取り（無かった）の直後に、他の人のタスクをストーリーの下へ移す
      const othersRead =
        kind === 'epic' ? 'select "os"."id" from "stories" as "os"' : 'select "ot"."id" from "tasks" as "ot"';
      let done = false;
      const racing = envWithD1Hooks(testEnv, {
        afterQuery: async (sql) => {
          if (done || !sql.startsWith(othersRead)) return;
          done = true;
          const db = dbOf(target);
          await db.run(
            db.statement((q) =>
              q
                .updateTable('tasks')
                .set({ story_id: story.id })
                .where('id', '=', theirs.id)
                .where('workspace_id', '=', ws),
            ),
          );
        },
      });
      const res =
        kind === 'epic'
          ? await removeEpic(target, epic.id, 'delete', target.member, racing)
          : await removeStory(target, story.id, 'delete', target.member, racing);
      expect(done).toBe(true);
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ error: { code: 'forbidden', details: { reason: 'others_children' } } });
      expect((await epicRow(target, epic.id)).deleted_at).toBeNull();
      expect((await storyRow(target, story.id)).deleted_at).toBeNull();
      expect((await taskRow(target, mine.id)).deleted_at).toBeNull();
      expect(await allLogs(target)).toEqual([]);
    },
  );

  test('epic-get と story-get の can_delete_children は、リーダーと管理者か、他の人の作った配下が無いとき真', async () => {
    const { target, ws, me, other } = await setup();
    const epic = await createEpic(target.organization, ws, me);
    const story = await createStory(target.organization, ws, me, { epic_id: epic.id });
    const read = async (person: Person) => ({
      epic: (await (
        await post(app, epicGet, {
          slug: target.slug,
          token: person.token,
          body: { workspace_id: ws, epic_id: epic.id },
        })
      ).json()) as { can_delete: boolean; can_delete_children: boolean },
      story: (await (
        await post(app, storyGet, {
          slug: target.slug,
          token: person.token,
          body: { workspace_id: ws, story_id: story.id },
        })
      ).json()) as { can_delete: boolean; can_delete_children: boolean },
    });
    const flags = (value: { epic: { can_delete_children: boolean }; story: { can_delete_children: boolean } }) => [
      value.epic.can_delete_children,
      value.story.can_delete_children,
    ];
    expect(flags(await read(target.member))).toEqual([true, true]);
    await createTask(target.organization, ws, other.userId!, { story_id: story.id });
    expect(flags(await read(target.member))).toEqual([false, false]);
    expect(flags(await read(target.leader))).toEqual([true, true]);
    expect(flags(await read(target.admin))).toEqual([true, true]);
    // 削除できない人は、まとめて削除もできない
    const outsider = await read(other);
    expect([outsider.epic.can_delete, outsider.epic.can_delete_children]).toEqual([false, false]);
  });
});

describe('実行計画', () => {
  test.each(['epic', 'story'] as const)(
    '%s を根にした文は、配下のストーリーを stories_workspace_epic、タスクを tasks_story で引き、タスクの表を走査しない',
    async (kind) => {
      const target = await createTarget();
      const db = dbOf(target);
      const context = {
        organizationId: target.organization.id,
        workspaceId: target.workspace.id,
        actorUserId: target.member.userId!,
        at: new Date(AT),
        deletedAt: AT,
        ownerOnly: target.member.userId!,
      };
      for (const mode of ['keep', 'delete'] as const) {
        const { statements } = deleteStatements(db, context, { kind, id: uuidv7() }, mode);
        const plans = await Promise.all(
          statements.map(async (statement) => (await queryPlanForTest(env, statement)).join('\n')),
        );
        const all = plans.join('\n');
        if (kind === 'epic') expect(all).toContain('stories_workspace_epic');
        expect(all).toContain('tasks_story');
        // 配下のタスク（ut、t、ot）を tasks_workspace_tray や全件の走査で引かない（移す先の末尾を読む別名なしの tasks だけが使う）
        expect(all).not.toMatch(/\b(ut|t|ot) USING (COVERING )?INDEX tasks_workspace_tray/);
        expect(all).not.toMatch(/^\s*SCAN (tasks|stories|ut|t|s|us|es|os|ot)\s*$/m);
      }
    },
  );
});

describe('文の数', () => {
  // 削除の batch() の文の数。子の数によらず決まっている
  async function statementCount(children: number, kind: 'epic' | 'story', mode: Mode): Promise<number> {
    const target = await createTarget();
    const ws = target.workspace.id;
    const me = target.member.userId!;
    const epic = await createEpic(target.organization, ws, me);
    const story = await createStory(target.organization, ws, me, kind === 'epic' ? { epic_id: epic.id } : {});
    for (let i = 0; i < children; i++) {
      if (kind === 'epic') await createStory(target.organization, ws, me, { epic_id: epic.id });
      await createTask(
        target.organization,
        ws,
        me,
        i % 2 === 0 ? { story_id: story.id } : imported({ story_id: story.id }),
      );
    }
    const batches: number[] = [];
    const counting = envWithD1Hooks(testEnv, { beforeBatch: (sqls) => void batches.push(sqls.length) });
    const res =
      kind === 'epic'
        ? await removeEpic(target, epic.id, mode, target.member, counting)
        : await removeStory(target, story.id, mode, target.member, counting);
    expect(res.status).toBe(200);
    // 書く batch() は最後の1回（読み取りの batch() が先にあれば、その後ろ）
    return batches.at(-1)!;
  }

  test.each([
    ['epic', 'keep', 4],
    ['epic', 'delete', 9],
    ['story', 'keep', 4],
    ['story', 'delete', 7],
  ] as const)('%s を %s で削除する文は %i 個で、子が 1 件でも 30 件でも同じ', async (kind, mode, expected) => {
    expect(await statementCount(1, kind, mode)).toBe(expected);
    expect(await statementCount(30, kind, mode)).toBe(expected);
  });

  test('子が多くても、振った位置は元の並びのまま末尾に続く（桁をそろえる）', async () => {
    const target = await createTarget();
    const ws = target.workspace.id;
    const me = target.member.userId!;
    const story = await createStory(target.organization, ws, me);
    const ids: string[] = [];
    for (let i = 0; i < 12; i++) {
      ids.push(
        (
          await createTask(target.organization, ws, me, {
            story_id: story.id,
            position: `a${String.fromCharCode(65 + i)}`,
          })
        ).id,
      );
    }
    expect((await removeStory(target, story.id, 'keep')).status).toBe(200);
    const positions = await Promise.all(ids.map(async (id) => (await taskRow(target, id)).position));
    expect(positions[0]).toBe('a001V');
    expect(positions[11]).toBe('a012V');
    expectOrderedKeys(positions);
  });
});

describe('epic-get と story-get の削除の可否と配下の件数', () => {
  test('作った人、リーダー、管理者は can_delete が真、ほかのメンバーは偽。件数は削除していない配下（完了したものも含む）', async () => {
    const target = await createTarget();
    const ws = target.workspace.id;
    const me = target.member.userId!;
    const other = await createPerson({
      organization: target.organization,
      membership: { workspaceId: ws, role: 'member' },
    });
    const epic = await createEpic(target.organization, ws, me);
    const s1 = await createStory(target.organization, ws, me, { epic_id: epic.id });
    const s2 = await createStory(target.organization, ws, me, {
      epic_id: epic.id,
      completed_at: '2026-10-21T00:00:00.000Z',
      completed_by: me,
    });
    await createStory(target.organization, ws, me, { epic_id: epic.id, deleted_at: '2026-10-21T00:00:00.000Z' });
    await createTask(target.organization, ws, me, { story_id: s1.id });
    await createTask(target.organization, ws, me, {
      story_id: s1.id,
      completed_at: '2026-10-21T00:00:00.000Z',
      completed_by: me,
    });
    await createTask(target.organization, ws, me, { story_id: s2.id });
    await createTask(target.organization, ws, me, { story_id: s2.id, deleted_at: '2026-10-21T00:00:00.000Z' });

    for (const [person, expected] of [
      [target.member, true],
      [target.leader, true],
      [target.admin, true],
      [other, false],
    ] as const) {
      const epicRes = await post(app, epicGet, {
        slug: target.slug,
        token: person.token,
        body: { workspace_id: ws, epic_id: epic.id },
      });
      expect(epicRes.status).toBe(200);
      expect(await epicRes.json()).toMatchObject({ can_delete: expected, children: { stories: 2, tasks: 3 } });
      const storyRes = await post(app, storyGet, {
        slug: target.slug,
        token: person.token,
        body: { workspace_id: ws, story_id: s1.id },
      });
      expect(storyRes.status).toBe(200);
      expect(await storyRes.json()).toMatchObject({ can_delete: expected, children: { tasks: 2 } });
    }
  });
});
