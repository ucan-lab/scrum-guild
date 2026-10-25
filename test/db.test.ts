import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import { commonDb, orgDb, pingDatabase } from '../src/server/db/index.ts';
import { compiledQueryForTest, verifiedOrganizationForTest } from '../src/server/db/testing.ts';
import {
  AT,
  createAccount,
  createOrganization,
  createTask,
  createUser,
  createWorkspace,
  hash64,
  uuidv7,
} from './factories.ts';

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
    const { sql, parameters } = compiledQueryForTest(
      db.statement((q) => q.selectFrom('accounts').selectAll().where('id', '=', "x' OR '1'='1")),
    );
    expect(sql).not.toContain('OR');
    expect(parameters).toEqual(["x' OR '1'='1"]);
  });

  test('pingDatabase は D1 に届けば通る', async () => {
    await expect(pingDatabase(env)).resolves.toBeUndefined();
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

// D1 は件数 0 の文では戻さない。先に読んだ値で判定した書き込みは、後ろの文にも同じ条件を付ける
describe('batch の件数 0 の文', () => {
  const UPDATED_AT = '2026-10-21T00:00:00.000Z';

  async function setup() {
    const account = await createAccount();
    const db = commonDb(env);
    // 先に読んだ updated_at が expected のときだけ更新する
    const update = (expected: string) =>
      db.statement((q) =>
        q
          .updateTable('accounts')
          .set({ updated_at: UPDATED_AT })
          .where('id', '=', account.id)
          .where('updated_at', '=', expected),
      );
    const session = (tokenHash: string, guarded: boolean) =>
      db.statement((q) =>
        q
          .insertInto('sessions')
          .columns(['token_hash', 'account_id', 'created_at', 'last_used_at', 'expires_at'])
          .expression((eb) =>
            eb
              .selectFrom('accounts')
              .select([
                eb.val(tokenHash).as('token_hash'),
                'id as account_id',
                eb.val(AT).as('created_at'),
                eb.val(AT).as('last_used_at'),
                eb.val(AT).as('expires_at'),
              ])
              .where('id', '=', account.id)
              // 前の文が書いた値で見る。前の文が 0 件なら、この条件は成り立たない
              .$if(guarded, (qb) => qb.where('updated_at', '=', UPDATED_AT)),
          ),
      );
    const sessionExists = async (tokenHash: string) =>
      (await db.first(
        db.statement((q) => q.selectFrom('sessions').select('token_hash').where('token_hash', '=', tokenHash)),
      )) !== undefined;
    return { account, update, session, sessionExists, db };
  }

  test('条件が成り立てば、前の文も後ろの文も書かれる', async () => {
    const { account, update, session, sessionExists, db } = await setup();
    const tokenHash = hash64();
    const results = await db.batch([update(account.updated_at), session(tokenHash, true)]);
    expect(results.map((result) => result.changes)).toEqual([1, 1]);
    expect(await sessionExists(tokenHash)).toBe(true);
  });

  test('前の文が 0 件でも、後ろの文に同じ条件が無ければ書かれる', async () => {
    const { update, session, sessionExists, db } = await setup();
    const tokenHash = hash64();
    const results = await db.batch([update('stale'), session(tokenHash, false)]);
    expect(results.map((result) => result.changes)).toEqual([0, 1]);
    expect(await sessionExists(tokenHash)).toBe(true);
  });

  test('後ろの文にも同じ条件を付ければ、前の文が 0 件のとき書かれない', async () => {
    const { update, session, sessionExists, db } = await setup();
    const tokenHash = hash64();
    const results = await db.batch([update('stale'), session(tokenHash, true)]);
    expect(results.map((result) => result.changes)).toEqual([0, 0]);
    expect(await sessionExists(tokenHash)).toBe(false);
  });
});

describe('束縛の数', () => {
  const ids = (count: number) => Array.from({ length: count }, () => uuidv7());
  const find = (db: ReturnType<typeof commonDb>, count: number) =>
    db.statement((q) => q.selectFrom('accounts').select('id').where('id', 'in', ids(count)));

  test('D1 の上限の100個までは通る', async () => {
    const db = commonDb(env);
    expect(await db.rows(find(db, 100))).toEqual([]);
  });

  test('100個を超えた文は、番号を添えて送る前に止め、SQL と値を出さない', async () => {
    const db = commonDb(env);
    const secret = '秘密の値';
    const tooMany = db.statement((q) =>
      q
        .selectFrom('accounts')
        .select('id')
        .where('id', 'in', [...ids(100), secret]),
    );
    const error = await db.run(tooMany).then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/101 個/);
    expect((error as Error).message).not.toContain(secret);
    expect((error as Error).message).not.toContain('select');

    await expect(db.batch([find(db, 1), find(db, 101)])).rejects.toThrow(/batch の 2 番目の文/);
  });
});

describe('orgDb', () => {
  async function organizationWithTask() {
    const organization = await createOrganization();
    const user = await createUser(organization);
    const workspace = await createWorkspace(organization, user.id);
    const task = await createTask(organization, workspace.id, user.id);
    return { organization, task };
  }

  // 組織の絞り込みは入口に付かない。呼び出し側が、入口が持つ確かめた組織の ID で絞る
  function taskIn(db: ReturnType<typeof orgDb>, taskId: string) {
    return db.statement((q) =>
      q
        .selectFrom('tasks')
        .innerJoin('workspaces', 'workspaces.id', 'tasks.workspace_id')
        .select(['tasks.id', 'tasks.title'])
        .where('workspaces.organization_id', '=', db.organizationId)
        .where('tasks.id', '=', taskId),
    );
  }

  test('組織で絞って読め、別の組織の行は返さない', async () => {
    const mine = await organizationWithTask();
    const other = await organizationWithTask();
    const db = orgDb(env, mine.organization.verified);
    expect(await db.first(taskIn(db, mine.task.id))).toEqual({ id: mine.task.id, title: mine.task.title });
    expect(await db.first(taskIn(db, other.task.id))).toBeUndefined();
  });

  test('入口は確かめた組織の ID を読み取り専用で持つ', () => {
    const id = uuidv7();
    const db = orgDb(env, verifiedOrganizationForTest(id));
    expect(db.organizationId).toBe(id);
    expect(() => {
      (db as { organizationId: string }).organizationId = uuidv7();
    }).toThrow(TypeError);
    expect(db.organizationId).toBe(id);
  });
});

describe('入口の実行時の検査', () => {
  test('組織を確かめた結果でないものは、キャストで通しても止める', () => {
    expect(() => orgDb(env, { organizationId: uuidv7() } as never)).toThrow(/組織を確かめた結果ではない/);
  });

  test('別の範囲の入口の文は、キャストで通しても止める', async () => {
    const organization = await createOrganization();
    const statement = commonDb(env).statement((q) => q.selectFrom('accounts').selectAll());
    const db = orgDb(env, organization.verified);
    await expect(db.run(statement as never)).rejects.toThrow(/この入口が作った文ではない/);
    await expect(db.batch([statement as never])).rejects.toThrow(/この入口が作った文ではない/);
  });

  test('同じ範囲でも、別の入口のインスタンスの文は止める', async () => {
    const mine = await createOrganization();
    const other = await createOrganization();
    const statement = orgDb(env, other.verified).statement((q) => q.selectFrom('users').selectAll());
    await expect(orgDb(env, mine.verified).rows(statement)).rejects.toThrow(/この入口が作った文ではない/);
    // 同じ組織でも、入口を作り直したら別のインスタンス
    await expect(orgDb(env, other.verified).rows(statement)).rejects.toThrow(/この入口が作った文ではない/);
    const common = commonDb(env).statement((q) => q.selectFrom('accounts').selectAll());
    await expect(commonDb(env).rows(common)).rejects.toThrow(/この入口が作った文ではない/);
  });

  test('文の範囲を付け替えたものと、形だけのオブジェクトは止める', async () => {
    const db = commonDb(env);
    const statement = db.statement((q) => q.selectFrom('accounts').selectAll());
    const spread = { ...statement, scope: 'common' };
    const query = { sql: 'select 1', parameters: [] };
    for (const forged of [spread, { scope: 'common', query }, query, null, 'select 1']) {
      await expect(db.run(forged as never)).rejects.toThrow(/この入口が作った文ではない/);
      await expect(db.batch([forged as never])).rejects.toThrow(/この入口が作った文ではない/);
    }
    // Object.create で作った同じ型の値も、入口が作ったものではない
    const created = Object.create(Object.getPrototypeOf(statement));
    await expect(db.run(created)).rejects.toThrow(/この入口が作った文ではない/);
  });
});

describe('VerifiedOrganization', () => {
  const verified = verifiedOrganizationForTest(uuidv7());

  test('値を書き換えられない', () => {
    expect(Object.isFrozen(verified)).toBe(true);
    expect(() => {
      (verified as { organizationId: string }).organizationId = uuidv7();
    }).toThrow(TypeError);
  });

  test('手に入れた値の constructor から作り直せない', () => {
    const Constructor = verified.constructor as new (...args: unknown[]) => unknown;
    expect(() => new Constructor(Symbol('issue'), uuidv7())).toThrow();
    expect(() => new Constructor(undefined, uuidv7())).toThrow();
    expect(() => new Constructor()).toThrow();
  });

  test('同じ形のオブジェクトや複製は、組織の中の入口に渡せない', () => {
    const forged = [
      { organizationId: verified.organizationId },
      { ...verified },
      Object.create(Object.getPrototypeOf(verified), { organizationId: { value: uuidv7() } }),
      structuredClone({ organizationId: verified.organizationId }),
    ];
    for (const value of forged) {
      expect(() => orgDb(env, value as never)).toThrow(/組織を確かめた結果ではない/);
    }
  });
});
