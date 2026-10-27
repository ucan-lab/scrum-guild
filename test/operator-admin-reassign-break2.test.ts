// 運用者による管理者の指名し直し（organization-admin-reassign、Issue #217）を崩すテスト（2周目）。
// test/operator-admin-reassign.test.ts と test/operator-admin-reassign-break.test.ts に無い手口として、
// 既にいる人の UPDATE が条件に外れたのに、その人が別の経路で有効な管理者になっていた場合（DELETE の EXISTS が成り立つ）を確かめる。
// docs/data-model.md の「書き込みの単位」の管理者の指名し直しは「既にいる人の UPDATE が条件に外れたとき（前の指名も消えない）」は 409、
// 辞書の operatorReassignConflict も「409 は ... 何も書かれていない」とする
import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
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
import { createAccount, createOrganization, createUser, type OrganizationFixture } from './factories.ts';
import { errorCodeOf, post } from './operations/harness.ts';
import { createPerson, getOperator, OPERATOR_LOGIN_ID, withNewSession } from './operations/world.ts';

const github = createFakeGithub();
const google = createFakeGoogle();
const app = createLoginApp(github, google);

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

// 組織の管理者が、ある人を管理者にする（読んだ後に is_admin が変わる）
async function makeAdmin(organizationId: string, userId: string) {
  const db = orgDbOf(organizationId);
  await db.run(
    db.statement((q) =>
      q
        .updateTable('users')
        .set({ is_admin: 1 })
        .where('id', '=', userId)
        .where('organization_id', '=', organizationId),
    ),
  );
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

describe('既にいる人の UPDATE が条件に外れたが、その人は別の経路で有効な管理者になっていた', () => {
  test('一般の人と読んだ後、書く前に組織の管理者がその人を管理者にしたら、conflict のときは前の指名を消さず、取り消しの記録も残さない', async () => {
    const organization = await createOrganization();
    const person = await createPerson({ organization, login: { provider: 'github', subject: '8420001' } });
    const pending = await pendingGithubAdmin(organization, 'yuzuha-dev');
    const { racingEnv, state } = afterFirstUsersRead(env, () => makeAdmin(organization.id, person.userId!));
    const result = await reassignOrganizationAdminForTest(racingEnv, organization.id, {
      operator: OPERATOR_LOGIN_ID,
      nominee: { provider: 'github', subject: '8420001', name: 'tsumugi-dev', accountId: person.accountId },
      now: new Date(),
    });
    expect(state.raced).toBe(true);
    // 409 を返すなら、書き込みは何も残っていないはず（docs/data-model.md「書き込みの単位」: 前の指名も消えない）
    if (result === 'conflict') {
      expect((await usersOf(organization.id)).map((row) => row.id)).toContain(pending.id);
      expect(await deleteLogsOf(organization.id)).toEqual([]);
    } else {
      expect(result).toMatchObject({ userId: person.userId, removed: 1 });
    }
  });

  test('結ばれていない有効な管理者の行と読んだ後、書く前にその人がログインして結ばれたら、conflict のときは前の指名を消さず、取り消しの記録も残さない', async () => {
    const organization = await createOrganization();
    const account = await createAccount();
    // 組織の作成の書いた後の結び直しが失敗して残った、アカウントのある人の結ばれていない自分の行
    const own = await createUser(organization, {
      account_id: null,
      is_admin: 1,
      login_subject: '8420011',
      name: 'hinata-dev',
    });
    const pending = await pendingGithubAdmin(organization, 'kogane-dev');
    const { racingEnv, state } = afterFirstUsersRead(env, async () => {
      await linkLoginToAccount(env, account.id, { provider: 'github', subject: '8420011' }, new Date());
    });
    const result = await reassignOrganizationAdminForTest(racingEnv, organization.id, {
      operator: OPERATOR_LOGIN_ID,
      nominee: { provider: 'github', subject: '8420011', name: 'hinata-dev', accountId: account.id },
      now: new Date(),
    });
    expect(state.raced).toBe(true);
    expect((await usersOf(organization.id)).find((row) => row.id === own.id)).toMatchObject({
      account_id: account.id,
      is_admin: 1,
    });
    if (result === 'conflict') {
      expect((await usersOf(organization.id)).map((row) => row.id)).toContain(pending.id);
      expect(await deleteLogsOf(organization.id)).toEqual([]);
    } else {
      expect(result).toMatchObject({ userId: own.id, removed: 1 });
    }
  });

  test('API で 409 の conflict を返したときは、前の指名が残っている（画面は「何も書かれていない」と伝える）', async () => {
    const organization = await createOrganization();
    const user = githubUser(`promote-${crypto.randomUUID().slice(0, 8)}`);
    github.addUser(user);
    const person = await createPerson({ organization, login: { provider: 'github', subject: String(user.id) } });
    const pending = await pendingGithubAdmin(organization, 'ayame-dev');
    const token = (await withNewSession(await getOperator())).token;
    const lookupsBefore = github.calls.length;
    // GitHub でユーザー名を解決した後の、最初の users の読み取り（指名し直しの読み取り）の直後に割り込む
    const { racingEnv, state } = afterFirstUsersRead(
      loginEnv,
      () => makeAdmin(organization.id, person.userId!),
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
    if (res.status === 409) {
      expect(await errorCodeOf(res)).toBe('conflict');
      expect((await usersOf(organization.id)).map((row) => row.id)).toContain(pending.id);
      expect(await deleteLogsOf(organization.id)).toEqual([]);
    } else {
      expect(res.status).toBe(200);
    }
  });
});
