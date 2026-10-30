// 手助けの経験値（task-complete が、そのタスクの感謝1件につき1行を足す。docs/data-model.md の「タスクの完了（task-complete）の文と条件」）。
// 感謝を受け取った人に付き、同じ送り手と相手の1週あたりの回数に上限がある（打ち消された分と打ち消しの行は数えない）。
// task-reopen が打ち消し、再び完了にすると付け直す。感謝は送る操作を通さず、行を直に足す（送る操作の条件は test/thanks.test.ts）
import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import { XP_HELP, XP_HELP_WEEKLY_LIMIT } from '../src/shared/experience.ts';
import { taskComplete, taskReopen } from '../src/shared/operations/task/index.ts';
import { createApp } from '../src/server/app.ts';
import { orgDb } from '../src/server/db/index.ts';
import { envWithD1Hooks } from '../src/server/db/testing.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import { createMembership, createTask, createThanks, createXpGrant } from './factories.ts';
import { post } from './operations/harness.ts';
import { createPerson, createTarget, testEnv, type Person, type Target } from './operations/world.ts';

const app = createApp(implementedOperations);

// 開発用の時計（DEV_NOW）で時刻を止めた、ループバックの公開 URL の環境
function clockAt(devNow: string): Env {
  return Object.assign({}, testEnv, { PUBLIC_ORIGIN: 'http://localhost:8787', DEV_NOW: devNow });
}

// 2026-10-28 は水曜（東京）。月曜始まりの週は 10-26〜11-01、日曜始まりの週は 10-25〜10-31
const WEDNESDAY = '2026-10-28T10:00:00+09:00';

function call(target: Target, definition: Parameters<typeof post>[1], taskId: string, devNow: string) {
  return post(app, definition, {
    slug: target.slug,
    token: target.member.token,
    body: { workspace_id: target.workspace.id, task_id: taskId },
    env: clockAt(devNow),
  });
}

async function complete(target: Target, taskId: string, devNow: string) {
  expect((await call(target, taskComplete, taskId, devNow)).status).toBe(200);
}

async function reopen(target: Target, taskId: string, devNow: string) {
  expect((await call(target, taskReopen, taskId, devNow)).status).toBe(200);
}

async function setWorkspace(target: Target, values: { timezone?: string; week_start?: number }) {
  const db = orgDb(env, target.organization.verified);
  await db.run(
    db.statement((q) =>
      q
        .updateTable('workspaces')
        .set(values)
        .where('id', '=', target.workspace.id)
        .where('organization_id', '=', target.organization.id),
    ),
  );
}

// 送り手から受け取る人への感謝を1件ずつ持つ、完了前のタスク。送り手の既定はメンバー
async function thankedTask(target: Target, recipients: Person[], sender: Person = target.member) {
  const task = await createTask(target.organization, target.workspace.id, sender.userId!);
  const thanks = [];
  for (const recipient of recipients) {
    thanks.push(
      await createThanks(target.organization, target.workspace.id, task.id, sender.userId!, recipient.userId!),
    );
  }
  return { task, thanks };
}

// 手助けの明細を直に足す（上限を数える前提の行）
function seedHelps(
  target: Target,
  count: number,
  confirmedAt: string,
  sender = target.member,
  recipient = target.leader,
) {
  return Promise.all(
    Array.from({ length: count }, () =>
      createXpGrant(target.organization, target.workspace.id, recipient.userId!, {
        action: 'help',
        helper_sender_user_id: sender.userId!,
        confirmed_at: new Date(confirmedAt).toISOString(),
      }),
    ),
  );
}

async function grantsOf(target: Target, taskId?: string) {
  const db = orgDb(env, target.organization.verified);
  return db.rows(
    db.statement((q) =>
      q
        .selectFrom('xp_grants')
        .selectAll()
        .where('workspace_id', '=', target.workspace.id)
        .where('action', '=', 'help')
        .$if(taskId !== undefined, (qb) => qb.where('task_id', '=', taskId!))
        .orderBy('id'),
    ),
  );
}

