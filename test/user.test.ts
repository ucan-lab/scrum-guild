// 組織のユーザーの管理（user-list、user-admin-update、user-disable、user-enable）の振る舞い。
// 組織の分離と、権限の種類ごとの許可と拒否は、一覧を回す test/operation-registry.test.ts が確かめる
import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import type { OutputOf } from '../src/shared/operations/define.ts';
import {
  organizationHistory,
  organizationInfo,
  userAdminUpdate,
  userDisable,
  userEnable,
  userList,
} from '../src/shared/operations/organization/index.ts';
import { memberList } from '../src/shared/operations/workspace/index.ts';
import { createApp } from '../src/server/app.ts';
import { commonDb, orgDb } from '../src/server/db/index.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import { userAdminUpdateOperation, userDisableOperation } from '../src/server/operations/user.ts';
import { createInvitation, createMembership, createTask, createUser, createWorkspace, hash64 } from './factories.ts';
import { errorCodeOf, post } from './operations/harness.ts';
import { admitElsewhere, createPerson, createTarget, testEnv, type Person, type Target } from './operations/world.ts';

const app = createApp(implementedOperations);

type Users = OutputOf<typeof userList>['users'];

function dbOf(target: Target) {
  return orgDb(env, target.organization.verified);
}

function listUsers(target: Target, person: Person = target.admin) {
  return post(app, userList, { slug: target.slug, token: person.token, body: {} });
}

async function usersOf(target: Target): Promise<Users> {
  const res = await listUsers(target);
  expect(res.status).toBe(200);
  return ((await res.json()) as { users: Users }).users;
}

function setAdmin(target: Target, person: Person, userId: string, isAdmin: boolean, requestEnv?: Env) {
  return post(app, userAdminUpdate, {
    slug: target.slug,
    token: person.token,
    body: { user_id: userId, is_admin: isAdmin },
    ...(requestEnv === undefined ? {} : { env: requestEnv }),
  });
}

function disable(target: Target, person: Person, userId: string, requestEnv?: Env) {
  return post(app, userDisable, {
    slug: target.slug,
    token: person.token,
    body: { user_id: userId },
    ...(requestEnv === undefined ? {} : { env: requestEnv }),
  });
}

function enable(target: Target, person: Person, userId: string) {
  return post(app, userEnable, { slug: target.slug, token: person.token, body: { user_id: userId } });
}

async function errorOf(res: Response): Promise<{ code?: string; reason?: unknown }> {
  const body = (await res.json()) as { error?: { code?: string; details?: { reason?: unknown } } };
  return { code: body.error?.code, reason: body.error?.details?.reason };
}

async function userRow(target: Target, userId: string) {
  const db = dbOf(target);
  return db.first(db.statement((q) => q.selectFrom('users').selectAll().where('id', '=', userId)));
}

