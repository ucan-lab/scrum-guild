// 自分の組織を作る操作の途中の失敗と、お試しの期限の境、最も早いログインの選び方。
// 組織の行を書いた後の失敗で、管理者のいない組織とお試しの枠が残らないことを確かめる
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createApp } from '../src/server/app.ts';
import { commonDb, insertSelfCreatedOrganization, orgDb } from '../src/server/db/index.ts';
import { envWithD1Hooks, verifiedOrganizationForTest } from '../src/server/db/testing.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import { createMyOrganization } from '../src/shared/operations/organization/index.ts';
import { createAccount, createAccountLogin, createOrganization, createSessionWithToken } from './factories.ts';
import { errorCodeOf, post } from './operations/harness.ts';
import { testEnv } from './operations/world.ts';

const app = createApp(implementedOperations, { fetcher: fetch });

let counter = 0;
const newSlug = () => `recover-${crypto.randomUUID().slice(0, 8)}-${counter++}`;

async function newAccount(options: { withLogin: boolean; loginName?: string } = { withLogin: true }) {
  const account = await createAccount();
  if (options.withLogin) await createAccountLogin(account.id, { login_name: options.loginName ?? 'mio-hoshino' });
  const { token } = await createSessionWithToken(account.id);
  return { accountId: account.id, token };
}
type Member = Awaited<ReturnType<typeof newAccount>>;

const create = (member: Pick<Member, 'token'>, slug: string, options: { env?: Env } = {}) =>
  post(app, createMyOrganization, { token: member.token, body: { slug, name: '青葉工房' }, ...options });

async function organizationRow(slug: string) {
  const db = commonDb(env);
  return db.first(db.statement((q) => q.selectFrom('organizations').selectAll().where('slug', '=', slug)));
}

async function organizationsOf(accountId: string) {
  const db = commonDb(env);
  return db.rows(
    db.statement((q) => q.selectFrom('organizations').selectAll().where('created_by_account_id', '=', accountId)),
  );
}

async function usersOf(organizationId: string) {
  const db = orgDb(env, verifiedOrganizationForTest(organizationId));
  return db.rows(db.statement((q) => q.selectFrom('users').selectAll().where('organization_id', '=', organizationId)));
}

const includesStatement = (sqls: readonly string[], text: string) => sqls.some((sql) => sql.includes(text));
const INSERT_USERS = 'insert into "users"';
const DELETE_ORGANIZATIONS = 'delete from "organizations"';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ログインを持たないアカウント', () => {
  test('500 になり、組織の行もお試しの枠も残らない。ログインを足して再送すれば 200', async () => {
    const member = await newAccount({ withLogin: false });
    const slug = newSlug();
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const failed = await create(member, slug);
    expect(failed.status).toBe(500);
    expect(await errorCodeOf(failed)).toBe('internal');
    expect(await organizationRow(slug)).toBeUndefined();
    expect(await organizationsOf(member.accountId)).toHaveLength(0);

    await createAccountLogin(member.accountId, { login_name: 'late-login' });
    const retried = await create(member, slug);
    expect(retried.status).toBe(200);
    const row = (await organizationRow(slug))!;
    expect(row.created_by_account_id).toBe(member.accountId);
    expect((await usersOf(row.id)).map((user) => user.name)).toEqual(['late-login']);
  });
});

describe('組織の DB の書き込みが失敗する', () => {
  test('組織の行を消して 500 を返し、同じ入力の再送が 200 になる', async () => {
    const member = await newAccount();
    const slug = newSlug();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const failing = envWithD1Hooks(testEnv, {
      beforeBatch: (sqls) => {
        if (includesStatement(sqls, INSERT_USERS)) throw new Error('組織の DB に書けない');
      },
    });

    const failed = await create(member, slug, { env: failing });
    expect(failed.status).toBe(500);
    expect(await errorCodeOf(failed)).toBe('internal');
    expect(await organizationRow(slug)).toBeUndefined();
    expect(await organizationsOf(member.accountId)).toHaveLength(0);

    const retried = await create(member, slug);
    expect(retried.status).toBe(200);
    expect(await organizationsOf(member.accountId)).toHaveLength(1);
  });

  test('組織の行を消す補償が自分の行だけを消す（同じ時刻に作られた他人の組織は残る）', async () => {
    const other = await createOrganization();
    const member = await newAccount();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const failing = envWithD1Hooks(testEnv, {
      beforeBatch: (sqls) => {
        if (includesStatement(sqls, INSERT_USERS)) throw new Error('組織の DB に書けない');
      },
    });
    expect((await create(member, newSlug(), { env: failing })).status).toBe(500);
    expect(await organizationRow(other.slug)).toBeDefined();
  });

  test('補償の DELETE も失敗したら、元の失敗を 500 で返し、組織の ID を含むログを残す。再送は trial_limit', async () => {
    const member = await newAccount({ withLogin: true, loginName: 'secret-login-name' });
    const slug = newSlug();
    const logged: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
      logged.push(String(line));
    });
    const failing = envWithD1Hooks(testEnv, {
      beforeBatch: (sqls) => {
        if (includesStatement(sqls, INSERT_USERS)) throw new Error('組織の DB に書けない');
        if (includesStatement(sqls, DELETE_ORGANIZATIONS)) throw new Error('補償の DELETE も書けない');
      },
    });

    const failed = await create(member, slug, { env: failing });
    expect(failed.status).toBe(500);
    expect(await errorCodeOf(failed)).toBe('internal');

    const row = (await organizationRow(slug))!;
    expect(row).toBeDefined();
    const compensation = logged.find((line) => line.includes(row.id));
    expect(compensation).toBeDefined();
    expect(JSON.parse(compensation!)).toMatchObject({ level: 'error', organizationId: row.id });
    expect(logged.join('\n')).not.toContain('secret-login-name');

    const retried = await create(member, newSlug());
    expect(retried.status).toBe(409);
  });

  test('users が書かれた後に失敗して外部キーで消せないときは、組織の行を残して 500 を返し、組織の ID を含むログを残す', async () => {
    const member = await newAccount();
    const slug = newSlug();
    const logged: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
      logged.push(String(line));
    });
    // 書き込みはコミットされたまま、呼び出し元には失敗が返る
    const lostResponse = envWithD1Hooks(testEnv, {
      afterBatch: (sqls) => {
        if (includesStatement(sqls, INSERT_USERS)) throw new Error('応答だけが届かない');
      },
    });

    const failed = await create(member, slug, { env: lostResponse });
    expect(failed.status).toBe(500);

    const row = (await organizationRow(slug))!;
    expect(row).toBeDefined();
    expect(await usersOf(row.id)).toHaveLength(1);
    expect(logged.some((line) => line.includes(row.id))).toBe(true);
  });
});

