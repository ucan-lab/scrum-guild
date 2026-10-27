// 運用者による管理者の指名し直し（organization-admin-reassign、Issue #217）を崩すテスト（3周目）。
// 前の周で、前の指名の削除と記録を「指名した人の行の updated_at が、この batch() の UPDATE の書いた値であること」に結ばせた。
// ここでは、その条件が時刻の一致で「自分の更新か」を見分けている点を狙う。UPDATE が条件に外れたのに、別の書き込みが
// 同じ時刻（同じミリ秒、止めた時計）の updated_at を書いていた場合に、409 を返しながら前の指名を消さないかを確かめる。
// 根拠:
// - docs/data-model.md の「書き込みの単位」の管理者の指名し直し: 「既にいる人を UPDATE するときは、指名した人の行の updated_at が
//   その UPDATE の書いた値であることも条件にし、UPDATE が条件に外れたら（その人が別の経路で有効な管理者になっていても）
//   前の指名も記録も書かない」「既にいる人の UPDATE が条件に外れたとき（前の指名も消えない）... は 409」。例外を置いていない
// - src/server/db/previous-statement.ts の決まり: 「行の内容や時刻の一致で『自分の更新か』を見分けると、止めた時計や
//   同じ値を書く要求では、負けた要求も一致して二重に書く」
// - workerd の Date は、I/O の間は進まない（同じ時刻を別の要求が読みうる）
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { organizationAdminReassign as reassign } from '../src/shared/operations/operator/index.ts';
import { linkLoginToAccount, orgDb } from '../src/server/db/index.ts';
import {
  envWithD1Hooks,
  reassignOrganizationAdminForTest,
  verifiedOrganizationForTest,
} from '../src/server/db/testing.ts';
import { createFakeGithub } from './auth/fake-github.ts';
import { createFakeGoogle } from './auth/fake-google.ts';
import { createLoginApp, loginEnv } from './auth/browser.ts';
import { githubUser } from './auth/helpers.ts';
import {
  createAccount,
  createAccountLogin,
  createOrganization,
  createUser,
  type OrganizationFixture,
} from './factories.ts';
import { errorCodeOf, post } from './operations/harness.ts';
import { createPerson, getOperator, OPERATOR_LOGIN_ID, withNewSession } from './operations/world.ts';

const github = createFakeGithub();
const google = createFakeGoogle();
const app = createLoginApp(github, google);

afterEach(() => {
  vi.useRealTimers();
});

const orgDbOf = (organizationId: string) => orgDb(env, verifiedOrganizationForTest(organizationId));

async function usersOf(organizationId: string) {
  const db = orgDbOf(organizationId);
  return db.rows(
    db.statement((q) =>
      q.selectFrom('users').selectAll().where('organization_id', '=', organizationId).orderBy('created_at'),
    ),
  );
}

async function deleteLogsOf(organizationId: string) {
  const db = orgDbOf(organizationId);
  return db.rows(
    db.statement((q) =>
      q
        .selectFrom('change_logs')
        .selectAll()
        .where('organization_id', '=', organizationId)
        .where('entity_type', '=', 'user')
        .where('action', '=', 'delete'),
    ),
  );
}

// GitHub でまだログインしていない前の指名（運用者の指名が作る行と同じ形）
function pendingGithubAdmin(organization: OrganizationFixture, name: string) {
  return createUser(organization, { account_id: null, is_admin: 1, name });
}

// 指名し直しの最初の users の読み取りの直後に、1回だけ action を流す env
function afterFirstUsersRead(base: Env, action: () => Promise<void>, ready: () => boolean = () => true) {
  const state = { raced: false };
  const racingEnv = envWithD1Hooks(base, {
    afterQuery: async (sql) => {
      if (state.raced || !ready() || !sql.includes('from "users"')) return;
      state.raced = true;
      await action();
    },
  });
  return { racingEnv, state };
}