async function adminCount(target: Target): Promise<number> {
  const db = dbOf(target);
  const rows = await db.rows(
    db.statement((q) =>
      q
        .selectFrom('users')
        .select('id')
        .where('organization_id', '=', target.organization.id)
        .where('is_admin', '=', 1)
        .where('disabled_at', 'is', null),
    ),
  );
  return rows.length;
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

async function membershipsOf(target: Target, userId: string) {
  const db = dbOf(target);
  return db.rows(
    db.statement((q) =>
      q.selectFrom('memberships').selectAll().where('user_id', '=', userId).orderBy('joined_at').orderBy('id'),
    ),
  );
}

async function sessionCount(accountId: string): Promise<number> {
  const db = commonDb(env);
  const rows = await db.rows(
    db.statement((q) => q.selectFrom('sessions').select('token_hash').where('account_id', '=', accountId)),
  );
  return rows.length;
}

// 組織の人数の上限（共通の表の organizations）を書き換える
async function setMemberLimit(target: Target, limit: number): Promise<void> {
  const db = commonDb(env);
  await db.run(
    db.statement((q) =>
      q.updateTable('organizations').set({ member_limit: limit }).where('id', '=', target.organization.id),
    ),
  );
}

// 2人目の管理者。所属を持たせ、解除された後も組織に入れるようにする
async function secondAdmin(target: Target): Promise<Person> {
  return createPerson({
    organization: target.organization,
    admin: true,
    membership: { workspaceId: target.otherWorkspace.id, role: 'member' },
  });
}

describe('user-list', () => {
  test('同じ組織の login_subject のある人を名前、ID の順に返し、所属の数は閉じていないワークスペースの今の所属だけを数える', async () => {
    const target = await createTarget();
    const other = await createTarget();
    const { organization } = target;
    const closed = await createWorkspace(organization, target.admin.userId!, {
      closed_at: '2026-10-22T00:00:00.000Z',
    });
    // メンバーは、開いているワークスペース2つ（1つは抜けた後に戻った）と閉じたワークスペース1つに所属する
    await createMembership(organization, target.otherWorkspace.id, target.member.userId!, {
      left_on: '2026-10-05',
      left_at: '2026-10-05T00:00:00.000Z',
    });
    await createMembership(organization, target.otherWorkspace.id, target.member.userId!);
    await createMembership(organization, closed.id, target.member.userId!);
    const disabled = await createUser(organization, {
      name: '朝倉 ナギ',
      disabled_at: '2026-10-21T00:00:00.000Z',
      last_seen_at: '2026-10-20T03:00:00.000Z',
    });
    // Google の指名でログインを待つ行は出さない
    await createUser(organization, {
      login_provider: 'google',
      login_subject: null,
      login_email: 'mio@example.test',
      claim_token_hash: hash64(),
      claim_expires_at: '2999-01-01T00:00:00.000Z',
      name: 'mio@example.test',
    });

    const users = await usersOf(target);
    const ids = users.map((user) => user.id);
    expect(ids).not.toContain(other.admin.userId);
    expect(users.map((user) => user.name)).toEqual(users.map((user) => user.name).toSorted());
    // 名前が同じ人（ファクトリーの既定の名前）は ID の順
    const sameName = users.filter((user) => user.name === '星野 澪').map((user) => user.id);
    expect(sameName).toEqual(sameName.toSorted());
    // 管理者、リーダー、メンバー、ほかのワークスペースの人、無効の人（承諾待ちの招待だけの人は行を持たない）
    expect(users).toHaveLength(5);

    const byId = new Map(users.map((user) => [user.id, user]));
    expect(byId.get(target.admin.userId!)).toMatchObject({ is_admin: true, disabled_at: null, workspace_count: 0 });
    expect(byId.get(target.member.userId!)).toMatchObject({ is_admin: false, workspace_count: 2 });
    expect(byId.get(target.leader.userId!)).toMatchObject({ workspace_count: 1 });
    expect(byId.get(disabled.id)).toEqual({
      id: disabled.id,
      name: '朝倉 ナギ',
      avatar_url: null,
      is_admin: false,
      disabled_at: '2026-10-21T00:00:00.000Z',
      workspace_count: 0,
      last_seen_at: '2026-10-20T03:00:00.000Z',
    });
  });

  test('有効な人を先に、無効の人を後ろに並べ、それぞれ名前、ID の順', async () => {
    const target = await createTarget();
    // 名前の順では有効な人より前に来る、無効の人
    const disabledFirst = await createUser(target.organization, {
      name: '安達 ハル',
      disabled_at: '2026-10-21T00:00:00.000Z',
    });
    const disabledSecond = await createUser(target.organization, {
      name: '安達 ミオ',
      disabled_at: '2026-10-22T00:00:00.000Z',
    });
    const enabledFirst = await createUser(target.organization, { name: '一ノ瀬 カナ' });
    const users = await usersOf(target);
    const ids = users.map((user) => user.id);
    expect(ids.indexOf(enabledFirst.id)).toBe(0);
    expect(ids.slice(-2)).toEqual([disabledFirst.id, disabledSecond.id]);
    expect(users.slice(0, -2).every((user) => user.disabled_at === null)).toBe(true);
  });

  test('一般のメンバーとリーダーは 403', async () => {
    const target = await createTarget();
    for (const person of [target.member, target.leader]) {
      const res = await listUsers(target, person);
      expect(res.status).toBe(403);
      expect(await errorCodeOf(res)).toBe('forbidden');
    }
  });
});

describe('user-admin-update', () => {
  test('ユーザーを管理者に指名し、解除でき、組織の変更の履歴に {"is_admin": [前, 後]} が残る', async () => {
    const target = await createTarget();
    const userId = target.member.userId!;
    const designated = await setAdmin(target, target.admin, userId, true);
    expect(designated.status).toBe(200);
    expect(await designated.json()).toEqual({ user_id: userId, is_admin: true, disabled_at: null });
    expect((await userRow(target, userId))!.is_admin).toBe(1);

    // 指名された人は、管理者の操作を呼べる
    expect((await listUsers(target, target.member)).status).toBe(200);

    const revoked = await setAdmin(target, target.admin, userId, false);
    expect(revoked.status).toBe(200);
    expect(await revoked.json()).toEqual({ user_id: userId, is_admin: false, disabled_at: null });

    const logs = await logsOf(target, 'user', userId);
    expect(logs.map((log) => [log.workspace_id, log.actor_user_id, log.action, log.changes])).toEqual([
      [null, target.admin.userId, 'update', { is_admin: [0, 1] }],
      [null, target.admin.userId, 'update', { is_admin: [1, 0] }],
    ]);
  });

  test('同じ値を送ると、何も書かずに今の値を返す', async () => {
    const target = await createTarget();
    const res = await setAdmin(target, target.admin, target.member.userId!, false);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ user_id: target.member.userId, is_admin: false, disabled_at: null });
    expect(await logsOf(target, 'user', target.member.userId!)).toHaveLength(0);
  });

  test('最後の管理者は解除できず 409（last_admin）。ほかに管理者がいれば自分も解除できる', async () => {
    const target = await createTarget();
    const alone = await setAdmin(target, target.admin, target.admin.userId!, false);
    expect(alone.status).toBe(409);
    expect(await errorOf(alone)).toEqual({ code: 'conflict', reason: 'last_admin' });
    expect(await logsOf(target, 'user', target.admin.userId!)).toHaveLength(0);

    // 無効の管理者と、ログインを待つ管理者は数えない
    await createUser(target.organization, { is_admin: 1, disabled_at: '2026-10-21T00:00:00.000Z' });
    await createUser(target.organization, {
      is_admin: 1,
      login_provider: 'google',
      login_subject: null,
      login_email: 'kaito@example.test',
      claim_token_hash: hash64(),
      claim_expires_at: '2999-01-01T00:00:00.000Z',
    });
    expect((await setAdmin(target, target.admin, target.admin.userId!, false)).status).toBe(409);

    const another = await secondAdmin(target);
    const self = await setAdmin(target, target.admin, target.admin.userId!, false);
    expect(self.status).toBe(200);
    expect((await userRow(target, target.admin.userId!))!.is_admin).toBe(0);
    // 残った管理者は最後の1人なので、解除できない
    const last = await setAdmin(target, another, another.userId!, false);
    expect(last.status).toBe(409);
    expect((await errorOf(last)).reason).toBe('last_admin');
  });

  test('無効の人は管理者に指名できず 409（disabled）', async () => {
    const target = await createTarget();
    const disabled = await createUser(target.organization, { disabled_at: '2026-10-21T00:00:00.000Z' });
    const res = await setAdmin(target, target.admin, disabled.id, true);
    expect(res.status).toBe(409);
    expect(await errorOf(res)).toEqual({ code: 'conflict', reason: 'disabled' });
    expect((await userRow(target, disabled.id))!.is_admin).toBe(0);
  });

  test('人数が上限以上なら、まだ数えられていない人の指名は 409（member_limit）で、すでに数えられている人は指名できる', async () => {
    const target = await createTarget();
    // 人数は、管理者、リーダー、メンバー、ほかのワークスペースの人、承諾待ちの招待だけの人の5人
    await setMemberLimit(target, 5);
    const outsider = await createUser(target.organization);
    const full = await setAdmin(target, target.admin, outsider.id, true);
    expect(full.status).toBe(409);
    expect(await errorOf(full)).toEqual({ code: 'conflict', reason: 'member_limit' });
    expect((await userRow(target, outsider.id))!.is_admin).toBe(0);
    expect(await logsOf(target, 'user', outsider.id)).toHaveLength(0);

    // 所属している人は数えられているので、上限でも指名できる
    expect((await setAdmin(target, target.admin, target.member.userId!, true)).status).toBe(200);
    // 承諾待ちの招待と同じログインの行も、招待で数えられている
    const invited = await createUser(target.organization, {
      login_provider: target.invitee.login.provider,
      login_subject: target.invitee.login.subject,
    });
    expect((await setAdmin(target, target.admin, invited.id, true)).status).toBe(200);
    // 解除は上限を見ない
    expect((await setAdmin(target, target.admin, target.member.userId!, false)).status).toBe(200);

    // 上限を上げれば指名できる
    await setMemberLimit(target, 6);
    expect((await setAdmin(target, target.admin, outsider.id, true)).status).toBe(200);
  });

  test('別の組織の ID、ログインを待つ行、無い ID は 404', async () => {
    const target = await createTarget();
    const other = await createTarget();
    const waiting = await createUser(target.organization, {
      login_provider: 'google',
      login_subject: null,
      login_email: 'mio@example.test',
      claim_token_hash: hash64(),
      claim_expires_at: '2999-01-01T00:00:00.000Z',
    });
    for (const userId of [other.member.userId!, waiting.id, 'no-such-user']) {
      for (const res of [
        await setAdmin(target, target.admin, userId, true),
        await disable(target, target.admin, userId),
        await enable(target, target.admin, userId),
      ]) {
        expect(res.status, userId).toBe(404);
        expect(await errorCodeOf(res)).toBe('not_found');
      }
    }
    expect(await userRow(other, other.member.userId!)).toMatchObject({ is_admin: 0, disabled_at: null });
  });

  test('一般のメンバーとリーダーは 403', async () => {
    const target = await createTarget();
    for (const person of [target.member, target.leader]) {
      for (const res of [
        await setAdmin(target, person, target.bystander.userId!, true),
        await disable(target, person, target.bystander.userId!),
        await enable(target, person, target.bystander.userId!),
      ]) {
        expect(res.status).toBe(403);
        expect(await errorCodeOf(res)).toBe('forbidden');
      }
    }
    expect(await userRow(target, target.bystander.userId!)).toMatchObject({ is_admin: 0, disabled_at: null });
  });

  test('2人の管理者が同時にお互いを解除しても、管理者は0人にならない', async () => {
    const target = await createTarget();
    const another = await secondAdmin(target);
    const [first, second] = await Promise.all([
      setAdmin(target, target.admin, another.userId!, false),
      setAdmin(target, another, target.admin.userId!, false),
    ]);
    const statuses = [first.status, second.status];
    expect(statuses.filter((status) => status === 200)).toHaveLength(1);
    // 後の要求は、書く文の条件で止まる（409 の last_admin）か、入るときにもう管理者でなく 403
    expect(statuses.filter((status) => status === 409 || status === 403)).toHaveLength(1);
    expect(await adminCount(target)).toBe(1);
  });

  test('2人の管理者が同時にそれぞれ自分を解除しても、片方だけが通り、管理者が1人残る', async () => {
    const target = await createTarget();
    const another = await secondAdmin(target);
    const [first, second] = await Promise.all([
      setAdmin(target, target.admin, target.admin.userId!, false),
      setAdmin(target, another, another.userId!, false),
    ]);
    // 自分の解除は呼んだ人の権限では止まらない（後の要求も、入るときと書くときはまだ管理者）。止めるのは、ほかの管理者の EXISTS
    expect([first.status, second.status].toSorted()).toEqual([200, 409]);
    const refused = first.status === 409 ? first : second;
    expect((await errorOf(refused)).reason).toBe('last_admin');
    expect(await adminCount(target)).toBe(1);
  });
});

