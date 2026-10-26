// メンバーのロールの付け替え（membership-role-update）と、ワークスペースからの離脱（membership-leave）の振る舞い。
// 組織の分離、権限の種類ごとの許可と拒否、閉じたワークスペースの 409 は、一覧を回す test/operation-registry.test.ts が確かめる
import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import { organizationInfo } from '../src/shared/operations/organization/index.ts';
import { taskComplete } from '../src/shared/operations/task/index.ts';
import { memberList, membershipLeave, membershipRoleUpdate } from '../src/shared/operations/workspace/index.ts';
import { createApp } from '../src/server/app.ts';
import { commonDb, orgDb, verifyWorkspace } from '../src/server/db/index.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import { membershipLeaveOperation, membershipRoleUpdateOperation } from '../src/server/operations/membership.ts';
import { createMembership, createTask, createUser, hash64 } from './factories.ts';
import { errorCodeOf, post } from './operations/harness.ts';
import { createPerson, createTarget, testEnv, type Person, type Target } from './operations/world.ts';

const app = createApp(implementedOperations);

function updateRole(target: Target, person: Person, userId: string, role: 'leader' | 'member') {
  return post(app, membershipRoleUpdate, {
    slug: target.slug,
    token: person.token,
    body: { workspace_id: target.workspace.id, user_id: userId, role },
  });
}

function leave(
  target: Target,
  person: Person,
  userId: string,
  workspaceId: string = target.workspace.id,
  requestEnv?: Env,
) {
  return post(app, membershipLeave, {
    slug: target.slug,
    token: person.token,
    body: { workspace_id: workspaceId, user_id: userId },
    ...(requestEnv === undefined ? {} : { env: requestEnv }),
  });
}

// 開発用の時計（DEV_NOW）を置いた環境（test/task-edit.test.ts と同じ）。DEV_NOW は、ループバックの公開 URL のときだけ使える
const FROZEN_AT = '2026-10-26T10:00:00+09:00';
const FROZEN_ISO = '2026-10-26T01:00:00.000Z';
function frozenEnv(): Env {
  return Object.assign({}, testEnv, { PUBLIC_ORIGIN: 'http://localhost:8787', DEV_NOW: FROZEN_AT });
}

function dbOf(target: Target) {
  return orgDb(env, target.organization.verified);
}

async function membershipsOf(target: Target, userId: string, workspaceId: string = target.workspace.id) {
  const db = dbOf(target);
  return db.rows(
    db.statement((q) =>
      q
        .selectFrom('memberships')
        .selectAll()
        .where('workspace_id', '=', workspaceId)
        .where('user_id', '=', userId)
        .orderBy('joined_at')
        .orderBy('id'),
    ),
  );
}

async function logsOf(target: Target, entityType: string, entityId: string) {
  const db = dbOf(target);
  const rows = await db.rows(
    db.statement((q) =>
      q
        .selectFrom('change_logs')
        .selectAll()
        .where('organization_id', '=', target.organization.id)
        .where('entity_type', '=', entityType)
        .where('entity_id', '=', entityId)
        .orderBy('created_at')
        .orderBy('id'),
    ),
  );
  return rows.map((row) => ({ ...row, changes: JSON.parse(row.changes_json) as unknown }));
}

async function taskOf(target: Target, taskId: string) {
  const db = dbOf(target);
  return db.first(db.statement((q) => q.selectFrom('tasks').selectAll().where('id', '=', taskId)));
}

async function sessionCount(accountId: string): Promise<number> {
  const db = commonDb(env);
  const rows = await db.rows(
    db.statement((q) => q.selectFrom('sessions').select('token_hash').where('account_id', '=', accountId)),
  );
  return rows.length;
}

async function nameOf(target: Target, userId: string): Promise<string> {
  const db = dbOf(target);
  const row = await db.first(db.statement((q) => q.selectFrom('users').select('name').where('id', '=', userId)));
  return row!.name;
}

