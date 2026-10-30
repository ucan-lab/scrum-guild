import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import { createApp } from '../src/server/app.ts';
import { orgDb } from '../src/server/db/index.ts';
import { envWithD1Hooks } from '../src/server/db/testing.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import { sprintExtend, sprintUpdate } from '../src/shared/operations/sprint/index.ts';
import { createSprint } from './factories.ts';
import { errorCodeOf, post } from './operations/harness.ts';
import { createTarget, testEnv, type Target } from './operations/world.ts';

const app = createApp(implementedOperations);
const range = { start_on: '2026-10-19', end_on: '2026-11-01' };
async function setup() {
  const target = await createTarget();
  const sprint = await createSprint(target.organization, target.workspace.id, { ...range, status: 'active' });
  return { target, sprint, db: orgDb(env, target.organization.verified) };
}
// end_on は画面が読んだ今の最終日。既定は setup() の進行中のスプリントの最終日
function extend(
  target: Target,
  sprintId: string,
  days: unknown = 3,
  callEnv: Env = testEnv,
  endOn: unknown = range.end_on,
) {
  return post(app, sprintExtend, {
    slug: target.slug,
    token: target.leader.token,
    body: { workspace_id: target.workspace.id, sprint_id: sprintId, days, end_on: endOn },
    env: callEnv,
  });
}
// 進行中のスプリントの行を読む文（要る列だけを選ぶ）
const isSprintRead = (sql: string) => sql.startsWith('select') && sql.includes('from "sprints"');
async function rows(target: Target) {
  const db = orgDb(env, target.organization.verified);
  return db.rows(
    db.statement((q) =>
      q.selectFrom('sprints').selectAll().where('workspace_id', '=', target.workspace.id).orderBy('start_on'),
    ),
  );
}
async function logs(target: Target) {
  const db = orgDb(env, target.organization.verified);
  return db.rows(
    db.statement((q) =>
      q
        .selectFrom('change_logs')
        .selectAll()
        .where('organization_id', '=', target.organization.id)
        .where('workspace_id', '=', target.workspace.id)
        .where('entity_type', '=', 'sprint'),
    ),
  );
}
async function reason(res: Response) {
  return ((await res.json()) as { error: { details: { reason: string } } }).error.details.reason;
}

