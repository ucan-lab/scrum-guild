// クリア報酬の段階の変更（epic-reward-update）と、依頼主の変更（epic-requester-update）、epic-detail の can_change_requester の振る舞い。
// 組織の分離と権限の種類ごとの許可と拒否は、一覧を回す test/operation-registry.test.ts が確かめる
import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import { XP_EPIC_REWARD } from '../src/shared/experience.ts';
import { epicDetail, epicRequesterUpdate, epicRewardUpdate, epicUpdate } from '../src/shared/operations/epic/index.ts';
import type { AnyOperationDefinition } from '../src/shared/operations/define.ts';
import { createApp } from '../src/server/app.ts';
import { orgDb, verifyWorkspace, type OrganizationDb } from '../src/server/db/index.ts';
import { epicRequesterUpdateOperation, epicRewardUpdateOperation } from '../src/server/operations/epic-reward.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import { AT, createEpic, createEpicPartyMember, createMembership, createUser, hash64 } from './factories.ts';
import { errorCodeOf, post } from './operations/harness.ts';
import { createPerson, createTarget, testEnv, type Person, type Target } from './operations/world.ts';

const app = createApp(implementedOperations);

function call(definition: AnyOperationDefinition, target: Target, person: Person, body: Record<string, unknown>) {
  return post(app, definition, {
    slug: target.slug,
    token: person.token,
    body: { workspace_id: target.workspace.id, ...body },
    env: testEnv,
  });
}

const reward = (target: Target, epicId: string, tier: string, person: Person = target.leader) =>
  call(epicRewardUpdate, target, person, { epic_id: epicId, reward_tier: tier });
const requester = (target: Target, epicId: string, userId: string, person: Person = target.leader) =>
  call(epicRequesterUpdate, target, person, { epic_id: epicId, user_id: userId });

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

// 名前で見分けられるように、メンバーとリーダーと管理者に別の名前を付けた対象
async function namedTarget(options: { closed?: boolean } = {}) {
  const target = await createTarget(options);
  await rename(target, target.member, '若葉 湊');
  await rename(target, target.leader, '朝霧 楓');
  await rename(target, target.admin, '白波 渚');
  return target;
}

function epicOf(target: Target, overrides: Parameters<typeof createEpic>[3] = {}) {
  return createEpic(target.organization, target.workspace.id, target.admin.userId!, overrides);
}

