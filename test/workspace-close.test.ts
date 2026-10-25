// ワークスペースを閉じる操作と開き直す操作の振る舞い。
// 組織の分離と権限の種類ごとの許可と拒否、閉じた対象への書き込みの 409 は、一覧を回す test/operation-registry.test.ts が確かめる
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { taskCreate } from '../src/shared/operations/task/index.ts';
import { workspaceClose, workspaceInfo, workspaceReopen } from '../src/shared/operations/workspace/index.ts';
import { createApp } from '../src/server/app.ts';
import { orgDb } from '../src/server/db/index.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import { createWorkspace, type OrganizationFixture } from './factories.ts';
import { errorCodeOf, post } from './operations/harness.ts';
import { admitElsewhere, createPerson, createTarget, type Target } from './operations/world.ts';

const app = createApp(implementedOperations);

const CLOSED_AT = '2026-10-22T00:00:00.000Z';
const NOW = '2026-10-26T03:00:00.000Z';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function close(target: Target, token: string, workspaceId: string, slug: string = target.slug) {
  return post(app, workspaceClose, { slug, token, body: { workspace_id: workspaceId } });
}

function reopen(target: Target, token: string, workspaceId: string, slug: string = target.slug) {
  return post(app, workspaceReopen, { slug, token, body: { workspace_id: workspaceId } });
}

async function readWorkspace(organization: OrganizationFixture, workspaceId: string) {
  const db = orgDb(env, organization.verified);
  const [row] = await db.rows(
    db.statement((q) =>
      q
        .selectFrom('workspaces')
        .select(['closed_at', 'updated_at'])
        .where('id', '=', workspaceId)
        .where('organization_id', '=', organization.id),
    ),
  );
  return row;
}

async function readLogs(organization: OrganizationFixture, workspaceId: string) {
  const db = orgDb(env, organization.verified);
  return db.rows(
    db.statement((q) =>
      q
        .selectFrom('change_logs')
        .selectAll()
        .where('organization_id', '=', organization.id)
        .where('workspace_id', '=', workspaceId)
        .orderBy('created_at')
        .orderBy('id'),
    ),
  );
}

async function openWorkspace(target: Target) {
  return createWorkspace(target.organization, target.admin.userId!);
}

async function closedWorkspace(target: Target) {
  return createWorkspace(target.organization, target.admin.userId!, { closed_at: CLOSED_AT });
}

// 入口の first が、条件に合う行を返した直後に一度だけ mutate を走らせる（読んでから書くまでの間に起きる変更）。
// 入口の first は DbEntry.prototype にある
function afterRead(target: Target, matches: (row: Record<string, unknown>) => boolean, mutate: () => Promise<void>) {
  const entry = orgDb(env, target.organization.verified);
  const prototype = Object.getPrototypeOf(Object.getPrototypeOf(entry)) as {
    first: (this: unknown, ...args: unknown[]) => Promise<unknown>;
  };
  const original = prototype.first;
  let fired = false;
  vi.spyOn(prototype, 'first').mockImplementation(async function (this: unknown, ...args: unknown[]) {
    const row = await original.apply(this, args);
    if (!fired && row !== undefined && matches(row as Record<string, unknown>)) {
      fired = true;
      await mutate();
    }
    return row;
  });
  return () => fired;
}

async function setWorkspace(target: Target, workspaceId: string, closedAt: string | null) {
  const db = orgDb(env, target.organization.verified);
  await db.batch([
    db.statement((q) =>
      q
        .updateTable('workspaces')
        .set({ closed_at: closedAt })
        .where('id', '=', workspaceId)
        .where('organization_id', '=', target.organization.id),
    ),
  ]);
}

async function demoteAdmin(target: Target) {
  const db = orgDb(env, target.organization.verified);
  await db.batch([
    db.statement((q) =>
      q
        .updateTable('users')
        .set({ is_admin: 0 })
        .where('id', '=', target.admin.userId!)
        .where('organization_id', '=', target.organization.id),
    ),
  ]);
}

