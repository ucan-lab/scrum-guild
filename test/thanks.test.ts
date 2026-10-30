import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import { createApp } from '../src/server/app.ts';
import { orgDb, verifyWorkspace } from '../src/server/db/index.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import { thanksSendOperation, thanksRevokeOperation } from '../src/server/operations/thanks.ts';
import {
  thanksSend,
  thanksRevoke,
  taskDetail,
  taskHistory,
  taskComplete,
  taskAssign,
} from '../src/shared/operations/task/index.ts';
import type { TaskDetail } from '../src/shared/operations/task/index.ts';
import { createMembership, createTask, createThanks, createUser } from './factories.ts';
import { post } from './operations/harness.ts';
import { createTarget, type Target, type Person } from './operations/world.ts';

const app = createApp(implementedOperations);
function send(target: Target, taskId: string, recipientId = target.leader.userId!, person = target.member) {
  return post(app, thanksSend, {
    slug: target.slug,
    token: person.token,
    body: { workspace_id: target.workspace.id, task_id: taskId, recipient_user_id: recipientId },
  });
}
function revoke(target: Target, thanksId: string, person = target.member) {
  return post(app, thanksRevoke, {
    slug: target.slug,
    token: person.token,
    body: { workspace_id: target.workspace.id, thanks_id: thanksId },
  });
}
async function detail(target: Target, taskId: string, person = target.member): Promise<TaskDetail> {
  const response = await post(app, taskDetail, {
    slug: target.slug,
    token: person.token,
    body: { workspace_id: target.workspace.id, task_id: taskId },
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { task: TaskDetail }).task;
}
async function assertError(response: Response, status: number, code: string, reason?: string) {
  expect(response.status).toBe(status);
  expect(await response.json()).toMatchObject({ error: { code, ...(reason ? { details: { reason } } : {}) } });
}
async function logs(target: Target, taskId: string) {
  const db = orgDb(env, target.organization.verified);
  return db.rows(
    db.statement((q) =>
      q
        .selectFrom('change_logs')
        .selectAll()
        .where('organization_id', '=', target.organization.id)
        .where('workspace_id', '=', target.workspace.id)
        .where('entity_type', '=', 'task')
        .where('entity_id', '=', taskId)
        .orderBy('created_at')
        .orderBy('id'),
    ),
  );
}
async function countThanks(target: Target, taskId: string) {
  const db = orgDb(env, target.organization.verified);
  return (
    await db.rows(
      db.statement((q) =>
        q
          .selectFrom('thanks')
          .select('id')
          .where('workspace_id', '=', target.workspace.id)
          .where('task_id', '=', taskId),
      ),
    )
  ).length;
}
async function complete(target: Target, taskId: string) {
  const response = await post(app, taskComplete, {
    slug: target.slug,
    token: target.member.token,
    body: { workspace_id: target.workspace.id, task_id: taskId },
  });
  expect(response.status).toBe(200);
}

// 読んだ後、書く batch の直前に実際の別の更新を入れる。SQL の条件が競合を止めることを確かめる。
async function beforeWrite(
  target: Target,
  person: Person,
  operation: typeof thanksSendOperation,
  input: Record<string, unknown>,
  race: (db: ReturnType<typeof orgDb>, n: number) => Promise<void>,
) {
  const db = orgDb(env, target.organization.verified);
  const actor = {
    accountId: person.accountId,
    userId: person.userId,
    isAdmin: person === target.admin,
    invitedOnly: false,
  };
  const workspace = await verifyWorkspace(db, actor, target.workspace.id);
  let writes = 0;
  const racing = new Proxy(db, {
    get(base, key) {
      const value = Reflect.get(base, key, base);
      if (typeof value !== 'function') return value;
      if (key !== 'batch') return value.bind(base);
      return async (...args: unknown[]) => {
        await race(base, ++writes);
        return (value as (...a: unknown[]) => Promise<unknown>).apply(base, args);
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

describe('感謝を送る・取り消す', () => {
  test('担当だけが送れ、作った人・管理者・ほかのメンバーは担当でなければ 403', async () => {
    const target = await createTarget();
    const task = await createTask(target.organization, target.workspace.id, target.leader.userId!, {
      assignee_user_id: target.member.userId,
    });
    for (const person of [target.leader, target.admin])
      await assertError(await send(target, task.id, target.leader.userId!, person), 403, 'forbidden');
    expect((await send(target, task.id)).status).toBe(200);
  });

  test('担当なしは作った人だけ。担当も作った人も空なら管理者にも送れない', async () => {
    const target = await createTarget();
    const task = await createTask(target.organization, target.workspace.id, target.member.userId!);
    expect((await detail(target, task.id)).can_send_thanks).toBe(true);
    expect((await detail(target, task.id, target.leader)).can_send_thanks).toBe(false);
    await assertError(await send(target, task.id, target.member.userId!, target.leader), 403, 'forbidden');
    expect((await send(target, task.id)).status).toBe(200);
    const noCreator = await createTask(target.organization, target.workspace.id, target.member.userId!, {
      created_by: null,
      is_imported: 1,
    });
    await assertError(await send(target, noCreator.id, target.leader.userId!, target.admin), 403, 'forbidden');
    expect((await detail(target, noCreator.id, target.admin)).can_send_thanks).toBe(false);
  });

  test('自分宛てと同じ相手への2回目は理由つき 409。余計な履歴と経験値は書かない', async () => {
    const target = await createTarget();
    const task = await createTask(target.organization, target.workspace.id, target.member.userId!);
    await assertError(await send(target, task.id, target.member.userId!), 409, 'conflict', 'self');
    expect((await send(target, task.id)).status).toBe(200);
    await assertError(await send(target, task.id), 409, 'conflict', 'duplicate');
    expect(await countThanks(target, task.id)).toBe(1);
    expect(await logs(target, task.id)).toHaveLength(1);
    const db = orgDb(env, target.organization.verified);
    expect(
      await db.rows(
        db.statement((q) => q.selectFrom('xp_grants').select('id').where('workspace_id', '=', target.workspace.id)),
      ),
    ).toEqual([]);
  });

  test('別組織・別ワークスペース・削除済み・無いタスクは 404', async () => {
    const target = await createTarget();
    const other = await createTarget();
    const foreign = await createTask(other.organization, other.workspace.id, other.member.userId!);
    const elsewhere = await createTask(target.organization, target.otherWorkspace.id, target.member.userId!);
    const deleted = await createTask(target.organization, target.workspace.id, target.member.userId!, {
      deleted_at: '2026-10-20T00:00:00.000Z',
    });
    for (const id of [foreign.id, elsewhere.id, deleted.id, crypto.randomUUID()])
      await assertError(await send(target, id), 404, 'not_found');
  });

  test('別組織、所属なし、離脱済み、無効な相手は 404。有効な所属のある相手は送れる', async () => {
    const target = await createTarget();
    const other = await createTarget();
    const task = await createTask(target.organization, target.workspace.id, target.member.userId!);
    const disabled = await createUser(target.organization, { disabled_at: '2026-10-20T00:00:00.000Z' });
    await createMembership(target.organization, target.workspace.id, disabled.id);
    const left = await createUser(target.organization);
    await createMembership(target.organization, target.workspace.id, left.id, {
      left_at: '2026-10-20T00:00:00.000Z',
      left_on: '2026-10-20',
    });
    for (const id of [other.member.userId!, target.bystander.userId!, disabled.id, left.id, crypto.randomUUID()])
      await assertError(await send(target, task.id, id), 404, 'not_found');
    const waiting = await createUser(target.organization, {
      login_subject: null,
      login_provider: 'google',
      login_email: 'waiting@example.test',
      claim_token_hash: 'a'.repeat(64),
      claim_expires_at: '2026-12-01T00:00:00.000Z',
    });
    await createMembership(target.organization, target.workspace.id, waiting.id);
    await assertError(await send(target, task.id, waiting.id), 404, 'not_found');
    const valid = await createUser(target.organization);
    await createMembership(target.organization, target.workspace.id, valid.id);
    expect((await send(target, task.id, valid.id)).status).toBe(200);
  });

  test('完了済みは送付も取消も completed。詳細は読み取りだけ', async () => {
    const target = await createTarget();
    const task = await createTask(target.organization, target.workspace.id, target.member.userId!);
    const sent = await send(target, task.id);
    const { thanks_id: id } = (await sent.json()) as { thanks_id: string };
    await complete(target, task.id);
    await assertError(await send(target, task.id), 409, 'conflict', 'completed');
    await assertError(await revoke(target, id), 409, 'conflict', 'completed');
    const result = await detail(target, task.id);
    expect(result.can_send_thanks).toBe(false);
    expect(result.thanks[0]?.can_revoke).toBe(false);
    expect(await countThanks(target, task.id)).toBe(1);
  });

  test('取消は送った本人だけ。担当が替わった後も本人は取り消せ、もう一度取り消すと 404', async () => {
    const target = await createTarget();
    const task = await createTask(target.organization, target.workspace.id, target.member.userId!, {
      assignee_user_id: target.member.userId,
    });
    const { thanks_id: id } = (await (await send(target, task.id)).json()) as { thanks_id: string };
    for (const person of [target.leader, target.admin])
      await assertError(await revoke(target, id, person), 403, 'forbidden');
    const assigned = await post(app, taskAssign, {
      slug: target.slug,
      token: target.member.token,
      body: { workspace_id: target.workspace.id, task_id: task.id, assignee_user_id: target.leader.userId },
    });
    expect(assigned.status).toBe(200);
    const result = await detail(target, task.id);
    expect(result.can_send_thanks).toBe(false);
    expect(result.thanks[0]?.can_revoke).toBe(true);
    expect((await revoke(target, id)).status).toBe(200);
    await assertError(await revoke(target, id), 404, 'not_found');
    expect(await countThanks(target, task.id)).toBe(0);
  });

  test('取消も別組織、別ワークスペース、存在しない感謝は 404', async () => {
    const target = await createTarget();
    const other = await createTarget();
    const task = await createTask(other.organization, other.workspace.id, other.member.userId!);
    const foreign = await createThanks(
      other.organization,
      other.workspace.id,
      task.id,
      other.member.userId!,
      other.leader.userId!,
    );
    const elsewhereTask = await createTask(target.organization, target.otherWorkspace.id, target.member.userId!);
    const elsewhere = await createThanks(
      target.organization,
      target.otherWorkspace.id,
      elsewhereTask.id,
      target.member.userId!,
      target.leader.userId!,
    );
    for (const id of [foreign.id, elsewhere.id, crypto.randomUUID()])
      await assertError(await revoke(target, id), 404, 'not_found');
  });

  test('詳細は created_at, id の昇順で別メンバーにも送り手と受取人が見える。送付・取消の履歴を名前つきで返す', async () => {
    const target = await createTarget();
    const task = await createTask(target.organization, target.workspace.id, target.member.userId!);
    const a = await createThanks(
      target.organization,
      target.workspace.id,
      task.id,
      target.member.userId!,
      target.admin.userId!,
      { created_at: '2026-01-01T00:00:00.000Z' },
    );
    const { thanks_id: id } = (await (await send(target, task.id)).json()) as { thanks_id: string };
    const mine = await detail(target, task.id);
    const theirs = await detail(target, task.id, target.leader);
    expect(theirs.thanks.map((thanks) => thanks.id)).toEqual([a.id, id]);
    expect(theirs.thanks.map((thanks) => ({ ...thanks, can_revoke: true }))).toEqual(mine.thanks);
    expect(theirs.can_send_thanks).toBe(false);
    expect(theirs.thanks.every((thanks) => !thanks.can_revoke)).toBe(true);
    const recipient = theirs.thanks[1]!.recipient;
    expect(theirs.thanks[1]?.sender.id).toBe(target.member.userId);
    expect((await revoke(target, id)).status).toBe(200);
    const history = await logs(target, task.id);
    expect(history).toHaveLength(2);
    expect(history.map((log) => JSON.parse(log.changes_json!))).toEqual(
      expect.arrayContaining([{ thanks: [null, recipient] }, { thanks: [recipient, null] }]),
    );
    expect(history.every((log) => log.actor_user_id === target.member.userId && log.action === 'update')).toBe(true);
    const response = await post(app, taskHistory, {
      slug: target.slug,
      token: target.leader.token,
      body: { workspace_id: target.workspace.id, task_id: task.id },
    });
    expect(response.status).toBe(200);
    expect(JSON.stringify(await response.json())).toContain(recipient.name);
  });

  test('同じ作成日時の感謝は ID の昇順。離脱・無効化後も一覧の名前を残す', async () => {
    const target = await createTarget();
    const task = await createTask(target.organization, target.workspace.id, target.member.userId!);
    const first = await createThanks(
      target.organization,
      target.workspace.id,
      task.id,
      target.member.userId!,
      target.leader.userId!,
    );
    const second = await createThanks(
      target.organization,
      target.workspace.id,
      task.id,
      target.member.userId!,
      target.admin.userId!,
    );
    const db = orgDb(env, target.organization.verified);
    await db.run(
      db.statement((q) =>
        q
          .updateTable('users')
          .set({ disabled_at: '2026-10-20T00:00:00.000Z' })
          .where('organization_id', '=', target.organization.id)
          .where('id', '=', target.leader.userId!),
      ),
    );
    await db.run(
      db.statement((q) =>
        q
          .updateTable('memberships')
          .set({ left_at: '2026-10-20T00:00:00.000Z', left_on: '2026-10-20' })
          .where('workspace_id', '=', target.workspace.id)
          .where('user_id', '=', target.admin.userId!),
      ),
    );
    const result = await detail(target, task.id);
    expect(result.thanks.map((thanks) => thanks.id)).toEqual([first.id, second.id].sort());
    expect(result.thanks.find((thanks) => thanks.id === first.id)?.recipient.name).not.toBe('');
    expect(result.thanks.find((thanks) => thanks.id === second.id)?.recipient.name).not.toBe('');
  });

  test('閉じたワークスペースは workspace_closed で送り口と取消口も偽', async () => {
    const target = await createTarget();
    const task = await createTask(target.organization, target.workspace.id, target.member.userId!);
    const { thanks_id: id } = (await (await send(target, task.id)).json()) as { thanks_id: string };
    const db = orgDb(env, target.organization.verified);
    await db.run(
      db.statement((q) =>
        q
          .updateTable('workspaces')
          .set({ closed_at: '2026-10-20T00:00:00.000Z' })
          .where('id', '=', target.workspace.id)
          .where('organization_id', '=', target.organization.id),
      ),
    );
    await assertError(await send(target, task.id), 409, 'workspace_closed');
    await assertError(await revoke(target, id), 409, 'workspace_closed');
    const result = await detail(target, task.id);
    expect(result.can_send_thanks).toBe(false);
    expect(result.thanks[0]?.can_revoke).toBe(false);
  });
});

describe('感謝の書き込みの競合', () => {
  test('読んだ後に完了が先に通ると送れず、感謝とその履歴を残さない', async () => {
    const target = await createTarget();
    const task = await createTask(target.organization, target.workspace.id, target.member.userId!);
    await expect(
      beforeWrite(
        target,
        target.member,
        thanksSendOperation,
        { task_id: task.id, recipient_user_id: target.leader.userId },
        async () => {
          await complete(target, task.id);
        },
      ),
    ).rejects.toMatchObject({ status: 409, details: { reason: 'completed' } });
    expect(await countThanks(target, task.id)).toBe(0);
    expect((await logs(target, task.id)).some((log) => log.changes_json?.includes('thanks'))).toBe(false);
  });

  test('送付が先に通った感謝は完了したタスクに残る', async () => {
    const target = await createTarget();
    const task = await createTask(target.organization, target.workspace.id, target.member.userId!);
    expect((await send(target, task.id)).status).toBe(200);
    await complete(target, task.id);
    expect(await countThanks(target, task.id)).toBe(1);
    expect((await logs(target, task.id)).filter((log) => log.changes_json?.includes('thanks'))).toHaveLength(1);
  });

  test('同じ相手へ先に送られても一意制約では落ちず duplicate、履歴は1行', async () => {
    const target = await createTarget();
    const task = await createTask(target.organization, target.workspace.id, target.member.userId!);
    await expect(
      beforeWrite(
        target,
        target.member,
        thanksSendOperation,
        { task_id: task.id, recipient_user_id: target.leader.userId },
        async () => {
          expect((await send(target, task.id)).status).toBe(200);
        },
      ),
    ).rejects.toMatchObject({ status: 409, details: { reason: 'duplicate' } });
    expect(await countThanks(target, task.id)).toBe(1);
    expect(await logs(target, task.id)).toHaveLength(1);
  });

  test('書く直前に担当が替わったら送れず 403', async () => {
    const target = await createTarget();
    const task = await createTask(target.organization, target.workspace.id, target.member.userId!);
    await expect(
      beforeWrite(
        target,
        target.member,
        thanksSendOperation,
        { task_id: task.id, recipient_user_id: target.leader.userId },
        async (db) => {
          await db.run(
            db.statement((q) =>
              q
                .updateTable('tasks')
                .set({ assignee_user_id: target.leader.userId })
                .where('workspace_id', '=', target.workspace.id)
                .where('id', '=', task.id),
            ),
          );
        },
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(await countThanks(target, task.id)).toBe(0);
  });

  test('書く直前に相手が離脱したら 404', async () => {
    const target = await createTarget();
    const task = await createTask(target.organization, target.workspace.id, target.member.userId!);
    await expect(
      beforeWrite(
        target,
        target.member,
        thanksSendOperation,
        { task_id: task.id, recipient_user_id: target.leader.userId },
        async (db) => {
          await db.run(
            db.statement((q) =>
              q
                .updateTable('memberships')
                .set({ left_at: '2026-10-20T00:00:00.000Z', left_on: '2026-10-20' })
                .where('workspace_id', '=', target.workspace.id)
                .where('user_id', '=', target.leader.userId!),
            ),
          );
        },
      ),
    ).rejects.toMatchObject({ status: 404 });
    expect(await countThanks(target, task.id)).toBe(0);
  });

  test('取消の直前に完了すれば消さず completed、先に取り消されれば 404', async () => {
    const target = await createTarget();
    const task = await createTask(target.organization, target.workspace.id, target.member.userId!);
    const { thanks_id: id } = (await (await send(target, task.id)).json()) as { thanks_id: string };
    await expect(
      beforeWrite(target, target.member, thanksRevokeOperation, { thanks_id: id }, async () => {
        await complete(target, task.id);
      }),
    ).rejects.toMatchObject({ status: 409, details: { reason: 'completed' } });
    expect(await countThanks(target, task.id)).toBe(1);
    const other = await createTask(target.organization, target.workspace.id, target.member.userId!);
    const { thanks_id: otherId } = (await (await send(target, other.id)).json()) as { thanks_id: string };
    await expect(
      beforeWrite(target, target.member, thanksRevokeOperation, { thanks_id: otherId }, async () => {
        expect((await revoke(target, otherId)).status).toBe(200);
      }),
    ).rejects.toMatchObject({ status: 404 });
    expect(await logs(target, other.id)).toHaveLength(2);
  });

  test('書く直前にワークスペースが閉じたら送付も取消も workspace_closed で、感謝を増減させない', async () => {
    const target = await createTarget();
    const task = await createTask(target.organization, target.workspace.id, target.member.userId!);
    const close = async (db: ReturnType<typeof orgDb>) => {
      await db.run(
        db.statement((q) =>
          q
            .updateTable('workspaces')
            .set({ closed_at: '2026-10-20T00:00:00.000Z' })
            .where('id', '=', target.workspace.id)
            .where('organization_id', '=', target.organization.id),
        ),
      );
    };
    await expect(
      beforeWrite(
        target,
        target.member,
        thanksSendOperation,
        { task_id: task.id, recipient_user_id: target.leader.userId },
        close,
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(await countThanks(target, task.id)).toBe(0);
    expect(await logs(target, task.id)).toHaveLength(0);

    const other = await createTarget();
    const otherTask = await createTask(other.organization, other.workspace.id, other.member.userId!);
    const { thanks_id: id } = (await (await send(other, otherTask.id)).json()) as { thanks_id: string };
    await expect(
      beforeWrite(other, other.member, thanksRevokeOperation, { thanks_id: id }, async (db) => {
        await db.run(
          db.statement((q) =>
            q
              .updateTable('workspaces')
              .set({ closed_at: '2026-10-20T00:00:00.000Z' })
              .where('id', '=', other.workspace.id)
              .where('organization_id', '=', other.organization.id),
          ),
        );
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(await countThanks(other, otherTask.id)).toBe(1);
  });

  test('書く直前にタスクが削除されるか相手が無効になったら 404', async () => {
    const target = await createTarget();
    const deleting = await createTask(target.organization, target.workspace.id, target.member.userId!);
    await expect(
      beforeWrite(
        target,
        target.member,
        thanksSendOperation,
        { task_id: deleting.id, recipient_user_id: target.leader.userId },
        async (db) => {
          await db.run(
            db.statement((q) =>
              q
                .updateTable('tasks')
                .set({ deleted_at: '2026-10-20T00:00:00.000Z' })
                .where('workspace_id', '=', target.workspace.id)
                .where('id', '=', deleting.id),
            ),
          );
        },
      ),
    ).rejects.toMatchObject({ status: 404 });
    expect(await countThanks(target, deleting.id)).toBe(0);

    const disabling = await createTask(target.organization, target.workspace.id, target.member.userId!);
    await expect(
      beforeWrite(
        target,
        target.member,
        thanksSendOperation,
        { task_id: disabling.id, recipient_user_id: target.leader.userId },
        async (db) => {
          await db.run(
            db.statement((q) =>
              q
                .updateTable('users')
                .set({ disabled_at: '2026-10-20T00:00:00.000Z' })
                .where('organization_id', '=', target.organization.id)
                .where('id', '=', target.leader.userId!),
            ),
          );
        },
      ),
    ).rejects.toMatchObject({ status: 404 });
    expect(await countThanks(target, disabling.id)).toBe(0);
  });

  test('履歴の受取人の名前は送付も取消も書くときの値', async () => {
    const target = await createTarget();
    const task = await createTask(target.organization, target.workspace.id, target.member.userId!);
    const rename = (name: string) => async (db: ReturnType<typeof orgDb>) => {
      await db.run(
        db.statement((q) =>
          q
            .updateTable('users')
            .set({ name })
            .where('organization_id', '=', target.organization.id)
            .where('id', '=', target.leader.userId!),
        ),
      );
    };
    const sent = (await beforeWrite(
      target,
      target.member,
      thanksSendOperation,
      { task_id: task.id, recipient_user_id: target.leader.userId },
      rename('送付時の名前'),
    )) as { thanks_id: string };
    await beforeWrite(
      target,
      target.member,
      thanksRevokeOperation,
      { thanks_id: sent.thanks_id },
      rename('取消時の名前'),
    );
    const history = await logs(target, task.id);
    expect(history).toHaveLength(2);
    expect(history.map((log) => JSON.parse(log.changes_json!))).toEqual(
      expect.arrayContaining([
        { thanks: [null, { id: target.leader.userId, name: '送付時の名前' }] },
        { thanks: [{ id: target.leader.userId, name: '取消時の名前' }, null] },
      ]),
    );
  });
});
