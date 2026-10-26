// スプリントの一覧、作成、変更、削除の振る舞い。
// 組織の分離と権限の種類ごとの許可と拒否は、一覧を回す test/operation-registry.test.ts が確かめる。ここでは要の場面だけを重ねて見る
import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import { sprintCreate, sprintDelete, sprintList, sprintUpdate } from '../src/shared/operations/sprint/index.ts';
import { createApp } from '../src/server/app.ts';
import { orgDb, verifyWorkspace } from '../src/server/db/index.ts';
import { sprintUpdateOperation } from '../src/server/operations/sprint.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import { createSprint } from './factories.ts';
import { errorCodeOf, post } from './operations/harness.ts';
import { createTarget, testEnv, type Person, type Target } from './operations/world.ts';

const app = createApp(implementedOperations);

// 開発用の時計（DEV_NOW）が使える、ループバックの公開 URL の環境。2026-10-26 は月曜
const DEV_NOW = '2026-10-26T10:00:00+09:00';
const devEnv: Env = Object.assign({}, testEnv, { PUBLIC_ORIGIN: 'http://localhost:8787', DEV_NOW });

type SprintBody = {
  sprint: { id: string; name: string | null; start_on: string; end_on: string; length: number; status: string };
};
type ListBody = {
  sprints: SprintBody['sprint'][];
  defaults: { start_on: string; length: number };
  today: string;
};

function list(target: Target, person: Person = target.member) {
  return post(app, sprintList, {
    slug: target.slug,
    token: person.token,
    body: { workspace_id: target.workspace.id },
    env: devEnv,
  });
}

function create(target: Target, body: Record<string, unknown>, person: Person = target.leader) {
  return post(app, sprintCreate, {
    slug: target.slug,
    token: person.token,
    body: { workspace_id: target.workspace.id, ...body },
  });
}

function update(target: Target, sprintId: string, body: Record<string, unknown>, person: Person = target.leader) {
  return post(app, sprintUpdate, {
    slug: target.slug,
    token: person.token,
    body: { workspace_id: target.workspace.id, sprint_id: sprintId, ...body },
  });
}

function remove(target: Target, sprintId: string, person: Person = target.leader) {
  return post(app, sprintDelete, {
    slug: target.slug,
    token: person.token,
    body: { workspace_id: target.workspace.id, sprint_id: sprintId },
  });
}

async function rowsOf(target: Target) {
  const db = orgDb(env, target.organization.verified);
  return db.rows(
    db.statement((q) =>
      q.selectFrom('sprints').selectAll().where('workspace_id', '=', target.workspace.id).orderBy('start_on'),
    ),
  );
}

async function rowOf(target: Target, sprintId: string) {
  const db = orgDb(env, target.organization.verified);
  return db.first(
    db.statement((q) =>
      q.selectFrom('sprints').selectAll().where('id', '=', sprintId).where('workspace_id', '=', target.workspace.id),
    ),
  );
}

async function logsOf(target: Target, sprintId: string) {
  const db = orgDb(env, target.organization.verified);
  return db.rows(
    db.statement((q) =>
      q
        .selectFrom('change_logs')
        .selectAll()
        .where('entity_type', '=', 'sprint')
        .where('entity_id', '=', sprintId)
        .where('organization_id', '=', target.organization.id)
        .orderBy('created_at'),
    ),
  );
}

async function setWeekStart(target: Target, weekStart: number) {
  const db = orgDb(env, target.organization.verified);
  await db.run(
    db.statement((q) =>
      q
        .updateTable('workspaces')
        .set({ week_start: weekStart })
        .where('id', '=', target.workspace.id)
        .where('organization_id', '=', target.organization.id),
    ),
  );
}

