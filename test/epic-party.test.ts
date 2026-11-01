// 討伐隊の受注（epic-party-join）、抜ける（epic-party-leave）、割り振り（epic-party-assign）と、配下のタスクの担当で加わる経路
// （task-assign、担当つきの task-create）、epic-detail の can_join と joined の振る舞い。
// 組織の分離と権限の種類ごとの許可と拒否は、一覧を回す test/operation-registry.test.ts が確かめる
import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import { epicDetail, epicPartyAssign, epicPartyJoin, epicPartyLeave } from '../src/shared/operations/epic/index.ts';
import { taskAssign, taskCreate } from '../src/shared/operations/task/index.ts';
import type { AnyOperationDefinition } from '../src/shared/operations/define.ts';
import { createApp } from '../src/server/app.ts';
import { orgDb, verifyWorkspace, type OrganizationDb } from '../src/server/db/index.ts';
import {
  epicPartyAssignOperation,
  epicPartyJoinOperation,
  epicPartyLeaveOperation,
} from '../src/server/operations/epic-party.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import {
  AT,
  createEpic,
  createEpicPartyMember,
  createMembership,
  createStory,
  createTask,
  createUser,
  hash64,
} from './factories.ts';
import { errorCodeOf, post } from './operations/harness.ts';
import { createPerson, createTarget, testEnv, type Person, type Target } from './operations/world.ts';

const app = createApp(implementedOperations);

function call(
  definition: AnyOperationDefinition,
  target: Target,
  person: Person,
  body: Record<string, unknown>,
  requestEnv: Env = testEnv,
) {
  return post(app, definition, {
    slug: target.slug,
    token: person.token,
    body: { workspace_id: target.workspace.id, ...body },
    env: requestEnv,
  });
}

// 止めた時計（開発用の DEV_NOW）。同時の要求が同じ時刻で書いても、負けた要求が二重に書かないことを見る
function frozenEnv(): Env {
  return Object.assign({}, testEnv, { PUBLIC_ORIGIN: 'http://localhost:8787', DEV_NOW: '2026-10-26T01:00:00.000Z' });
}

const join = (target: Target, epicId: string, person: Person = target.member) =>
  call(epicPartyJoin, target, person, { epic_id: epicId });
const leave = (target: Target, epicId: string, person: Person = target.member) =>
  call(epicPartyLeave, target, person, { epic_id: epicId });
const assign = (target: Target, epicId: string, userId: string, person: Person = target.leader) =>
  call(epicPartyAssign, target, person, { epic_id: epicId, user_id: userId });

async function partyOf(target: Target, epicId: string) {
  const db = orgDb(env, target.organization.verified);
  return db.rows(
    db.statement((q) =>
      q
        .selectFrom('epic_party_members')
        .innerJoin('epics', 'epics.id', 'epic_party_members.epic_id')
        .select([
          'epic_party_members.user_id',
          'epic_party_members.joined_via',
          'epic_party_members.added_by',
          'epic_party_members.joined_at',
        ])
        .where('epic_party_members.epic_id', '=', epicId)
        .where('epics.workspace_id', '=', target.workspace.id)
        .orderBy('epic_party_members.user_id'),
    ),
  );
}

async function epicLogsOf(target: Target, epicId: string) {
  const db = orgDb(env, target.organization.verified);
  const rows = await db.rows(
    db.statement((q) =>
      q
        .selectFrom('change_logs')
        .selectAll()
        .where('entity_type', '=', 'epic')
        .where('entity_id', '=', epicId)
        .where('organization_id', '=', target.organization.id)
        .orderBy('created_at')
        .orderBy('id'),
    ),
  );
  return rows.map((row) => ({
    actor: row.actor_user_id,
    action: row.action,
    workspace_id: row.workspace_id,
    changes: JSON.parse(row.changes_json) as unknown,
  }));
}

async function rename(target: Target, person: Person, name: string) {
  const db = orgDb(env, target.organization.verified);
  await db.run(
    db.statement((q) =>
      q
        .updateTable('users')
        .set({ name })
        .where('id', '=', person.userId!)
        .where('organization_id', '=', target.organization.id),
    ),
  );
}

// 名前で見分けられるように、メンバーとリーダーに別の名前を付けた対象
async function namedTarget(options: { closed?: boolean } = {}) {
  const target = await createTarget(options);
  await rename(target, target.member, '若葉 湊');
  await rename(target, target.leader, '朝霧 楓');
  return target;
}

