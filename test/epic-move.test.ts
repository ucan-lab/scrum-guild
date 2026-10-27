// エピックの並べ替え（epic-move）の振る舞い。
// 組織の分離と権限の種類ごとの許可と拒否は、一覧を回す test/operation-registry.test.ts が確かめる
import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import { epicMove } from '../src/shared/operations/epic/index.ts';
import { createApp } from '../src/server/app.ts';
import { orgDb } from '../src/server/db/index.ts';
import { envWithD1Hooks } from '../src/server/db/testing.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import { MAX_TIES } from '../src/server/operations/move-position.ts';
import { createEpic } from './factories.ts';
import { errorCodeOf, post } from './operations/harness.ts';
import { createTarget, testEnv, type Person, type Target } from './operations/world.ts';

const app = createApp(implementedOperations);

const DONE_AT = '2026-10-21T00:00:00.000Z';

function moveEpic(
  target: Target,
  body: Record<string, unknown>,
  person: Person = target.member,
  requestEnv: Env = testEnv,
) {
  return post(app, epicMove, {
    slug: target.slug,
    token: person.token,
    body: { workspace_id: target.workspace.id, ...body },
    env: requestEnv,
  });
}

// 応答のエラーの code と、409 の理由（details.reason）
async function errorOf(res: Response) {
  const body = (await res.json()) as { error: { code: string; details?: { reason?: string } } };
  return { code: body.error.code, reason: body.error.details?.reason };
}

// 読んでから書くまでに別の要求が割り込んだ状況を作る。match に当たる問い合わせが答えた直後に、一度だけ change を流す
function racing(match: (sql: string) => boolean, change: () => Promise<void>): Env {
  let done = false;
  return envWithD1Hooks(testEnv, {
    afterQuery: async (sql) => {
      if (done || !match(sql)) return;
      done = true;
      await change();
    },
  });
}

// 直前の行の読み取り
const readsAfterEpic = (sql: string) =>
  sql.startsWith('select "epics"."id", "epics"."position" from "epics"') &&
  sql.includes('"epics"."id" = ?') &&
  !sql.includes('order by');

async function updateEpic(target: Target, id: string, values: Record<string, unknown>) {
  const db = orgDb(env, target.organization.verified);
  await db.run(
    db.statement((q) =>
      q.updateTable('epics').set(values).where('id', '=', id).where('workspace_id', '=', target.workspace.id),
    ),
  );
}

// 削除していないエピックの id。position、id の順
async function epicOrder(target: Target) {
  const db = orgDb(env, target.organization.verified);
  const rows = await db.rows(
    db.statement((q) =>
      q
        .selectFrom('epics')
        .select(['id', 'position'])
        .where('workspace_id', '=', target.workspace.id)
        .where('deleted_at', 'is', null)
        .orderBy('position')
        .orderBy('id'),
    ),
  );
  return rows.map((row) => row.id);
}

async function positionOf(target: Target, id: string) {
  const db = orgDb(env, target.organization.verified);
  const row = await db.first(
    db.statement((q) =>
      q.selectFrom('epics').select('position').where('id', '=', id).where('workspace_id', '=', target.workspace.id),
    ),
  );
  return row?.position;
}

async function logsOf(target: Target, entityId: string) {
  const db = orgDb(env, target.organization.verified);
  return db.rows(
    db.statement((q) =>
      q
        .selectFrom('change_logs')
        .selectAll()
        .where('entity_id', '=', entityId)
        .where('organization_id', '=', target.organization.id),
    ),
  );
}

// エピックを、指した位置の順に作る
async function epics(target: Target, positions: readonly string[]) {
  const ids: string[] = [];
  for (const position of positions) {
    ids.push((await createEpic(target.organization, target.workspace.id, target.admin.userId!, { position })).id);
  }
  return ids;
}

