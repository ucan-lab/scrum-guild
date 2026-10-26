// ストーリーの完了と取り消しの振る舞い（経験値の付与と打ち消し、競合、変更の履歴）。
// 組織の分離と権限の種類ごとの許可と拒否は、一覧を回す test/operation-registry.test.ts が確かめる
import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import { XP_STORY_COMPLETED } from '../src/shared/experience.ts';
import { storyComplete, storyReopen } from '../src/shared/operations/story/index.ts';
import { taskComplete } from '../src/shared/operations/task/index.ts';
import { createApp } from '../src/server/app.ts';
import { orgDb } from '../src/server/db/index.ts';
import { envWithD1Hooks } from '../src/server/db/testing.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import { AT, createEpic, createMembership, createStory, createTask, createUser, uuidv7 } from './factories.ts';
import { errorCodeOf, post } from './operations/harness.ts';
import { createTarget, testEnv, type Person, type Target } from './operations/world.ts';

const app = createApp(implementedOperations);

// 開発用の時計（DEV_NOW）で時刻を止めた、ループバックの公開 URL の環境
function clockAt(devNow: string): Env {
  return Object.assign({}, testEnv, { PUBLIC_ORIGIN: 'http://localhost:8787', DEV_NOW: devNow });
}

function complete(target: Target, storyId: string, person: Person = target.member, requestEnv: Env = testEnv) {
  return post(app, storyComplete, {
    slug: target.slug,
    token: person.token,
    body: { workspace_id: target.workspace.id, story_id: storyId },
    env: requestEnv,
  });
}

function reopen(target: Target, storyId: string, person: Person = target.member, requestEnv: Env = testEnv) {
  return post(app, storyReopen, {
    slug: target.slug,
    token: person.token,
    body: { workspace_id: target.workspace.id, story_id: storyId },
    env: requestEnv,
  });
}

async function errorOf(res: Response) {
  const body = (await res.json()) as { error: { code: string; details?: { reason?: string } } };
  return { code: body.error.code, reason: body.error.details?.reason };
}

// 読んでから書くまでに別の要求が割り込んだ状況を作る。match に当たる batch() が答えた直後に、一度だけ change を流す
function racing(match: (sqls: readonly string[]) => boolean, change: () => Promise<void>): Env {
  let done = false;
  return envWithD1Hooks(testEnv, {
    afterBatch: async (sqls) => {
      if (done || !match(sqls)) return;
      done = true;
      await change();
    },
  });
}

// 完了にする前の状態の読み取り（ストーリー、未完了の件数、受け取り手）
const readsCompletion = (sqls: readonly string[]) =>
  sqls[0]?.startsWith(
    'select "stories"."id", "stories"."completed_at", "epics"."completed_at" as "epic_completed_at"',
  ) === true;

async function storyRow(target: Target, storyId: string) {
  const db = orgDb(env, target.organization.verified);
  return db.first(
    db.statement((q) =>
      q.selectFrom('stories').selectAll().where('id', '=', storyId).where('workspace_id', '=', target.workspace.id),
    ),
  );
}

async function storyGrants(target: Target, storyId: string) {
  const db = orgDb(env, target.organization.verified);
  return db.rows(
    db.statement((q) =>
      q
        .selectFrom('xp_grants')
        .selectAll()
        .where('story_id', '=', storyId)
        .where('workspace_id', '=', target.workspace.id)
        .orderBy('confirmed_at')
        .orderBy('id'),
    ),
  );
}

// 受け取った人ごとの合計
async function balances(target: Target, storyId: string) {
  const totals: Record<string, number> = {};
  for (const grant of await storyGrants(target, storyId)) {
    totals[grant.user_id] = (totals[grant.user_id] ?? 0) + grant.amount;
  }
  return totals;
}

async function logsOf(target: Target, storyId: string) {
  const db = orgDb(env, target.organization.verified);
  return db.rows(
    db.statement((q) =>
      q
        .selectFrom('change_logs')
        .selectAll()
        .where('entity_type', '=', 'story')
        .where('entity_id', '=', storyId)
        .where('organization_id', '=', target.organization.id)
        .orderBy('created_at')
        .orderBy('id'),
    ),
  );
}

