// エピックの作成、読み取り、変更の振る舞い。
// 組織の分離と権限の種類ごとの許可と拒否は、一覧を回す test/operation-registry.test.ts が確かめる
import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import { epicCreate, epicGet, epicUpdate } from '../src/shared/operations/epic/index.ts';
import { createApp } from '../src/server/app.ts';
import { orgDb, verifyWorkspace } from '../src/server/db/index.ts';
import { epicUpdateOperation } from '../src/server/operations/epic.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import { createEpic } from './factories.ts';
import { errorCodeOf, post } from './operations/harness.ts';
import { createTarget, type Person, type Target } from './operations/world.ts';

const app = createApp(implementedOperations);

type EpicBody = {
  epic: { id: string; title: string; body_md: string | null; due_on: string | null; link_url: string | null };
};

function create(target: Target, body: Record<string, unknown>, person: Person = target.member) {
  return post(app, epicCreate, {
    slug: target.slug,
    token: person.token,
    body: { workspace_id: target.workspace.id, ...body },
  });
}

function update(target: Target, epicId: string, body: Record<string, unknown>, person: Person = target.member) {
  return post(app, epicUpdate, {
    slug: target.slug,
    token: person.token,
    body: { workspace_id: target.workspace.id, epic_id: epicId, ...body },
  });
}

function get(target: Target, epicId: string, person: Person = target.member) {
  return post(app, epicGet, {
    slug: target.slug,
    token: person.token,
    body: { workspace_id: target.workspace.id, epic_id: epicId },
  });
}

async function rowOf(target: Target, epicId: string) {
  const db = orgDb(env, target.organization.verified);
  return db.first(
    db.statement((q) =>
      q.selectFrom('epics').selectAll().where('id', '=', epicId).where('workspace_id', '=', target.workspace.id),
    ),
  );
}

async function logsOf(target: Target, epicId: string) {
  const db = orgDb(env, target.organization.verified);
  return db.rows(
    db.statement((q) =>
      q
        .selectFrom('change_logs')
        .selectAll()
        .where('entity_type', '=', 'epic')
        .where('entity_id', '=', epicId)
        .where('organization_id', '=', target.organization.id)
        .orderBy('created_at'),
    ),
  );
}

function seeded(target: Target) {
  return createEpic(target.organization, target.workspace.id, target.admin.userId!, {
    title: '元のタイトル',
    body_md: '元の本文',
    due_on: '2026-10-30',
    link_url: 'https://example.com/old',
  });
}

describe('epic-create', () => {
  test('エピックの末尾に、依頼主は作った人、クリア報酬は中で書き、変更の履歴を残す', async () => {
    const target = await createTarget();
    const first = await create(target, {
      title: '  会員ランクを公開する  ',
      body_md: '\n\n  本文  \n',
      due_on: '2026-11-30',
      link_url: ' HTTPS://Example.com/rank ',
    });
    expect(first.status).toBe(200);
    const { epic } = (await first.json()) as EpicBody;
    expect(epic).toMatchObject({
      title: '会員ランクを公開する',
      body_md: '  本文',
      due_on: '2026-11-30',
      link_url: 'https://example.com/rank',
    });

    const second = await create(target, { title: '二つ目' });
    const secondEpic = ((await second.json()) as EpicBody).epic;
    expect(secondEpic).toMatchObject({ body_md: null, due_on: null, link_url: null });

    const one = (await rowOf(target, epic.id))!;
    const two = (await rowOf(target, secondEpic.id))!;
    expect(one).toMatchObject({
      workspace_id: target.workspace.id,
      reward_tier: 'medium',
      requester_user_id: target.member.userId,
      created_by: target.member.userId,
      category_id: null,
      completed_at: null,
      canceled_at: null,
      deleted_at: null,
    });
    expect(two.position > one.position).toBe(true);

    const logs = await logsOf(target, epic.id);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ actor_user_id: target.member.userId, action: 'create' });
    expect(JSON.parse(logs[0]!.changes_json)).toEqual({
      title: [null, '会員ランクを公開する'],
      body_md: [null, '  本文'],
      due_on: [null, '2026-11-30'],
      link_url: [null, 'https://example.com/rank'],
    });
  });

  test.each([
    ['タイトルが空', { title: '   ' }],
    ['タイトルが201字', { title: 'あ'.repeat(201) }],
    ['本文が1万字を超える', { title: 'x', body_md: 'あ'.repeat(10_001) }],
    ['期日が暦に無い', { title: 'x', due_on: '2026-02-30' }],
    ['リンクが javascript', { title: 'x', link_url: 'javascript:alert(1)' }],
  ])('%s は 400', async (_name, body) => {
    const target = await createTarget();
    const res = await create(target, body);
    expect(res.status).toBe(400);
    expect(await errorCodeOf(res)).toBe('invalid_input');
  });

  test('閉じたワークスペースでは 409 の workspace_closed で、何も書かない', async () => {
    const target = await createTarget({ closed: true });
    const res = await create(target, { title: 'x' }, target.admin);
    expect(res.status).toBe(409);
    expect(await errorCodeOf(res)).toBe('workspace_closed');
    const db = orgDb(env, target.organization.verified);
    expect(
      await db.rows(
        db.statement((q) => q.selectFrom('epics').select('id').where('workspace_id', '=', target.workspace.id)),
      ),
    ).toEqual([]);
  });
});