function epicOf(target: Target, overrides: Parameters<typeof createEpic>[3] = {}) {
  return createEpic(target.organization, target.workspace.id, target.admin.userId!, overrides);
}

const finishedEpics = {
  クリア: { completed_at: '2026-10-22T00:00:00.000Z' },
  中止: { canceled_at: '2026-10-22T00:00:00.000Z' },
} as const;

async function expectError(res: Response, status: number, code: string) {
  expect(res.status).toBe(status);
  expect(await errorCodeOf(res)).toBe(code);
}

function finishedOf(target: Target) {
  return { completed_at: '2026-10-22T00:00:00.000Z', completed_by: target.admin.userId! };
}

// 処理が呼ぶ batch() の直前に、別の要求が先に書いた、という状態を作って処理を直に呼ぶ。
// 討伐隊の処理は、読み取りも書く文も batch() で送る。batch の番号は 0（1 回目の読み）、1（1 回目の書き込み）、2（2 回目の読み）…
// の順で、最後にやり直しを使い切った後の読み（6）が続く。before はその番号を受ける
async function runRacing(
  operation: typeof epicPartyJoinOperation | typeof epicPartyLeaveOperation | typeof epicPartyAssignOperation,
  target: Target,
  person: Person,
  input: Record<string, unknown>,
  before: (batch: number, db: OrganizationDb) => Promise<void>,
) {
  const db = orgDb(env, target.organization.verified);
  const actor = { accountId: person.accountId, userId: person.userId, isAdmin: false, invitedOnly: false };
  const workspace = await verifyWorkspace(db, actor, target.workspace.id);
  let batches = 0;
  const racing = new Proxy(db, {
    get(base, key) {
      const value = Reflect.get(base, key, base);
      if (typeof value !== 'function') return value;
      if (key !== 'batch') return value.bind(base);
      return async (...args: unknown[]) => {
        await before(batches++, db);
        return (value as (...a: unknown[]) => Promise<unknown>).apply(base, args);
      };
    },
  });
  const context = {
    db: racing,
    actor,
    workspace,
    input: { workspace_id: target.workspace.id, ...input },
    defer: () => {},
  } as never;
  return (operation.handler as (context: never) => Promise<unknown>)(context);
}

function setFinished(db: OrganizationDb, target: Target, epicId: string, finished: boolean) {
  return db.run(
    db.statement((q) =>
      q
        .updateTable('epics')
        .set(
          finished
            ? { completed_at: AT, completed_by: target.admin.userId! }
            : { completed_at: null, completed_by: null },
        )
        .where('id', '=', epicId)
        .where('workspace_id', '=', target.workspace.id),
    ),
  );
}

// 書く文の batch()（奇数の番号）の直前にエピックを終わらせ、次の読み（偶数の番号）の前に戻す。毎回書き込みに負けるが、読む時点では終わっていない
const losingEveryWrite = (target: Target, epicId: string) => async (batch: number, db: OrganizationDb) => {
  await setFinished(db, target, epicId, batch % 2 === 1);
};

// 最初の 2 回の書き込みは同じように負け、最後の書き込み（番号 5）の直前に終わらせる。やり直しを使い切った後の読み（番号 6）では戻さない
const finishingBeforeLastWrite = (target: Target, epicId: string) => async (batch: number, db: OrganizationDb) => {
  if (batch <= 5) await setFinished(db, target, epicId, batch % 2 === 1);
};

// 読んだ後（最初の書き込みの直前）にエピックが終わる
const finishingAfterRead = (target: Target, epicId: string) => async (batch: number, db: OrganizationDb) => {
  if (batch === 1) await setFinished(db, target, epicId, true);
};