// 完了したタスクと、その完了の経験値（task_completed）。打ち消しの行も足せる
async function completedTask(target: Target, storyId: string, userId: string, options: { deleted?: boolean } = {}) {
  const task = await createTask(target.organization, target.workspace.id, target.admin.userId!, {
    story_id: storyId,
    points: 3,
    assignee_user_id: userId,
    completed_at: AT,
    completed_by: userId,
    deleted_at: options.deleted ? AT : null,
  });
  const grantId = await insertGrant(target, { user_id: userId, task_id: task.id, amount: 30 });
  return { task, grantId };
}

async function insertGrant(
  target: Target,
  values: { user_id: string; task_id: string; amount: number; reverses_grant_id?: string },
) {
  const db = orgDb(env, target.organization.verified);
  const id = uuidv7();
  await db.run(
    db.statement((q) =>
      q.insertInto('xp_grants').values({
        id,
        workspace_id: target.workspace.id,
        user_id: values.user_id,
        action: 'task_completed',
        task_id: values.task_id,
        story_id: null,
        epic_id: null,
        completion_id: uuidv7(),
        thank_id: null,
        helper_sender_user_id: null,
        amount: values.amount,
        reverses_grant_id: values.reverses_grant_id ?? null,
        dedupe_key:
          values.reverses_grant_id === undefined ? `task_completed:${id}` : `reversal:${values.reverses_grant_id}`,
        confirmed_at: AT,
      }),
    ),
  );
  return id;
}

// このワークスペースに今所属する人（ほかの値は factories の既定）
async function newMember(target: Target, overrides: { left?: boolean } = {}) {
  const user = await createUser(target.organization, { name: '若葉 律' });
  await createMembership(
    target.organization,
    target.workspace.id,
    user.id,
    overrides.left ? { left_on: '2026-10-20', left_at: AT } : {},
  );
  return user.id;
}

function emptyStory(target: Target, overrides: Parameters<typeof createStory>[3] = {}) {
  return createStory(target.organization, target.workspace.id, target.admin.userId!, overrides);
}