describe('epic-get', () => {
  test('ダイアログに出す欄を全部返す。閉じたワークスペースでも読める', async () => {
    const target = await createTarget();
    const epic = await seeded(target);
    const res = await get(target, epic.id);
    expect(res.status).toBe(200);
    expect(((await res.json()) as EpicBody).epic).toEqual({
      id: epic.id,
      title: '元のタイトル',
      body_md: '元の本文',
      due_on: '2026-10-30',
      link_url: 'https://example.com/old',
    });

    const closed = await createTarget({ closed: true });
    const closedEpic = await seeded(closed);
    expect((await get(closed, closedEpic.id, closed.admin)).status).toBe(200);
  });

  test('別の組織・別のワークスペース・削除済み・存在しないエピックは 404', async () => {
    const target = await createTarget();
    const foreign = await createTarget();
    const adminId = target.admin.userId!;
    const ids = [
      (await createEpic(foreign.organization, foreign.workspace.id, foreign.admin.userId!)).id,
      (await createEpic(target.organization, target.otherWorkspace.id, adminId)).id,
      (await createEpic(target.organization, target.workspace.id, adminId, { deleted_at: '2026-10-21T00:00:00.000Z' }))
        .id,
      '019a0000-0000-7000-8000-00000000ffff',
    ];
    for (const id of ids) {
      const res = await get(target, id);
      expect(res.status, id).toBe(404);
      expect(await errorCodeOf(res)).toBe('not_found');
    }
  });
});

