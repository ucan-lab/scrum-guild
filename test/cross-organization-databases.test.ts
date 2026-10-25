// 組織をまたいで読み書きする関数は、組織の中の表を持つ DB ごとに引いて合わせる（docs/data-model.md の「読み書きの入口」）。
// 今は DB が1つなので、DB を2つにした場合を、入口の一覧を渡して確かめる。
// 2つ目の DB は、問い合わせに決まった行を返し、batch() で送られた書き込みを記録する作り物
// （別の DB にだけある組織の行、アカウントに結ばれる前の行、無効にされた行）
import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import { orgDb } from '../src/server/db/index.ts';
import {
  verifiedOrganizationForTest,
  hasLoginAccessForTest,
  linkLoginToAccountForTest,
  listAccountOrganizationsForTest,
  type FakeStatement,
} from '../src/server/db/testing.ts';
import {
  AT,
  createAccount,
  createAccountLogin,
  createInvitation,
  createOrganization,
  createUser,
  createWorkspace,
} from './factories.ts';

type Row = Record<string, unknown>;

// users を引く文には usersRows、結ぶ行を探す文（account_id が空の行を1件）には waitingRows を返し、ほかの文には何も返さない
function fakeDatabase(options: { usersRows?: Row[]; waitingRows?: Row[] }) {
  const queries: string[] = [];
  const writes: { text: string; values: unknown[] }[] = [];
  const database = {
    prepare: (text: string) => ({
      bind: (...values: unknown[]) => ({
        text,
        values,
        all: async () => {
          queries.push(text);
          const isUsers = text.includes('from "users"');
          // 結ぶ行を探す文だけが limit を持つ（select "id" from "users" ... limit ?）
          const isWaiting = isUsers && text.includes('limit');
          const results = isWaiting ? (options.waitingRows ?? []) : isUsers ? (options.usersRows ?? []) : [];
          return { results, meta: { changes: 0 } };
        },
      }),
    }),
    batch: async (statements: FakeStatement[]) => {
      for (const statement of statements) {
        const { text, values } = statement as unknown as { text: string; values: unknown[] };
        writes.push({ text, values });
      }
      return statements.map(() => ({ results: [], meta: { changes: 1 } }));
    },
  };
  return { database, queries, writes };
}

async function account() {
  const created = await createAccount();
  const login = await createAccountLogin(created.id);
  return { id: created.id, identity: { provider: login.login_provider, subject: login.login_subject } };
}

describe('組織の中の DB が2つのとき', () => {
  test('どちらの DB にある組織も合わせて、名前順に返す', async () => {
    const { id, identity } = await account();
    const inFirst = await createOrganization({ name: 'い工房' });
    await createUser(inFirst, {
      account_id: id,
      login_provider: identity.provider,
      login_subject: identity.subject,
      is_admin: 1,
    });
    // 組織の行は共通の表にあり、users の行は2つ目の DB にだけある
    const inSecond = await createOrganization({ name: 'あ工房' });
    const second = fakeDatabase({
      usersRows: [
        { id: 'second-db-user', organization_id: inSecond.id, account_id: id, is_admin: 1, disabled_at: null },
      ],
    });

    const result = await listAccountOrganizationsForTest(env, { accountId: id, logins: [identity] }, [second.database]);
    expect(result.organizations.map((item) => item.name)).toEqual(['あ工房', 'い工房']);
    expect(result.invitations).toEqual([]);
    // 2つ目の DB には、users の問い合わせと、招待の問い合わせが届いている
    expect(second.queries.some((text) => text.includes('from "users"'))).toBe(true);
    expect(second.queries.some((text) => text.includes('from "invitations"'))).toBe(true);
  });

  test('同じ組織が両方の DB に出ても、重ねずに1件にする', async () => {
    const { id, identity } = await account();
    const organization = await createOrganization({ name: '重なる工房' });
    await createUser(organization, {
      account_id: id,
      login_provider: identity.provider,
      login_subject: identity.subject,
      is_admin: 1,
    });
    const second = fakeDatabase({
      usersRows: [{ id: 'dup', organization_id: organization.id, account_id: id, is_admin: 1, disabled_at: null }],
    });

    const result = await listAccountOrganizationsForTest(env, { accountId: id, logins: [identity] }, [second.database]);
    expect(result.organizations.map((item) => item.name)).toEqual(['重なる工房']);
  });
});

