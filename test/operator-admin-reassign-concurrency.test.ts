// 運用者による管理者の指名し直し（organization-admin-reassign、Issue #217）の、並行と結び直しを確かめる。
// 並行した2回の指名し直し、招待の URL からの結びとログインの結びとの並行、結ばれていない自分の行を持つアカウントのある人、
// Google で指名した既にいる無効の人（基本の振る舞いは test/operator-admin-reassign.test.ts）
import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import { organizationAdminReassign as reassign } from '../src/shared/operations/operator/index.ts';
import { organizationInfo } from '../src/shared/operations/organization/index.ts';
import { randomToken, sha256Hex } from '../src/server/auth/tokens.ts';
import { claimPendingLogin, linkLoginToAccount, orgDb } from '../src/server/db/index.ts';
import {
  envWithD1Hooks,
  reassignOrganizationAdminForTest,
  verifiedOrganizationForTest,
} from '../src/server/db/testing.ts';
import { createFakeGithub } from './auth/fake-github.ts';
import { createFakeGoogle } from './auth/fake-google.ts';
import { createLoginApp, FakeBrowser, loginEnv } from './auth/browser.ts';
import { githubUser, googleUser } from './auth/helpers.ts';
import { createAccount, createOrganization, createUser, type OrganizationFixture } from './factories.ts';
import { post } from './operations/harness.ts';
import { createPerson, getOperator, OPERATOR_LOGIN_ID, withNewSession } from './operations/world.ts';

const github = createFakeGithub();
const google = createFakeGoogle();
const app = createLoginApp(github, google);
const newBrowser = () => new FakeBrowser(app, github, loginEnv, undefined, google);

const DAY_MS = 24 * 60 * 60 * 1000;
const inDays = (days: number) => new Date(Date.now() + days * DAY_MS).toISOString();

const orgDbOf = (organizationId: string) => orgDb(env, verifiedOrganizationForTest(organizationId));

async function usersOf(organizationId: string) {
  const db = orgDbOf(organizationId);
  return db.rows(
    db.statement((q) =>
      q.selectFrom('users').selectAll().where('organization_id', '=', organizationId).orderBy('created_at'),
    ),
  );
}

async function userChangeLogsOf(organizationId: string) {
  const db = orgDbOf(organizationId);
  return db.rows(
    db.statement((q) =>
      q
        .selectFrom('change_logs')
        .selectAll()
        .where('organization_id', '=', organizationId)
        .where('entity_type', '=', 'user'),
    ),
  );
}

async function operatorToken(): Promise<string> {
  return (await withNewSession(await getOperator())).token;
}

const githubNominee = (subject: string, name: string, accountId: string | null = null) => ({
  provider: 'github',
  subject,
  name,
  accountId,
});

// GitHub でまだログインしていない指名（運用者の指名が作る行と同じ形）
function pendingGithubAdmin(organization: OrganizationFixture, overrides: Parameters<typeof createUser>[1] = {}) {
  return createUser(organization, { account_id: null, is_admin: 1, name: 'kaede-dev', ...overrides });
}

// Google の指名で待つ行（運用者の指名が作る行と同じ形）。秘密も返す
async function waitingGoogleAdmin(organization: OrganizationFixture, email: string) {
  const token = randomToken();
  const row = await createUser(organization, {
    account_id: null,
    login_provider: 'google',
    login_subject: null,
    login_email: email,
    claim_token_hash: await sha256Hex(token),
    claim_expires_at: inDays(14),
    name: email,
    is_admin: 1,
  });
  return { row, token };
}

// 指名し直しの最初の users の読み取り（指名する人と前の指名を読む文）の直後に、1回だけ action を流す env
function afterFirstUsersRead(action: () => Promise<void>) {
  let armed = true;
  const state = { raced: false };
  const racingEnv = envWithD1Hooks(env, {
    afterQuery: async (sql) => {
      if (!armed || !sql.includes('from "users"')) return;
      armed = false;
      await action();
      state.raced = true;
    },
  });
  return { racingEnv, state };
}

describe('並行した2回の指名し直し', () => {
  // 運用者 B が前の指名を読んだ後、書く前に、別の指名し直し（A）が終わる。B が後に書いたので、残る前の指名は B の指名だけのはず
  test('後に書いた指名し直しの後に、先の指名し直しのまだログインしていない指名が残らない', async () => {
    const organization = await createOrganization();
    await pendingGithubAdmin(organization, { name: 'old-dev' });
    let first: Awaited<ReturnType<typeof reassignOrganizationAdminForTest>> | undefined;
    const { racingEnv, state } = afterFirstUsersRead(async () => {
      first = await reassignOrganizationAdminForTest(env, organization.id, {
        operator: OPERATOR_LOGIN_ID,
        nominee: githubNominee('8410001', 'first-dev'),
        now: new Date(),
      });
    });
    const second = await reassignOrganizationAdminForTest(racingEnv, organization.id, {
      operator: OPERATOR_LOGIN_ID,
      nominee: githubNominee('8410002', 'second-dev'),
      now: new Date(),
    });
    expect(state.raced).toBe(true);
    expect(first).toMatchObject({ outcome: 'created' });
    const waiting = (await usersOf(organization.id)).filter((row) => row.account_id === null);
    // 競合として断るか、後の指名だけを残すかのどちらか。先の指名（first-dev）が、ログインすれば管理者になれる行として残らない
    if (second === 'conflict') {
      expect(waiting.map((row) => row.name)).toEqual(['first-dev']);
    } else {
      expect(waiting.map((row) => row.id)).toEqual([second.userId]);
    }
  });
});