describe('討伐隊の処理の競合', () => {
  // 3 つの処理を同じ形で確かめる。抜けるは、先に討伐隊にいる状態にしておく
  const cases = [
    {
      name: 'epic-party-join',
      operation: epicPartyJoinOperation,
      person: (target: Target) => target.member,
      withUserId: false,
      setup: async () => {},
    },
    {
      name: 'epic-party-leave',
      operation: epicPartyLeaveOperation,
      person: (target: Target) => target.member,
      withUserId: false,
      setup: async (target: Target, epicId: string) => {
        await createEpicPartyMember(target.organization, epicId, target.member.userId!);
      },
    },
    {
      name: 'epic-party-assign',
      operation: epicPartyAssignOperation,
      person: (target: Target) => target.leader,
      withUserId: true,
      setup: async () => {},
    },
  ];

  for (const item of cases) {
    describe(item.name, () => {
      function run(target: Target, epicId: string, before: (batch: number, db: OrganizationDb) => Promise<void>) {
        return runRacing(
          item.operation,
          target,
          item.person(target),
          { epic_id: epicId, ...(item.withUserId ? { user_id: target.member.userId! } : {}) },
          before,
        );
      }

      test('書き込みの直前に毎回別の要求が状態を変えて 3 回負けると、409 の conflict', async () => {
        const target = await namedTarget();
        const epic = await epicOf(target);
        await item.setup(target, epic.id);
        const before = await partyOf(target, epic.id);
        await expect(run(target, epic.id, losingEveryWrite(target, epic.id))).rejects.toMatchObject({
          status: 409,
          code: 'conflict',
        });
        expect(await partyOf(target, epic.id)).toEqual(before);
        expect(await epicLogsOf(target, epic.id)).toEqual([]);
      });

      test('読んだ後（最初の書き込みの直前）にエピックが終わると、409 の epic_finished', async () => {
        const target = await namedTarget();
        const epic = await epicOf(target);
        await item.setup(target, epic.id);
        const before = await partyOf(target, epic.id);
        await expect(run(target, epic.id, finishingAfterRead(target, epic.id))).rejects.toMatchObject({
          status: 409,
          code: 'epic_finished',
        });
        expect(await partyOf(target, epic.id)).toEqual(before);
        expect(await epicLogsOf(target, epic.id)).toEqual([]);
      });

      test('2 回負けた後の最後の書き込みの直前にエピックが終わると、409 の epic_finished（conflict ではない）', async () => {
        const target = await namedTarget();
        const epic = await epicOf(target);
        await item.setup(target, epic.id);
        const before = await partyOf(target, epic.id);
        await expect(run(target, epic.id, finishingBeforeLastWrite(target, epic.id))).rejects.toMatchObject({
          status: 409,
          code: 'epic_finished',
        });
        expect(await partyOf(target, epic.id)).toEqual(before);
        expect(await epicLogsOf(target, epic.id)).toEqual([]);
      });
    });
  }
});

