// ログインの結合テストが共有する、行の読み書きと入れ物。D1 は入口（commonDb、orgDb）とファクトリーを通す
import { env } from 'cloudflare:workers';
import { commonDb, orgDb } from '../../src/server/db/index.ts';
import { envWithD1Hooks, verifiedOrganizationForTest } from '../../src/server/db/testing.ts';
import { createOrganization, createUser, createWorkspace } from '../factories.ts';
import type { FakeGithubUser } from './fake-github.ts';
import type { FakeGoogleUser } from './fake-google.ts';

// 一意の GitHub のユーザー。実在の人に当たらないよう、架空の名前と ID にする
let nextGithubId = 7_000_000;
export function githubUser(login: string, overrides: Partial<FakeGithubUser> = {}): FakeGithubUser {
  return {
    id: nextGithubId++,
    login,
    name: '星野 澪',
    avatar_url: 'https://avatars.githubusercontent.com/u/7000000',
    ...overrides,
  };
}

// 一意の Google の人。sub は数値に直すと桁が落ちる長さの文字列
let nextGoogleSub = 118_234_567_890_123_456_000n;
export function googleUser(name: string | null, overrides: Partial<FakeGoogleUser> = {}): FakeGoogleUser {
  const sub = String(nextGoogleSub++);
  return {
    sub,
    name,
    picture: 'https://lh3.googleusercontent.com/a/fake-avatar',
    email: `user-${sub}@example.test`,
    email_verified: true,
    ...overrides,
  };
}

export async function googleAccountLoginOf(user: FakeGoogleUser) {
  const db = commonDb(env);
  return db.first(
    db.statement((q) =>
      q
        .selectFrom('account_logins')
        .selectAll()
        .where('login_provider', '=', 'google')
        .where('login_subject', '=', user.sub),
    ),
  );
}

export async function accountLoginOf(user: FakeGithubUser) {
  const db = commonDb(env);
  return db.first(
    db.statement((q) =>
      q
        .selectFrom('account_logins')
        .selectAll()
        .where('login_provider', '=', 'github')
        .where('login_subject', '=', String(user.id)),
    ),
  );
}

export async function countAccounts(): Promise<number> {
  const db = commonDb(env);
  return (await db.rows(db.statement((q) => q.selectFrom('accounts').select('id')))).length;
}

export async function sessionRowsOf(accountId: string) {
  const db = commonDb(env);
  return db.rows(db.statement((q) => q.selectFrom('sessions').selectAll().where('account_id', '=', accountId)));
}

export async function stateRow(state: string) {
  const db = commonDb(env);
  return db.first(db.statement((q) => q.selectFrom('oauth_states').selectAll().where('state', '=', state)));
}

// 組織を1つ作り、その管理者（ユーザーの行だけで、アカウントは持たない）と、ワークスペースを返す
export async function organizationWithAdmin() {
  const organization = await createOrganization();
  const admin = await createUser(organization, { is_admin: 1, name: '管理者' });
  const workspace = await createWorkspace(organization, admin.id);
  return { organization, admin, workspace };
}

export async function userRow(organizationId: string, login: FakeGithubUser) {
  const db = orgDb(env, verifiedOrganizationForTest(organizationId));
  return db.first(
    db.statement((q) =>
      q
        .selectFrom('users')
        .selectAll()
        .where('organization_id', '=', organizationId)
        .where('login_subject', '=', String(login.id)),
    ),
  );
}

// 条件に合う SQL の最初の問い合わせが答えを返した直後に、別の処理（action）を1回だけ割り込ませる D1。
// 並行したログインの実行の順を固定するのに使う（読んだ後、次の文を送る前に、もう片方を最後まで進める）
export function afterFirstQuery(base: Env, matches: (sql: string) => boolean, action: () => Promise<void>): Env {
  let done = false;
  return envWithD1Hooks(base, {
    afterQuery: async (sql) => {
      if (done || !matches(sql)) return;
      done = true;
      await action();
    },
  });
}

// users への書き込みを含む batch() だけが失敗する D1。例外の message には SQL や接続の詳細が混ざりうる
export function failUserWrites(base: Env): Env {
  return envWithD1Hooks(base, {
    beforeBatch: (sqls) => {
      if (sqls.some((sql) => sql.startsWith('update "users"'))) throw new Error('secret SQL detail');
    },
  });
}