describe('sprint-extend', () => {
  test.each([
    ['重ならない', '2026-11-05', '2026-11-11', '2026-11-05', '2026-11-11', 0],
    ['空きで一部吸収', '2026-11-03', '2026-11-09', '2026-11-05', '2026-11-11', 1],
    ['空きがない', '2026-11-02', '2026-11-08', '2026-11-05', '2026-11-11', 1],
  ])('%s', async (_, start, end, nextStart, nextEnd, shiftedCount) => {
    const { target, sprint } = await setup();
    const next = await createSprint(target.organization, target.workspace.id, {
      start_on: start as string,
      end_on: end as string,
    });
    const res = await extend(target, sprint.id);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sprint: { end_on: string; extended_days: number }; shifted: unknown[] };
    expect(body.sprint).toMatchObject({ end_on: '2026-11-04', extended_days: 3 });
    expect(body.shifted).toHaveLength(shiftedCount as number);
    expect((await rows(target)).find((r) => r.id === next.id)).toMatchObject({ start_on: nextStart, end_on: nextEnd });
    const history = await logs(target);
    expect(history).toHaveLength(1 + (shiftedCount as number));
    expect(JSON.parse(history.find((l) => l.entity_id === sprint.id)!.changes_json)).toEqual({
      end_on: ['2026-11-01', '2026-11-04'],
      extended_days: [0, 3],
    });
    if (shiftedCount)
      expect(JSON.parse(history.find((l) => l.entity_id === next.id)!.changes_json)).toEqual({
        start_on: [start, nextStart],
        end_on: [end, nextEnd],
      });
  });
  test('押し出しが続き、途中の空きで止まる', async () => {
    const { target, sprint } = await setup();
    for (const [start_on, end_on] of [
      ['2026-11-02', '2026-11-08'],
      ['2026-11-10', '2026-11-16'],
      ['2026-11-20', '2026-11-26'],
    ]) {
      await createSprint(target.organization, target.workspace.id, { start_on, end_on });
    }
    expect((await extend(target, sprint.id)).status).toBe(200);
    expect((await rows(target)).map((r) => [r.start_on, r.end_on])).toEqual([
      ['2026-10-19', '2026-11-04'],
      ['2026-11-05', '2026-11-11'],
      ['2026-11-12', '2026-11-18'],
      ['2026-11-20', '2026-11-26'],
    ]);
  });
  test('28日ちょうどは通し、超える延長は書かない', async () => {
    const { target, sprint } = await setup();
    expect((await extend(target, sprint.id, 14)).status).toBe(200);
    expect((await extend(target, sprint.id, 1, testEnv, '2026-11-15')).status).toBe(400);
    expect((await rows(target))[0]?.extended_days).toBe(14);
    expect(await logs(target)).toHaveLength(1);
  });
  test.each([0, -1, 28, 1.5, '3'])('days=%s を断る', async (days) => {
    const { target, sprint } = await setup();
    expect((await extend(target, sprint.id, days)).status).toBe(400);
    expect(await logs(target)).toHaveLength(0);
  });
  test.each(['planned', 'closed'])('%s の延長を断る', async (status) => {
    const { target, sprint, db } = await setup();
    await db.batch([
      db.statement((q) =>
        q
          .updateTable('sprints')
          .set({ status })
          .where('workspace_id', '=', target.workspace.id)
          .where('id', '=', sprint.id),
      ),
    ]);
    const res = await extend(target, sprint.id);
    expect(res.status).toBe(409);
    expect(await reason(res)).toBe('not_active');
    expect(await logs(target)).toHaveLength(0);
  });
  test('終了したスプリントと押し出した先が重なると全部書かない', async () => {
    const { target, sprint } = await setup();
    await createSprint(target.organization, target.workspace.id, { start_on: '2026-11-02', end_on: '2026-11-08' });
    await createSprint(target.organization, target.workspace.id, {
      start_on: '2026-11-10',
      end_on: '2026-11-16',
      status: 'closed',
    });
    const before = await rows(target);
    const res = await extend(target, sprint.id);
    expect(res.status).toBe(409);
    expect(await reason(res)).toBe('overlap');
    expect(await rows(target)).toEqual(before);
    expect(await logs(target)).toHaveLength(0);
  });
  test('同じ最終日を読んだ延長が同時に来ても、後の要求は足さずに changed で断る', async () => {
    const { target, sprint } = await setup();
    await createSprint(target.organization, target.workspace.id, { start_on: '2026-11-02', end_on: '2026-11-08' });
    let entered = false;
    const watched = envWithD1Hooks(testEnv, {
      afterQuery: async (sql) => {
        if (!entered && isSprintRead(sql)) {
          entered = true;
          expect((await extend(target, sprint.id, 2)).status).toBe(200);
        }
      },
    });
    const res = await extend(target, sprint.id, 3, watched);
    expect(res.status).toBe(409);
    expect(await reason(res)).toBe('changed');
    expect(entered).toBe(true);
    expect((await rows(target)).map((r) => [r.start_on, r.end_on, r.extended_days])).toEqual([
      ['2026-10-19', '2026-11-03', 2],
      ['2026-11-04', '2026-11-10', 0],
    ]);
    expect(await logs(target)).toHaveLength(2);
  });
  test('同じ日数と最終日を2回送ると、2回目は changed で最終日は1回分だけ延びる', async () => {
    const { target, sprint } = await setup();
    expect((await extend(target, sprint.id, 3)).status).toBe(200);
    const res = await extend(target, sprint.id, 3);
    expect(res.status).toBe(409);
    expect(await reason(res)).toBe('changed');
    expect((await rows(target))[0]).toMatchObject({ end_on: '2026-11-04', extended_days: 3 });
    expect(await logs(target)).toHaveLength(1);
  });
  test('押し出しの行だけが変わったときは、同じ最終日から計算し直して通す', async () => {
    const { target, sprint, db } = await setup();
    const next = await createSprint(target.organization, target.workspace.id, {
      start_on: '2026-11-02',
      end_on: '2026-11-08',
    });
    let entered = false;
    const watched = envWithD1Hooks(testEnv, {
      afterQuery: async (sql) => {
        if (!entered && isSprintRead(sql)) {
          entered = true;
          await db.batch([
            db.statement((q) =>
              q
                .updateTable('sprints')
                .set({ name: '名前だけ変わった', end_on: '2026-11-09' })
                .where('workspace_id', '=', target.workspace.id)
                .where('id', '=', next.id),
            ),
          ]);
        }
      },
    });
    expect((await extend(target, sprint.id, 3, watched)).status).toBe(200);
    expect((await rows(target)).map((r) => [r.start_on, r.end_on])).toEqual([
      ['2026-10-19', '2026-11-04'],
      ['2026-11-05', '2026-11-12'],
    ]);
  });
  // 重なりの検査が押し出す件数の2乗で伸びると、ここが数十秒かかる（50件で約20秒だった）
  test('進行中の直後に隙間なく続く planned 200 件も、全部押し出して通す', { timeout: 30_000 }, async () => {
    const { target, sprint } = await setup();
    const rowsToAdd = Array.from({ length: 200 }, (_, index) => {
      const start = new Date(Date.parse('2026-11-02') + index * 7 * 86_400_000);
      const end = new Date(start.getTime() + 6 * 86_400_000);
      return { start_on: start.toISOString().slice(0, 10), end_on: end.toISOString().slice(0, 10) };
    });
    for (const period of rowsToAdd) await createSprint(target.organization, target.workspace.id, period);
    const res = await extend(target, sprint.id, 3);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { shifted: unknown[] };
    expect(body.shifted).toHaveLength(200);
    expect((await rows(target)).map((r) => r.start_on)).toEqual(
      ['2026-10-19', ...rowsToAdd.map((r) => r.start_on)].map((start, index) =>
        index === 0 ? start : new Date(Date.parse(start) + 3 * 86_400_000).toISOString().slice(0, 10),
      ),
    );
    expect(await logs(target)).toHaveLength(201);
  });
  test('応答の shifted は id、name、start_on、end_on の4項目だけ', async () => {
    const { target, sprint } = await setup();
    const next = await createSprint(target.organization, target.workspace.id, {
      name: '次',
      start_on: '2026-11-02',
      end_on: '2026-11-08',
    });
    const res = await extend(target, sprint.id);
    expect(((await res.json()) as { shifted: unknown[] }).shifted).toEqual([
      { id: next.id, name: '次', start_on: '2026-11-05', end_on: '2026-11-11' },
    ]);
  });
  test.each(['planned', 'closed'])(
    '閉じたワークスペースの %s の延長は not_active より先に workspace_closed',
    async (status) => {
      const target = await createTarget({ closed: true });
      const sprint = await createSprint(target.organization, target.workspace.id, { ...range, status });
      const res = await extend(target, sprint.id);
      expect(res.status).toBe(409);
      expect(await errorCodeOf(res)).toBe('workspace_closed');
      expect(await logs(target)).toHaveLength(0);
    },
  );
  describe('新しい最終日との境界', () => {
    test('新しい最終日と同じ日に始まる planned は1日押し出される', async () => {
      const { target, sprint } = await setup();
      const next = await createSprint(target.organization, target.workspace.id, {
        start_on: '2026-11-04',
        end_on: '2026-11-10',
      });
      expect((await extend(target, sprint.id)).status).toBe(200);
      expect((await rows(target)).find((r) => r.id === next.id)).toMatchObject({
        start_on: '2026-11-05',
        end_on: '2026-11-11',
      });
    });
    test('押し出しの連なりの途中で、直前の新しい最終日と同じ日に始まる行も押し出される', async () => {
      const { target, sprint } = await setup();
      await createSprint(target.organization, target.workspace.id, { start_on: '2026-11-04', end_on: '2026-11-10' });
      // 1つ目は 11-05〜11-11 になるので、2つ目の始まり 11-11 は直前の新しい最終日と同じ日
      const last = await createSprint(target.organization, target.workspace.id, {
        start_on: '2026-11-11',
        end_on: '2026-11-17',
      });
      expect((await extend(target, sprint.id)).status).toBe(200);
      expect((await rows(target)).find((r) => r.id === last.id)).toMatchObject({
        start_on: '2026-11-12',
        end_on: '2026-11-18',
      });
    });
    test('終了したスプリントが新しい最終日と同じ日に始まれば overlap で何も書かない', async () => {
      const { target, sprint } = await setup();
      await createSprint(target.organization, target.workspace.id, {
        start_on: '2026-11-04',
        end_on: '2026-11-10',
        status: 'closed',
      });
      const before = await rows(target);
      const res = await extend(target, sprint.id);
      expect(res.status).toBe(409);
      expect(await reason(res)).toBe('overlap');
      expect(await rows(target)).toEqual(before);
      expect(await logs(target)).toHaveLength(0);
    });
    test('終了したスプリントが新しい最終日の翌日に始まれば通す', async () => {
      const { target, sprint } = await setup();
      await createSprint(target.organization, target.workspace.id, {
        start_on: '2026-11-05',
        end_on: '2026-11-10',
        status: 'closed',
      });
      expect((await extend(target, sprint.id)).status).toBe(200);
      expect((await rows(target))[0]).toMatchObject({ end_on: '2026-11-04', extended_days: 3 });
    });
  });
  test('読んだ後で後続が終了したら、延長と履歴を残さない', async () => {
    const { target, sprint, db } = await setup();
    const next = await createSprint(target.organization, target.workspace.id, {
      start_on: '2026-11-02',
      end_on: '2026-11-08',
    });
    let entered = false;
    const watched = envWithD1Hooks(testEnv, {
      afterQuery: async (sql) => {
        if (!entered && isSprintRead(sql)) {
          entered = true;
          await db.batch([
            db.statement((q) =>
              q
                .updateTable('sprints')
                .set({ status: 'closed' })
                .where('workspace_id', '=', target.workspace.id)
                .where('id', '=', next.id),
            ),
          ]);
        }
      },
    });
    const res = await extend(target, sprint.id, 3, watched);
    expect(res.status).toBe(409);
    expect(await reason(res)).toBe('overlap');
    expect((await rows(target)).find((r) => r.id === sprint.id)).toMatchObject({
      end_on: range.end_on,
      extended_days: 0,
    });
    expect(await logs(target)).toHaveLength(0);
  });
  test('延長と終了が同時なら終了後には何も書かない', async () => {
    const { target, sprint, db } = await setup();
    let entered = false;
    const watched = envWithD1Hooks(testEnv, {
      afterQuery: async (sql) => {
        if (!entered && isSprintRead(sql)) {
          entered = true;
          await db.batch([
            db.statement((q) =>
              q
                .updateTable('sprints')
                .set({ status: 'closed' })
                .where('workspace_id', '=', target.workspace.id)
                .where('id', '=', sprint.id),
            ),
          ]);
        }
      },
    });
    const res = await extend(target, sprint.id, 3, watched);
    expect(res.status).toBe(409);
    expect(await reason(res)).toBe('not_active');
    expect((await rows(target))[0]).toMatchObject({ end_on: range.end_on, extended_days: 0 });
    expect(await logs(target)).toHaveLength(0);
  });
  test('3回とも読んだ値が変わったら changed、どの試行も履歴を残さない', async () => {
    const { target, sprint, db } = await setup();
    let reads = 0;
    let batches = 0;
    const watched = envWithD1Hooks(testEnv, {
      afterQuery: async (sql) => {
        if (!isSprintRead(sql)) return;
        reads++;
        await db.batch([
          db.statement((q) =>
            q
              .updateTable('sprints')
              .set({ extended_days: reads % 2 })
              .where('workspace_id', '=', target.workspace.id)
              .where('id', '=', sprint.id),
          ),
        ]);
      },
      beforeBatch: (sqls) => {
        if (sqls[0]?.startsWith('update "sprints"')) batches++;
      },
    });
    const res = await extend(target, sprint.id, 3, watched);
    expect(res.status).toBe(409);
    expect(await reason(res)).toBe('changed');
    expect(batches).toBe(3);
    expect(await logs(target)).toHaveLength(0);
    expect((await rows(target))[0]?.end_on).toBe(range.end_on);
  });
  test('押し出さない行が読み取り後に重なる位置へ動いたら、全体を読み直す', async () => {
    const { target, sprint, db } = await setup();
    const next = await createSprint(target.organization, target.workspace.id, {
      start_on: '2026-11-10',
      end_on: '2026-11-16',
    });
    let entered = false;
    const watched = envWithD1Hooks(testEnv, {
      afterQuery: async (sql) => {
        if (!entered && isSprintRead(sql)) {
          entered = true;
          await db.batch([
            db.statement((q) =>
              q
                .updateTable('sprints')
                .set({ start_on: '2026-11-03', end_on: '2026-11-09' })
                .where('workspace_id', '=', target.workspace.id)
                .where('id', '=', next.id),
            ),
          ]);
        }
      },
    });
    expect((await extend(target, sprint.id, 3, watched)).status).toBe(200);
    expect((await rows(target)).find((r) => r.id === next.id)).toMatchObject({
      start_on: '2026-11-05',
      end_on: '2026-11-11',
    });
    expect(await logs(target)).toHaveLength(2);
  });
});

