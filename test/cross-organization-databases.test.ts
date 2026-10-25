// 組織をまたいで読む関数は、組織の中の表を持つ DB ごとに引いて合わせる（docs/data-model.md の「読み書きの入口」）。
// 今は DB が1つなので、DB を2つにした場合を、入口の一覧を渡して確かめる。
// 2つ目の DB は、users の問い合わせにだけ行を返す作り物（別の DB にだけある組織の管理者の行）
import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import { listAccountOrganizationsForTest } from '../src/server/db/testing.ts';
import { createAccount, createAccountLogin, createOrganization, createUser } from './factories.ts';

function fakeDatabase(rows: Record<string, unknown>[]) {
  const queries: string[] = [];
  const database = {
    prepare: (text: string) => ({
      bind: () => ({
        all: async () => {
          queries.push(text);
          return { results: text.includes('from "users"') ? rows : [], meta: { changes: 0 } };
        },
      }),
    }),
  };
  return { database, queries };
}

describe('組織の中の DB が2つのとき', () => {
  test('どちらの DB にある組織も合わせて、名前順に返す', async () => {
    const account = await createAccount();
    const login = await createAccountLogin(account.id);
    const identity = { provider: login.login_provider, subject: login.login_subject };
    const inFirst = await createOrganization({ name: 'い工房' });
    await createUser(inFirst, {
      account_id: account.id,
      login_provider: identity.provider,
      login_subject: identity.subject,
      is_admin: 1,
    });
    // 組織の行は共通の表にあり、users の行は2つ目の DB にだけある
    const inSecond = await createOrganization({ name: 'あ工房' });
    const second = fakeDatabase([
      { id: 'second-db-user', organization_id: inSecond.id, account_id: account.id, is_admin: 1, disabled_at: null },
    ]);

    const result = await listAccountOrganizationsForTest(env, { accountId: account.id, logins: [identity] }, [
      second.database,
    ]);
    expect(result.organizations.map((item) => item.name)).toEqual(['あ工房', 'い工房']);
    expect(result.invitations).toEqual([]);
    // 2つ目の DB には、users の問い合わせと、招待の問い合わせが届いている
    expect(second.queries.some((text) => text.includes('from "users"'))).toBe(true);
    expect(second.queries.some((text) => text.includes('from "invitations"'))).toBe(true);
  });

  test('同じ組織が両方の DB に出ても、重ねずに1件にする', async () => {
    const account = await createAccount();
    const login = await createAccountLogin(account.id);
    const identity = { provider: login.login_provider, subject: login.login_subject };
    const organization = await createOrganization({ name: '重なる工房' });
    await createUser(organization, {
      account_id: account.id,
      login_provider: identity.provider,
      login_subject: identity.subject,
      is_admin: 1,
    });
    const second = fakeDatabase([
      { id: 'dup', organization_id: organization.id, account_id: account.id, is_admin: 1, disabled_at: null },
    ]);

    const result = await listAccountOrganizationsForTest(env, { accountId: account.id, logins: [identity] }, [
      second.database,
    ]);
    expect(result.organizations.map((item) => item.name)).toEqual(['重なる工房']);
  });
});

describe('不変条件が崩れたアカウント', () => {
  // アカウントは必ず1つ以上のログインを持つ。0件のときは、users の行を引き当てる手がかりが無いので空を返す
  // （enterOrganization は account_id で引くので入れる。不変条件が崩れたときの差で、ログインの付け替えや統合を入れるときに直す）
  test('ログインが0件のときは、管理者の行があっても空を返し、問い合わせも送らない', async () => {
    const account = await createAccount();
    const login = await createAccountLogin(account.id);
    const organization = await createOrganization();
    await createUser(organization, {
      account_id: account.id,
      login_provider: login.login_provider,
      login_subject: login.login_subject,
      is_admin: 1,
    });
    const second = fakeDatabase([]);

    const result = await listAccountOrganizationsForTest(env, { accountId: account.id, logins: [] }, [second.database]);
    expect(result).toEqual({ organizations: [], invitations: [] });
    expect(second.queries).toEqual([]);
  });
});