describe('前の指名の削除を結ぶ updated_at の条件が、同じ時刻の別の書き込みと見分けられない', () => {
  test('結ばれていない有効な管理者の行と読んだ後、同じミリ秒にその人のログインが行を結んだら、409 のときは前の指名を消さず、取り消しの記録も残さない', async () => {
    const organization = await createOrganization();
    const account = await createAccount();
    // 組織の作成の書いた後の結び直しが失敗して残った、アカウントのある人の結ばれていない自分の行
    await createUser(organization, { account_id: null, is_admin: 1, login_subject: '8430011', name: 'shion-dev' });
    const pending = await pendingGithubAdmin(organization, 'tsubaki-dev');
    // 指名し直しと、別の要求（ログインのたびの結び直し）が同じミリ秒の時刻を読んだ
    const now = new Date();
    const { racingEnv, state } = afterFirstUsersRead(env, async () => {
      await linkLoginToAccount(env, account.id, { provider: 'github', subject: '8430011' }, now);
    });
    const result = await reassignOrganizationAdminForTest(racingEnv, organization.id, {
      operator: OPERATOR_LOGIN_ID,
      nominee: { provider: 'github', subject: '8430011', name: 'shion-dev', accountId: account.id },
      now,
    });
    expect(state.raced).toBe(true);
    // 既にいる人の UPDATE は、読んだ account_id の空が条件に外れて 0 行
    expect(result).toBe('conflict');
    // docs/data-model.md「書き込みの単位」: UPDATE が条件に外れたら前の指名も記録も書かない
    expect((await usersOf(organization.id)).map((row) => row.id)).toContain(pending.id);
    expect(await deleteLogsOf(organization.id)).toEqual([]);
  });

  test('止めた時計で、同じ人への2つめの指名し直しは 409 を返すのに、間に入った3つめの指名し直しの新しい指名を消す', async () => {
    const organization = await createOrganization();
    const person = await createPerson({ organization, login: { provider: 'github', subject: '8430021' } });
    const now = new Date();
    let third: Awaited<ReturnType<typeof reassignOrganizationAdminForTest>> | undefined;
    // B（2つめ）が一般の人と読んだ後、書く前に、A（同じ人への指名し直し）と C（別の人への指名し直し）が終わる。
    // 3つとも同じ時刻を読んだ（止めた時計）
    const { racingEnv, state } = afterFirstUsersRead(env, async () => {
      const first = await reassignOrganizationAdminForTest(env, organization.id, {
        operator: OPERATOR_LOGIN_ID,
        nominee: { provider: 'github', subject: '8430021', name: 'kikyo-dev', accountId: person.accountId },
        now,
      });
      expect(first).toMatchObject({ outcome: 'updated' });
      third = await reassignOrganizationAdminForTest(env, organization.id, {
        operator: OPERATOR_LOGIN_ID,
        nominee: { provider: 'github', subject: '8430022', name: 'satsuki-dev', accountId: null },
        now,
      });
    });
    const second = await reassignOrganizationAdminForTest(racingEnv, organization.id, {
      operator: OPERATOR_LOGIN_ID,
      nominee: { provider: 'github', subject: '8430021', name: 'kikyo-dev', accountId: person.accountId },
      now,
    });
    expect(state.raced).toBe(true);
    expect(third).toMatchObject({ outcome: 'created' });
    const thirdUserId = (third as { userId: string }).userId;
    expect(second).toBe('conflict');
    // 409（何も書かれていない）を返した要求が、C の指名した人の行を消してはいけない
    expect((await usersOf(organization.id)).map((row) => row.id)).toContain(thirdUserId);
    expect((await deleteLogsOf(organization.id)).map((row) => row.entity_id)).not.toContain(thirdUserId);
  });

  test('API: 止めた時計で、読んだ後に指名する人のログインが行を結んだら、409 の conflict を返すときは前の指名が残っている', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date());
    const organization = await createOrganization();
    const user = githubUser(`stopped-${crypto.randomUUID().slice(0, 8)}`);
    github.addUser(user);
    const account = await createAccount();
    await createAccountLogin(account.id, { login_subject: String(user.id), login_name: user.login });
    // アカウントのある人の、まだ結ばれていない自分の有効な管理者の行
    await createUser(organization, {
      account_id: null,
      is_admin: 1,
      login_subject: String(user.id),
      name: user.login,
    });
    const pending = await pendingGithubAdmin(organization, 'hazuki-dev');
    const token = (await withNewSession(await getOperator())).token;
    const lookupsBefore = github.calls.length;
    // ログインのたびの結び直しは、要求の時刻（止めた時計では指名し直しと同じ値）を updated_at に書く
    const { racingEnv, state } = afterFirstUsersRead(
      loginEnv,
      () => linkLoginToAccount(env, account.id, { provider: 'github', subject: String(user.id) }, new Date()),
      () => github.calls.length > lookupsBefore,
    );
    const res = await post(app, reassign, {
      token,
      body: {
        slug: organization.slug,
        admin: { provider: 'github', username: user.login, login_subject: String(user.id) },
      },
      env: racingEnv,
    });
    expect(state.raced).toBe(true);
    expect(res.status).toBe(409);
    expect(await errorCodeOf(res)).toBe('conflict');
    // 辞書の operatorReassignConflict と docs/data-model.md「書き込みの単位」: 409 は何も書かれていない
    expect((await usersOf(organization.id)).map((row) => row.id)).toContain(pending.id);
    expect(await deleteLogsOf(organization.id)).toEqual([]);
  });
});