describe('epic-move の並べ替え', () => {
  test('先頭、途中、末尾へ移せる。履歴を書かない', async () => {
    const target = await createTarget();
    const [a, b, c, d] = await epics(target, ['a0', 'a1', 'a2', 'a3']);

    // 先頭へ
    let res = await moveEpic(target, { epic_id: c, after_epic_id: null });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ epic_id: c });
    expect(await epicOrder(target)).toEqual([c, a, b, d]);

    // 途中（a の直後）
    res = await moveEpic(target, { epic_id: c, after_epic_id: a });
    expect(res.status).toBe(200);
    expect(await epicOrder(target)).toEqual([a, c, b, d]);

    // 末尾（直前の行を省く）
    res = await moveEpic(target, { epic_id: a });
    expect(res.status).toBe(200);
    expect(await epicOrder(target)).toEqual([c, b, d, a]);

    // 最後の行の直後
    res = await moveEpic(target, { epic_id: c, after_epic_id: a });
    expect(res.status).toBe(200);
    expect(await epicOrder(target)).toEqual([b, d, a, c]);

    for (const id of [a!, b!, c!, d!]) expect(await logsOf(target, id)).toEqual([]);
  });

  test('完了と中止したエピックも並べ替えられ、その前後にも動かせる', async () => {
    const target = await createTarget();
    const adminId = target.admin.userId!;
    const [open] = await epics(target, ['a0']);
    const done = await createEpic(target.organization, target.workspace.id, adminId, {
      position: 'a1',
      completed_at: DONE_AT,
      completed_by: adminId,
    });
    const canceled = await createEpic(target.organization, target.workspace.id, adminId, {
      position: 'a2',
      canceled_at: DONE_AT,
      canceled_by: adminId,
    });

    // 完了したエピックの直後へ
    let res = await moveEpic(target, { epic_id: open, after_epic_id: done.id });
    expect(res.status).toBe(200);
    expect(await epicOrder(target)).toEqual([done.id, open, canceled.id]);

    // 中止したエピックの直後（末尾）へ
    res = await moveEpic(target, { epic_id: open, after_epic_id: canceled.id });
    expect(res.status).toBe(200);
    expect(await epicOrder(target)).toEqual([done.id, canceled.id, open]);

    // 中止したエピックを先頭へ
    res = await moveEpic(target, { epic_id: canceled.id, after_epic_id: null });
    expect(res.status).toBe(200);
    expect(await epicOrder(target)).toEqual([canceled.id, done.id, open]);

    // 完了したエピックを末尾へ
    res = await moveEpic(target, { epic_id: done.id });
    expect(res.status).toBe(200);
    expect(await epicOrder(target)).toEqual([canceled.id, open, done.id]);
  });

  test('直前の行と同じ値の行が続くときは、移す行と一緒に振り直す', async () => {
    const target = await createTarget();
    const [head] = await epics(target, ['a0']);
    const ties = (await epics(target, ['a1', 'a1', 'a1'])).sort();
    const [tail, moving] = await epics(target, ['a2', 'a3']);

    const res = await moveEpic(target, { epic_id: moving, after_epic_id: ties[0] });
    expect(res.status).toBe(200);
    expect(await epicOrder(target)).toEqual([head, ties[0], moving, ties[1], ties[2], tail]);
  });

  test('削除したエピックは並びに数えない', async () => {
    const target = await createTarget();
    const [a, b, c] = await epics(target, ['a0', 'a1', 'a2']);
    const deleted = await createEpic(target.organization, target.workspace.id, target.admin.userId!, {
      position: 'Zx',
      deleted_at: DONE_AT,
    });
    // 削除したエピックは先頭の値でも、先頭へ移すときの基準にしない（基準にすると 'Zx' より前の値になる）
    const res = await moveEpic(target, { epic_id: c, after_epic_id: null });
    expect(res.status).toBe(200);
    expect((await positionOf(target, c!))! > 'Zx').toBe(true);
    expect(await epicOrder(target)).toEqual([c, a, b]);
    expect(await positionOf(target, deleted.id)).toBe('Zx');
  });
});