async function rowOf(target: Target, epicId: string) {
  const db = orgDb(env, target.organization.verified);
  const row = await db.first(
    db.statement((q) =>
      q
        .selectFrom('epics')
        .select(['reward_tier', 'requester_user_id', 'updated_at'])
        .where('id', '=', epicId)
        .where('workspace_id', '=', target.workspace.id),
    ),
  );
  return row!;
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

async function partyIdsOf(target: Target, epicId: string) {
  const db = orgDb(env, target.organization.verified);
  const rows = await db.rows(
    db.statement((q) =>
      q.selectFrom('epic_party_members').select('user_id').where('epic_id', '=', epicId).orderBy('user_id'),
    ),
  );
  return rows.map((row) => row.user_id);
}

const finishedEpics = {
  クリア: { completed_at: '2026-10-22T00:00:00.000Z' },
  中止: { canceled_at: '2026-10-22T00:00:00.000Z' },
} as const;

function finishedOverrides(label: string, target: Target) {
  const overrides = finishedEpics[label as keyof typeof finishedEpics];
  return { ...overrides, [label === 'クリア' ? 'completed_by' : 'canceled_by']: target.admin.userId! };
}

async function expectError(res: Response, status: number, code: string) {
  expect(res.status).toBe(status);
  expect(await errorCodeOf(res)).toBe(code);
}

// 書く文の batch() の直前に、別の要求が先に書いた、という状態を作って処理を直に呼ぶ。
// 読み取りは db.first（batch() を通らない）なので、処理が呼ぶ最初の batch() が書く文になる。before は何回目の書き込みかを受ける
async function runRacing(
  operation: typeof epicRewardUpdateOperation | typeof epicRequesterUpdateOperation,
  target: Target,
  person: Person,
  input: Record<string, unknown>,
  before: (attempt: number, db: OrganizationDb) => Promise<void>,
) {
  const db = orgDb(env, target.organization.verified);
  const actor = { accountId: person.accountId, userId: person.userId, isAdmin: false, invitedOnly: false };
  const workspace = await verifyWorkspace(db, actor, target.workspace.id);
  let attempts = 0;
  const racing = new Proxy(db, {
    get(base, key) {
      const value = Reflect.get(base, key, base);
      if (typeof value !== 'function') return value;
      if (key !== 'batch') return value.bind(base);
      return async (...args: unknown[]) => {
        await before(attempts++, db);
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

function setEpic(db: OrganizationDb, target: Target, epicId: string, set: Record<string, unknown>) {
  return db.run(
    db.statement((q) =>
      q.updateTable('epics').set(set).where('id', '=', epicId).where('workspace_id', '=', target.workspace.id),
    ),
  );
}

describe('epic-reward-update', () => {
  test('リーダーは段階を変えられ、額と、前後の段階を履歴に残す。updated_at も更新する', async () => {
    const target = await namedTarget();
    const epic = await epicOf(target);
    const res = await reward(target, epic.id, 'large');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ changed: true, reward_tier: 'large', reward_xp: XP_EPIC_REWARD.large });
    const row = await rowOf(target, epic.id);
    expect(row.reward_tier).toBe('large');
    expect(row.updated_at).not.toBe(AT);
    expect(await epicLogsOf(target, epic.id)).toEqual([
      {
        actor: target.leader.userId,
        action: 'update',
        workspace_id: target.workspace.id,
        changes: { reward_tier: ['small', 'large'] },
      },
    ]);
  });

  test('依頼主は一般のメンバーでも変えられる。管理者も変えられる', async () => {
    const target = await namedTarget();
    const epic = await epicOf(target, { requester_user_id: target.member.userId! });
    expect((await reward(target, epic.id, 'medium', target.member)).status).toBe(200);
    expect((await rowOf(target, epic.id)).reward_tier).toBe('medium');
    expect((await reward(target, epic.id, 'small', target.admin)).status).toBe(200);
    expect((await epicLogsOf(target, epic.id)).map((log) => [log.actor, log.changes])).toEqual([
      [target.member.userId, { reward_tier: ['small', 'medium'] }],
      [target.admin.userId, { reward_tier: ['medium', 'small'] }],
    ]);
  });

  test('依頼主でもリーダーでもない一般のメンバーは 403 の forbidden で、何も書かない', async () => {
    const target = await namedTarget();
    const epic = await epicOf(target);
    await expectError(await reward(target, epic.id, 'large', target.member), 403, 'forbidden');
    expect((await rowOf(target, epic.id)).reward_tier).toBe('small');
    expect(await epicLogsOf(target, epic.id)).toEqual([]);
  });

  test('依頼主が離れたレイドでも、リーダーは変えられる', async () => {
    const target = await namedTarget();
    const gone = await createUser(target.organization, { name: '離れた 人' });
    await createMembership(target.organization, target.workspace.id, gone.id, { left_at: AT, left_on: '2026-10-20' });
    const epic = await epicOf(target, { requester_user_id: gone.id });
    expect((await reward(target, epic.id, 'large')).status).toBe(200);
    expect((await rowOf(target, epic.id)).reward_tier).toBe('large');
  });

  test('今と同じ段階は 200 の changed: false で、何も書かず、履歴も残さない', async () => {
    const target = await namedTarget();
    const epic = await epicOf(target);
    const res = await reward(target, epic.id, 'small');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ changed: false, reward_tier: 'small', reward_xp: XP_EPIC_REWARD.small });
    expect((await rowOf(target, epic.id)).updated_at).toBe(AT);
    expect(await epicLogsOf(target, epic.id)).toEqual([]);
  });

  test('段階の値が列挙に無ければ 400', async () => {
    const target = await namedTarget();
    const epic = await epicOf(target);
    await expectError(await reward(target, epic.id, 'huge'), 400, 'invalid_input');
  });

  for (const label of Object.keys(finishedEpics)) {
    test(`${label}したエピックの段階は変えられない（409 の conflict）`, async () => {
      const target = await namedTarget();
      const epic = await epicOf(target, finishedOverrides(label, target));
      await expectError(await reward(target, epic.id, 'large'), 409, 'conflict');
      // 同じ段階でも、終わったエピックは 409
      await expectError(await reward(target, epic.id, 'small'), 409, 'conflict');
      expect((await rowOf(target, epic.id)).reward_tier).toBe('small');
      expect(await epicLogsOf(target, epic.id)).toEqual([]);
    });
  }

  test('別の組織・別のワークスペース・削除済み・存在しないエピックは 404', async () => {
    const target = await namedTarget();
    const foreign = await createTarget();
    const ids = [
      (await createEpic(foreign.organization, foreign.workspace.id, foreign.admin.userId!)).id,
      (await createEpic(target.organization, target.otherWorkspace.id, target.admin.userId!)).id,
      (await epicOf(target, { deleted_at: '2026-10-21T00:00:00.000Z' })).id,
      '019a0000-0000-7000-8000-00000000ffff',
    ];
    for (const id of ids) await expectError(await reward(target, id, 'large'), 404, 'not_found');
    // 別のワークスペースのエピックは書き換わっていない
    const db = orgDb(env, target.organization.verified);
    const other = await db.first(
      db.statement((q) => q.selectFrom('epics').select('reward_tier').where('id', '=', ids[1]!)),
    );
    expect(other?.reward_tier).toBe('small');
  });

  test('閉じたワークスペースは 409 の workspace_closed', async () => {
    const target = await namedTarget({ closed: true });
    const epic = await epicOf(target);
    await expectError(await reward(target, epic.id, 'large'), 409, 'workspace_closed');
    await expectError(await reward(target, epic.id, 'small'), 409, 'workspace_closed');
  });

  test('2つの画面から同時に同じ段階へ変えても、変わるのは1回で、履歴も1つ', async () => {
    const target = await namedTarget();
    const epic = await epicOf(target);
    const results = await Promise.all([
      reward(target, epic.id, 'large'),
      reward(target, epic.id, 'large'),
      reward(target, epic.id, 'large'),
    ]);
    for (const res of results) expect(res.status).toBe(200);
    const changed = await Promise.all(results.map(async (res) => ((await res.json()) as { changed: boolean }).changed));
    expect(changed.filter(Boolean)).toHaveLength(1);
    expect(await epicLogsOf(target, epic.id)).toHaveLength(1);
  });

  test('読んだ後に別の要求が先に段階を変えたら、読み直して、変えた後の段階から書く', async () => {
    const target = await namedTarget();
    const epic = await epicOf(target);
    const result = await runRacing(
      epicRewardUpdateOperation,
      target,
      target.leader,
      { epic_id: epic.id, reward_tier: 'large' },
      async (attempt, db) => {
        if (attempt === 0) await setEpic(db, target, epic.id, { reward_tier: 'medium' });
      },
    );
    expect(result).toEqual({ changed: true, reward_tier: 'large', reward_xp: XP_EPIC_REWARD.large });
    expect((await rowOf(target, epic.id)).reward_tier).toBe('large');
    expect((await epicLogsOf(target, epic.id)).map((log) => log.changes)).toEqual([
      { reward_tier: ['medium', 'large'] },
    ]);
  });

  test('読んだ後に別の要求が先に同じ段階へ変えたら、何も書かずに changed: false', async () => {
    const target = await namedTarget();
    const epic = await epicOf(target);
    const result = await runRacing(
      epicRewardUpdateOperation,
      target,
      target.leader,
      { epic_id: epic.id, reward_tier: 'large' },
      async (attempt, db) => {
        if (attempt === 0) await setEpic(db, target, epic.id, { reward_tier: 'large' });
      },
    );
    expect(result).toMatchObject({ changed: false, reward_tier: 'large' });
    expect(await epicLogsOf(target, epic.id)).toEqual([]);
  });

  test('負け続けたら 3 回で諦めて 409 の conflict', async () => {
    const target = await namedTarget();
    const epic = await epicOf(target);
    await expect(
      runRacing(
        epicRewardUpdateOperation,
        target,
        target.leader,
        { epic_id: epic.id, reward_tier: 'large' },
        async (attempt, db) => {
          await setEpic(db, target, epic.id, { reward_tier: attempt % 2 === 0 ? 'medium' : 'small' });
        },
      ),
    ).rejects.toMatchObject({ status: 409, code: 'conflict' });
    expect(await epicLogsOf(target, epic.id)).toEqual([]);
  });

  test('読んだ後に依頼主が替わったら、書く文の条件で止まり、読み直して 403 で何も書かない', async () => {
    const target = await namedTarget();
    const epic = await epicOf(target, { requester_user_id: target.member.userId! });
    await expect(
      runRacing(
        epicRewardUpdateOperation,
        target,
        target.member,
        { epic_id: epic.id, reward_tier: 'large' },
        async (attempt, db) => {
          if (attempt === 0) await setEpic(db, target, epic.id, { requester_user_id: target.leader.userId! });
        },
      ),
    ).rejects.toMatchObject({ status: 403, code: 'forbidden' });
    expect((await rowOf(target, epic.id)).reward_tier).toBe('small');
    expect(await epicLogsOf(target, epic.id)).toEqual([]);
  });

  test('読んだ後にエピックがクリアされたら、書く文の条件で止まり、読み直して 409', async () => {
    const target = await namedTarget();
    const epic = await epicOf(target);
    await expect(
      runRacing(
        epicRewardUpdateOperation,
        target,
        target.leader,
        { epic_id: epic.id, reward_tier: 'large' },
        async (attempt, db) => {
          if (attempt === 0)
            await setEpic(db, target, epic.id, { completed_at: AT, completed_by: target.admin.userId! });
        },
      ),
    ).rejects.toMatchObject({ status: 409, code: 'conflict' });
    expect((await rowOf(target, epic.id)).reward_tier).toBe('small');
  });

  test('epic-update の変更とは独立で、タイトルを直しても段階は変わらない', async () => {
    const target = await namedTarget();
    const epic = await epicOf(target, { reward_tier: 'large' });
    const res = await call(epicUpdate, target, target.leader, { epic_id: epic.id, title: '見直した' });
    expect(res.status).toBe(200);
    expect((await rowOf(target, epic.id)).reward_tier).toBe('large');
  });
});

describe('epic-requester-update', () => {
  test('リーダーは今所属している人に替えられ、前後の依頼主の名前を履歴に残す。updated_at も更新する', async () => {
    const target = await namedTarget();
    const epic = await epicOf(target);
    const res = await requester(target, epic.id, target.member.userId!);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      changed: true,
      requester: { id: target.member.userId, name: '若葉 湊', left: false },
    });
    const row = await rowOf(target, epic.id);
    expect(row.requester_user_id).toBe(target.member.userId);
    expect(row.updated_at).not.toBe(AT);
    expect(await epicLogsOf(target, epic.id)).toEqual([
      {
        actor: target.leader.userId,
        action: 'update',
        workspace_id: target.workspace.id,
        changes: {
          requester: [
            { id: target.admin.userId, name: '白波 渚' },
            { id: target.member.userId, name: '若葉 湊' },
          ],
        },
      },
    ]);
  });

  test('管理者（ワークスペースに所属していなくても）も替えられる', async () => {
    const target = await namedTarget();
    const epic = await epicOf(target, { requester_user_id: target.member.userId! });
    expect((await requester(target, epic.id, target.leader.userId!, target.admin)).status).toBe(200);
    expect((await rowOf(target, epic.id)).requester_user_id).toBe(target.leader.userId);
  });

  test('依頼主本人も、一般のメンバーも、所属していない人も 403 の forbidden で、何も書かない', async () => {
    const target = await namedTarget();
    const epic = await epicOf(target, { requester_user_id: target.member.userId! });
    for (const person of [target.member, target.bystander]) {
      await expectError(await requester(target, epic.id, target.leader.userId!, person), 403, 'forbidden');
    }
    expect((await rowOf(target, epic.id)).requester_user_id).toBe(target.member.userId);
    expect(await epicLogsOf(target, epic.id)).toEqual([]);
  });

  test('討伐隊は自動で変えない。新しい依頼主を加えず、前の依頼主も外さない', async () => {
    const target = await namedTarget();
    const epic = await epicOf(target, { requester_user_id: target.leader.userId! });
    await createEpicPartyMember(target.organization, epic.id, target.leader.userId!);
    expect((await requester(target, epic.id, target.member.userId!)).status).toBe(200);
    expect(await partyIdsOf(target, epic.id)).toEqual([target.leader.userId]);
  });

  test('依頼主が離れたレイドで、リーダーは依頼主を替えられる', async () => {
    const target = await namedTarget();
    const gone = await createUser(target.organization, { name: '離れた 人' });
    await createMembership(target.organization, target.workspace.id, gone.id, { left_at: AT, left_on: '2026-10-20' });
    const epic = await epicOf(target, { requester_user_id: gone.id });
    expect((await requester(target, epic.id, target.member.userId!)).status).toBe(200);
    expect((await rowOf(target, epic.id)).requester_user_id).toBe(target.member.userId);
    expect((await epicLogsOf(target, epic.id)).map((log) => log.changes)).toEqual([
      {
        requester: [
          { id: gone.id, name: '離れた 人' },
          { id: target.member.userId, name: '若葉 湊' },
        ],
      },
    ]);
  });

  test('今と同じ依頼主は 200 の changed: false で、何も書かず、履歴も残さない', async () => {
    const target = await namedTarget();
    const epic = await epicOf(target, { requester_user_id: target.member.userId! });
    const res = await requester(target, epic.id, target.member.userId!);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      changed: false,
      requester: { id: target.member.userId, name: '若葉 湊', left: false },
    });
    expect((await rowOf(target, epic.id)).updated_at).toBe(AT);
    expect(await epicLogsOf(target, epic.id)).toEqual([]);
  });

  test('所属していない管理者が依頼主のレイドで、その管理者を替え先にすると 404', async () => {
    const target = await namedTarget();
    const epic = await epicOf(target);
    await expectError(await requester(target, epic.id, target.admin.userId!), 404, 'not_found');
  });

  test('所属していない人、抜けた人、無効の人、login_subject の無い人、別の組織の人は 404', async () => {
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
      gone.id,
      disabled.userId!,
      pending.id,
      foreign.member.userId!,
      '019a0000-0000-7000-8000-00000000ffff',
    ];
    for (const id of ids) await expectError(await requester(target, epic.id, id), 404, 'not_found');
    expect((await rowOf(target, epic.id)).requester_user_id).toBe(target.admin.userId);
    expect(await epicLogsOf(target, epic.id)).toEqual([]);
  });

  for (const label of Object.keys(finishedEpics)) {
    test(`${label}したエピックの依頼主は替えられない（409 の conflict）`, async () => {
      const target = await namedTarget();
      const epic = await epicOf(target, finishedOverrides(label, target));
      await expectError(await requester(target, epic.id, target.member.userId!), 409, 'conflict');
      expect((await rowOf(target, epic.id)).requester_user_id).toBe(target.admin.userId);
      expect(await epicLogsOf(target, epic.id)).toEqual([]);
    });
  }

  test('別の組織・別のワークスペース・削除済み・存在しないエピックは 404', async () => {
    const target = await namedTarget();
    const foreign = await createTarget();
    const ids = [
      (await createEpic(foreign.organization, foreign.workspace.id, foreign.admin.userId!)).id,
      (await createEpic(target.organization, target.otherWorkspace.id, target.admin.userId!)).id,
      (await epicOf(target, { deleted_at: '2026-10-21T00:00:00.000Z' })).id,
      '019a0000-0000-7000-8000-00000000ffff',
    ];
    for (const id of ids) await expectError(await requester(target, id, target.member.userId!), 404, 'not_found');
  });

  test('閉じたワークスペースは 409 の workspace_closed', async () => {
    const target = await namedTarget({ closed: true });
    const epic = await epicOf(target);
    await expectError(await requester(target, epic.id, target.member.userId!), 409, 'workspace_closed');
  });

  test('読んだ後に別の要求が先に依頼主を替えたら、読み直して、替えた後の依頼主から書く', async () => {
    const target = await namedTarget();
    const epic = await epicOf(target);
    const result = await runRacing(
      epicRequesterUpdateOperation,
      target,
      target.leader,
      { epic_id: epic.id, user_id: target.member.userId! },
      async (attempt, db) => {
        if (attempt === 0) await setEpic(db, target, epic.id, { requester_user_id: target.leader.userId! });
      },
    );
    expect(result).toEqual({
      changed: true,
      requester: { id: target.member.userId, name: '若葉 湊', left: false },
    });
    expect((await rowOf(target, epic.id)).requester_user_id).toBe(target.member.userId);
    expect((await epicLogsOf(target, epic.id)).map((log) => log.changes)).toEqual([
      {
        requester: [
          { id: target.leader.userId, name: '朝霧 楓' },
          { id: target.member.userId, name: '若葉 湊' },
        ],
      },
    ]);
  });

  test('読んだ後に替え先が所属を外れたら、書く文の条件で止まり、読み直して 404', async () => {
    const target = await namedTarget();
    const epic = await epicOf(target);
    await expect(
      runRacing(
        epicRequesterUpdateOperation,
        target,
        target.leader,
        { epic_id: epic.id, user_id: target.member.userId! },
        async (attempt, db) => {
          if (attempt !== 0) return;
          await db.run(
            db.statement((q) =>
              q
                .updateTable('memberships')
                .set({ left_at: AT, left_on: '2026-10-20' })
                .where('workspace_id', '=', target.workspace.id)
                .where('user_id', '=', target.member.userId!),
            ),
          );
        },
      ),
    ).rejects.toMatchObject({ status: 404, code: 'not_found' });
    expect((await rowOf(target, epic.id)).requester_user_id).toBe(target.admin.userId);
    expect(await epicLogsOf(target, epic.id)).toEqual([]);
  });

  test('負け続けたら 3 回で諦めて 409 の conflict', async () => {
    const target = await namedTarget();
    const epic = await epicOf(target);
    const others = [target.leader.userId!, target.admin.userId!];
    await expect(
      runRacing(
        epicRequesterUpdateOperation,
        target,
        target.leader,
        { epic_id: epic.id, user_id: target.member.userId! },
        async (attempt, db) => {
          await setEpic(db, target, epic.id, { requester_user_id: others[attempt % 2]! });
        },
      ),
    ).rejects.toMatchObject({ status: 409, code: 'conflict' });
    expect(await epicLogsOf(target, epic.id)).toEqual([]);
  });
});