describe('再送と重なり', () => {
  test('同じアカウントが別の slug を送ると 409（trial_limit）', async () => {
    const member = await newAccount();
    expect((await create(member, newSlug())).status).toBe(200);
    const res = await create(member, newSlug());
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { details: unknown } }).error.details).toEqual({ reason: 'trial_limit' });
    expect(await organizationsOf(member.accountId)).toHaveLength(1);
  });

  test('同じ slug が他人の組織のものなら 409（slug_taken）で、自分の枠は使わない', async () => {
    const owner = await newAccount();
    const slug = newSlug();
    expect((await create(owner, slug)).status).toBe(200);

    const member = await newAccount();
    const res = await create(member, slug);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { details: unknown } }).error.details).toEqual({ reason: 'slug_taken' });
    expect(await organizationsOf(member.accountId)).toHaveLength(0);
    expect((await create(member, newSlug())).status).toBe(200);
  });
});

describe('お試しの期限の境', () => {
  test.each([
    ['月をまたぐ', '2026-12-02T23:59:59.000Z', '2027-01-01'],
    ['うるう日に当たる', '2028-01-30T00:00:00.000Z', '2028-02-29'],
    ['うるう年の2月の頭', '2028-02-01T00:00:00.000Z', '2028-03-02'],
    ['UTC の日付が切り替わる直前', '2026-10-01T23:59:59.999Z', '2026-10-31'],
    ['UTC の日付が切り替わる瞬間', '2026-10-02T00:00:00.000Z', '2026-11-01'],
  ])('作った時刻が%s（%s）なら期限は %s', async (_label, at, expected) => {
    const account = await createAccount();
    const slug = newSlug();
    const created = await insertSelfCreatedOrganization(testEnv, {
      slug,
      name: '青葉工房',
      accountId: account.id,
      now: new Date(at),
    });
    expect(typeof created).toBe('object');
    expect((await organizationRow(slug))?.trial_ends_on).toBe(expected);
  });
});

describe('最も早いログイン', () => {
  async function createdUserName(logins: { provider: string; subject: string; name: string; at: string }[]) {
    const account = await createAccount();
    for (const login of logins) {
      await createAccountLogin(account.id, {
        login_provider: login.provider,
        login_subject: login.subject,
        login_name: login.name,
        created_at: login.at,
      });
    }
    const { token } = await createSessionWithToken(account.id);
    const slug = newSlug();
    expect((await create({ token }, slug)).status).toBe(200);
    const users = await usersOf((await organizationRow(slug))!.id);
    return users.map((user) => user.name);
  }

  const AT = '2026-10-21T00:00:00.000Z';
  const suffix = () => crypto.randomUUID().slice(0, 8);

  test('作った日時が同じなら、手段の名前が小さい方', async () => {
    expect(
      await createdUserName([
        { provider: 'google', subject: `g-${suffix()}`, name: 'by-google', at: AT },
        { provider: 'github', subject: `h-${suffix()}`, name: 'by-github', at: AT },
      ]),
    ).toEqual(['by-github']);
  });

  test('作った日時も手段も同じなら、ID が小さい方', async () => {
    expect(
      await createdUserName([
        { provider: 'github', subject: `b-${suffix()}`, name: 'subject-b', at: AT },
        { provider: 'github', subject: `a-${suffix()}`, name: 'subject-a', at: AT },
      ]),
    ).toEqual(['subject-a']);
  });
});