// 打ち消されていない手助け（正の値で、打ち消しの行に指されていない行）
async function liveHelps(target: Target, taskId?: string) {
  const rows = await grantsOf(target, taskId);
  const reversed = new Set(rows.map((row) => row.reverses_grant_id).filter((id) => id !== null));
  return rows.filter((row) => row.amount > 0 && !reversed.has(row.id));
}

async function thanksCount(target: Target, taskId: string) {
  const db = orgDb(env, target.organization.verified);
  const rows = await db.rows(
    db.statement((q) =>
      q.selectFrom('thanks').select('id').where('task_id', '=', taskId).where('workspace_id', '=', target.workspace.id),
    ),
  );
  return rows.length;
}

async function completionIdOf(target: Target, taskId: string) {
  const db = orgDb(env, target.organization.verified);
  const rows = await db.rows(
    db.statement((q) =>
      q
        .selectFrom('completions')
        .select('id')
        .where('task_id', '=', taskId)
        .where('workspace_id', '=', target.workspace.id),
    ),
  );
  expect(rows).toHaveLength(1);
  return rows[0]!.id;
}

// 同じ送り手（メンバー）と相手（リーダー）の感謝が付いた、完了前のタスクを作って完了にし、付いた手助けの数を返す
async function completeThanked(
  target: Target,
  devNow: string,
  sender: Person = target.member,
  recipient = target.leader,
) {
  const { task } = await thankedTask(target, [recipient], sender);
  await complete(target, task.id, devNow);
  return (await liveHelps(target, task.id)).length;
}

describe('手助けの付与（task-complete）', () => {
  test('感謝が2件あるタスクを完了にすると、2人に1行ずつ付く。ポイントが無くても付く', async () => {
    const target = await createTarget();
    const second = await createPerson({
      organization: target.organization,
      membership: { workspaceId: target.workspace.id, role: 'member' },
    });
    const { task, thanks } = await thankedTask(target, [target.leader, second]);

    await complete(target, task.id, WEDNESDAY);

    const helps = await liveHelps(target, task.id);
    expect(helps).toHaveLength(2);
    const completionId = await completionIdOf(target, task.id);
    for (const [recipient, thank] of [
      [target.leader, thanks[0]!],
      [second, thanks[1]!],
    ] as const) {
      expect(helps.find((row) => row.user_id === recipient.userId)).toMatchObject({
        action: 'help',
        amount: XP_HELP,
        task_id: task.id,
        thank_id: thank.id,
        helper_sender_user_id: target.member.userId,
        completion_id: completionId,
        dedupe_key: `help:${thank.id}:${completionId}`,
        confirmed_at: new Date(WEDNESDAY).toISOString(),
        story_id: null,
        epic_id: null,
        reverses_grant_id: null,
      });
    }
  });

  test('戻すと両方が打ち消され、もう一度完了にすると付け直される', async () => {
    const target = await createTarget();
    const second = await createPerson({
      organization: target.organization,
      membership: { workspaceId: target.workspace.id, role: 'member' },
    });
    const { task } = await thankedTask(target, [target.leader, second]);

    await complete(target, task.id, WEDNESDAY);
    const first = await liveHelps(target, task.id);
    expect(first).toHaveLength(2);

    await reopen(target, task.id, '2026-10-28T11:00:00+09:00');
    const afterReopen = await grantsOf(target, task.id);
    expect(afterReopen).toHaveLength(4);
    expect(await liveHelps(target, task.id)).toEqual([]);
    for (const original of first) {
      expect(afterReopen.find((row) => row.reverses_grant_id === original.id)).toMatchObject({
        user_id: original.user_id,
        action: 'help',
        amount: -XP_HELP,
        completion_id: original.completion_id,
        dedupe_key: `reversal:${original.id}`,
      });
    }

    await complete(target, task.id, '2026-10-28T12:00:00+09:00');
    const again = await liveHelps(target, task.id);
    expect(again).toHaveLength(2);
    // 新しい完了の記録で付け直す（元の付与とは別の行）
    const completionId = await completionIdOf(target, task.id);
    for (const row of again) {
      expect(first.map((old) => old.id)).not.toContain(row.id);
      expect(row.completion_id).toBe(completionId);
      expect(completionId).not.toBe(first[0]!.completion_id);
      expect(row.dedupe_key).toBe(`help:${row.thank_id}:${completionId}`);
    }

    // もう一度戻すと、付け直した分も打ち消される
    await reopen(target, task.id, '2026-10-28T13:00:00+09:00');
    expect(await liveHelps(target, task.id)).toEqual([]);
  });

  test('止めた時計で、完了、戻す、同じ時刻にもう一度完了にしても、付け直される', async () => {
    const target = await createTarget();
    const { task } = await thankedTask(target, [target.leader]);
    await complete(target, task.id, WEDNESDAY);
    await reopen(target, task.id, WEDNESDAY);
    expect(await liveHelps(target, task.id)).toEqual([]);
    await complete(target, task.id, WEDNESDAY);
    expect(await liveHelps(target, task.id)).toHaveLength(1);
  });

  test('今所属していない相手には付かず、所属している相手の分は付く。感謝の行は残る', async () => {
    const target = await createTarget();
    const leaver = await createPerson({ organization: target.organization });
    await createMembership(target.organization, target.workspace.id, leaver.userId!, {
      left_at: '2026-10-21T00:00:00.000Z',
      left_on: '2026-10-21',
    });
    const { task } = await thankedTask(target, [target.leader, leaver]);

    await complete(target, task.id, WEDNESDAY);

    expect((await liveHelps(target, task.id)).map((row) => row.user_id)).toEqual([target.leader.userId]);
    // 所属していない管理者（所属の行が無い）にも付かない
    const { task: adminTask } = await thankedTask(target, [target.admin]);
    await complete(target, adminTask.id, WEDNESDAY);
    expect(await liveHelps(target, adminTask.id)).toEqual([]);
  });

  test('感謝の無いタスクには付かない', async () => {
    const target = await createTarget();
    const task = await createTask(target.organization, target.workspace.id, target.member.userId!);
    await complete(target, task.id, WEDNESDAY);
    expect(await grantsOf(target, task.id)).toEqual([]);
  });
});