describe('epic-party-join と epic-party-leave', () => {
  test('メンバーは受注して self で加わり、抜けると行が消える。どちらも履歴に残す', async () => {
    const target = await namedTarget();
    const epic = await epicOf(target);
    const memberId = target.member.userId!;

    const joined = await join(target, epic.id);
    expect(joined.status).toBe(200);
    expect(await joined.json()).toEqual({ changed: true });
    expect(await partyOf(target, epic.id)).toEqual([
      { user_id: memberId, joined_via: 'self', added_by: memberId, joined_at: expect.any(String) },
    ]);

    const left = await leave(target, epic.id);
    expect(left.status).toBe(200);
    expect(await left.json()).toEqual({ changed: true });
    expect(await partyOf(target, epic.id)).toEqual([]);

    expect(await epicLogsOf(target, epic.id)).toEqual([
      {
        actor: memberId,
        action: 'update',
        workspace_id: target.workspace.id,
        changes: { party_member: [null, { id: memberId, name: '若葉 湊', via: 'self' }] },
      },
      {
        actor: memberId,
        action: 'update',
        workspace_id: target.workspace.id,
        changes: { party_member: [{ id: memberId, name: '若葉 湊', via: 'self' }, null] },
      },
    ]);
  });

  test('既に討伐隊にいれば、入り方を問わず受注しても何も書かない。いなければ抜けても何も書かない', async () => {
    const target = await namedTarget();
    const epic = await epicOf(target);
    await createEpicPartyMember(target.organization, epic.id, target.member.userId!, {
      joined_via: 'assigned',
      added_by: target.leader.userId!,
    });

    const again = await join(target, epic.id);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ changed: false });
    expect((await partyOf(target, epic.id)).map((row) => row.joined_via)).toEqual(['assigned']);

    const notIn = await leave(target, epic.id, target.leader);
    expect(notIn.status).toBe(200);
    expect(await notIn.json()).toEqual({ changed: false });
    expect(await epicLogsOf(target, epic.id)).toEqual([]);
  });

  test('抜けるときの履歴は、消した行の入り方を残す', async () => {
    const target = await namedTarget();
    const epic = await epicOf(target);
    await createEpicPartyMember(target.organization, epic.id, target.member.userId!, {
      joined_via: 'task_assignee',
      added_by: target.leader.userId!,
    });
    expect((await leave(target, epic.id)).status).toBe(200);
    expect((await epicLogsOf(target, epic.id)).map((log) => log.changes)).toEqual([
      { party_member: [{ id: target.member.userId, name: '若葉 湊', via: 'task_assignee' }, null] },
    ]);
  });

  test('抜けるのは自分の行だけ。ほかの人の行は残る', async () => {
    const target = await namedTarget();
    const epic = await epicOf(target);
    await createEpicPartyMember(target.organization, epic.id, target.leader.userId!);
    await createEpicPartyMember(target.organization, epic.id, target.member.userId!);
    expect((await leave(target, epic.id)).status).toBe(200);
    expect((await partyOf(target, epic.id)).map((row) => row.user_id)).toEqual([target.leader.userId]);
  });

  test('2つの画面から同時に受注しても1行で、履歴も1つ', async () => {
    const target = await namedTarget();
    const epic = await epicOf(target);
    const results = await Promise.all([join(target, epic.id), join(target, epic.id), join(target, epic.id)]);
    for (const res of results) expect(res.status).toBe(200);
    const changed = await Promise.all(results.map(async (res) => ((await res.json()) as { changed: boolean }).changed));
    expect(changed.filter(Boolean)).toHaveLength(1);
    expect(await partyOf(target, epic.id)).toHaveLength(1);
    expect(await epicLogsOf(target, epic.id)).toHaveLength(1);
  });

  test('止めた時計で2つの画面から同時に抜けても、行は消え、履歴は1つ', async () => {
    const target = await namedTarget();
    const epic = await epicOf(target);
    await createEpicPartyMember(target.organization, epic.id, target.member.userId!);
    const requestEnv = frozenEnv();
    const results = await Promise.all([
      call(epicPartyLeave, target, target.member, { epic_id: epic.id }, requestEnv),
      call(epicPartyLeave, target, target.member, { epic_id: epic.id }, requestEnv),
    ]);
    for (const res of results) expect(res.status).toBe(200);
    const changed = await Promise.all(results.map(async (res) => ((await res.json()) as { changed: boolean }).changed));
    expect(changed.filter(Boolean)).toHaveLength(1);
    expect(await partyOf(target, epic.id)).toEqual([]);
    expect((await epicLogsOf(target, epic.id)).map((log) => log.changes)).toEqual([
      { party_member: [{ id: target.member.userId, name: '若葉 湊', via: 'self' }, null] },
    ]);
  });

  test('所属していない管理者の受注は 404', async () => {
    const target = await namedTarget();
    const epic = await epicOf(target);
    await expectError(await join(target, epic.id, target.admin), 404, 'not_found');
    expect(await partyOf(target, epic.id)).toEqual([]);
  });

  for (const [label, overrides] of Object.entries(finishedEpics)) {
    test(`${label}したエピックには受注できず、抜けられない（409 の epic_finished）`, async () => {
      const target = await namedTarget();
      const epic = await epicOf(target, {
        ...overrides,
        [label === 'クリア' ? 'completed_by' : 'canceled_by']: target.admin.userId!,
      });
      await expectError(await join(target, epic.id), 409, 'epic_finished');
      await createEpicPartyMember(target.organization, epic.id, target.member.userId!);
      await expectError(await leave(target, epic.id), 409, 'epic_finished');
      expect(await partyOf(target, epic.id)).toHaveLength(1);
      expect(await epicLogsOf(target, epic.id)).toEqual([]);
    });
  }

  test('別の組織・別のワークスペース・削除済み・存在しないエピックは、受注も抜けるも 404', async () => {
    const target = await namedTarget();
    const foreign = await createTarget();
    const ids = [
      (await createEpic(foreign.organization, foreign.workspace.id, foreign.admin.userId!)).id,
      (await createEpic(target.organization, target.otherWorkspace.id, target.admin.userId!)).id,
      // 終わったエピックでも、別の組織・別のワークスペースのものは 409 でなく 404
      (await createEpic(foreign.organization, foreign.workspace.id, foreign.admin.userId!, finishedOf(foreign))).id,
      (await createEpic(target.organization, target.otherWorkspace.id, target.admin.userId!, finishedOf(target))).id,
      (await epicOf(target, { deleted_at: '2026-10-21T00:00:00.000Z' })).id,
      '019a0000-0000-7000-8000-00000000ffff',
    ];
    for (const id of ids) {
      await expectError(await join(target, id), 404, 'not_found');
      await expectError(await leave(target, id), 404, 'not_found');
    }
  });

  test('別のワークスペースのエピックの討伐隊の行は、自分のワークスペースの ID では消せない', async () => {
    const target = await namedTarget();
    const epic = await createEpic(target.organization, target.otherWorkspace.id, target.admin.userId!);
    await createMembership(target.organization, target.otherWorkspace.id, target.member.userId!);
    await createEpicPartyMember(target.organization, epic.id, target.member.userId!);
    await expectError(await leave(target, epic.id), 404, 'not_found');
    const db = orgDb(env, target.organization.verified);
    const rows = await db.rows(
      db.statement((q) => q.selectFrom('epic_party_members').select('user_id').where('epic_id', '=', epic.id)),
    );
    expect(rows).toHaveLength(1);
  });

  test('閉じたワークスペースは 409 の workspace_closed', async () => {
    const target = await namedTarget({ closed: true });
    const epic = await epicOf(target);
    await expectError(await join(target, epic.id), 409, 'workspace_closed');
    await expectError(await leave(target, epic.id), 409, 'workspace_closed');
  });
});