async function rolesInList(target: Target): Promise<Record<string, string>> {
  const res = await post(app, memberList, {
    slug: target.slug,
    token: target.admin.token,
    body: { workspace_id: target.workspace.id },
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { members: { id: string; role: string }[] };
  return Object.fromEntries(body.members.map((member) => [member.id, member.role]));
}

describe('ロールの付け替え', () => {
  test('リーダーは一般のメンバーをリーダーにでき、変更の履歴に {"role": [前, 後]} が残る', async () => {
    const target = await createTarget();
    const res = await updateRole(target, target.leader, target.member.userId!, 'leader');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ user_id: target.member.userId, role: 'leader' });

    const [membership] = await membershipsOf(target, target.member.userId!);
    expect(membership!.role).toBe('leader');
    const logs = await logsOf(target, 'membership', membership!.id);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      workspace_id: target.workspace.id,
      actor_user_id: target.leader.userId,
      action: 'update',
      changes: { role: ['member', 'leader'] },
    });
    expect((await rolesInList(target))[target.member.userId!]).toBe('leader');
  });

  test('同じロールを送ると、何も書かずに今の値を返す', async () => {
    const target = await createTarget();
    const res = await updateRole(target, target.leader, target.member.userId!, 'member');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ user_id: target.member.userId, role: 'member' });
    const [membership] = await membershipsOf(target, target.member.userId!);
    expect(await logsOf(target, 'membership', membership!.id)).toHaveLength(0);
  });

  test('リーダーは自分を一般に戻せ、リーダーが0人になっても止めない。その後は管理者がリーダーを任命できる', async () => {
    const target = await createTarget();
    const demoted = await updateRole(target, target.leader, target.leader.userId!, 'member');
    expect(demoted.status).toBe(200);
    const roles = await rolesInList(target);
    expect(Object.values(roles).filter((role) => role === 'leader')).toHaveLength(0);

    // 一般に戻った人は、もうロールを付け替えられない
    const forbidden = await updateRole(target, target.leader, target.leader.userId!, 'leader');
    expect(forbidden.status).toBe(403);
    expect(await errorCodeOf(forbidden)).toBe('forbidden');

    // 所属していない管理者が任命する
    const appointed = await updateRole(target, target.admin, target.member.userId!, 'leader');
    expect(appointed.status).toBe(200);
    expect((await rolesInList(target))[target.member.userId!]).toBe('leader');
  });

  test('一覧に出ない人（ほかのワークスペースの人、無効にされた人、login_subject の無い人、抜けた人）は 404', async () => {
    const target = await createTarget();
    const disabled = await createUser(target.organization, { disabled_at: '2026-10-21T00:00:00.000Z' });
    await createMembership(target.organization, target.workspace.id, disabled.id);
    const waiting = await createUser(target.organization, {
      login_provider: 'google',
      login_subject: null,
      login_email: 'mio@example.test',
      claim_token_hash: hash64(),
      claim_expires_at: '2999-01-01T00:00:00.000Z',
    });
    await createMembership(target.organization, target.workspace.id, waiting.id);
    const left = await createUser(target.organization);
    await createMembership(target.organization, target.workspace.id, left.id, {
      left_on: '2026-10-10',
      left_at: '2026-10-10T00:00:00.000Z',
    });
    for (const userId of [target.bystander.userId!, disabled.id, waiting.id, left.id, 'no-such-user']) {
      const res = await updateRole(target, target.leader, userId, 'leader');
      expect(res.status, userId).toBe(404);
      expect(await errorCodeOf(res)).toBe('not_found');
    }
  });

  test('別の組織の人の ID は、無いときと同じ 404', async () => {
    const target = await createTarget();
    const other = await createTarget();
    const res = await updateRole(target, target.leader, other.member.userId!, 'leader');
    expect(res.status).toBe(404);
    expect(await errorCodeOf(res)).toBe('not_found');
    const [membership] = await membershipsOf(other, other.member.userId!, other.workspace.id);
    expect(membership!.role).toBe('member');
  });
});