describe('epic-update', () => {
  test('送った欄のうち変わるものだけを書き、変えた欄だけ [前, 後] で履歴に残す', async () => {
    const target = await createTarget();
    const epic = await seeded(target);
    const res = await update(target, epic.id, { title: '  新しいタイトル  ', due_on: null, body_md: '元の本文' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as EpicBody).epic).toMatchObject({
      title: '新しいタイトル',
      body_md: '元の本文',
      due_on: null,
      link_url: 'https://example.com/old',
    });
    const logs = await logsOf(target, epic.id);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ action: 'update', actor_user_id: target.member.userId });
    expect(JSON.parse(logs[0]!.changes_json)).toEqual({
      title: ['元のタイトル', '新しいタイトル'],
      due_on: ['2026-10-30', null],
    });
  });

  test('変わる欄が無ければ、何も書かず、履歴も残さない', async () => {
    const target = await createTarget();
    const epic = await seeded(target);
    const res = await update(target, epic.id, { title: '元のタイトル' });
    expect(res.status).toBe(200);
    expect(await rowOf(target, epic.id)).toEqual(epic);
    expect(await logsOf(target, epic.id)).toEqual([]);
  });

  test('同時に別の欄を直しても、両方が残る', async () => {
    const target = await createTarget();
    const epic = await seeded(target);
    const results = await Promise.all([
      update(target, epic.id, { title: 'Aのタイトル' }, target.member),
      update(target, epic.id, { link_url: 'https://example.com/new' }, target.leader),
    ]);
    expect(results.map((res) => res.status)).toEqual([200, 200]);
    expect(await rowOf(target, epic.id)).toMatchObject({ title: 'Aのタイトル', link_url: 'https://example.com/new' });
    expect(await logsOf(target, epic.id)).toHaveLength(2);
  });

  test('別の組織・別のワークスペース・削除済み・存在しないエピックは 404 で、何も書かない', async () => {
    const target = await createTarget();
    const foreign = await createTarget();
    const foreignEpic = await createEpic(foreign.organization, foreign.workspace.id, foreign.admin.userId!);
    const elsewhere = await createEpic(target.organization, target.otherWorkspace.id, target.admin.userId!);
    for (const id of [foreignEpic.id, elsewhere.id, '019a0000-0000-7000-8000-00000000ffff']) {
      const res = await update(target, id, { title: '書き換える' });
      expect(res.status, id).toBe(404);
      expect(await errorCodeOf(res)).toBe('not_found');
    }
    expect((await rowOf(foreign, foreignEpic.id))!.title).toBe(foreignEpic.title);
  });

  test('閉じたワークスペースでは 409 の workspace_closed で、何も書かない', async () => {
    const target = await createTarget({ closed: true });
    const epic = await seeded(target);
    const res = await update(target, epic.id, { title: '書き換える' }, target.admin);
    expect(res.status).toBe(409);
    expect(await errorCodeOf(res)).toBe('workspace_closed');
    expect(await rowOf(target, epic.id)).toEqual(epic);
  });

  describe('同じ欄を同時に変える要求', () => {
    // 処理を直に呼ぶ。エピックを読む文が答えを返した直後に、race を呼ぶ（n は何回目の読み取りか）
    async function updateWithRace(
      target: Target,
      input: Record<string, unknown>,
      race: (n: number, db: ReturnType<typeof orgDb>) => Promise<void>,
    ) {
      const db = orgDb(env, target.organization.verified);
      const actor = {
        accountId: target.member.accountId,
        userId: target.member.userId,
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
            if ((result as { title?: string } | undefined)?.title !== undefined) await race(++reads, base);
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
      return epicUpdateOperation.handler(context) as Promise<EpicBody>;
    }

    test('先に別の要求が同じ欄を変えたら、読み直してやり直し、履歴が [元, A]、[A, B] と連なる', async () => {
      const target = await createTarget();
      const epic = await seeded(target);
      const result = await updateWithRace(target, { epic_id: epic.id, title: 'B' }, async (n) => {
        if (n === 1) expect((await update(target, epic.id, { title: 'A' }, target.leader)).status).toBe(200);
      });
      expect(result.epic.title).toBe('B');
      const titles = (await logsOf(target, epic.id)).map((log) => JSON.parse(log.changes_json).title);
      expect(titles).toContainEqual(['元のタイトル', 'A']);
      expect(titles).toContainEqual(['A', 'B']);
    });

    test('負け続けて3回やり直しても書けなければ、409 の conflict で、履歴は書かない', async () => {
      const target = await createTarget();
      const epic = await seeded(target);
      await expect(
        updateWithRace(target, { epic_id: epic.id, title: 'Z' }, async (n, base) => {
          await base.run(
            base.statement((q) =>
              q
                .updateTable('epics')
                .set({ title: `割り込み ${n}` })
                .where('id', '=', epic.id)
                .where('workspace_id', '=', target.workspace.id),
            ),
          );
        }),
      ).rejects.toMatchObject({ status: 409, code: 'conflict' });
      expect(await logsOf(target, epic.id)).toEqual([]);
    });
  });
});