describe('感謝が割り込む', () => {
  // タスクの感謝を読んだ直後に、別の要求が感謝を送った（thanks-send は未完了のタスクにだけ送れる）状態を作って完了にする
  async function completeWithThanksArriving(target: Target, taskId: string, arrivals: Person[]) {
    const pending = [...arrivals];
    const racing = envWithD1Hooks(clockAt(WEDNESDAY), {
      afterQuery: async (sql) => {
        if (!sql.startsWith('select') || !sql.includes('from "thanks"') || pending.length === 0) return;
        const recipient = pending.shift()!;
        await createThanks(target.organization, target.workspace.id, taskId, target.member.userId!, recipient.userId!);
      },
    });
    return post(app, taskComplete, {
      slug: target.slug,
      token: target.member.token,
      body: { workspace_id: target.workspace.id, task_id: taskId },
      env: racing,
    });
  }

  test('感謝を読んだ後に別の感謝が届いても、読み直して全部の感謝に手助けが付く', async () => {
    const target = await createTarget();
    const { task } = await thankedTask(target, [target.leader]);
    const other = await createPerson({
      organization: target.organization,
      membership: { workspaceId: target.workspace.id, role: 'member' },
    });
    expect((await completeWithThanksArriving(target, task.id, [other])).status).toBe(200);
    expect(await thanksCount(target, task.id)).toBe(2);
    expect((await liveHelps(target, task.id)).map((row) => row.user_id).sort()).toEqual(
      [target.leader.userId, other.userId].sort(),
    );
  });

  test('感謝が1件も無いと読んだ後に届いても、読み直して手助けが付く', async () => {
    const target = await createTarget();
    const task = await createTask(target.organization, target.workspace.id, target.member.userId!);
    expect((await completeWithThanksArriving(target, task.id, [target.leader])).status).toBe(200);
    expect(await thanksCount(target, task.id)).toBe(1);
    expect(await liveHelps(target, task.id)).toHaveLength(1);
  });

  test('読み直しのたびに感謝が届き続けると、3 回で 409 の conflict になり、何も書かない', async () => {
    const target = await createTarget();
    const task = await createTask(target.organization, target.workspace.id, target.member.userId!);
    const people = await Promise.all(
      [1, 2, 3].map(() =>
        createPerson({
          organization: target.organization,
          membership: { workspaceId: target.workspace.id, role: 'member' },
        }),
      ),
    );
    const res = await completeWithThanksArriving(target, task.id, people);
    expect(res.status).toBe(409);
    expect(await grantsOf(target, task.id)).toEqual([]);
  });
});

