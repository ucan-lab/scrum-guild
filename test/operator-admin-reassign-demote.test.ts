// 運用者による管理者の指名し直し（organization-admin-reassign、Issue #217）で、ワークスペースの所属を持つ前の指名を確かめる。
// 所属を持つ行は消せない（memberships.user_id が指す）ので、消す代わりに管理者の印を外す。外さないと、指名し直して
// 取り消したつもりの人が、後でログインすると管理者として入れてしまう（PR #410 の AI レビューの指摘）
import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import { organizationInfo } from '../src/shared/operations/organization/index.ts';
import { organizationHistory } from '../src/shared/operations/organization/organization-history.ts';
import { orgDb } from '../src/server/db/index.ts';
import {
  envWithD1Hooks,
  reassignOrganizationAdminForTest,
  verifiedOrganizationForTest,
} from '../src/server/db/testing.ts';
import { createFakeGithub } from './auth/fake-github.ts';
import { createFakeGoogle } from './auth/fake-google.ts';
import { createLoginApp, FakeBrowser, loginEnv } from './auth/browser.ts';
import { githubUser } from './auth/helpers.ts';
import {
  createMembership,
  createOrganization,
  createUser,
  createWorkspace,
  type OrganizationFixture,
} from './factories.ts';
import { post } from './operations/harness.ts';
import { createPerson, createTarget, OPERATOR_LOGIN_ID } from './operations/world.ts';

const github = createFakeGithub();
const google = createFakeGoogle();
const app = createLoginApp(github, google);

const orgDbOf = (organizationId: string) => orgDb(env, verifiedOrganizationForTest(organizationId));

async function userRow(organizationId: string, userId: string) {
  const db = orgDbOf(organizationId);
  return db.first(
    db.statement((q) =>
      q.selectFrom('users').selectAll().where('organization_id', '=', organizationId).where('id', '=', userId),
    ),
  );
}

async function userLogsOf(organizationId: string, userId: string) {
  const db = orgDbOf(organizationId);
  return db.rows(
    db.statement((q) =>
      q
        .selectFrom('change_logs')
        .selectAll()
        .where('organization_id', '=', organizationId)
        .where('entity_type', '=', 'user')
        .where('entity_id', '=', userId),
    ),
  );
}

describe('ワークスペースの所属を持つ前の指名', () => {
  test('行は残して管理者の印を外し（is_admin = 0）、管理者の解除の記録を1行残す。その人が後でログインしても管理者として入れない', async () => {
    const target = await createTarget();
    const organization = target.organization;
    const workspace = await createWorkspace(organization, target.admin.userId!);
    const user = githubUser(`demote-${crypto.randomUUID().slice(0, 8)}`);
    github.addUser(user);
    // まだログインしていない指名の行が、ワークスペースの最初のリーダーに選ばれた
    const pending = await createUser(organization, {
      account_id: null,
      is_admin: 1,
      login_subject: String(user.id),
      name: user.login,
    });
    await createMembership(organization, workspace.id, pending.id, { role: 'leader' });

    const result = await reassignOrganizationAdminForTest(env, organization.id, {
      operator: OPERATOR_LOGIN_ID,
      nominee: { provider: 'github', subject: '8440001', name: 'next-dev', accountId: null },
      now: new Date(),
    });
    // removed は消した行の数で、印を外しただけの行は数えない
    expect(result).toMatchObject({ outcome: 'created', removed: 0 });

    expect(await userRow(organization.id, pending.id)).toMatchObject({ is_admin: 0, account_id: null });
    const logs = await userLogsOf(organization.id, pending.id);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ action: 'update', operator: OPERATOR_LOGIN_ID, actor_user_id: null });
    expect(JSON.parse(logs[0]!.changes_json)).toEqual({ is_admin: [1, 0] });

    // 履歴では、運用者の操作の管理者の解除として出る
    const history = await post(app, organizationHistory, { slug: target.slug, token: target.admin.token });
    expect(history.status).toBe(200);
    const entries = ((await history.json()) as { entries: { actor: unknown; event: unknown }[] }).entries;
    expect(entries.map((entry) => ({ actor: entry.actor, event: entry.event }))).toContainEqual({
      actor: { kind: 'operator' },
      event: { kind: 'admin_revoked', name: user.login },
    });

    // 後でログインしても、管理者としては入れない（所属のある一般の人として入る）
    const browser = new FakeBrowser(app, github, loginEnv, undefined, google);
    await browser.login(user);
    await browser.consent();
    const entered = await post(app, organizationInfo, { slug: target.slug, token: browser.sessionToken });
    expect(entered.status).toBe(200);
    expect(await entered.json()).toMatchObject({ me: { is_admin: false } });
  });
});