describe('sprint-list', () => {
  test('削除していない先と進行中のスプリントを開始日の順に返し、終了、削除、別のワークスペースのものは返さない', async () => {
    const target = await createTarget();
    const later = await createSprint(target.organization, target.workspace.id, {
      name: '年末',
      start_on: '2026-11-09',
      end_on: '2026-11-22',
    });
    const active = await createSprint(target.organization, target.workspace.id, {
      start_on: '2026-10-26',
      end_on: '2026-11-08',
      status: 'active',
      started_at: '2026-10-26T00:00:00.000Z',
      started_by: target.leader.userId,
    });
    await createSprint(target.organization, target.workspace.id, {
      start_on: '2026-10-12',
      end_on: '2026-10-25',
      status: 'closed',
    });
    await createSprint(target.organization, target.workspace.id, {
      start_on: '2026-11-23',
      end_on: '2026-11-29',
      deleted_at: '2026-10-21T00:00:00.000Z',
    });
    await createSprint(target.organization, target.otherWorkspace.id, { start_on: '2026-10-01', end_on: '2026-10-07' });

    const res = await list(target);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListBody;
    expect(body.today).toBe('2026-10-26');
    expect(body.sprints).toEqual([
      { id: active.id, name: null, start_on: '2026-10-26', end_on: '2026-11-08', length: 14, status: 'active' },
      { id: later.id, name: '年末', start_on: '2026-11-09', end_on: '2026-11-22', length: 14, status: 'planned' },
    ]);
  });

  test('前のスプリントが無ければ、初期値は今日より後で最初の週の始まりと 14 日', async () => {
    const target = await createTarget();
    // 今日（月曜）が週の始まりでも、今日ではなく次の週の始まり
    expect(((await (await list(target)).json()) as ListBody).defaults).toEqual({ start_on: '2026-11-02', length: 14 });
    await setWeekStart(target, 0);
    expect(((await (await list(target)).json()) as ListBody).defaults).toEqual({ start_on: '2026-11-01', length: 14 });
    // 別のワークスペースのスプリントと、削除したスプリントは前のスプリントに数えない
    await createSprint(target.organization, target.otherWorkspace.id, { start_on: '2026-12-01', end_on: '2026-12-07' });
    await createSprint(target.organization, target.workspace.id, {
      start_on: '2026-12-01',
      end_on: '2026-12-07',
      deleted_at: '2026-10-21T00:00:00.000Z',
    });
    expect(((await (await list(target)).json()) as ListBody).defaults).toEqual({ start_on: '2026-11-01', length: 14 });
  });

  test('前のスプリントがあれば、最終日がいちばん後のもの（終了したものも含む）の翌日と同じ長さ', async () => {
    const target = await createTarget();
    await createSprint(target.organization, target.workspace.id, { start_on: '2026-10-26', end_on: '2026-11-01' });
    await createSprint(target.organization, target.workspace.id, {
      start_on: '2026-11-02',
      end_on: '2026-11-11',
      status: 'closed',
    });
    expect(((await (await list(target)).json()) as ListBody).defaults).toEqual({ start_on: '2026-11-12', length: 10 });
  });

  test('閉じたワークスペースでも読める', async () => {
    const target = await createTarget({ closed: true });
    await createSprint(target.organization, target.workspace.id);
    const res = await list(target);
    expect(res.status).toBe(200);
    expect(((await res.json()) as ListBody).sprints).toHaveLength(1);
  });
});