describe('結ぶ処理との並行', () => {
  test('前の指名を読んだ後、書く前に Google の招待の URL から結ばれたら、その行は消さず、取り消しの記録も残さない', async () => {
    const organization = await createOrganization();
    const email = 'kohaku.mizuse@example.com';
    const waiting = await waitingGoogleAdmin(organization, email);
    const sub = '118234567890999000001';
    const account = await createAccount();
    const { racingEnv, state } = afterFirstUsersRead(async () => {
      const claimed = await claimPendingLogin(env, {
        tokenHash: await sha256Hex(waiting.token),
        email,
        login: { provider: 'google', subject: sub },
        name: '水瀬 琥珀',
        now: new Date(),
      });
      expect(claimed).toEqual({ kind: 'user', organizationSlug: organization.slug });
      await linkLoginToAccount(env, account.id, { provider: 'google', subject: sub }, new Date());
    });
    const result = await reassignOrganizationAdminForTest(racingEnv, organization.id, {
      operator: OPERATOR_LOGIN_ID,
      nominee: githubNominee('8410011', 'next-dev'),
      now: new Date(),
    });
    expect(state.raced).toBe(true);
    expect(result).toMatchObject({ outcome: 'created', removed: 0 });
    const users = await usersOf(organization.id);
    expect(users.find((row) => row.id === waiting.row.id)).toMatchObject({
      login_subject: sub,
      account_id: account.id,
      is_admin: 1,
    });
    const deletes = (await userChangeLogsOf(organization.id)).filter((log) => log.action === 'delete');
    expect(deletes).toEqual([]);
  });

  test('前の指名を読んだ後、書く前に GitHub の指名した人が初めてログインして結ばれたら、その行は消さず、取り消しの記録も残さない', async () => {
    const organization = await createOrganization();
    const pending = await pendingGithubAdmin(organization, { login_subject: '8410021', name: 'early-dev' });
    const account = await createAccount();
    const { racingEnv, state } = afterFirstUsersRead(async () => {
      await linkLoginToAccount(env, account.id, { provider: 'github', subject: '8410021' }, new Date());
    });
    const result = await reassignOrganizationAdminForTest(racingEnv, organization.id, {
      operator: OPERATOR_LOGIN_ID,
      nominee: githubNominee('8410022', 'late-dev'),
      now: new Date(),
    });
    expect(state.raced).toBe(true);
    expect(result).toMatchObject({ outcome: 'created', removed: 0 });
    expect((await usersOf(organization.id)).find((row) => row.id === pending.id)).toMatchObject({
      account_id: account.id,
      is_admin: 1,
    });
    expect((await userChangeLogsOf(organization.id)).filter((log) => log.action === 'delete')).toEqual([]);
  });
});

describe('アカウントのある人の、結ばれていない自分の行', () => {
  // 組織の作成の書いた後の結び直しが失敗すると（operator-nominee.ts の linkIfLoggedInSince は投げずにログに残す）、
  // アカウントのある人の (github, ID) の行が account_id の空のまま残る。運用者がその人を指名し直したら、組織の作成と同じく
  // account_id を埋め、ログインし直さずに入れるはず
  test('指名し直すと account_id が埋まり、今のセッションのまま管理者として入れる', async () => {
    const organization = await createOrganization();
    const user = githubUser(`unlinked-${crypto.randomUUID().slice(0, 8)}`);
    github.addUser(user);
    const person = await createPerson({
      organization: await createOrganization(),
      admin: true,
      login: { provider: 'github', subject: String(user.id) },
    });
    const own = await pendingGithubAdmin(organization, { login_subject: String(user.id), name: user.login });
    const res = await post(app, reassign, {
      token: await operatorToken(),
      body: {
        slug: organization.slug,
        admin: { provider: 'github', username: user.login, login_subject: String(user.id) },
      },
    });
    expect(res.status).toBe(200);
    const users = await usersOf(organization.id);
    expect(users.map((row) => row.id)).toEqual([own.id]);
    expect(users[0]?.account_id).toBe(person.accountId);
    const entered = await post(app, organizationInfo, { slug: organization.slug, token: person.token });
    expect(entered.status).toBe(200);
  });
});

describe('Google で指名した、既にいる人', () => {
  // 指名する前に無効にされた人は、招待の URL から結んだときに有効に戻って管理者になる（受け入れ条件の3。
  // 結ぶときの統合は「メールアドレスで待つ指名と招待」の 6、指名の後に無効にされた人だけを除く）
  test('指名する前に無効にされた Google の人は、招待の URL から結ぶと有効に戻って管理者になり、行は1つにまとまる', async () => {
    const organization = await createOrganization();
    const email = 'suzuna.hoshikawa@example.com';
    const user = googleUser('星川 すずな', { email });
    const person = await createPerson({
      organization,
      disabled: true,
      login: { provider: 'google', subject: user.sub },
    });
    const res = await post(app, reassign, {
      token: await operatorToken(),
      body: { slug: organization.slug, admin: { provider: 'google', email } },
    });
    expect(res.status).toBe(200);
    const claimToken = new URL(((await res.json()) as { invite: { url: string } }).invite.url).hash.slice(1);

    const result = await newBrowser().loginWithInvite(user, claimToken);
    expect(result.location).toBe(`/${organization.slug}`);
    const users = await usersOf(organization.id);
    expect(users.map((row) => row.id)).toEqual([person.userId]);
    expect(users[0]).toMatchObject({ is_admin: 1, disabled_at: null });
  });
});