describe('進行中の sprint-update', () => {
  test('名前とゴールを直し、期間と延長日数を保つ', async () => {
    const { target, sprint } = await setup();
    expect((await extend(target, sprint.id, 1)).status).toBe(200);
    const res = await post(app, sprintUpdate, {
      slug: target.slug,
      token: target.leader.token,
      body: {
        workspace_id: target.workspace.id,
        sprint_id: sprint.id,
        name: ' 新しい名前 ',
        goal: ' 新しいゴール\r\n次の行 ',
      },
    });
    expect(res.status).toBe(200);
    expect((await rows(target))[0]).toMatchObject({
      name: '新しい名前',
      goal: '新しいゴール\n次の行',
      end_on: '2026-11-02',
      extended_days: 1,
    });
    expect((await logs(target)).some((l) => JSON.parse(l.changes_json).goal?.[1] === '新しいゴール\n次の行')).toBe(
      true,
    );
  });
  test.each([
    ['active', { length: 14 }, 'started'],
    ['active', { start_on: '2026-10-19' }, 'started'],
    ['planned', { goal: null }, 'not_active'],
    ['closed', { name: '名前' }, 'started'],
  ])('%s で変えられない欄を断る', async (status, fields, expected) => {
    const { target, sprint, db } = await setup();
    await db.batch([
      db.statement((q) =>
        q
          .updateTable('sprints')
          .set({ status: status as string })
          .where('workspace_id', '=', target.workspace.id)
          .where('id', '=', sprint.id),
      ),
    ]);
    const res = await post(app, sprintUpdate, {
      slug: target.slug,
      token: target.leader.token,
      body: { workspace_id: target.workspace.id, sprint_id: sprint.id, ...(fields as object) },
    });
    expect(res.status).toBe(409);
    expect(await reason(res)).toBe(expected);
  });
  test('閉じたワークスペースの planned にゴールを送ると not_active より先に workspace_closed', async () => {
    const target = await createTarget({ closed: true });
    const sprint = await createSprint(target.organization, target.workspace.id);
    const res = await post(app, sprintUpdate, {
      slug: target.slug,
      token: target.leader.token,
      body: { workspace_id: target.workspace.id, sprint_id: sprint.id, goal: '目標' },
    });
    expect(res.status).toBe(409);
    expect(await errorCodeOf(res)).toBe('workspace_closed');
  });
});