describe('epic-detail の can_change_requester', () => {
  async function detailOf(target: Target, epicId: string, person: Person) {
    const res = await call(epicDetail, target, person, { epic_id: epicId });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { can_manage: boolean; can_change_requester: boolean };
    return { can_manage: body.can_manage, can_change_requester: body.can_change_requester };
  }

  test('リーダーと管理者は真。依頼主の一般のメンバーは can_manage だけ真', async () => {
    const target = await namedTarget();
    const epic = await epicOf(target, { requester_user_id: target.member.userId! });
    expect(await detailOf(target, epic.id, target.leader)).toEqual({ can_manage: true, can_change_requester: true });
    expect(await detailOf(target, epic.id, target.admin)).toEqual({ can_manage: true, can_change_requester: true });
    expect(await detailOf(target, epic.id, target.member)).toEqual({ can_manage: true, can_change_requester: false });
  });

  test('依頼主でもリーダーでもない一般のメンバーはどちらも偽', async () => {
    const target = await namedTarget();
    const epic = await epicOf(target);
    expect(await detailOf(target, epic.id, target.member)).toEqual({ can_manage: false, can_change_requester: false });
  });

  test('替えた後の epic-detail は、新しい依頼主と段階と額を返す', async () => {
    const target = await namedTarget();
    const epic = await epicOf(target);
    expect((await requester(target, epic.id, target.member.userId!)).status).toBe(200);
    expect((await reward(target, epic.id, 'large')).status).toBe(200);
    const res = await call(epicDetail, target, target.leader, { epic_id: epic.id });
    expect(await res.json()).toMatchObject({
      requester: { id: target.member.userId, name: '若葉 湊', left: false },
      reward_tier: 'large',
      reward_xp: XP_EPIC_REWARD.large,
    });
  });
});