// 組織に、ワークスペースの最初のリーダーに選ばれた、まだログインしていない指名の行を作る
async function pendingLeader(organization: OrganizationFixture, name: string) {
  const admin = await createPerson({ organization, admin: true });
  const workspace = await createWorkspace(organization, admin.userId!);
  const pending = await createUser(organization, { account_id: null, is_admin: 1, name });
  await createMembership(organization, workspace.id, pending.id, { role: 'leader' });
  return pending;
}

describe('所属を持つ前の指名の印を外す、ほかの経路', () => {
  test('既にいる無効の人を指名する経路（UPDATE の前に置く）でも、印を外して記録を1行残す', async () => {
    const organization = await createOrganization();
    const pending = await pendingLeader(organization, 'yuzu-dev');
    const person = await createPerson({
      organization,
      disabled: true,
      login: { provider: 'github', subject: '8440011' },
    });
    const result = await reassignOrganizationAdminForTest(env, organization.id, {
      operator: OPERATOR_LOGIN_ID,
      nominee: { provider: 'github', subject: '8440011', name: 'kaede-dev', accountId: person.accountId },
      now: new Date(),
    });
    expect(result).toMatchObject({ outcome: 'updated' });
    expect(await userRow(organization.id, pending.id)).toMatchObject({ is_admin: 0 });
    expect(await userLogsOf(organization.id, pending.id)).toHaveLength(1);
  });

  test('同じ指名し直しをもう一度流しても、印を外した記録は増えない', async () => {
    const organization = await createOrganization();
    const pending = await pendingLeader(organization, 'suzu-dev');
    const input = {
      operator: OPERATOR_LOGIN_ID,
      nominee: { provider: 'github', subject: '8440021', name: 'ran-dev', accountId: null },
    };
    expect(await reassignOrganizationAdminForTest(env, organization.id, { ...input, now: new Date() })).toMatchObject({
      outcome: 'created',
    });
    expect(await reassignOrganizationAdminForTest(env, organization.id, { ...input, now: new Date() })).toMatchObject({
      outcome: 'unchanged',
    });
    expect(await userRow(organization.id, pending.id)).toMatchObject({ is_admin: 0 });
    expect(await userLogsOf(organization.id, pending.id)).toHaveLength(1);
  });

  test('別の組織の、所属を持つ前の指名の印は外さない', async () => {
    const organization = await createOrganization();
    await pendingLeader(organization, 'mei-dev');
    const other = await createOrganization();
    const otherPending = await pendingLeader(other, 'rio-dev');
    await reassignOrganizationAdminForTest(env, organization.id, {
      operator: OPERATOR_LOGIN_ID,
      nominee: { provider: 'github', subject: '8440031', name: 'sora-dev', accountId: null },
      now: new Date(),
    });
    expect(await userRow(other.id, otherPending.id)).toMatchObject({ is_admin: 1 });
    expect(await userLogsOf(other.id, otherPending.id)).toEqual([]);
  });

  test('既にいる人の UPDATE が条件に外れて 409 になるときは、所属を持つ前の指名の印も外さない', async () => {
    const organization = await createOrganization();
    const pending = await pendingLeader(organization, 'nao-dev');
    const person = await createPerson({ organization, login: { provider: 'github', subject: '8440041' } });
    // 指名し直しが users を読んだ直後に、組織の管理者がその人を管理者にする（読んだ is_admin = 0 から変わる）
    let raced = false;
    const racingEnv = envWithD1Hooks(env, {
      afterQuery: async (sql) => {
        if (raced || !sql.includes('from "users"')) return;
        raced = true;
        const db = orgDbOf(organization.id);
        await db.run(
          db.statement((q) =>
            q
              .updateTable('users')
              .set({ is_admin: 1 })
              .where('id', '=', person.userId!)
              .where('organization_id', '=', organization.id),
          ),
        );
      },
    });
    const result = await reassignOrganizationAdminForTest(racingEnv, organization.id, {
      operator: OPERATOR_LOGIN_ID,
      nominee: { provider: 'github', subject: '8440041', name: 'hina-dev', accountId: person.accountId },
      now: new Date(),
    });
    expect(raced).toBe(true);
    expect(result).toBe('conflict');
    expect(await userRow(organization.id, pending.id)).toMatchObject({ is_admin: 1 });
    expect(await userLogsOf(organization.id, pending.id)).toEqual([]);
  });
});
