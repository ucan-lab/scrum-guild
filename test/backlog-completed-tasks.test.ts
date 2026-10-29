import { describe, expect, test } from 'vitest';
import { backlogCompletedTasks } from '../src/shared/operations/task/index.ts';
import type { OutputOf } from '../src/shared/operations/define.ts';
import { createApp } from '../src/server/app.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import { AT, createStory, createTask, createUser, createMembership, uuidv7 } from './factories.ts';
import { post } from './operations/harness.ts';
import { createTarget, type Target } from './operations/world.ts';

const app = createApp(implementedOperations);
type Output = OutputOf<typeof backlogCompletedTasks>;
const read = (target: Target, input: Record<string, unknown> = {}) =>
  post(app, backlogCompletedTasks, {
    slug: target.slug,
    token: target.member.token,
    body: { workspace_id: target.workspace.id, story_id: null, ...input },
  });
async function body(target: Target, input: Record<string, unknown> = {}): Promise<Output> {
  const response = await read(target, input);
  expect(response.status).toBe(200);
  return response.json() as Promise<Output>;
}

describe('backlog-completed-tasks', () => {
  test('既定20件、日時と同時刻のIDの降順、nextから続きを重複なく読む', async () => {
    const target = await createTarget();
    const tasks = [];
    for (let i = 0; i < 22; i++)
      tasks.push(
        await createTask(target.organization, target.workspace.id, target.admin.userId!, {
          completed_at: i < 10 ? AT : '2026-10-21T00:00:00.000Z',
          completed_by: target.admin.userId,
        }),
      );
    const sorted = tasks.sort((a, b) => b.completed_at!.localeCompare(a.completed_at!) || b.id.localeCompare(a.id));
    const first = await body(target);
    expect(first.tasks.map((t) => t.id)).toEqual(sorted.slice(0, 20).map((t) => t.id));
    expect(first.next).toEqual({ completed_at: sorted[19]!.completed_at, id: sorted[19]!.id });
    const second = await body(target, { before: first.next });
    expect(second.tasks.map((t) => t.id)).toEqual(sorted.slice(20).map((t) => t.id));
    expect(second.next).toBeNull();
    expect((await body(target, { limit: 1 })).tasks).toHaveLength(1);
    expect((await body(target, { limit: 200 })).tasks).toHaveLength(22);
    for (const limit of [0, 201, 1.5]) expect((await read(target, { limit })).status).toBe(400);
  });

  test('親なしとストーリー配下を分け、未完了、削除、アーカイブ、他ワークスペースを除く。離脱者の名前も読む', async () => {
    const target = await createTarget();
    const owner = target.admin.userId!;
    const story = await createStory(target.organization, target.workspace.id, owner, {
      completed_at: AT,
      completed_by: owner,
    });
    const former = await createUser(target.organization, { name: '離脱した担い手' });
    await createMembership(target.organization, target.workspace.id, former.id, { left_at: AT, left_on: '2026-10-20' });
    const done = { completed_at: AT, completed_by: owner };
    const root = await createTask(target.organization, target.workspace.id, owner, {
      ...done,
      points: 3,
      assignee_user_id: former.id,
    });
    const child = await createTask(target.organization, target.workspace.id, owner, { ...done, story_id: story.id });
    await createTask(target.organization, target.workspace.id, owner);
    await createTask(target.organization, target.workspace.id, owner, { ...done, deleted_at: AT });
    await createTask(target.organization, target.workspace.id, owner, { ...done, tray: 'archive', is_imported: 1 });
    await createTask(target.organization, target.otherWorkspace.id, owner, done);
    const roots = await body(target);
    expect(roots.tasks).toEqual([
      {
        id: root.id,
        title: root.title,
        points: 3,
        completed_at: AT,
        assignee: { id: former.id, name: expect.any(String) },
      },
    ]);
    expect((await body(target, { story_id: story.id })).tasks).toEqual([
      { id: child.id, title: child.title, points: null, completed_at: AT, assignee: null },
    ]);
  });

  test('無い、別組織、別ワークスペース、削除済みのストーリーは404', async () => {
    const target = await createTarget();
    const other = await createTarget();
    const foreign = await createStory(other.organization, other.workspace.id, other.admin.userId!);
    const elsewhere = await createStory(target.organization, target.otherWorkspace.id, target.admin.userId!);
    const deleted = await createStory(target.organization, target.workspace.id, target.admin.userId!, {
      deleted_at: AT,
    });
    for (const story_id of [uuidv7(), foreign.id, elsewhere.id, deleted.id])
      expect((await read(target, { story_id })).status).toBe(404);
  });

  test('閉じたワークスペースでも読める。空ならnextはnull', async () => {
    const target = await createTarget({ closed: true });
    expect(await body(target)).toEqual({ tasks: [], next: null });
  });
});