// 読んでから書くまでに別の要求が割り込む。処理を直に呼び、相手の行（is_admin を持つ行）を読んだ直後に race を走らせる
async function runWithRace(
  operation: typeof userAdminUpdateOperation | typeof userDisableOperation,
  target: Target,
  caller: Person,
  input: Record<string, unknown>,
  race: () => Promise<void>,
) {
  const db = orgDb(env, target.organization.verified);
  const actor = { accountId: caller.accountId, userId: caller.userId, isAdmin: true, invitedOnly: false };
  let raced = false;
  const racing = new Proxy(db, {
    get(base, key) {
      const value = Reflect.get(base, key, base);
      if (typeof value !== 'function') return value;
      if (key !== 'first') return value.bind(base);
      return async (...args: unknown[]) => {
        const result = await (value as (...a: unknown[]) => Promise<unknown>).apply(base, args);
        if (!raced && (result as { is_admin?: number } | undefined)?.is_admin !== undefined) {
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
    // 指名は人数の上限を数える（readSeats が上限だけを読む）。上限に当たらない値にする
    tools: { endSessionsIfLoginLost: async () => {}, readOrganization: async () => ({ memberLimit: 1000 }) },
    input,
    defer: () => {},
  } as never;
  return (operation.handler as (context: never) => Promise<unknown>)(context);
}

describe('読んでから書くまでの競合', () => {
  test('相手を読んだ後に、相手が自分を解除したら、自分の解除は 409 の last_admin で、管理者が1人残る', async () => {
    const target = await createTarget();
    const another = await secondAdmin(target);
    await expect(
      runWithRace(
        userAdminUpdateOperation,
        target,
        target.admin,
        { user_id: another.userId, is_admin: false },
        async () => {
          expect((await setAdmin(target, another, target.admin.userId!, false)).status).toBe(200);
        },
      ),
    ).rejects.toMatchObject({ status: 409, code: 'conflict', details: { reason: 'last_admin' } });
    expect(await adminCount(target)).toBe(1);
    expect((await userRow(target, another.userId!))!.is_admin).toBe(1);
    expect(await logsOf(target, 'user', another.userId!)).toHaveLength(0);
  });

  test('自分を読んだ後に、もう1人の管理者が自分を解除したら、自分の解除は 409 の last_admin で、管理者が1人残る', async () => {
    const target = await createTarget();
    const another = await secondAdmin(target);
    await expect(
      runWithRace(
        userAdminUpdateOperation,
        target,
        target.admin,
        { user_id: target.admin.userId, is_admin: false },
        async () => {
          expect((await setAdmin(target, another, another.userId!, false)).status).toBe(200);
        },
      ),
    ).rejects.toMatchObject({ status: 409, code: 'conflict', details: { reason: 'last_admin' } });
    expect(await adminCount(target)).toBe(1);
    expect((await userRow(target, target.admin.userId!))!.is_admin).toBe(1);
  });

  test('相手を読んだ後に自分が解除されたら、指名も無効化も 403 の forbidden で書かない', async () => {
    const target = await createTarget();
    const another = await secondAdmin(target);
    const third = await secondAdmin(target);
    await expect(
      runWithRace(
        userAdminUpdateOperation,
        target,
        target.admin,
        { user_id: target.member.userId, is_admin: true },
        async () => {
          expect((await setAdmin(target, another, target.admin.userId!, false)).status).toBe(200);
        },
      ),
    ).rejects.toMatchObject({ status: 403, code: 'forbidden' });
    expect((await userRow(target, target.member.userId!))!.is_admin).toBe(0);

    await expect(
      runWithRace(userDisableOperation, target, another, { user_id: target.member.userId }, async () => {
        expect((await setAdmin(target, third, another.userId!, false)).status).toBe(200);
      }),
    ).rejects.toMatchObject({ status: 403, code: 'forbidden' });
    expect((await userRow(target, target.member.userId!))!.disabled_at).toBeNull();
    expect((await membershipsOf(target, target.member.userId!))[0]!.left_at).toBeNull();
    expect(await logsOf(target, 'user', target.member.userId!)).toHaveLength(0);
  });

  test('管理者を読んだ後に、その人が自分を解除して最後の管理者になったら、無効化は 409 の last_admin', async () => {
    const target = await createTarget();
    const another = await secondAdmin(target);
    await expect(
      runWithRace(userDisableOperation, target, target.admin, { user_id: another.userId }, async () => {
        expect((await setAdmin(target, another, target.admin.userId!, false)).status).toBe(200);
      }),
    ).rejects.toMatchObject({ status: 409, code: 'conflict', details: { reason: 'last_admin' } });
    expect(await userRow(target, another.userId!)).toMatchObject({ is_admin: 1, disabled_at: null });
  });
});

describe('user-disable', () => {
  test('自分は無効にできず 409（self）', async () => {
    const target = await createTarget();
    const res = await disable(target, target.admin, target.admin.userId!);
    expect(res.status).toBe(409);
    expect(await errorOf(res)).toEqual({ code: 'conflict', reason: 'self' });
    expect((await userRow(target, target.admin.userId!))!.disabled_at).toBeNull();
  });

  test('無効にすると、閉じたものを含むすべてのワークスペースから外れ、担当が外れ、招待が取り消され、履歴が残る', async () => {
    const target = await createTarget();
    const { organization } = target;
    const person = target.member;
    const userId = person.userId!;
    const closed = await createWorkspace(organization, target.admin.userId!, {
      closed_at: '2026-10-22T00:00:00.000Z',
      timezone: 'America/Los_Angeles',
    });
    await createMembership(organization, closed.id, userId, { role: 'leader' });
    const open = await createTask(organization, target.workspace.id, userId, {
      assignee_user_id: userId,
      today_on: '2026-10-26',
    });
    const inClosed = await createTask(organization, closed.id, userId, { assignee_user_id: userId });
    const done = await createTask(organization, target.workspace.id, userId, {
      assignee_user_id: userId,
      completed_at: '2026-10-20T00:00:00.000Z',
      completed_by: userId,
    });
    const others = await createTask(organization, target.workspace.id, userId, {
      assignee_user_id: target.leader.userId,
    });
    // その人のログインへの承諾待ちの招待（所属していないワークスペース）。別の人への招待は残す
    const invitation = await createInvitation(
      organization,
      target.otherWorkspace.id,
      target.admin.userId!,
      person.login,
    );
    // 別の組織の同じ人の所属と招待は変えない
    const other = await createTarget();
    const elsewhere = await createUser(other.organization, {
      account_id: person.accountId,
      login_provider: person.login.provider,
      login_subject: person.login.subject,
    });
    await createMembership(other.organization, other.workspace.id, elsewhere.id);
    const elsewhereInvitation = await createInvitation(
      other.organization,
      other.otherWorkspace.id,
      other.admin.userId!,
      person.login,
    );

    const res = await disable(target, target.admin, userId);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user_id: string; is_admin: boolean; disabled_at: string };
    expect(body).toMatchObject({ user_id: userId, is_admin: false });
    const stamp = body.disabled_at;
    expect((await userRow(target, userId))!.disabled_at).toBe(stamp);

    // 所属はどれも終わる（閉じたワークスペースも）。離脱日はワークスペースのタイムゾーンの今日
    const memberships = await membershipsOf(target, userId);
    expect(memberships).toHaveLength(2);
    for (const membership of memberships) {
      expect(membership.left_at).toBe(stamp);
      expect(membership.left_on).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    const tokyo = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo' }).format(new Date(stamp));
    const losAngeles = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(new Date(stamp));
    expect(memberships.find((row) => row.workspace_id === target.workspace.id)!.left_on).toBe(tokyo);
    expect(memberships.find((row) => row.workspace_id === closed.id)!.left_on).toBe(losAngeles);
    for (const membership of memberships) {
      const logs = await logsOf(target, 'membership', membership.id);
      expect(logs.map((log) => [log.workspace_id, log.actor_user_id, log.action, log.changes])).toEqual([
        [
          membership.workspace_id,
          target.admin.userId,
          'delete',
          { user: [{ id: userId, name: '星野 澪' }, null], role: [membership.role, null] },
        ],
      ]);
    }

    // 担当は外れる（閉じたワークスペースも）。完了したタスクとほかの人のタスクは変えない
    const db = dbOf(target);
    const taskOf = async (taskId: string) =>
      db.first(db.statement((q) => q.selectFrom('tasks').selectAll().where('id', '=', taskId)));
    for (const task of [open, inClosed]) {
      expect(await taskOf(task.id)).toMatchObject({ assignee_user_id: null, today_on: null, updated_at: stamp });
    }
    expect((await logsOf(target, 'task', open.id)).map((log) => [log.workspace_id, log.changes])).toEqual([
      [target.workspace.id, { assignee: [{ id: userId, name: '星野 澪' }, null], today_on: ['2026-10-26', null] }],
    ]);
    expect((await logsOf(target, 'task', inClosed.id)).map((log) => [log.workspace_id, log.changes])).toEqual([
      [closed.id, { assignee: [{ id: userId, name: '星野 澪' }, null] }],
    ]);
    expect((await taskOf(done.id))!.assignee_user_id).toBe(userId);
    expect((await taskOf(others.id))!.assignee_user_id).toBe(target.leader.userId);
    expect(await logsOf(target, 'task', done.id)).toHaveLength(0);

    // 招待は取り消す。ほかの人への招待（invitee）は残す
    const invitationOf = async (organizationDb: ReturnType<typeof dbOf>, invitationId: string) =>
      organizationDb.first(
        organizationDb.statement((q) => q.selectFrom('invitations').selectAll().where('id', '=', invitationId)),
      );
    expect(await invitationOf(db, invitation.id)).toMatchObject({ status: 'revoked', responded_at: stamp });
    expect((await logsOf(target, 'invitation', invitation.id)).map((log) => [log.workspace_id, log.changes])).toEqual([
      [target.otherWorkspace.id, { status: ['pending', 'revoked'] }],
    ]);
    const inviteeInvitation = await db.first(
      db.statement((q) =>
        q.selectFrom('invitations').select('status').where('login_subject', '=', target.invitee.login.subject),
      ),
    );
    expect(inviteeInvitation!.status).toBe('pending');

    // 別の組織のその人は変えない
    const otherDb = dbOf(other);
    expect((await userRow(other, elsewhere.id))!.disabled_at).toBeNull();
    expect((await membershipsOf(other, elsewhere.id))[0]!.left_at).toBeNull();
    expect((await invitationOf(otherDb, elsewhereInvitation.id))!.status).toBe('pending');

    // ユーザーの記録
    expect((await logsOf(target, 'user', userId)).map((log) => [log.workspace_id, log.changes])).toEqual([
      [null, { disabled_at: [null, stamp] }],
    ]);
  });

  test('管理者を無効にすると、同じ文で解除し、記録に is_admin も残る。もう一度無効にしても何も書かない', async () => {
    const target = await createTarget();
    const another = await secondAdmin(target);
    const res = await disable(target, target.admin, another.userId!);
    expect(res.status).toBe(200);
    const { disabled_at: stamp } = (await res.json()) as { disabled_at: string };
    expect(await userRow(target, another.userId!)).toMatchObject({ is_admin: 0, disabled_at: stamp });
    expect((await logsOf(target, 'user', another.userId!)).map((log) => log.changes)).toEqual([
      { disabled_at: [null, stamp], is_admin: [1, 0] },
    ]);

    const again = await disable(target, target.admin, another.userId!);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ user_id: another.userId, is_admin: false, disabled_at: stamp });
    expect(await logsOf(target, 'user', another.userId!)).toHaveLength(1);
  });

  test('時計を止めた二重の無効化（同じ時刻の2つの要求）でも、履歴は1回分のまま', async () => {
    const target = await createTarget();
    const userId = target.member.userId!;
    const task = await createTask(target.organization, target.workspace.id, userId, { assignee_user_id: userId });
    const requestEnv = Object.assign({}, testEnv, {
      PUBLIC_ORIGIN: 'http://localhost:8787',
      DEV_NOW: '2026-10-27T10:00:00+09:00',
    });
    const results = await Promise.all([
      disable(target, target.admin, userId, requestEnv),
      disable(target, target.admin, userId, requestEnv),
    ]);
    expect(results.map((res) => res.status)).toEqual([200, 200]);
    expect(await logsOf(target, 'user', userId)).toHaveLength(1);
    const [membership] = await membershipsOf(target, userId);
    expect(await logsOf(target, 'membership', membership!.id)).toHaveLength(1);
    expect(await logsOf(target, 'task', task.id)).toHaveLength(1);
  });

  test('無効にした人は組織に入れず、入れる組織が無くなればセッションが消える', async () => {
    const target = await createTarget();
    expect(await sessionCount(target.member.accountId)).toBe(1);
    expect((await disable(target, target.admin, target.member.userId!)).status).toBe(200);
    expect(await sessionCount(target.member.accountId)).toBe(0);
    const res = await post(app, organizationInfo, { slug: target.slug, token: target.member.token, body: {} });
    expect(res.status).toBe(401);
  });

  test('ほかの組織に入れる人は、セッションが残り、この組織にだけ入れない。メンバーの一覧からも消える', async () => {
    const target = await createTarget();
    await admitElsewhere(target.member);
    expect((await disable(target, target.admin, target.member.userId!)).status).toBe(200);
    expect(await sessionCount(target.member.accountId)).toBe(1);
    const res = await post(app, organizationInfo, { slug: target.slug, token: target.member.token, body: {} });
    expect(res.status).toBe(404);
    const list = await post(app, memberList, {
      slug: target.slug,
      token: target.admin.token,
      body: { workspace_id: target.workspace.id },
    });
    const members = ((await list.json()) as { members: { id: string }[] }).members.map((member) => member.id);
    expect(members).not.toContain(target.member.userId);
  });
});

describe('user-enable', () => {
  test('無効の間にその人のログインに結ばれた、無効にする前の招待（Google のメールで待っていた招待）は、有効に戻すときに取り消す。無効の間に作った招待は残す', async () => {
    const target = await createTarget();
    const { organization } = target;
    const person = target.member;
    const userId = person.userId!;
    // 無効にする前に作った Google の招待。メールアドレスで待っているので、無効化では取り消されない
    const waiting = await createInvitation(
      organization,
      target.otherWorkspace.id,
      target.admin.userId!,
      { provider: 'google', subject: '' },
      {
        login_provider: 'google',
        login_subject: null,
        login_email: 'nagi@example.test',
        claim_token_hash: hash64(),
        claim_expires_at: '2999-01-01T00:00:00.000Z',
        login_name: 'nagi@example.test',
        created_at: '2026-10-20T00:00:00.000Z',
      },
    );
    const res = await disable(target, target.admin, userId);
    expect(res.status).toBe(200);
    const db = dbOf(target);
    expect(
      (await db.first(db.statement((q) => q.selectFrom('invitations').select('status').where('id', '=', waiting.id))))!
        .status,
    ).toBe('pending');

    // 無効の間に、本人が招待の URL から結んだ（その人のログインの手段と ID が入る）
    await db.run(
      db.statement((q) =>
        q
          .updateTable('invitations')
          .set({
            login_provider: person.login.provider,
            login_subject: person.login.subject,
            login_email: null,
            claim_token_hash: null,
            claim_expires_at: null,
          })
          .where('id', '=', waiting.id),
      ),
    );
    // 無効の間に作った招待（無効にした日時より後）は、管理者が招待し直したものなので残す
    const reinvited = await createInvitation(organization, target.workspace.id, target.admin.userId!, person.login, {
      created_at: '2999-01-01T00:00:00.000Z',
    });

    const enabled = await enable(target, target.admin, userId);
    expect(enabled.status).toBe(200);
    const statusOf = async (invitationId: string) =>
      (await db.first(db.statement((q) => q.selectFrom('invitations').selectAll().where('id', '=', invitationId))))!;
    const revoked = await statusOf(waiting.id);
    expect(revoked.status).toBe('revoked');
    expect(revoked.responded_at).not.toBeNull();
    expect((await logsOf(target, 'invitation', waiting.id)).map((log) => [log.workspace_id, log.changes])).toEqual([
      [target.otherWorkspace.id, { status: ['pending', 'revoked'] }],
    ]);
    expect((await statusOf(reinvited.id)).status).toBe('pending');
    expect(await logsOf(target, 'invitation', reinvited.id)).toHaveLength(0);
  });

  test('有効に戻してもログインはできるが、所属は戻らず、招待し直すまで組織に入れない', async () => {
    const target = await createTarget();
    await admitElsewhere(target.member);
    const userId = target.member.userId!;
    const disabled = await disable(target, target.admin, userId);
    const { disabled_at: stamp } = (await disabled.json()) as { disabled_at: string };

    const res = await enable(target, target.admin, userId);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ user_id: userId, is_admin: false, disabled_at: null });
    expect((await userRow(target, userId))!.disabled_at).toBeNull();
    expect((await membershipsOf(target, userId)).every((membership) => membership.left_at !== null)).toBe(true);
    expect((await logsOf(target, 'user', userId)).map((log) => log.changes)).toEqual([
      { disabled_at: [null, stamp] },
      { disabled_at: [stamp, null] },
    ]);
    const info = await post(app, organizationInfo, { slug: target.slug, token: target.member.token, body: {} });
    expect(info.status).toBe(404);

    // 有効な人を有効に戻しても、何も書かない
    const again = await enable(target, target.admin, userId);
    expect(again.status).toBe(200);
    expect(await logsOf(target, 'user', userId)).toHaveLength(2);
  });

  test('無効にした管理者は、有効に戻しても管理者には戻らない', async () => {
    const target = await createTarget();
    const another = await secondAdmin(target);
    expect((await disable(target, target.admin, another.userId!)).status).toBe(200);
    expect((await enable(target, target.admin, another.userId!)).status).toBe(200);
    expect(await userRow(target, another.userId!)).toMatchObject({ is_admin: 0, disabled_at: null });
  });
});

