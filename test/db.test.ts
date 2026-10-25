import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import { commonDb, orgDb, sql } from '../src/server/db/index.ts';
import { AT, createAccount, createOrganization, createTask, createUser, createWorkspace, uuidv7 } from './factories.ts';

describe('commonDb', () => {
  test('入れた行を読める', async () => {
    const account = await createAccount();
    const db = commonDb(env);
    const row = await db.first(db.statement((q) => q.selectFrom('accounts').selectAll().where('id', '=', account.id)));
    expect(row).toEqual(account);
  });

  test('該当が無ければ first は undefined、rows は空', async () => {
    const db = commonDb(env);
    const find = () => db.statement((q) => q.selectFrom('accounts').selectAll().where('id', '=', uuidv7()));
    expect(await db.first(find())).toBeUndefined();
    expect(await db.rows(find())).toEqual([]);
  });

  test('値は SQL に埋めずに束縛する', () => {
    const db = commonDb(env);
    const { query } = db.statement((q) => q.selectFrom('accounts').selectAll().where('id', '=', "x' OR '1'='1"));
    expect(query.sql).not.toContain('OR');
    expect(query.parameters).toEqual(["x' OR '1'='1"]);
  });

  test('SELECT 1 が通る', async () => {
    const db = commonDb(env);
    expect(await db.first(db.statement((q) => q.selectNoFrom(sql<number>`1`.as('ok'))))).toEqual({ ok: 1 });
  });
});

describe('run', () => {
  test('更新した行の数を changes で返す', async () => {
    const account = await createAccount();
    const db = commonDb(env);
    const update = (id: string) =>
      db.statement((q) =>
        q.updateTable('accounts').set({ updated_at: '2026-10-21T00:00:00.000Z' }).where('id', '=', id),
      );
    expect((await db.run(update(account.id))).changes).toBe(1);
    expect((await db.run(update(uuidv7()))).changes).toBe(0);
  });
});

describe('batch', () => {
  test('文ごとの結果と changes を返す', async () => {
    const first = await createAccount();
    const second = await createAccount();
    const db = commonDb(env);
    const touch = (id: string) =>
      db.statement((q) => q.updateTable('accounts').set({ last_login_at: AT }).where('id', '=', id));
    const results = await db.batch([
      touch(first.id),
      touch(uuidv7()),
      db.statement((q) => q.selectFrom('accounts').select('id').where('id', '=', second.id)),
    ]);
    expect(results.map((result) => result.changes)).toEqual([1, 0, 0]);
    expect(results[2].rows).toEqual([{ id: second.id }]);
  });

  test('空の配列は何も送らない', async () => {
    expect(await commonDb(env).batch([])).toEqual([]);
  });

  test('共通の入口の途中の文が失敗すると、前の文も書かれない', async () => {
    const account = await createAccount();
    const db = commonDb(env);
    const insertedId = uuidv7();
    const insert = (id: string) =>
      db.statement((q) => q.insertInto('accounts').values({ id, last_login_at: null, created_at: AT, updated_at: AT }));
    await expect(
      db.batch([
        insert(insertedId),
        // 主キーが重なって落ちる
        insert(account.id),
      ]),
    ).rejects.toThrow(/UNIQUE/);
    const found = await db.first(
      db.statement((q) => q.selectFrom('accounts').select('id').where('id', '=', insertedId)),
    );
    expect(found).toBeUndefined();
  });

  test('組織の入口でも、途中の文が失敗すると前の文も書かれない', async () => {
    const organization = await createOrganization();
    const user = await createUser(organization);
    const db = orgDb(env, organization.verified);
    const workspaceId = uuidv7();
    await expect(
      db.batch([
        db.statement((q) =>
          q.insertInto('workspaces').values({
            id: workspaceId,
            organization_id: organization.id,
            name: '青葉チーム',
            timezone: 'Asia/Tokyo',
            created_by: user.id,
            created_at: AT,
            updated_at: AT,
          }),
        ),
        // 存在しない親を指して、外部キーに落ちる
        db.statement((q) =>
          q.insertInto('memberships').values({
            id: uuidv7(),
            workspace_id: workspaceId,
            user_id: uuidv7(),
            role: 'member',
            joined_on: '2026-10-01',
            joined_at: AT,
          }),
        ),
      ]),
    ).rejects.toThrow(/FOREIGN KEY/);
    const found = await db.first(
      db.statement((q) =>
        q
          .selectFrom('workspaces')
          .select('id')
          .where('organization_id', '=', organization.id)
          .where('id', '=', workspaceId),
      ),
    );
    expect(found).toBeUndefined();
  });
});

describe('orgDb', () => {
  test('組織で絞って読める', async () => {
    const organization = await createOrganization();
    const user = await createUser(organization);
    const workspace = await createWorkspace(organization, user.id);
    const task = await createTask(organization, workspace.id, user.id);
    const db = orgDb(env, organization.verified);
    const found = await db.first(
      db.statement((q) =>
        q
          .selectFrom('tasks')
          .innerJoin('workspaces', 'workspaces.id', 'tasks.workspace_id')
          .select(['tasks.id', 'tasks.title'])
          .where('workspaces.organization_id', '=', organization.id)
          .where('tasks.id', '=', task.id),
      ),
    );
    expect(found).toEqual({ id: task.id, title: task.title });
  });

  test('組織を確かめた結果でないものは、キャストで通しても実行時に止める', () => {
    expect(() => orgDb(env, { organizationId: uuidv7() } as never)).toThrow(/組織を確かめた結果ではない/);
  });

  test('別の入口の文は、キャストで通しても実行時に止める', async () => {
    const organization = await createOrganization();
    const common = commonDb(env);
    const statement = common.statement((q) => q.selectFrom('accounts').selectAll());
    await expect(orgDb(env, organization.verified).run(statement as never)).rejects.toThrow(/入口で実行できない/);
    await expect(orgDb(env, organization.verified).batch([statement as never])).rejects.toThrow(/入口で実行できない/);
  });
});