describe('workspace-close', () => {
  test('閉じた日時と更新日時を書き、変更の履歴を1行残す', async () => {
    const target = await createTarget();
    const workspace = await openWorkspace(target);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(NOW));

    const res = await close(target, target.admin.token, workspace.id);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ workspace_id: workspace.id, closed_at: NOW });
    expect(await readWorkspace(target.organization, workspace.id)).toEqual({ closed_at: NOW, updated_at: NOW });

    const logs = await readLogs(target.organization, workspace.id);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      organization_id: target.organization.id,
      workspace_id: workspace.id,
      actor_user_id: target.admin.userId,
      operator: null,
      entity_type: 'workspace',
      entity_id: workspace.id,
      action: 'close',
      created_at: NOW,
    });
    expect(JSON.parse(logs[0]!.changes_json)).toEqual({ closed_at: [null, NOW] });
  });

  test('閉じた後は、枠の操作が閉じた日時を返し、タスクを作れない', async () => {
    const target = await createTarget();
    const workspace = await openWorkspace(target);
    expect((await close(target, target.admin.token, workspace.id)).status).toBe(200);

    const info = await post(app, workspaceInfo, {
      slug: target.slug,
      token: target.admin.token,
      body: { workspace_id: workspace.id },
    });
    expect(((await info.json()) as { closed_at: string | null }).closed_at).not.toBeNull();
    const created = await post(app, taskCreate, {
      slug: target.slug,
      token: target.admin.token,
      body: { workspace_id: workspace.id, title: '見積もりを送る' },
    });
    expect(created.status).toBe(409);
    expect(await errorCodeOf(created)).toBe('workspace_closed');
  });

  test('閉じたものを閉じると 409 の workspace_closed で、何も書かない', async () => {
    const target = await createTarget();
    const workspace = await closedWorkspace(target);

    const res = await close(target, target.admin.token, workspace.id);
    expect(res.status).toBe(409);
    expect(await errorCodeOf(res)).toBe('workspace_closed');
    expect(await readWorkspace(target.organization, workspace.id)).toEqual({
      closed_at: CLOSED_AT,
      updated_at: workspace.updated_at,
    });
    expect(await readLogs(target.organization, workspace.id)).toEqual([]);
  });

  test('管理者でない人（リーダー、メンバー、所属なし）は 403 で、何も書かない', async () => {
    const target = await createTarget();
    const workspace = await openWorkspace(target);
    for (const person of [target.leader, target.member, target.bystander]) {
      const res = await close(target, person.token, workspace.id);
      expect(res.status).toBe(403);
      expect(await errorCodeOf(res)).toBe('forbidden');
    }
    expect((await readWorkspace(target.organization, workspace.id))?.closed_at).toBeNull();
    expect(await readLogs(target.organization, workspace.id)).toEqual([]);
  });

  test('別の組織のワークスペースの ID は 404 で、何も書かない', async () => {
    const [target, other] = await Promise.all([createTarget(), createTarget()]);
    const res = await close(target, target.admin.token, other.workspace.id);
    expect(res.status).toBe(404);
    expect(await errorCodeOf(res)).toBe('not_found');
    expect((await readWorkspace(other.organization, other.workspace.id))?.closed_at).toBeNull();
    expect(await readLogs(other.organization, other.workspace.id)).toEqual([]);
  });

  test('無効にされた管理者は組織に入れず、何も書かない', async () => {
    const target = await createTarget();
    const workspace = await openWorkspace(target);
    // 入れる組織がほかに無いと、セッションごと消えて 401 になる。別の組織には入れる人にして、この組織の 404 を見る
    const disabled = await admitElsewhere(
      await createPerson({ organization: target.organization, admin: true, disabled: true }),
    );

    const res = await close(target, disabled.token, workspace.id);
    expect(res.status).toBe(404);
    expect((await readWorkspace(target.organization, workspace.id))?.closed_at).toBeNull();
    expect(await readLogs(target.organization, workspace.id)).toEqual([]);
  });

  test('読んでから書くまでに管理者を外されたら、404 で何も書かない', async () => {
    const target = await createTarget();
    const workspace = await openWorkspace(target);
    // 登録の関数がワークスペースを確かめる読み取りの直後
    const fired = afterRead(
      target,
      (row) => row.id === workspace.id && 'role' in row,
      () => demoteAdmin(target),
    );

    const res = await close(target, target.admin.token, workspace.id);
    expect(fired()).toBe(true);
    expect(res.status).toBe(404);
    expect((await readWorkspace(target.organization, workspace.id))?.closed_at).toBeNull();
    expect(await readLogs(target.organization, workspace.id)).toEqual([]);
  });

  test('読んでから書くまでに別の要求が閉じていたら、409 の workspace_closed で履歴を重ねない', async () => {
    const target = await createTarget();
    const workspace = await openWorkspace(target);
    const fired = afterRead(
      target,
      (row) => row.id === workspace.id && 'role' in row,
      () => setWorkspace(target, workspace.id, CLOSED_AT),
    );

    const res = await close(target, target.admin.token, workspace.id);
    expect(fired()).toBe(true);
    expect(res.status).toBe(409);
    expect(await errorCodeOf(res)).toBe('workspace_closed');
    expect((await readWorkspace(target.organization, workspace.id))?.closed_at).toBe(CLOSED_AT);
    expect(await readLogs(target.organization, workspace.id)).toEqual([]);
  });
});