describe('組織の変更の履歴', () => {
  test('指名、解除、無効化、有効化が、それぞれの種類で出る', async () => {
    const target = await createTarget();
    const userId = target.member.userId!;
    expect((await setAdmin(target, target.admin, userId, true)).status).toBe(200);
    expect((await setAdmin(target, target.admin, userId, false)).status).toBe(200);
    expect((await setAdmin(target, target.admin, userId, true)).status).toBe(200);
    // 管理者のまま無効にする（解除も同じ記録に入る）
    expect((await disable(target, target.admin, userId)).status).toBe(200);
    expect((await enable(target, target.admin, userId)).status).toBe(200);

    const res = await post(app, organizationHistory, { slug: target.slug, token: target.admin.token, body: {} });
    expect(res.status).toBe(200);
    const { entries } = (await res.json()) as OutputOf<typeof organizationHistory>;
    const events = entries
      .filter((entry) => entry.actor.kind === 'user' && entry.actor.id === target.admin.userId)
      .map((entry) => entry.event);
    expect(events).toEqual([
      { kind: 'user_enabled', name: '星野 澪' },
      { kind: 'user_disabled', name: '星野 澪' },
      { kind: 'admin_designated', name: '星野 澪' },
      { kind: 'admin_revoked', name: '星野 澪' },
      { kind: 'admin_designated', name: '星野 澪' },
    ]);
  });
});