describe('ログインのときの判定（アカウントに結ばれる前の行を数える）が、DB が2つのとき', () => {
  test('2つ目の DB にだけ、結ばれる前の行がある人も、通す。組織の選択には数えない', async () => {
    const { id, identity } = await account();
    // 組織の行は共通の表にあり、users の行は2つ目の DB にだけある（account_id が空）
    const organization = await createOrganization({ name: '2つ目の工房' });
    const second = fakeDatabase({
      usersRows: [
        { id: 'unlinked', organization_id: organization.id, account_id: null, is_admin: 1, disabled_at: null },
      ],
    });

    expect(await hasLoginAccessForTest(env, { accountId: id, logins: [identity] }, [second.database])).toBe(true);
    // 初めてのログイン（アカウントが無い）も同じ
    expect(await hasLoginAccessForTest(env, { accountId: undefined, logins: [identity] }, [second.database])).toBe(
      true,
    );
    // 組織の選択は、結ばれる前の行を数えない
    const listed = await listAccountOrganizationsForTest(env, { accountId: id, logins: [identity] }, [second.database]);
    expect(listed.organizations).toEqual([]);
  });

  test('2つ目の DB の無効な行は、1つ目の DB の招待を止める（DB をまたいで持ち越す）', async () => {
    const { id, identity } = await account();
    const owner = await createOrganization();
    const ownerUser = await createUser(owner, { is_admin: 1 });
    const workspace = await createWorkspace(owner, ownerUser.id);
    // 1つ目の DB（本物）にある組織の招待。その組織の、手段と ID が一致する無効な行は、2つ目の DB にある
    await createInvitation(owner, workspace.id, ownerUser.id, identity);
    const second = fakeDatabase({
      usersRows: [{ id: 'disabled', organization_id: owner.id, account_id: null, is_admin: 0, disabled_at: AT }],
    });

    expect(await hasLoginAccessForTest(env, { accountId: id, logins: [identity] }, [])).toBe(true);
    expect(await hasLoginAccessForTest(env, { accountId: id, logins: [identity] }, [second.database])).toBe(false);
  });

  test('2つ目の DB の管理者の行は、1つ目の DB の無効な行で止まらない（有効な行で入れる）', async () => {
    const { id, identity } = await account();
    const organization = await createOrganization();
    await createUser(organization, {
      account_id: id,
      login_provider: identity.provider,
      login_subject: identity.subject,
      disabled_at: AT,
    });
    const other = await createOrganization();
    const second = fakeDatabase({
      usersRows: [{ id: 'admin', organization_id: other.id, account_id: id, is_admin: 1, disabled_at: null }],
    });
    expect(await hasLoginAccessForTest(env, { accountId: id, logins: [identity] }, [])).toBe(false);
    expect(await hasLoginAccessForTest(env, { accountId: id, logins: [identity] }, [second.database])).toBe(true);
  });
});

describe('指名で待っていた行を結ぶことが、DB が2つのとき', () => {
  test('どちらの DB にも待っている行があれば、両方で結ぶ', async () => {
    const { id, identity } = await account();
    const organization = await createOrganization();
    const user = await createUser(organization, {
      account_id: null,
      login_provider: identity.provider,
      login_subject: identity.subject,
      is_admin: 1,
    });
    const second = fakeDatabase({ waitingRows: [{ id: 'waiting-in-second' }] });

    await linkLoginToAccountForTest(env, id, identity, new Date(AT), [second.database]);

    // 1つ目の DB（本物）の行が結ばれている
    const db = orgDb(env, verifiedOrganizationForTest(organization.id));
    const row = await db.first(
      db.statement((q) => q.selectFrom('users').select('account_id').where('id', '=', user.id)),
    );
    expect(row?.account_id).toBe(id);
    // 2つ目の DB にも、結ぶ書き込みが1回だけ届いた（account_id が空の行だけを、ログインの手段と ID で絞る）
    expect(second.writes).toHaveLength(1);
    expect(second.writes[0]!.text).toMatch(/^update "users" set "account_id" = \?, "updated_at" = \?/);
    expect(second.writes[0]!.text).toContain('"account_id" is null');
    expect(second.writes[0]!.values).toEqual([id, AT, identity.provider, identity.subject]);
  });

  test('待っている行が無い DB には、書き込みを送らない', async () => {
    const { id, identity } = await account();
    const second = fakeDatabase({ waitingRows: [] });
    await linkLoginToAccountForTest(env, id, identity, new Date(AT), [second.database]);
    expect(second.writes).toEqual([]);
    // 読む文は届いている
    expect(second.queries.some((text) => text.includes('from "users"'))).toBe(true);
  });

  test('2つ目の DB にだけ待っている行があれば、そこだけに書く', async () => {
    const { id, identity } = await account();
    const second = fakeDatabase({ waitingRows: [{ id: 'only-second' }] });
    await linkLoginToAccountForTest(env, id, identity, new Date(AT), [second.database]);
    expect(second.writes).toHaveLength(1);
  });
});

describe('不変条件が崩れたアカウント', () => {
  // アカウントは必ず1つ以上のログインを持つ。0件のときは、users の行を引き当てる手がかりが無いので空を返す
  // （enterOrganization は account_id で引くので入れる。不変条件が崩れたときの差で、ログインの付け替えや統合を入れるときに直す）
  test('ログインが0件のときは、管理者の行があっても空を返し、問い合わせも送らない', async () => {
    const { id, identity } = await account();
    const organization = await createOrganization();
    await createUser(organization, {
      account_id: id,
      login_provider: identity.provider,
      login_subject: identity.subject,
      is_admin: 1,
    });
    const second = fakeDatabase({});

    const result = await listAccountOrganizationsForTest(env, { accountId: id, logins: [] }, [second.database]);
    expect(result).toEqual({ organizations: [], invitations: [] });
    expect(await hasLoginAccessForTest(env, { accountId: id, logins: [] }, [second.database])).toBe(false);
    expect(second.queries).toEqual([]);
  });
});