describe('離脱', () => {
  test('一般のメンバーは自分で抜けられ、所属の終わりが変更の履歴に残る', async () => {
    const target = await createTarget();
    const res = await leave(target, target.member, target.member.userId!);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ user_id: target.member.userId });

    const [membership] = await membershipsOf(target, target.member.userId!);
    expect(membership!.left_at).not.toBeNull();
    // ワークスペースのタイムゾーン（Asia/Tokyo）の今日
    expect(membership!.left_on).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const logs = await logsOf(target, 'membership', membership!.id);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      workspace_id: target.workspace.id,
      actor_user_id: target.member.userId,
      action: 'delete',
      created_at: membership!.left_at,
      changes: {
        user: [{ id: target.member.userId, name: await nameOf(target, target.member.userId!) }, null],
        role: ['member', null],
      },
    });
    expect(Object.keys(await rolesInList(target))).not.toContain(target.member.userId);
  });

  test('リーダーと管理者は他人を外せ、一般のメンバーが他人を外すと 403', async () => {
    const target = await createTarget();
    const another = await createPerson({
      organization: target.organization,
      membership: { workspaceId: target.workspace.id, role: 'member' },
    });
    const forbidden = await leave(target, target.member, another.userId!);
    expect(forbidden.status).toBe(403);
    expect(await errorCodeOf(forbidden)).toBe('forbidden');
    expect((await membershipsOf(target, another.userId!))[0]!.left_at).toBeNull();

    expect((await leave(target, target.leader, another.userId!)).status).toBe(200);
    expect((await leave(target, target.admin, target.member.userId!)).status).toBe(200);
    // リーダーも外せる（リーダーが0人になっても止めない）
    expect((await leave(target, target.admin, target.leader.userId!)).status).toBe(200);
    expect(await rolesInList(target)).toEqual({});
  });

  test('二重の離脱は 404。所属していない管理者が自分を指しても 404', async () => {
    const target = await createTarget();
    expect((await leave(target, target.leader, target.member.userId!)).status).toBe(200);
    const again = await leave(target, target.leader, target.member.userId!);
    expect(again.status).toBe(404);
    expect(await errorCodeOf(again)).toBe('not_found');
    const [membership] = await membershipsOf(target, target.member.userId!);
    expect(await logsOf(target, 'membership', membership!.id)).toHaveLength(1);

    const admin = await leave(target, target.admin, target.admin.userId!);
    expect(admin.status).toBe(404);
    expect(await errorCodeOf(admin)).toBe('not_found');
  });

  test('別の組織の人の ID は 404 で、その組織の所属は変えない', async () => {
    const target = await createTarget();
    const other = await createTarget();
    const res = await leave(target, target.admin, other.member.userId!);
    expect(res.status).toBe(404);
    expect(await errorCodeOf(res)).toBe('not_found');
    expect((await membershipsOf(other, other.member.userId!, other.workspace.id))[0]!.left_at).toBeNull();
  });

  test('外れた人が担当していた未完了のタスクは担当なしになり、完了したタスク、完了の記録、経験値は残る', async () => {
    const target = await createTarget();
    const userId = target.member.userId!;
    const open = await createTask(target.organization, target.workspace.id, userId, { assignee_user_id: userId });
    const today = await createTask(target.organization, target.workspace.id, userId, {
      assignee_user_id: userId,
      today_on: '2026-10-26',
    });
    const done = await createTask(target.organization, target.workspace.id, userId, {
      assignee_user_id: userId,
      points: 3,
    });
    const deleted = await createTask(target.organization, target.workspace.id, userId, {
      assignee_user_id: userId,
      deleted_at: '2026-10-21T00:00:00.000Z',
    });
    const others = await createTask(target.organization, target.workspace.id, userId, {
      assignee_user_id: target.leader.userId,
    });
    // 同じ人の、別のワークスペースのタスクは変えない
    await createMembership(target.organization, target.otherWorkspace.id, userId);
    const elsewhere = await createTask(target.organization, target.otherWorkspace.id, userId, {
      assignee_user_id: userId,
    });

    const completed = await post(app, taskComplete, {
      slug: target.slug,
      token: target.member.token,
      body: { workspace_id: target.workspace.id, task_id: done.id },
    });
    expect(completed.status).toBe(200);
    const db = dbOf(target);
    const countOf = async (table: 'completions' | 'xp_grants') =>
      (
        await db.rows(
          db.statement((q) => q.selectFrom(table).select('id').where('workspace_id', '=', target.workspace.id)),
        )
      ).length;
    const completionsBefore = await countOf('completions');
    const grantsBefore = await countOf('xp_grants');
    expect(completionsBefore).toBe(1);
    expect(grantsBefore).toBeGreaterThan(0);

    const res = await leave(target, target.leader, userId);
    expect(res.status).toBe(200);
    const name = await nameOf(target, userId);
    const [membership] = await membershipsOf(target, userId);

    for (const task of [open, today]) {
      const row = await taskOf(target, task.id);
      expect(row!.assignee_user_id).toBeNull();
      expect(row!.today_on).toBeNull();
      expect(row!.updated_at).toBe(membership!.left_at);
    }
    expect((await logsOf(target, 'task', open.id)).map((log) => [log.action, log.actor_user_id, log.changes])).toEqual([
      ['update', target.leader.userId, { assignee: [{ id: userId, name }, null] }],
    ]);
    expect((await logsOf(target, 'task', today.id)).map((log) => log.changes)).toEqual([
      { assignee: [{ id: userId, name }, null], today_on: ['2026-10-26', null] },
    ]);
    // 完了したタスク、削除したタスク、ほかの人のタスク、別のワークスペースのタスクは変えない
    expect((await taskOf(target, done.id))!.assignee_user_id).toBe(userId);
    expect((await taskOf(target, deleted.id))!.assignee_user_id).toBe(userId);
    expect((await taskOf(target, others.id))!.assignee_user_id).toBe(target.leader.userId);
    expect((await taskOf(target, elsewhere.id))!.assignee_user_id).toBe(userId);
    for (const task of [deleted, others, elsewhere]) expect(await logsOf(target, 'task', task.id)).toHaveLength(0);
    expect((await logsOf(target, 'task', done.id)).filter((log) => log.action === 'update')).toHaveLength(0);
    expect(await countOf('completions')).toBe(completionsBefore);
    expect(await countOf('xp_grants')).toBe(grantsBefore);
  });

  test('すべてのワークスペースから外れた人は組織に入れず、入れる組織が無くなればセッションが消える', async () => {
    const target = await createTarget();
    expect(await sessionCount(target.member.accountId)).toBe(1);
    expect((await leave(target, target.leader, target.member.userId!)).status).toBe(200);
    expect(await sessionCount(target.member.accountId)).toBe(0);
    const res = await post(app, organizationInfo, { slug: target.slug, token: target.member.token, body: {} });
    expect(res.status).toBe(401);
  });

  test('ほかのワークスペースに残る人は、組織に入れたままでセッションも消えない', async () => {
    const target = await createTarget();
    await createMembership(target.organization, target.otherWorkspace.id, target.member.userId!);
    expect((await leave(target, target.member, target.member.userId!)).status).toBe(200);
    expect(await sessionCount(target.member.accountId)).toBe(1);
    const res = await post(app, organizationInfo, { slug: target.slug, token: target.member.token, body: {} });
    expect(res.status).toBe(200);
    // 抜けたワークスペースには入れない
    const list = await post(app, memberList, {
      slug: target.slug,
      token: target.member.token,
      body: { workspace_id: target.workspace.id },
    });
    expect(list.status).toBe(403);
  });

  test('時計を止めた二重の離脱（同じ時刻の2つの要求）でも、所属とタスクの履歴は1回分のまま', async () => {
    const target = await createTarget();
    const userId = target.member.userId!;
    const task = await createTask(target.organization, target.workspace.id, userId, { assignee_user_id: userId });
    const requestEnv = frozenEnv();
    const [first, second] = await Promise.all([
      leave(target, target.leader, userId, target.workspace.id, requestEnv),
      leave(target, target.admin, userId, target.workspace.id, requestEnv),
    ]);
    expect([first.status, second.status].sort()).toEqual([200, 404]);
    // 続けてもう一度送っても、同じ時刻のまま 404 で何も書かない
    expect((await leave(target, target.leader, userId, target.workspace.id, requestEnv)).status).toBe(404);

    const [membership] = await membershipsOf(target, userId);
    expect(membership!.left_at).toBe(FROZEN_ISO);
    expect(await logsOf(target, 'membership', membership!.id)).toHaveLength(1);
    expect(await logsOf(target, 'task', task.id)).toHaveLength(1);
    expect((await taskOf(target, task.id))!.assignee_user_id).toBeNull();
  });
});