describe('手助けの週の上限', () => {
  test('同じ送り手と相手は、同じ週に上限の数まで付き、超えた分は付かない。打ち消した分の枠は空く', async () => {
    const target = await createTarget();
    const counts = [];
    for (let n = 0; n < XP_HELP_WEEKLY_LIMIT + 1; n++) counts.push(await completeThanked(target, WEDNESDAY));
    expect(counts).toEqual([1, 1, 1, 0]);
    expect(await liveHelps(target)).toHaveLength(XP_HELP_WEEKLY_LIMIT);

    // 1件を戻すと枠が1つ空き、次の完了に付く。そのあとはまた満杯
    const [first] = await liveHelps(target);
    await reopen(target, first!.task_id!, WEDNESDAY);
    expect(await liveHelps(target)).toHaveLength(XP_HELP_WEEKLY_LIMIT - 1);
    expect(await completeThanked(target, WEDNESDAY)).toBe(1);
    expect(await completeThanked(target, WEDNESDAY)).toBe(0);
    expect(await liveHelps(target)).toHaveLength(XP_HELP_WEEKLY_LIMIT);
  });

  test('打ち消された行と、打ち消しの行（負の値）は数えない', async () => {
    const target = await createTarget();
    const helps = await seedHelps(target, XP_HELP_WEEKLY_LIMIT, WEDNESDAY);
    // 1件を打ち消す。打ち消しの行も、送り手と相手と週が上限の数え方に合う形にしておく
    await createXpGrant(target.organization, target.workspace.id, target.leader.userId!, {
      action: 'help',
      helper_sender_user_id: target.member.userId!,
      amount: -XP_HELP,
      reverses_grant_id: helps[0]!.id,
      confirmed_at: new Date(WEDNESDAY).toISOString(),
    });
    expect(await completeThanked(target, WEDNESDAY)).toBe(1);
    expect(await completeThanked(target, WEDNESDAY)).toBe(0);
  });

  test('組み合わせごとに数える。送り手が違う、相手が違う感謝は、別の枠で付く', async () => {
    const target = await createTarget();
    await seedHelps(target, XP_HELP_WEEKLY_LIMIT, WEDNESDAY);
    const other = await createPerson({
      organization: target.organization,
      membership: { workspaceId: target.workspace.id, role: 'member' },
    });
    expect(await completeThanked(target, WEDNESDAY)).toBe(0);
    // 送り手が違う（リーダーからメンバーへ）
    expect(await completeThanked(target, WEDNESDAY, target.leader, target.member)).toBe(1);
    // 相手が違う（メンバーからもう1人へ）
    expect(await completeThanked(target, WEDNESDAY, target.member, other)).toBe(1);
  });

  test('別のワークスペースの手助けは数えない', async () => {
    const target = await createTarget();
    for (let n = 0; n < XP_HELP_WEEKLY_LIMIT; n++) {
      await createXpGrant(target.organization, target.otherWorkspace.id, target.leader.userId!, {
        action: 'help',
        helper_sender_user_id: target.member.userId!,
        confirmed_at: new Date(WEDNESDAY).toISOString(),
      });
    }
    expect(await completeThanked(target, WEDNESDAY)).toBe(1);
  });

  // 3件が水曜に付いた後、日曜（11-01 の 10 時）の完了。月曜始まりでは同じ週で付かず、日曜始まりでは新しい週で付く
  test.each([
    { weekStart: 1, expected: 0 },
    { weekStart: 0, expected: 1 },
  ])('週の始まり $weekStart のワークスペースでは、日曜の完了に $expected 件付く', async ({ weekStart, expected }) => {
    const target = await createTarget();
    await setWorkspace(target, { week_start: weekStart });
    await seedHelps(target, XP_HELP_WEEKLY_LIMIT, WEDNESDAY);
    expect(await completeThanked(target, '2026-11-01T10:00:00+09:00')).toBe(expected);
  });

  test('週の境目は、ワークスペースの週の始まりの日の 0 時。1秒前は前の週、ちょうどは次の週', async () => {
    const target = await createTarget();
    await seedHelps(target, XP_HELP_WEEKLY_LIMIT, WEDNESDAY);
    expect(await completeThanked(target, '2026-11-01T23:59:59+09:00')).toBe(0);
    expect(await completeThanked(target, '2026-11-02T00:00:00+09:00')).toBe(1);
    // 次の週に付いた分は、その週の枠を使う。前の週の枠は戻らない
    expect(await completeThanked(target, '2026-11-02T01:00:00+09:00')).toBe(1);
    expect(await completeThanked(target, '2026-11-02T02:00:00+09:00')).toBe(1);
    expect(await completeThanked(target, '2026-11-02T03:00:00+09:00')).toBe(0);
    // 翌週の始まりの前に付いた分は、前の週へは戻らない
    expect(await completeThanked(target, '2026-11-01T23:59:59+09:00')).toBe(0);
  });

  // 2026-11-02T03:00:00Z は UTC では月曜、東京では月曜の昼、ロサンゼルスでは日曜の夜（前の週）
  test.each([
    { timezone: 'Asia/Tokyo', expected: 1 },
    { timezone: 'America/Los_Angeles', expected: 0 },
  ])('タイムゾーン $timezone のワークスペースの週で数える', async ({ timezone, expected }) => {
    const target = await createTarget();
    await setWorkspace(target, { timezone, week_start: 1 });
    // 10-28 10:00 JST は、東京では水曜、ロサンゼルスでは火曜の夕方（どちらも 10-26 始まりの週）
    await seedHelps(target, XP_HELP_WEEKLY_LIMIT, WEDNESDAY);
    expect(await completeThanked(target, '2026-11-02T03:00:00Z')).toBe(expected);
  });

  // 水曜に2件（週の内）、月曜 0 時ちょうどに1件（次の週）。日曜の最後の1秒に完了にすると、次の週の分は数えず 3 件目として付く
  test('週の終わり（次の週の始まり）ちょうどの手助けは、その前の週の数に入れない', async () => {
    const target = await createTarget();
    await seedHelps(target, XP_HELP_WEEKLY_LIMIT - 1, WEDNESDAY);
    await seedHelps(target, 1, '2026-11-02T00:00:00+09:00');
    expect(await completeThanked(target, '2026-11-01T23:59:59+09:00')).toBe(1);
  });

  test('同時に完了にした2つのタスクで上限をまたいでも、超えない', async () => {
    const target = await createTarget();
    await seedHelps(target, XP_HELP_WEEKLY_LIMIT - 1, WEDNESDAY);
    const [a, b] = await Promise.all([thankedTask(target, [target.leader]), thankedTask(target, [target.leader])]);
    await Promise.all([complete(target, a.task.id, WEDNESDAY), complete(target, b.task.id, WEDNESDAY)]);
    expect(await liveHelps(target)).toHaveLength(XP_HELP_WEEKLY_LIMIT);
    // 付いたのは片方だけ
    expect((await liveHelps(target, a.task.id)).length + (await liveHelps(target, b.task.id)).length).toBe(1);
  });
});
