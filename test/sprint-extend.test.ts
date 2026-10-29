import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import { createApp } from '../src/server/app.ts';
import { orgDb } from '../src/server/db/index.ts';
import { envWithD1Hooks } from '../src/server/db/testing.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import { sprintExtend, sprintUpdate } from '../src/shared/operations/sprint/index.ts';
import { createSprint } from './factories.ts';
import { post } from './operations/harness.ts';
import { createTarget, testEnv, type Target } from './operations/world.ts';

const app = createApp(implementedOperations);
const range = { start_on: '2026-10-19', end_on: '2026-11-01' };
async function setup() {
  const target = await createTarget();
  const sprint = await createSprint(target.organization, target.workspace.id, { ...range, status: 'active' });
  return { target, sprint, db: orgDb(env, target.organization.verified) };
}
function extend(target: Target, sprintId: string, days: unknown = 3, callEnv: Env = testEnv) {
  return post(app, sprintExtend, {
    slug: target.slug,
    token: target.leader.token,
    body: { workspace_id: target.workspace.id, sprint_id: sprintId, days },
    env: callEnv,
  });
}
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
    expect((await extend(target, sprint.id, 1)).status).toBe(400);
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
  test('同時の延長は新しい期間を読み直し、成功した日数だけ押し出す', async () => {
    const { target, sprint } = await setup();
    await createSprint(target.organization, target.workspace.id, { start_on: '2026-11-02', end_on: '2026-11-08' });
    let entered = false;
    const watched = envWithD1Hooks(testEnv, {
      afterQuery: async (sql) => {
        if (!entered && sql.startsWith('select * from "sprints"')) {
          entered = true;
          expect((await extend(target, sprint.id, 2)).status).toBe(200);
        }
      },
    });
    expect((await extend(target, sprint.id, 3, watched)).status).toBe(200);
    expect(entered).toBe(true);
    expect((await rows(target)).map((r) => [r.start_on, r.end_on, r.extended_days])).toEqual([
      ['2026-10-19', '2026-11-06', 5],
      ['2026-11-07', '2026-11-13', 0],
    ]);
    expect(await logs(target)).toHaveLength(4);
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
        if (!entered && sql.startsWith('select * from "sprints"')) {
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
        if (!entered && sql.startsWith('select * from "sprints"')) {
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
        if (!sql.startsWith('select * from "sprints"')) return;
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
        if (!entered && sql.startsWith('select * from "sprints"')) {
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
});