describe('epic-move で断るもの', () => {
  test('無い、削除済み、別のワークスペース、別の組織のエピックと直前の行は 404、自分自身なら 400', async () => {
    const target = await createTarget();
    const foreign = await createTarget();
    const adminId = target.admin.userId!;
    const [moving] = await epics(target, ['a0']);
    const deleted = await createEpic(target.organization, target.workspace.id, adminId, { deleted_at: DONE_AT });
    const otherWorkspace = await createEpic(target.organization, target.otherWorkspace.id, adminId);
    const foreignEpic = await createEpic(foreign.organization, foreign.workspace.id, foreign.admin.userId!);
    const missing = '01900000-0000-7000-8000-000000000000';

    for (const body of [
      { epic_id: missing },
      { epic_id: deleted.id },
      { epic_id: otherWorkspace.id },
      { epic_id: foreignEpic.id },
      { epic_id: moving, after_epic_id: missing },
      { epic_id: moving, after_epic_id: deleted.id },
      { epic_id: moving, after_epic_id: otherWorkspace.id },
      { epic_id: moving, after_epic_id: foreignEpic.id },
    ]) {
      const res = await moveEpic(target, body);
      expect(res.status, JSON.stringify(body)).toBe(404);
      expect(await errorCodeOf(res)).toBe('not_found');
    }
    const self = await moveEpic(target, { epic_id: moving, after_epic_id: moving });
    expect(self.status).toBe(400);
    expect(await errorCodeOf(self)).toBe('invalid_input');
  });

  test('閉じたワークスペースでは 409 の workspace_closed', async () => {
    const target = await createTarget({ closed: true });
    const [epic] = await epics(target, ['a0']);
    const res = await moveEpic(target, { epic_id: epic, after_epic_id: null }, target.admin);
    expect(res.status).toBe(409);
    expect(await errorCodeOf(res)).toBe('workspace_closed');
  });

  test('同じ値の続きが上限を超えたら、振り直さず 409（ties）', async () => {
    const target = await createTarget();
    const ties = (
      await epics(
        target,
        Array.from({ length: MAX_TIES + 2 }, () => 'a1'),
      )
    ).sort();
    const [moving] = await epics(target, ['a2']);
    const res = await moveEpic(target, { epic_id: moving, after_epic_id: ties[0] });
    expect(res.status).toBe(409);
    expect(await errorOf(res)).toEqual({ code: 'conflict', reason: 'ties' });
    expect(await positionOf(target, moving!)).toBe('a2');
  });
});

describe('epic-move で、読んでから書くまでに別の要求が割り込んだとき', () => {
  test('直前の行が動いていたら 409（changed）で、振り直しも書かない', async () => {
    const target = await createTarget();
    const [a, b, c] = await epics(target, ['a0', 'a1', 'a2']);
    const raced = racing(readsAfterEpic, () => updateEpic(target, a!, { position: 'a5' }));
    const res = await moveEpic(target, { epic_id: c, after_epic_id: a }, target.member, raced);
    expect(res.status).toBe(409);
    expect(await errorOf(res)).toEqual({ code: 'conflict', reason: 'changed' });
    expect(await epicOrder(target)).toEqual([b, c, a]);
  });

  test('直前の行が消えていたら 404', async () => {
    const target = await createTarget();
    const [a, b, c] = await epics(target, ['a0', 'a1', 'a2']);
    const raced = racing(readsAfterEpic, () => updateEpic(target, a!, { deleted_at: '2026-10-22T00:00:00.000Z' }));
    const res = await moveEpic(target, { epic_id: c, after_epic_id: a }, target.member, raced);
    expect(res.status).toBe(404);
    expect(await errorCodeOf(res)).toBe('not_found');
    expect(await epicOrder(target)).toEqual([b, c]);
  });
});