describe('epic-party-assign', () => {
  test('リーダーは今所属している人を assigned で割り振れ、した人と割り振った人の名前を履歴に残す', async () => {
    const target = await namedTarget();
    const epic = await epicOf(target);
    const res = await assign(target, epic.id, target.member.userId!);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ changed: true });
    expect(await partyOf(target, epic.id)).toEqual([
      {
        user_id: target.member.userId,
        joined_via: 'assigned',
        added_by: target.leader.userId,
        joined_at: expect.any(String),
      },
    ]);
    expect(await epicLogsOf(target, epic.id)).toEqual([
      {
        actor: target.leader.userId,
        action: 'update',
        workspace_id: target.workspace.id,
        changes: { party_member: [null, { id: target.member.userId, name: '若葉 湊', via: 'assigned' }] },
      },
    ]);
  });

  test('依頼主は一般のメンバーでも割り振れる。管理者も割り振れる', async () => {
    const target = await namedTarget();
    const epic = await epicOf(target, { requester_user_id: target.member.userId! });
    expect((await assign(target, epic.id, target.leader.userId!, target.member)).status).toBe(200);
    const other = await epicOf(target);
    expect((await assign(target, other.id, target.member.userId!, target.admin)).status).toBe(200);
    expect((await partyOf(target, other.id)).map((row) => row.added_by)).toEqual([target.admin.userId]);
  });

  test('依頼主でもリーダーでもない一般のメンバーの割り振りは、API でも 403 の forbidden', async () => {
    const target = await namedTarget();
    const epic = await epicOf(target);
    await expectError(await assign(target, epic.id, target.member.userId!, target.member), 403, 'forbidden');
    expect(await partyOf(target, epic.id)).toEqual([]);
  });

  test('既に討伐隊にいる人を割り振っても何も書かない', async () => {
    const target = await namedTarget();
    const epic = await epicOf(target);
    await createEpicPartyMember(target.organization, epic.id, target.member.userId!);
    const res = await assign(target, epic.id, target.member.userId!);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ changed: false });
    expect((await partyOf(target, epic.id)).map((row) => row.joined_via)).toEqual(['self']);
    expect(await epicLogsOf(target, epic.id)).toEqual([]);
  });

  test('所属していない人、抜けた人、無効の人、login_subject の無い人、別の組織の人の割り振りは 404', async () => {
    const target = await namedTarget();
    const foreign = await createTarget();
    const epic = await epicOf(target);
    const gone = await createUser(target.organization, { name: '離れた 人' });
    await createMembership(target.organization, target.workspace.id, gone.id, { left_at: AT, left_on: '2026-10-20' });
    const disabled = await createPerson({
      organization: target.organization,
      disabled: true,
      membership: { workspaceId: target.workspace.id, role: 'member' },
    });
    const pending = await createUser(target.organization, {
      login_provider: 'google',
      login_subject: null,
      login_email: 'waiting@example.test',
      claim_token_hash: hash64(),
      claim_expires_at: '2999-01-01T00:00:00.000Z',
    });
    await createMembership(target.organization, target.workspace.id, pending.id);
    const ids = [
      target.bystander.userId!,
      target.admin.userId!,
      gone.id,
      disabled.userId!,
      pending.id,
      foreign.member.userId!,
      '019a0000-0000-7000-8000-00000000ffff',
    ];
    for (const id of ids) await expectError(await assign(target, epic.id, id), 404, 'not_found');
    expect(await partyOf(target, epic.id)).toEqual([]);
  });

  for (const [label, overrides] of Object.entries(finishedEpics)) {
    test(`${label}したエピックには割り振れない（409 の epic_finished）`, async () => {
      const target = await namedTarget();
      const epic = await epicOf(target, {
        ...overrides,
        [label === 'クリア' ? 'completed_by' : 'canceled_by']: target.admin.userId!,
      });
      await expectError(await assign(target, epic.id, target.member.userId!), 409, 'epic_finished');
      expect(await partyOf(target, epic.id)).toEqual([]);
    });
  }

  test('別の組織のエピックの ID は 404', async () => {
    const target = await namedTarget();
    const foreign = await createTarget();
    const epic = await createEpic(foreign.organization, foreign.workspace.id, foreign.admin.userId!);
    await expectError(await assign(target, epic.id, target.member.userId!), 404, 'not_found');
    // 終わったエピックでも、別の組織・別のワークスペースのものは 409 でなく 404
    const foreignFinished = await createEpic(
      foreign.organization,
      foreign.workspace.id,
      foreign.admin.userId!,
      finishedOf(foreign),
    );
    const otherFinished = await createEpic(
      target.organization,
      target.otherWorkspace.id,
      target.admin.userId!,
      finishedOf(target),
    );
    for (const id of [foreignFinished.id, otherFinished.id]) {
      await expectError(await assign(target, id, target.member.userId!), 404, 'not_found');
    }
  });

  test('読んだ後に依頼主が替わったら、書く文の条件で止まり、403 で何も書かない', async () => {
    const target = await namedTarget();
    const epic = await epicOf(target, { requester_user_id: target.member.userId! });
    const db = orgDb(env, target.organization.verified);
    const actor = {
      accountId: target.member.accountId,
      userId: target.member.userId,
      isAdmin: false,
      invitedOnly: false,
    };
    const workspace = await verifyWorkspace(db, actor, target.workspace.id);
    let batches = 0;
    // 最初の batch()（読み取り）の後に、依頼主をリーダーに替える
    const racing = new Proxy(db, {
      get(base, key) {
        const value = Reflect.get(base, key, base);
        if (typeof value !== 'function') return value;
        if (key !== 'batch') return value.bind(base);
        return async (...args: unknown[]) => {
          const result = await (value as (...a: unknown[]) => Promise<unknown>).apply(base, args);
          if (++batches === 1) {
            await db.run(
              db.statement((q) =>
                q
                  .updateTable('epics')
                  .set({ requester_user_id: target.leader.userId! })
                  .where('id', '=', epic.id)
                  .where('workspace_id', '=', target.workspace.id),
              ),
            );
          }
          return result;
        };
      },
    });
    const context = {
      db: racing,
      actor,
      workspace,
      input: { workspace_id: target.workspace.id, epic_id: epic.id, user_id: target.leader.userId },
      defer: () => {},
    } as never;
    await expect(epicPartyAssignOperation.handler(context)).rejects.toMatchObject({ status: 403, code: 'forbidden' });
    expect(await partyOf(target, epic.id)).toEqual([]);
    expect(await epicLogsOf(target, epic.id)).toEqual([]);
  });
});