// 読んでから書くまでに別の要求が割り込む。処理を直に呼び、相手の所属（role を持つ行）を読んだ直後に race を走らせる
describe('読んでから書くまでの競合', () => {
  async function runWithRace(
    operation: typeof membershipRoleUpdateOperation,
    target: Target,
    caller: Person,
    input: Record<string, unknown>,
    race: () => Promise<void>,
  ) {
    const db = orgDb(env, target.organization.verified);
    const actor = { accountId: caller.accountId, userId: caller.userId, isAdmin: false, invitedOnly: false };
    const workspace = await verifyWorkspace(db, actor, target.workspace.id);
    let raced = false;
    const racing = new Proxy(db, {
      get(base, key) {
        const value = Reflect.get(base, key, base);
        if (typeof value !== 'function') return value;
        if (key !== 'first') return value.bind(base);
        return async (...args: unknown[]) => {
          const result = await (value as (...a: unknown[]) => Promise<unknown>).apply(base, args);
          if (!raced && (result as { role?: string } | undefined)?.role !== undefined) {
            raced = true;
            await race();
          }
          return result;
        };
      },
    });
    const context = {
      db: racing,
      actor,
      workspace,
      tools: { endSessionsIfLoginLost: async () => {} },
      input: { workspace_id: target.workspace.id, ...input },
      defer: () => {},
    } as never;
    return operation.handler(context);
  }

  // リーダーを一般に戻す（別の要求が先にロールを変えた、または呼んだ人がリーダーを外された）
  async function setRole(target: Target, userId: string, role: 'leader' | 'member') {
    const db = dbOf(target);
    await db.run(
      db.statement((q) =>
        q
          .updateTable('memberships')
          .set({ role })
          .where('workspace_id', '=', target.workspace.id)
          .where('user_id', '=', userId)
          .where('left_at', 'is', null),
      ),
    );
  }

  test('読んだロールが古い（間に別の要求が変えた）と 409 の conflict で、履歴は増えない', async () => {
    const target = await createTarget();
    const [membership] = await membershipsOf(target, target.member.userId!);
    await expect(
      runWithRace(
        membershipRoleUpdateOperation,
        target,
        target.leader,
        { user_id: target.member.userId, role: 'leader' },
        async () => {
          // 別の要求が先にリーダーにした（その要求の履歴が1行入る）
          expect((await updateRole(target, target.admin, target.member.userId!, 'leader')).status).toBe(200);
        },
      ),
    ).rejects.toMatchObject({ status: 409, code: 'conflict' });
    expect(await logsOf(target, 'membership', membership!.id)).toHaveLength(1);
    expect((await membershipsOf(target, target.member.userId!))[0]!.role).toBe('leader');
  });

  test('読んだ後にリーダーを外された人のロールの付け替えは、403 の forbidden で書かない', async () => {
    const target = await createTarget();
    const [membership] = await membershipsOf(target, target.member.userId!);
    await expect(
      runWithRace(
        membershipRoleUpdateOperation,
        target,
        target.leader,
        { user_id: target.member.userId, role: 'leader' },
        () => setRole(target, target.leader.userId!, 'member'),
      ),
    ).rejects.toMatchObject({ status: 403, code: 'forbidden' });
    expect((await membershipsOf(target, target.member.userId!))[0]!.role).toBe('member');
    expect(await logsOf(target, 'membership', membership!.id)).toHaveLength(0);
  });

  test('読んだ後にリーダーを外された人が他人を外すと、403 の forbidden で書かない', async () => {
    const target = await createTarget();
    const userId = target.member.userId!;
    const task = await createTask(target.organization, target.workspace.id, userId, { assignee_user_id: userId });
    await expect(
      runWithRace(membershipLeaveOperation, target, target.leader, { user_id: userId }, () =>
        setRole(target, target.leader.userId!, 'member'),
      ),
    ).rejects.toMatchObject({ status: 403, code: 'forbidden' });
    const [membership] = await membershipsOf(target, userId);
    expect(membership!.left_at).toBeNull();
    expect(await logsOf(target, 'membership', membership!.id)).toHaveLength(0);
    expect((await taskOf(target, task.id))!.assignee_user_id).toBe(userId);
    expect(await logsOf(target, 'task', task.id)).toHaveLength(0);
  });

  test('自分が抜けるときは、読んだ後にリーダーを外されていても抜けられる', async () => {
    const target = await createTarget();
    await createMembership(target.organization, target.otherWorkspace.id, target.leader.userId!);
    await runWithRace(membershipLeaveOperation, target, target.leader, { user_id: target.leader.userId }, () =>
      setRole(target, target.leader.userId!, 'member'),
    );
    expect((await membershipsOf(target, target.leader.userId!))[0]!.left_at).not.toBeNull();
  });

  // ワークスペースを閉じる（workspace-close の書き込みと同じ列）。登録の関数が見た「開いている」の後に閉じられた競合を作る
  async function closeWorkspace(target: Target) {
    const db = dbOf(target);
    await db.run(
      db.statement((q) =>
        q
          .updateTable('workspaces')
          .set({ closed_at: '2026-10-26T00:00:00.000Z' })
          .where('id', '=', target.workspace.id)
          .where('organization_id', '=', target.organization.id),
      ),
    );
  }

  test('読んだ後にワークスペースが閉じられたら、ロールの付け替えは 409 の workspace_closed で書かない', async () => {
    const target = await createTarget();
    const [membership] = await membershipsOf(target, target.member.userId!);
    await expect(
      runWithRace(
        membershipRoleUpdateOperation,
        target,
        target.leader,
        { user_id: target.member.userId, role: 'leader' },
        () => closeWorkspace(target),
      ),
    ).rejects.toMatchObject({ status: 409, code: 'workspace_closed' });
    expect((await membershipsOf(target, target.member.userId!))[0]!.role).toBe('member');
    expect(await logsOf(target, 'membership', membership!.id)).toHaveLength(0);
  });

  test('読んだ後にワークスペースが閉じられたら、離脱は 409 の workspace_closed で書かない', async () => {
    const target = await createTarget();
    const userId = target.member.userId!;
    const task = await createTask(target.organization, target.workspace.id, userId, { assignee_user_id: userId });
    await expect(
      runWithRace(membershipLeaveOperation, target, target.member, { user_id: userId }, () => closeWorkspace(target)),
    ).rejects.toMatchObject({ status: 409, code: 'workspace_closed' });
    const [membership] = await membershipsOf(target, userId);
    expect(membership!.left_at).toBeNull();
    expect(await logsOf(target, 'membership', membership!.id)).toHaveLength(0);
    expect((await taskOf(target, task.id))!.assignee_user_id).toBe(userId);
    expect(await logsOf(target, 'task', task.id)).toHaveLength(0);
  });

  test('読んだ後に相手の所属が終わったら、ロールの付け替えは 404 で書かない', async () => {
    const target = await createTarget();
    const userId = target.member.userId!;
    const [membership] = await membershipsOf(target, userId);
    await expect(
      runWithRace(
        membershipRoleUpdateOperation,
        target,
        target.leader,
        { user_id: userId, role: 'leader' },
        async () => {
          expect((await leave(target, target.admin, userId)).status).toBe(200);
        },
      ),
    ).rejects.toMatchObject({ status: 404, code: 'not_found' });
    const [after] = await membershipsOf(target, userId);
    expect(after!.role).toBe('member');
    // 離脱の履歴だけで、ロールの変更は残らない
    expect((await logsOf(target, 'membership', membership!.id)).map((log) => log.action)).toEqual(['delete']);
  });
});

describe('閉じたワークスペース', () => {
  test('ロールの付け替えと離脱は 409 の workspace_closed で、何も書かない', async () => {
    const target = await createTarget({ closed: true });
    const userId = target.member.userId!;
    const task = await createTask(target.organization, target.workspace.id, userId, { assignee_user_id: userId });
    const updated = await updateRole(target, target.leader, userId, 'leader');
    expect(updated.status).toBe(409);
    expect(await errorCodeOf(updated)).toBe('workspace_closed');
    const left = await leave(target, target.member, userId);
    expect(left.status).toBe(409);
    expect(await errorCodeOf(left)).toBe('workspace_closed');

    const [membership] = await membershipsOf(target, userId);
    expect(membership).toMatchObject({ role: 'member', left_at: null, left_on: null });
    expect(await logsOf(target, 'membership', membership!.id)).toHaveLength(0);
    expect((await taskOf(target, task.id))!.assignee_user_id).toBe(userId);
    expect(await logsOf(target, 'task', task.id)).toHaveLength(0);
  });
});