describe('story-complete', () => {
  test('配下のタスクで完了の経験値を受け取った人に、1人1回ずつ経験値を付け、変更の履歴を残す', async () => {
    const target = await createTarget();
    const story = await emptyStory(target);
    const member = target.member.userId!;
    const leader = target.leader.userId!;
    // ハルカは2件のタスクで受け取っていても1回
    await completedTask(target, story.id, member);
    await completedTask(target, story.id, member);
    await completedTask(target, story.id, leader);
    // 所属を外れた人、打ち消された付与、削除したタスクの付与は数えない
    await completedTask(target, story.id, await newMember(target, { left: true }));
    const reversed = await newMember(target);
    const { task, grantId } = await completedTask(target, story.id, reversed);
    await insertGrant(target, { user_id: reversed, task_id: task.id, amount: -30, reverses_grant_id: grantId });
    await completedTask(target, story.id, await newMember(target), { deleted: true });
    // 別のストーリーの付与も数えない
    const other = await emptyStory(target);
    await completedTask(target, other.id, await newMember(target));

    const res = await complete(target, story.id);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { story_id: string; completed_at: string };
    expect(body.story_id).toBe(story.id);
    expect(await storyRow(target, story.id)).toMatchObject({
      completed_at: body.completed_at,
      completed_by: member,
      updated_at: body.completed_at,
    });

    const grants = await storyGrants(target, story.id);
    expect(grants.map((grant) => grant.user_id).sort()).toEqual([member, leader].sort());
    for (const grant of grants) {
      expect(grant).toMatchObject({
        action: 'story_completed',
        amount: XP_STORY_COMPLETED,
        task_id: null,
        reverses_grant_id: null,
        confirmed_at: body.completed_at,
        dedupe_key: `story_completed:${story.id}:${grant.user_id}:${body.completed_at}`,
      });
    }

    const logs = await logsOf(target, story.id);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ action: 'complete', actor_user_id: member, created_at: body.completed_at });
    expect(JSON.parse(logs[0]!.changes_json)).toEqual({
      completed_at: [null, body.completed_at],
      completed_by: [null, { id: member, name: '星野 澪' }],
    });
  });

  test('タスクの完了の操作で付いた経験値の受け取り手に付く（担当のいないタスクは完了にした人）', async () => {
    const target = await createTarget();
    const story = await emptyStory(target);
    const assigned = await createTask(target.organization, target.workspace.id, target.admin.userId!, {
      story_id: story.id,
      points: 2,
      assignee_user_id: target.leader.userId,
    });
    const unassigned = await createTask(target.organization, target.workspace.id, target.admin.userId!, {
      story_id: story.id,
      points: 1,
    });
    for (const task of [assigned, unassigned]) {
      const res = await post(app, taskComplete, {
        slug: target.slug,
        token: target.member.token,
        body: { workspace_id: target.workspace.id, task_id: task.id },
      });
      expect(res.status).toBe(200);
    }
    expect((await complete(target, story.id)).status).toBe(200);
    expect(await balances(target, story.id)).toEqual({
      [target.leader.userId!]: XP_STORY_COMPLETED,
      [target.member.userId!]: XP_STORY_COMPLETED,
    });
  });

  test('配下にタスクが1件も無いストーリーも完了にでき、経験値は誰にも付かない', async () => {
    const target = await createTarget();
    const story = await emptyStory(target);
    expect((await complete(target, story.id)).status).toBe(200);
    expect((await storyRow(target, story.id))!.completed_at).not.toBeNull();
    expect(await storyGrants(target, story.id)).toEqual([]);
    expect(await logsOf(target, story.id)).toHaveLength(1);
  });

  test('配下に未完了のタスクが残っていれば 409 の conflict（open_tasks）で、何も書かない', async () => {
    const target = await createTarget();
    const story = await emptyStory(target);
    await completedTask(target, story.id, target.member.userId!);
    await createTask(target.organization, target.workspace.id, target.admin.userId!, { story_id: story.id });
    const res = await complete(target, story.id);
    expect(res.status).toBe(409);
    expect(await errorOf(res)).toEqual({ code: 'conflict', reason: 'open_tasks' });
    expect((await storyRow(target, story.id))!.completed_at).toBeNull();
    expect(await storyGrants(target, story.id)).toEqual([]);
    expect(await logsOf(target, story.id)).toEqual([]);
  });

  test('削除した未完了のタスクと、別のストーリーの未完了のタスクは、残りに数えない', async () => {
    const target = await createTarget();
    const story = await emptyStory(target);
    const other = await emptyStory(target);
    await createTask(target.organization, target.workspace.id, target.admin.userId!, {
      story_id: story.id,
      deleted_at: AT,
    });
    await createTask(target.organization, target.workspace.id, target.admin.userId!, { story_id: other.id });
    expect((await complete(target, story.id)).status).toBe(200);
  });

  test('親のエピックが完了か中止していれば 409 の conflict（parent_completed）で、何も書かない', async () => {
    const target = await createTarget();
    const adminId = target.admin.userId!;
    for (const overrides of [
      { completed_at: AT, completed_by: adminId },
      { canceled_at: AT, canceled_by: adminId },
    ]) {
      const epic = await createEpic(target.organization, target.workspace.id, adminId, overrides);
      const story = await emptyStory(target, { epic_id: epic.id });
      await completedTask(target, story.id, target.member.userId!);
      const res = await complete(target, story.id);
      expect(res.status).toBe(409);
      expect(await errorOf(res)).toEqual({ code: 'conflict', reason: 'parent_completed' });
      expect((await storyRow(target, story.id))!.completed_at).toBeNull();
      expect(await storyGrants(target, story.id)).toEqual([]);
      expect(await logsOf(target, story.id)).toEqual([]);
    }
    // 開いているエピックの下と、削除したエピックの下なら完了にできる
    for (const overrides of [{}, { completed_at: AT, completed_by: adminId, deleted_at: AT }]) {
      const epic = await createEpic(target.organization, target.workspace.id, adminId, overrides);
      const story = await emptyStory(target, { epic_id: epic.id });
      expect((await complete(target, story.id)).status).toBe(200);
    }
  });

  test('読んでから書くまでに親のエピックが完了したら、何も書かず 409 の conflict（parent_completed）', async () => {
    const target = await createTarget();
    const adminId = target.admin.userId!;
    const epic = await createEpic(target.organization, target.workspace.id, adminId);
    const story = await emptyStory(target, { epic_id: epic.id });
    const raced = racing(readsCompletion, async () => {
      const db = orgDb(env, target.organization.verified);
      await db.run(
        db.statement((q) =>
          q
            .updateTable('epics')
            .set({ completed_at: AT, completed_by: adminId })
            .where('id', '=', epic.id)
            .where('workspace_id', '=', target.workspace.id),
        ),
      );
    });
    const res = await complete(target, story.id, target.member, raced);
    expect(res.status).toBe(409);
    expect(await errorOf(res)).toEqual({ code: 'conflict', reason: 'parent_completed' });
    expect((await storyRow(target, story.id))!.completed_at).toBeNull();
    expect(await logsOf(target, story.id)).toEqual([]);
  });

  test('すでに完了していれば 409 の conflict（completed）', async () => {
    const target = await createTarget();
    const story = await emptyStory(target, { completed_at: AT, completed_by: target.admin.userId! });
    const res = await complete(target, story.id);
    expect(res.status).toBe(409);
    expect(await errorOf(res)).toEqual({ code: 'conflict', reason: 'completed' });
  });

  test('2つの画面から同時に完了にすると、片方は 409 の conflict で、記録と経験値は1回分', async () => {
    const target = await createTarget();
    const story = await emptyStory(target);
    await completedTask(target, story.id, target.member.userId!);
    await completedTask(target, story.id, target.leader.userId!);
    // 1つ目の要求が読んだ直後に、2つ目の要求が先に完了にする
    let second: Response | undefined;
    const raced = racing(readsCompletion, async () => {
      second = await complete(target, story.id, target.leader);
    });
    const first = await complete(target, story.id, target.member, raced);
    expect(second?.status).toBe(200);
    expect(first.status).toBe(409);
    expect(await errorOf(first)).toEqual({ code: 'conflict', reason: 'completed' });
    expect((await storyRow(target, story.id))!.completed_by).toBe(target.leader.userId);
    expect(await storyGrants(target, story.id)).toHaveLength(2);
    expect(await logsOf(target, story.id)).toHaveLength(1);
  });

  test('止めた時計で同じ人が2回完了にしても、記録と経験値は1回分', async () => {
    const target = await createTarget();
    const story = await emptyStory(target);
    await completedTask(target, story.id, target.member.userId!);
    const frozen = clockAt('2026-10-26T01:00:00.000Z');
    const results = await Promise.all([
      complete(target, story.id, target.member, frozen),
      complete(target, story.id, target.member, frozen),
    ]);
    expect(results.map((res) => res.status).sort()).toEqual([200, 409]);
    expect(await storyGrants(target, story.id)).toHaveLength(1);
    expect(await logsOf(target, story.id)).toHaveLength(1);
  });

  test('読んでから書くまでに配下のタスクが足されたら、何も書かず 409 の conflict（open_tasks）', async () => {
    const target = await createTarget();
    const story = await emptyStory(target);
    const raced = racing(readsCompletion, async () => {
      await createTask(target.organization, target.workspace.id, target.admin.userId!, { story_id: story.id });
    });
    const res = await complete(target, story.id, target.member, raced);
    expect(res.status).toBe(409);
    expect(await errorOf(res)).toEqual({ code: 'conflict', reason: 'open_tasks' });
    expect((await storyRow(target, story.id))!.completed_at).toBeNull();
    expect(await logsOf(target, story.id)).toEqual([]);
  });

  test('受け取り手が0人と読んだ後に1人増えても、やり直してその人に付ける', async () => {
    const target = await createTarget();
    const story = await emptyStory(target);
    // 配下のタスクは完了しているが、まだ完了の経験値の付与が無い（読んだ受け取り手は0人）
    const task = await createTask(target.organization, target.workspace.id, target.admin.userId!, {
      story_id: story.id,
      completed_at: AT,
      completed_by: target.member.userId!,
    });
    const raced = racing(readsCompletion, async () => {
      await insertGrant(target, { user_id: target.member.userId!, task_id: task.id, amount: 30 });
    });
    const res = await complete(target, story.id, target.member, raced);
    expect(res.status).toBe(200);
    expect(await balances(target, story.id)).toEqual({ [target.member.userId!]: XP_STORY_COMPLETED });
  });

  test('受け取り手が100人を超えても（D1 の1文の bind の上限）、完了にでき、全員に付ける', async () => {
    const target = await createTarget();
    const story = await emptyStory(target);
    const db = orgDb(env, target.organization.verified);
    const userIds: string[] = [];
    const statements = [];
    for (let index = 0; index < 110; index++) {
      const userId = uuidv7();
      const taskId = uuidv7();
      userIds.push(userId);
      statements.push(
        db.statement((q) =>
          q.insertInto('users').values({
            id: userId,
            organization_id: target.organization.id,
            account_id: null,
            login_provider: 'github',
            login_subject: `${8100000 + index}${crypto.randomUUID().slice(0, 4).replace(/\D/g, '1')}`,
            login_email: null,
            claim_token_hash: null,
            claim_expires_at: null,
            name: `冒険者 ${index}`,
            is_admin: 0,
            work_start_on: null,
            work_end_on: null,
            disabled_at: null,
            last_seen_at: null,
            theme: null,
            created_at: AT,
            updated_at: AT,
          }),
        ),
        db.statement((q) =>
          q.insertInto('memberships').values({
            id: uuidv7(),
            workspace_id: target.workspace.id,
            user_id: userId,
            role: 'member',
            joined_on: '2026-10-01',
            left_on: null,
            joined_at: AT,
            left_at: null,
          }),
        ),
        db.statement((q) =>
          q.insertInto('tasks').values({
            id: taskId,
            workspace_id: target.workspace.id,
            is_imported: 0,
            tray: 'backlog',
            title: `見積もり ${index}`,
            body_md: null,
            link_url: null,
            story_id: story.id,
            category_id: null,
            repository_id: null,
            sprint_id: null,
            column_id: null,
            assignee_user_id: userId,
            points: 1,
            due_on: null,
            today_on: null,
            completed_at: AT,
            completed_by: userId,
            position: 'a0',
            column_position: null,
            created_by: target.admin.userId!,
            created_at: AT,
            updated_at: AT,
            deleted_at: null,
          }),
        ),
      );
    }
    await db.batch(statements);
    for (const [index, userId] of userIds.entries()) {
      const tasks = await db.rows(
        db.statement((q) =>
          q
            .selectFrom('tasks')
            .select('id')
            .where('workspace_id', '=', target.workspace.id)
            .where('assignee_user_id', '=', userId),
        ),
      );
      expect(tasks, String(index)).toHaveLength(1);
      await insertGrant(target, { user_id: userId, task_id: tasks[0]!.id, amount: 30 });
    }

    const res = await complete(target, story.id);
    expect(res.status).toBe(200);
    expect(await storyGrants(target, story.id)).toHaveLength(110);
  });

  test('読んでから書くまでに受け取り手が増えたら、読み直してやり直し、増えた人にも付ける', async () => {
    const target = await createTarget();
    const story = await emptyStory(target);
    await completedTask(target, story.id, target.member.userId!);
    const raced = racing(readsCompletion, async () => {
      await completedTask(target, story.id, target.leader.userId!);
    });
    const res = await complete(target, story.id, target.member, raced);
    expect(res.status).toBe(200);
    expect(await balances(target, story.id)).toEqual({
      [target.member.userId!]: XP_STORY_COMPLETED,
      [target.leader.userId!]: XP_STORY_COMPLETED,
    });
    expect(await logsOf(target, story.id)).toHaveLength(1);
  });

  test('別の組織・別のワークスペース・削除済み・存在しないストーリーは 404', async () => {
    const target = await createTarget();
    const foreign = await createTarget();
    const ids = [
      (await createStory(foreign.organization, foreign.workspace.id, foreign.admin.userId!)).id,
      (await createStory(target.organization, target.otherWorkspace.id, target.admin.userId!)).id,
      (await emptyStory(target, { deleted_at: AT })).id,
      '019a0000-0000-7000-8000-00000000ffff',
    ];
    for (const id of ids) {
      for (const res of [await complete(target, id), await reopen(target, id)]) {
        expect(res.status, id).toBe(404);
        expect(await errorCodeOf(res)).toBe('not_found');
      }
    }
    expect((await storyRow(foreign, ids[0]!))!.completed_at).toBeNull();
  });

  test('閉じたワークスペースでは 409 の workspace_closed', async () => {
    const target = await createTarget({ closed: true });
    const story = await emptyStory(target);
    const res = await complete(target, story.id, target.admin);
    expect(res.status).toBe(409);
    expect(await errorCodeOf(res)).toBe('workspace_closed');
  });
});