describe('sprint-create', () => {
  test('先のスプリントを作り、変更の履歴を残す。名前は前後の空白を除き、空は null', async () => {
    const target = await createTarget();
    const res = await create(target, { start_on: '2026-11-02', length: 14, name: '  秋の仕上げ  ' });
    expect(res.status).toBe(200);
    const { sprint } = (await res.json()) as SprintBody;
    expect(sprint).toMatchObject({
      name: '秋の仕上げ',
      start_on: '2026-11-02',
      end_on: '2026-11-15',
      length: 14,
      status: 'planned',
    });
    expect(await rowOf(target, sprint.id)).toMatchObject({
      workspace_id: target.workspace.id,
      status: 'planned',
      goal: null,
      extended_days: 0,
      deleted_at: null,
    });
    const logs = await logsOf(target, sprint.id);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ action: 'create', actor_user_id: target.leader.userId });
    expect(JSON.parse(logs[0]!.changes_json)).toEqual({
      name: [null, '秋の仕上げ'],
      start_on: [null, '2026-11-02'],
      end_on: [null, '2026-11-15'],
    });

    const unnamed = await create(target, { start_on: '2026-11-16', length: 1, name: ' 　 ' }, target.admin);
    expect(unnamed.status).toBe(200);
    expect(((await unnamed.json()) as SprintBody).sprint).toMatchObject({ name: null, end_on: '2026-11-16' });
  });

  test('開始日が今日より前でも作れる', async () => {
    const target = await createTarget();
    expect((await create(target, { start_on: '2020-01-06', length: 28 })).status).toBe(200);
  });

  test.each([
    ['長さが 0', { start_on: '2026-11-02', length: 0 }],
    ['長さが 29', { start_on: '2026-11-02', length: 29 }],
    ['長さが小数', { start_on: '2026-11-02', length: 1.5 }],
    ['開始日が暦に無い', { start_on: '2026-02-30', length: 14 }],
    ['最終日が暦を外れる', { start_on: '9999-12-31', length: 2 }],
    ['名前が 101 字', { start_on: '2026-11-02', length: 14, name: 'あ'.repeat(101) }],
    ['名前に制御文字', { start_on: '2026-11-02', length: 14, name: 'a\u0007b' }],
  ])('%s は 400', async (_name, body) => {
    const target = await createTarget();
    const res = await create(target, body);
    expect(res.status).toBe(400);
    expect(await errorCodeOf(res)).toBe('invalid_input');
    expect(await rowsOf(target)).toEqual([]);
  });

  test('名前は 100 字まで（コードポイントで数える）', async () => {
    const target = await createTarget();
    expect((await create(target, { start_on: '2026-11-02', length: 14, name: '😀'.repeat(100) })).status).toBe(200);
  });

  test('期間が重なれば（終了したスプリントとも）409 の overlap で、何も書かない。隣り合うのはよい', async () => {
    const target = await createTarget();
    await createSprint(target.organization, target.workspace.id, {
      start_on: '2026-10-12',
      end_on: '2026-10-25',
      status: 'closed',
    });
    await createSprint(target.organization, target.workspace.id, { start_on: '2026-11-02', end_on: '2026-11-15' });
    // 削除したスプリントと、別のワークスペースのスプリントとは重なってよい
    await createSprint(target.organization, target.workspace.id, {
      start_on: '2026-11-16',
      end_on: '2026-11-29',
      deleted_at: '2026-10-21T00:00:00.000Z',
    });
    await createSprint(target.organization, target.otherWorkspace.id, { start_on: '2026-10-26', end_on: '2026-11-01' });

    for (const body of [
      { start_on: '2026-10-25', length: 1 },
      { start_on: '2026-10-20', length: 28 },
      { start_on: '2026-11-15', length: 3 },
    ]) {
      const res = await create(target, body);
      expect(res.status, body.start_on).toBe(409);
      expect(((await res.json()) as { error: { code: string; details: unknown } }).error).toMatchObject({
        code: 'conflict',
        details: { reason: 'overlap' },
      });
    }
    expect(await rowsOf(target)).toHaveLength(3);

    expect((await create(target, { start_on: '2026-10-26', length: 7 })).status).toBe(200);
    expect((await create(target, { start_on: '2026-11-16', length: 14 })).status).toBe(200);
  });

  test('2つの画面から同じ期間を同時に作ると、片方だけが入り、もう片方は 409 の overlap', async () => {
    const target = await createTarget();
    const results = await Promise.all([
      create(target, { start_on: '2026-11-02', length: 14, name: 'A' }, target.leader),
      create(target, { start_on: '2026-11-09', length: 14, name: 'B' }, target.admin),
    ]);
    expect(results.map((res) => res.status).sort()).toEqual([200, 409]);
    const refused = results.find((res) => res.status === 409)!;
    expect(((await refused.json()) as { error: { code: string; details: unknown } }).error).toMatchObject({
      code: 'conflict',
      details: { reason: 'overlap' },
    });
    const rows = await rowsOf(target);
    expect(rows).toHaveLength(1);
    expect(await logsOf(target, rows[0]!.id)).toHaveLength(1);
  });

  test('一般のメンバーは 403 で、管理者は所属していなくても作れる', async () => {
    const target = await createTarget();
    const res = await create(target, { start_on: '2026-11-02', length: 14 }, target.member);
    expect(res.status).toBe(403);
    expect(await errorCodeOf(res)).toBe('forbidden');
    expect((await create(target, { start_on: '2026-11-02', length: 14 }, target.admin)).status).toBe(200);
  });

  test('閉じたワークスペースでは 409 の workspace_closed で、何も書かない', async () => {
    const target = await createTarget({ closed: true });
    const res = await create(target, { start_on: '2026-11-02', length: 14 }, target.admin);
    expect(res.status).toBe(409);
    expect(await errorCodeOf(res)).toBe('workspace_closed');
    expect(await rowsOf(target)).toEqual([]);
  });
});