describe('配下のタスクの担当で討伐隊に加わる', () => {
  async function underEpic(target: Target, epicOverrides: Parameters<typeof createEpic>[3] = {}) {
    const epic = await epicOf(target, epicOverrides);
    const story = await createStory(target.organization, target.workspace.id, target.admin.userId!, {
      epic_id: epic.id,
    });
    return { epic, story };
  }

  test('task-assign でエピックの配下のタスクに担当を付けると、担当が task_assignee で加わり、履歴に残す', async () => {
    const target = await namedTarget();
    const { epic, story } = await underEpic(target);
    const task = await createTask(target.organization, target.workspace.id, target.admin.userId!, {
      story_id: story.id,
    });
    const res = await call(taskAssign, target, target.leader, {
      task_id: task.id,
      assignee_user_id: target.member.userId,
    });
    expect(res.status).toBe(200);
    expect(await partyOf(target, epic.id)).toEqual([
      {
        user_id: target.member.userId,
        joined_via: 'task_assignee',
        added_by: target.leader.userId,
        joined_at: expect.any(String),
      },
    ]);
    expect(await epicLogsOf(target, epic.id)).toEqual([
      {
        actor: target.leader.userId,
        action: 'update',
        workspace_id: target.workspace.id,
        changes: { party_member: [null, { id: target.member.userId, name: '若葉 湊', via: 'task_assignee' }] },
      },
    ]);

    // 担当を替えても、前の担当は討伐隊に残り、新しい担当が加わる。外しても（null）何もしない
    expect(
      (await call(taskAssign, target, target.leader, { task_id: task.id, assignee_user_id: target.leader.userId }))
        .status,
    ).toBe(200);
    expect((await call(taskAssign, target, target.leader, { task_id: task.id, assignee_user_id: null })).status).toBe(
      200,
    );
    expect((await partyOf(target, epic.id)).map((row) => row.user_id).sort()).toEqual(
      [target.member.userId, target.leader.userId].sort(),
    );
    expect(await epicLogsOf(target, epic.id)).toHaveLength(2);
  });

  test('止めた時計で同じタスクに同時に同じ担当を割り当てても、討伐隊は1行で、エピックの履歴も1つ', async () => {
    const target = await namedTarget();
    const { epic, story } = await underEpic(target);
    const task = await createTask(target.organization, target.workspace.id, target.admin.userId!, {
      story_id: story.id,
    });
    const requestEnv = frozenEnv();
    const body = { task_id: task.id, assignee_user_id: target.member.userId };
    const results = await Promise.all([
      call(taskAssign, target, target.leader, body, requestEnv),
      call(taskAssign, target, target.member, body, requestEnv),
      call(taskAssign, target, target.leader, body, requestEnv),
    ]);
    for (const res of results) expect(res.status).toBe(200);
    expect(await partyOf(target, epic.id)).toEqual([
      // 時計が止まっていることも確かめる（止まっていなければ、この試験は同じ時刻の競合を見ていない）
      expect.objectContaining({
        user_id: target.member.userId,
        joined_via: 'task_assignee',
        joined_at: '2026-10-26T01:00:00.000Z',
      }),
    ]);
    expect((await epicLogsOf(target, epic.id)).map((log) => log.changes)).toEqual([
      { party_member: [null, { id: target.member.userId, name: '若葉 湊', via: 'task_assignee' }] },
    ]);
  });

  test('担当つきの task-create でエピックの配下に作ると、担当が加わる', async () => {
    const target = await namedTarget();
    const { epic, story } = await underEpic(target);
    const res = await call(taskCreate, target, target.member, {
      title: '見積もりを送る',
      story_id: story.id,
      assignee_user_id: target.leader.userId,
    });
    expect(res.status).toBe(200);
    expect(await partyOf(target, epic.id)).toEqual([
      {
        user_id: target.leader.userId,
        joined_via: 'task_assignee',
        added_by: target.member.userId,
        joined_at: expect.any(String),
      },
    ]);
    expect((await epicLogsOf(target, epic.id)).map((log) => log.changes)).toEqual([
      { party_member: [null, { id: target.leader.userId, name: '朝霧 楓', via: 'task_assignee' }] },
    ]);
  });

  test('既に討伐隊にいれば、担当を付けても入り方を変えず、履歴も書かない', async () => {
    const target = await namedTarget();
    const { epic, story } = await underEpic(target);
    await createEpicPartyMember(target.organization, epic.id, target.member.userId!);
    const task = await createTask(target.organization, target.workspace.id, target.admin.userId!, {
      story_id: story.id,
    });
    expect(
      (await call(taskAssign, target, target.member, { task_id: task.id, assignee_user_id: target.member.userId }))
        .status,
    ).toBe(200);
    expect(
      (
        await call(taskCreate, target, target.member, {
          title: '請求書を出す',
          story_id: story.id,
          assignee_user_id: target.member.userId,
        })
      ).status,
    ).toBe(200);
    expect((await partyOf(target, epic.id)).map((row) => row.joined_via)).toEqual(['self']);
    expect(await epicLogsOf(target, epic.id)).toEqual([]);
  });

  test('親のないタスク、エピックの下でないストーリーのタスクでは、どのエピックの討伐隊にも加わらない', async () => {
    const target = await namedTarget();
    const { epic } = await underEpic(target);
    const loneStory = await createStory(target.organization, target.workspace.id, target.admin.userId!);
    const root = await createTask(target.organization, target.workspace.id, target.admin.userId!);
    const underLone = await createTask(target.organization, target.workspace.id, target.admin.userId!, {
      story_id: loneStory.id,
    });
    for (const task of [root, underLone]) {
      expect(
        (await call(taskAssign, target, target.member, { task_id: task.id, assignee_user_id: target.member.userId }))
          .status,
      ).toBe(200);
    }
    expect(
      (
        await call(taskCreate, target, target.member, {
          title: '親なし',
          assignee_user_id: target.member.userId,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await call(taskCreate, target, target.member, {
          title: 'エピックの外',
          story_id: loneStory.id,
          assignee_user_id: target.member.userId,
        })
      ).status,
    ).toBe(200);
    const db = orgDb(env, target.organization.verified);
    const all = await db.rows(db.statement((q) => q.selectFrom('epic_party_members').select('epic_id')));
    expect(all.filter((row) => row.epic_id === epic.id)).toEqual([]);
    expect(await partyOf(target, epic.id)).toEqual([]);
  });

  for (const [label, overrides] of Object.entries(finishedEpics)) {
    test(`${label}したエピックの配下のタスクに担当を付けても、討伐隊は変わらない`, async () => {
      const target = await namedTarget();
      const { epic, story } = await underEpic(target, {
        ...overrides,
        [label === 'クリア' ? 'completed_by' : 'canceled_by']: target.admin.userId!,
      });
      const task = await createTask(target.organization, target.workspace.id, target.admin.userId!, {
        story_id: story.id,
      });
      expect(
        (await call(taskAssign, target, target.member, { task_id: task.id, assignee_user_id: target.member.userId }))
          .status,
      ).toBe(200);
      expect(await partyOf(target, epic.id)).toEqual([]);
      expect(await epicLogsOf(target, epic.id)).toEqual([]);
    });
  }

  test('削除したストーリーの下のタスクでは加わらない', async () => {
    const target = await namedTarget();
    const epic = await epicOf(target);
    const story = await createStory(target.organization, target.workspace.id, target.admin.userId!, {
      epic_id: epic.id,
      deleted_at: '2026-10-21T00:00:00.000Z',
    });
    const task = await createTask(target.organization, target.workspace.id, target.admin.userId!, {
      story_id: story.id,
    });
    expect(
      (await call(taskAssign, target, target.member, { task_id: task.id, assignee_user_id: target.member.userId }))
        .status,
    ).toBe(200);
    expect(await partyOf(target, epic.id)).toEqual([]);
  });

  test('担当を替えられなかった（所属していない人）ときは、討伐隊も変わらない', async () => {
    const target = await namedTarget();
    const { epic, story } = await underEpic(target);
    const task = await createTask(target.organization, target.workspace.id, target.admin.userId!, {
      story_id: story.id,
    });
    const res = await call(taskAssign, target, target.member, {
      task_id: task.id,
      assignee_user_id: target.bystander.userId,
    });
    expect(res.status).toBe(404);
    expect(await partyOf(target, epic.id)).toEqual([]);
  });
});

describe('epic-detail の can_join と joined', () => {
  async function detailOf(target: Target, epicId: string, person: Person) {
    const res = await call(epicDetail, target, person, { epic_id: epicId });
    expect(res.status).toBe(200);
    return (await res.json()) as { can_join: boolean; joined: boolean };
  }

  test('今所属している人は can_join が真。討伐隊にいれば joined が真', async () => {
    const target = await namedTarget();
    const epic = await epicOf(target);
    expect(await detailOf(target, epic.id, target.member)).toMatchObject({ can_join: true, joined: false });
    expect((await join(target, epic.id)).status).toBe(200);
    expect(await detailOf(target, epic.id, target.member)).toMatchObject({ can_join: true, joined: true });
    expect(await detailOf(target, epic.id, target.leader)).toMatchObject({ can_join: true, joined: false });
  });

  test('所属していない管理者は can_join が偽', async () => {
    const target = await namedTarget();
    const epic = await epicOf(target);
    expect(await detailOf(target, epic.id, target.admin)).toMatchObject({ can_join: false, joined: false });
  });
});