describe('workspace-reopen', () => {
  test('閉じた日時を空にし、前の日時を残して変更の履歴を1行残す', async () => {
    const target = await createTarget();
    const workspace = await closedWorkspace(target);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(NOW));

    const res = await reopen(target, target.admin.token, workspace.id);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ workspace_id: workspace.id });
    expect(await readWorkspace(target.organization, workspace.id)).toEqual({ closed_at: null, updated_at: NOW });

    const logs = await readLogs(target.organization, workspace.id);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      organization_id: target.organization.id,
      workspace_id: workspace.id,
      actor_user_id: target.admin.userId,
      entity_type: 'workspace',
      entity_id: workspace.id,
      action: 'reopen',
      created_at: NOW,
    });
    expect(JSON.parse(logs[0]!.changes_json)).toEqual({ closed_at: [CLOSED_AT, null] });
  });

  test('閉じて、開き直すと、タスクを作れる状態に戻る。履歴は閉じると開き直しの2行', async () => {
    const target = await createTarget();
    const workspace = await openWorkspace(target);
    expect((await close(target, target.admin.token, workspace.id)).status).toBe(200);
    expect((await reopen(target, target.admin.token, workspace.id)).status).toBe(200);

    const created = await post(app, taskCreate, {
      slug: target.slug,
      token: target.admin.token,
      body: { workspace_id: workspace.id, title: '見積もりを送る' },
    });
    expect(created.status).toBe(200);
    const actions = (await readLogs(target.organization, workspace.id))
      .filter((log) => log.entity_type === 'workspace')
      .map((log) => log.action);
    expect(actions.sort()).toEqual(['close', 'reopen']);
  });

  test('開いているものを開き直すと 409 の conflict で、何も書かない', async () => {
    const target = await createTarget();
    const workspace = await openWorkspace(target);

    const res = await reopen(target, target.admin.token, workspace.id);
    expect(res.status).toBe(409);
    expect(await errorCodeOf(res)).toBe('conflict');
    expect(await readWorkspace(target.organization, workspace.id)).toEqual({
      closed_at: null,
      updated_at: workspace.updated_at,
    });
    expect(await readLogs(target.organization, workspace.id)).toEqual([]);
  });

  test('管理者でない人（リーダー、メンバー、所属なし）は 403 で、何も書かない', async () => {
    const target = await createTarget();
    const workspace = await closedWorkspace(target);
    for (const person of [target.leader, target.member, target.bystander]) {
      const res = await reopen(target, person.token, workspace.id);
      expect(res.status).toBe(403);
      expect(await errorCodeOf(res)).toBe('forbidden');
    }
    expect((await readWorkspace(target.organization, workspace.id))?.closed_at).toBe(CLOSED_AT);
    expect(await readLogs(target.organization, workspace.id)).toEqual([]);
  });

  test('別の組織のワークスペースの ID は 404 で、何も書かない', async () => {
    const [target, other] = await Promise.all([createTarget(), createTarget()]);
    const foreign = await closedWorkspace(other);
    const res = await reopen(target, target.admin.token, foreign.id);
    expect(res.status).toBe(404);
    expect(await errorCodeOf(res)).toBe('not_found');
    expect((await readWorkspace(other.organization, foreign.id))?.closed_at).toBe(CLOSED_AT);
    expect(await readLogs(other.organization, foreign.id)).toEqual([]);
  });

  test('無効にされた管理者は組織に入れず、何も書かない', async () => {
    const target = await createTarget();
    const workspace = await closedWorkspace(target);
    const disabled = await admitElsewhere(
      await createPerson({ organization: target.organization, admin: true, disabled: true }),
    );

    const res = await reopen(target, disabled.token, workspace.id);
    expect(res.status).toBe(404);
    expect((await readWorkspace(target.organization, workspace.id))?.closed_at).toBe(CLOSED_AT);
    expect(await readLogs(target.organization, workspace.id)).toEqual([]);
  });

  // 処理が閉じた日時を読んだ直後（select が closed_at の1列だけの問い合わせ）
  const handlerRead = (row: Record<string, unknown>) => Object.keys(row).join() === 'closed_at';

  test('読んでから書くまでに管理者を外されたら、404 で何も書かない', async () => {
    const target = await createTarget();
    const workspace = await closedWorkspace(target);
    const fired = afterRead(target, handlerRead, () => demoteAdmin(target));

    const res = await reopen(target, target.admin.token, workspace.id);
    expect(fired()).toBe(true);
    expect(res.status).toBe(404);
    expect((await readWorkspace(target.organization, workspace.id))?.closed_at).toBe(CLOSED_AT);
    expect(await readLogs(target.organization, workspace.id)).toEqual([]);
  });

  test('読んでから書くまでに別の要求が開き直していたら、409 の conflict で履歴を重ねない', async () => {
    const target = await createTarget();
    const workspace = await closedWorkspace(target);
    const fired = afterRead(target, handlerRead, () => setWorkspace(target, workspace.id, null));

    const res = await reopen(target, target.admin.token, workspace.id);
    expect(fired()).toBe(true);
    expect(res.status).toBe(409);
    expect(await errorCodeOf(res)).toBe('conflict');
    expect(await readLogs(target.organization, workspace.id)).toEqual([]);
  });

  test('読んでから書くまでに、開き直されて別の日時で閉じ直されていても、前の日時を履歴に誤って残さず 409', async () => {
    const target = await createTarget();
    const workspace = await closedWorkspace(target);
    const reclosedAt = '2026-10-25T00:00:00.000Z';
    const fired = afterRead(target, handlerRead, () => setWorkspace(target, workspace.id, reclosedAt));

    const res = await reopen(target, target.admin.token, workspace.id);
    expect(fired()).toBe(true);
    expect(res.status).toBe(409);
    expect(await errorCodeOf(res)).toBe('conflict');
    expect((await readWorkspace(target.organization, workspace.id))?.closed_at).toBe(reclosedAt);
    expect(await readLogs(target.organization, workspace.id)).toEqual([]);
  });
});