describe('sprint-update', () => {
  test('送った欄のうち変わる列だけを書き、[前, 後] で履歴に残す。長さだけなら最終日を決め直す', async () => {
    const target = await createTarget();
    const sprint = await createSprint(target.organization, target.workspace.id, { name: '元の名前' });
    const res = await update(target, sprint.id, { length: 21, name: '元の名前' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as SprintBody).sprint).toMatchObject({
      name: '元の名前',
      start_on: '2026-11-02',
      end_on: '2026-11-22',
      length: 21,
    });
    const moved = await update(target, sprint.id, { start_on: '2026-11-09', name: '' });
    expect(((await moved.json()) as SprintBody).sprint).toMatchObject({
      name: null,
      start_on: '2026-11-09',
      end_on: '2026-11-29',
      length: 21,
    });
    const logs = await logsOf(target, sprint.id);
    expect(logs.map((log) => JSON.parse(log.changes_json))).toEqual([
      { end_on: ['2026-11-15', '2026-11-22'] },
      { name: ['元の名前', null], start_on: ['2026-11-02', '2026-11-09'], end_on: ['2026-11-22', '2026-11-29'] },
    ]);
    expect(logs[0]).toMatchObject({ action: 'update', actor_user_id: target.leader.userId });
  });

  test('変わる列が無ければ、何も書かず、履歴も残さない', async () => {
    const target = await createTarget();
    const sprint = await createSprint(target.organization, target.workspace.id);
    const res = await update(target, sprint.id, { start_on: '2026-11-02', length: 14, name: null });
    expect(res.status).toBe(200);
    expect(await rowOf(target, sprint.id)).toEqual(sprint);
    expect(await logsOf(target, sprint.id)).toEqual([]);
  });

  test('ほかのスプリントと重なる期間には直せず、409 の overlap で何も書かない。名前だけなら直せる', async () => {
    const target = await createTarget();
    const first = await createSprint(target.organization, target.workspace.id);
    await createSprint(target.organization, target.workspace.id, { start_on: '2026-11-16', end_on: '2026-11-29' });
    const res = await update(target, first.id, { length: 15 });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string; details: unknown } }).error).toMatchObject({
      code: 'conflict',
      details: { reason: 'overlap' },
    });
    expect(await rowOf(target, first.id)).toEqual(first);
    expect(await logsOf(target, first.id)).toEqual([]);
    // 自分自身とは重ならない
    expect((await update(target, first.id, { start_on: '2026-11-01' })).status).toBe(200);
    expect((await update(target, first.id, { name: '名前だけ' })).status).toBe(200);
  });

  test('始まった（進行中、終了した）スプリントは 409 の started で、何も書かない', async () => {
    const target = await createTarget();
    for (const status of ['active', 'closed'] as const) {
      const sprint = await createSprint(target.organization, target.workspace.id, {
        status,
        start_on: status === 'active' ? '2026-10-26' : '2026-10-01',
        end_on: status === 'active' ? '2026-11-01' : '2026-10-07',
      });
      const res = await update(target, sprint.id, { name: '直す' });
      expect(res.status, status).toBe(409);
      expect(((await res.json()) as { error: { details: unknown } }).error.details).toEqual({ reason: 'started' });
      expect(await rowOf(target, sprint.id)).toEqual(sprint);
    }
  });

  test('最終日が暦を外れる長さは 400', async () => {
    const target = await createTarget();
    const sprint = await createSprint(target.organization, target.workspace.id, {
      start_on: '9999-12-20',
      end_on: '9999-12-31',
    });
    const res = await update(target, sprint.id, { length: 13 });
    expect(res.status).toBe(400);
    expect(await errorCodeOf(res)).toBe('invalid_input');
  });

  test('別の組織・別のワークスペース・削除済み・存在しないスプリントは 404 で、何も書かない', async () => {
    const target = await createTarget();
    const foreign = await createTarget();
    const foreignSprint = await createSprint(foreign.organization, foreign.workspace.id);
    const elsewhere = await createSprint(target.organization, target.otherWorkspace.id);
    const deleted = await createSprint(target.organization, target.workspace.id, {
      deleted_at: '2026-10-21T00:00:00.000Z',
    });
    for (const id of [foreignSprint.id, elsewhere.id, deleted.id, '019a0000-0000-7000-8000-00000000ffff']) {
      const res = await update(target, id, { name: '書き換える' });
      expect(res.status, id).toBe(404);
      expect(await errorCodeOf(res)).toBe('not_found');
    }
    expect((await rowOf(foreign, foreignSprint.id))!.name).toBeNull();
  });

  test('一般のメンバーは 403', async () => {
    const target = await createTarget();
    const sprint = await createSprint(target.organization, target.workspace.id);
    const res = await update(target, sprint.id, { name: '直す' }, target.member);
    expect(res.status).toBe(403);
    expect(await rowOf(target, sprint.id)).toEqual(sprint);
  });

  test('閉じたワークスペースでは 409 の workspace_closed', async () => {
    const target = await createTarget({ closed: true });
    const sprint = await createSprint(target.organization, target.workspace.id);
    const res = await update(target, sprint.id, { name: '直す' }, target.admin);
    expect(res.status).toBe(409);
    expect(await errorCodeOf(res)).toBe('workspace_closed');
  });

  // 読んでから書くまでに別の要求が割り込む。処理を直に呼び、スプリントの行を読んだ直後（n 回目）に race を走らせる
  describe('読んだ後に別の要求が割り込む', () => {
    async function updateWithRace(
      target: Target,
      input: Record<string, unknown>,
      race: (n: number, db: ReturnType<typeof orgDb>) => Promise<void>,
    ) {
      const db = orgDb(env, target.organization.verified);
      const actor = {
        accountId: target.leader.accountId,
        userId: target.leader.userId,
        isAdmin: false,
        invitedOnly: false,
      };
      const workspace = await verifyWorkspace(db, actor, target.workspace.id);
      let reads = 0;
      const racing = new Proxy(db, {
        get(base, key) {
          const value = Reflect.get(base, key, base);
          if (typeof value !== 'function') return value;
          if (key !== 'first') return value.bind(base);
          return async (...args: unknown[]) => {
            const result = await (value as (...a: unknown[]) => Promise<unknown>).apply(base, args);
            if ((result as { status?: string } | undefined)?.status !== undefined) await race(++reads, base);
            return result;
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
      return sprintUpdateOperation.handler(context) as Promise<SprintBody>;
    }

    function setRange(db: ReturnType<typeof orgDb>, target: Target, sprintId: string, range: Record<string, string>) {
      return db.run(
        db.statement((q) =>
          q
            .updateTable('sprints')
            .set(range)
            .where('id', '=', sprintId)
            .where('workspace_id', '=', target.workspace.id),
        ),
      );
    }

    test('開始日だけを書く間に別の要求が最終日を動かしたら、その上に書かず、読み直して決め直す', async () => {
      const target = await createTarget();
      const sprint = await createSprint(target.organization, target.workspace.id);
      // 11-02〜11-15 を読み、開始日を 11-01、長さを 15 日にする（最終日は変わらないので、書く列は開始日だけ）。
      // 読んだ後に最終日が 11-29 に伸びる。片側だけを守ると 11-01〜11-29（29 日）を書いて長さの CHECK に当たる。
      // 両端を守るので書かず、読み直して 11-01〜11-15 にする
      const result = await updateWithRace(
        target,
        { sprint_id: sprint.id, start_on: '2026-11-01', length: 15 },
        async (n, base) => {
          if (n === 1) await setRange(base, target, sprint.id, { end_on: '2026-11-29' });
        },
      );
      expect(result.sprint).toMatchObject({ start_on: '2026-11-01', end_on: '2026-11-15', length: 15 });
      const logs = (await logsOf(target, sprint.id)).map((log) => JSON.parse(log.changes_json));
      expect(logs).toEqual([{ start_on: ['2026-11-02', '2026-11-01'], end_on: ['2026-11-29', '2026-11-15'] }]);
    });

    test('名前を送る間に別の要求が名前を変えたら、読み直してやり直し、履歴が連なる', async () => {
      const target = await createTarget();
      const sprint = await createSprint(target.organization, target.workspace.id, { name: '元' });
      const result = await updateWithRace(target, { sprint_id: sprint.id, name: 'B' }, async (n) => {
        if (n === 1) expect((await update(target, sprint.id, { name: 'A' })).status).toBe(200);
      });
      expect(result.sprint.name).toBe('B');
      const names = (await logsOf(target, sprint.id)).map((log) => JSON.parse(log.changes_json).name);
      expect(names).toEqual([
        ['元', 'A'],
        ['A', 'B'],
      ]);
    });

    test('負け続けて3回やり直しても書けなければ、409 の conflict で、履歴は書かない', async () => {
      const target = await createTarget();
      const sprint = await createSprint(target.organization, target.workspace.id);
      await expect(
        updateWithRace(target, { sprint_id: sprint.id, length: 7 }, async (n, base) => {
          await setRange(base, target, sprint.id, { end_on: `2026-11-${String(15 + n).padStart(2, '0')}` });
        }),
      ).rejects.toMatchObject({ status: 409, code: 'conflict' });
      expect(await logsOf(target, sprint.id)).toEqual([]);
    });
  });
});

describe('sprint-delete', () => {
  test('始まる前のスプリントを論理削除し、履歴を残す。続けて削除すると 404', async () => {
    const target = await createTarget();
    const sprint = await createSprint(target.organization, target.workspace.id);
    const res = await remove(target, sprint.id);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sprint_id: sprint.id });
    const row = (await rowOf(target, sprint.id))!;
    expect(row.deleted_at).not.toBeNull();
    const logs = await logsOf(target, sprint.id);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ action: 'delete', actor_user_id: target.leader.userId });
    expect(JSON.parse(logs[0]!.changes_json)).toEqual({ deleted_at: [null, row.deleted_at] });
    // 一覧から消え、同じ期間にまた作れる
    expect(((await (await list(target)).json()) as ListBody).sprints).toEqual([]);
    expect((await create(target, { start_on: sprint.start_on, length: 14 })).status).toBe(200);

    expect((await remove(target, sprint.id)).status).toBe(404);
  });

  test('始まったスプリントは 409 の started で、何も書かない', async () => {
    const target = await createTarget();
    const sprint = await createSprint(target.organization, target.workspace.id, { status: 'active' });
    const res = await remove(target, sprint.id);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { details: unknown } }).error.details).toEqual({ reason: 'started' });
    expect(await rowOf(target, sprint.id)).toEqual(sprint);
    expect(await logsOf(target, sprint.id)).toEqual([]);
  });

  test('一般のメンバーは 403、別の組織のスプリントは 404', async () => {
    const target = await createTarget();
    const foreign = await createTarget();
    const sprint = await createSprint(target.organization, target.workspace.id);
    expect((await remove(target, sprint.id, target.member)).status).toBe(403);
    const foreignSprint = await createSprint(foreign.organization, foreign.workspace.id);
    expect((await remove(target, foreignSprint.id)).status).toBe(404);
    expect((await rowOf(foreign, foreignSprint.id))!.deleted_at).toBeNull();
  });

  test('閉じたワークスペースでは 409 の workspace_closed', async () => {
    const target = await createTarget({ closed: true });
    const sprint = await createSprint(target.organization, target.workspace.id);
    const res = await remove(target, sprint.id, target.admin);
    expect(res.status).toBe(409);
    expect(await errorCodeOf(res)).toBe('workspace_closed');
    expect((await rowOf(target, sprint.id))!.deleted_at).toBeNull();
  });
});