describe('story-reopen', () => {
  test('完了を取り消し、付けた経験値を打ち消し、もう一度完了にすると付け直す', async () => {
    const target = await createTarget();
    const story = await emptyStory(target);
    const member = target.member.userId!;
    const leader = target.leader.userId!;
    await completedTask(target, story.id, member);
    await completedTask(target, story.id, leader);
    const completing = await complete(target, story.id, target.member, clockAt('2026-10-26T01:00:00.000Z'));
    const first = (await completing.json()) as { completed_at: string };

    const res = await reopen(target, story.id, target.leader, clockAt('2026-10-26T02:00:00.000Z'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ story_id: story.id });
    expect(await storyRow(target, story.id)).toMatchObject({
      completed_at: null,
      completed_by: null,
      updated_at: '2026-10-26T02:00:00.000Z',
    });
    const afterReopen = await storyGrants(target, story.id);
    expect(afterReopen).toHaveLength(4);
    const originals = afterReopen.filter((grant) => grant.amount > 0);
    for (const original of originals) {
      const reversal = afterReopen.find((grant) => grant.reverses_grant_id === original.id);
      expect(reversal).toMatchObject({
        user_id: original.user_id,
        action: 'story_completed',
        story_id: story.id,
        amount: -XP_STORY_COMPLETED,
        dedupe_key: `reversal:${original.id}`,
        confirmed_at: '2026-10-26T02:00:00.000Z',
      });
    }
    expect(await balances(target, story.id)).toEqual({ [member]: 0, [leader]: 0 });

    // もう一度完了にすると、新しい回のキーで付け直す
    expect((await complete(target, story.id, target.member, clockAt('2026-10-26T03:00:00.000Z'))).status).toBe(200);
    expect(await balances(target, story.id)).toEqual({ [member]: XP_STORY_COMPLETED, [leader]: XP_STORY_COMPLETED });
    const keys = (await storyGrants(target, story.id)).map((grant) => grant.dedupe_key);
    expect(keys).toContain(`story_completed:${story.id}:${member}:2026-10-26T03:00:00.000Z`);
    expect(keys).toContain(`story_completed:${story.id}:${member}:${first.completed_at}`);

    // 2回目の取り消しは、2回目の付与だけを打ち消す
    expect((await reopen(target, story.id, target.member, clockAt('2026-10-26T04:00:00.000Z'))).status).toBe(200);
    expect(await balances(target, story.id)).toEqual({ [member]: 0, [leader]: 0 });
    expect(await storyGrants(target, story.id)).toHaveLength(8);

    const logs = await logsOf(target, story.id);
    expect(logs.map((log) => log.action)).toEqual(['complete', 'reopen', 'complete', 'reopen']);
    expect(logs[1]).toMatchObject({ actor_user_id: leader });
    expect(JSON.parse(logs[1]!.changes_json)).toEqual({
      completed_at: [first.completed_at, null],
      completed_by: [{ id: member, name: '星野 澪' }, null],
    });
  });

  test('止めた時計で、完了、取り消し、完了を同じ時刻に流しても落ちず、2回目の完了は同じキーの付与を付け直さない', async () => {
    const target = await createTarget();
    const story = await emptyStory(target);
    await completedTask(target, story.id, target.member.userId!);
    const frozen = clockAt('2026-10-26T01:00:00.000Z');
    expect((await complete(target, story.id, target.member, frozen)).status).toBe(200);
    expect((await reopen(target, story.id, target.member, frozen)).status).toBe(200);
    expect((await complete(target, story.id, target.member, frozen)).status).toBe(200);
    expect((await storyRow(target, story.id))!.completed_at).toBe('2026-10-26T01:00:00.000Z');
    // 開発用の時計だけで起きる。完了の回のキー（完了した日時を含む）が同じなので、付与と打ち消しの1組だけが残り、合計は 0
    expect(await storyGrants(target, story.id)).toHaveLength(2);
    expect(await balances(target, story.id)).toEqual({ [target.member.userId!]: 0 });
  });

  test('受け取った人が所属を外れていても、取り消すと打ち消す', async () => {
    const target = await createTarget();
    const story = await emptyStory(target);
    const leaving = await newMember(target);
    await completedTask(target, story.id, leaving);
    expect((await complete(target, story.id, target.member, clockAt('2026-10-26T01:00:00.000Z'))).status).toBe(200);
    expect(await balances(target, story.id)).toEqual({ [leaving]: XP_STORY_COMPLETED });
    const db = orgDb(env, target.organization.verified);
    await db.run(
      db.statement((q) =>
        q
          .updateTable('memberships')
          .set({ left_on: '2026-10-26', left_at: '2026-10-26T01:30:00.000Z' })
          .where('user_id', '=', leaving)
          .where('workspace_id', '=', target.workspace.id),
      ),
    );
    expect((await reopen(target, story.id, target.member, clockAt('2026-10-26T02:00:00.000Z'))).status).toBe(200);
    expect(await balances(target, story.id)).toEqual({ [leaving]: 0 });
  });

  test('完了していなければ 409 の conflict（not_completed）', async () => {
    const target = await createTarget();
    const story = await emptyStory(target);
    const res = await reopen(target, story.id);
    expect(res.status).toBe(409);
    expect(await errorOf(res)).toEqual({ code: 'conflict', reason: 'not_completed' });
    expect(await logsOf(target, story.id)).toEqual([]);
  });

  test('親のエピックが完了か中止していれば 409 の conflict（parent_completed）で、何も書かない', async () => {
    const target = await createTarget();
    const adminId = target.admin.userId!;
    for (const overrides of [
      { completed_at: AT, completed_by: adminId },
      { canceled_at: AT, canceled_by: adminId },
    ]) {
      const epic = await createEpic(target.organization, target.workspace.id, adminId, overrides);
      const story = await emptyStory(target, { epic_id: epic.id, completed_at: AT, completed_by: adminId });
      const res = await reopen(target, story.id);
      expect(res.status).toBe(409);
      expect(await errorOf(res)).toEqual({ code: 'conflict', reason: 'parent_completed' });
      expect((await storyRow(target, story.id))!.completed_at).toBe(AT);
    }
    // 開いているエピックの下なら取り消せる
    const open = await createEpic(target.organization, target.workspace.id, adminId);
    const story = await emptyStory(target, { epic_id: open.id, completed_at: AT, completed_by: adminId });
    expect((await reopen(target, story.id)).status).toBe(200);
  });

  test('2つの画面から同時に取り消すと、片方は 409 の conflict（not_completed）で、打ち消しは1回分', async () => {
    const target = await createTarget();
    const story = await emptyStory(target);
    await completedTask(target, story.id, target.member.userId!);
    expect((await complete(target, story.id)).status).toBe(200);
    // 1つ目の要求が付与を読んだ直後に、2つ目の要求が先に取り消す
    let second: Response | undefined;
    let done = false;
    const raced = envWithD1Hooks(testEnv, {
      afterQuery: async (sql) => {
        if (done || !sql.startsWith('select "g"."id", "g"."user_id", "g"."amount" from "xp_grants"')) return;
        done = true;
        second = await reopen(target, story.id, target.leader);
      },
    });
    const first = await reopen(target, story.id, target.member, raced);
    expect(second?.status).toBe(200);
    expect(first.status).toBe(409);
    expect(await errorOf(first)).toEqual({ code: 'conflict', reason: 'not_completed' });
    expect(await storyGrants(target, story.id)).toHaveLength(2);
    expect(await balances(target, story.id)).toEqual({ [target.member.userId!]: 0 });
    expect((await logsOf(target, story.id)).map((log) => log.action)).toEqual(['complete', 'reopen']);
  });
});
