// 運用者による管理者の指名し直し（organization-admin-reassign、Issue #217）の、done-check のレビューで出た指摘を確かめる。
// - 運用者が自分（自分のアカウントに結んだ GitHub のログイン）を指名するのを断る（nominee_is_operator）
// - ワークスペースの所属を持つ前の指名は消さず残す（memberships.user_id が行を指すため）
// - batch() の失敗を 409 にするのは、新しい行を入れるときだけ（ほかは 500 として残す）
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { organizationAdminReassign as reassign } from '../src/shared/operations/operator/index.ts';
import { orgDb } from '../src/server/db/index.ts';
import {
  envWithD1Hooks,
  reassignOrganizationAdminForTest,
  verifiedOrganizationForTest,
} from '../src/server/db/testing.ts';
import { createFakeGithub } from './auth/fake-github.ts';
import { createFakeGoogle } from './auth/fake-google.ts';
import { createLoginApp } from './auth/browser.ts';
import { githubUser } from './auth/helpers.ts';
import {
  createAccountLogin,
  createMembership,
  createOrganization,
  createUser,
  createWorkspace,
  type OrganizationFixture,
} from './factories.ts';
import { errorCodeOf, post } from './operations/harness.ts';
import { createPerson, getOperator, OPERATOR_LOGIN_ID, withNewSession } from './operations/world.ts';

const github = createFakeGithub();
const google = createFakeGoogle();
const app = createLoginApp(github, google);

afterEach(() => {
  vi.restoreAllMocks();
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

function pendingGithubAdmin(organization: OrganizationFixture, name: string) {
  return createUser(organization, { account_id: null, is_admin: 1, name });
}

type Problem = { path: string; code: string };

async function problemsOf(res: Response): Promise<Problem[]> {
  const body = (await res.json()) as { error: { details?: Problem[] } };
  return body.error.details ?? [];
}

describe('運用者が自分を指名する', () => {
  test('運用者のログインの GitHub の人を指名すると、400 の invalid_input（nominee_is_operator）で、前の指名も消さない', async () => {
    const operatorPerson = await getOperator();
    const subject = OPERATOR_LOGIN_ID.split(':')[1]!;
    const self = { id: Number(subject), login: `opself-${crypto.randomUUID().slice(0, 6)}`, name: '運用 太郎' };
    github.addUser(self);
    const organization = await createOrganization();
    const pending = await pendingGithubAdmin(organization, 'kiri-dev');
    const lookupsBefore = github.calls.length;
    const res = await post(app, reassign, {
      token: (await withNewSession(operatorPerson)).token,
      body: { slug: organization.slug, admin: { provider: 'github', username: self.login, login_subject: subject } },
    });
    expect(res.status).toBe(400);
    expect(await errorCodeOf(res.clone())).toBe('invalid_input');
    expect(await problemsOf(res)).toEqual([
      expect.objectContaining({ path: 'admin.username', code: 'nominee_is_operator' }),
    ]);
    // 断るのは GitHub に問い合わせた後
    expect(github.calls.length).toBeGreaterThan(lookupsBefore);
    expect((await usersOf(organization.id)).map((row) => row.id)).toEqual([pending.id]);
    expect(await deleteLogsOf(organization.id)).toEqual([]);
  });

  test('運用者のアカウントに結んだ別の GitHub のログインの人も、自分として断る', async () => {
    const operatorPerson = await getOperator();
    const other = githubUser(`opalt-${crypto.randomUUID().slice(0, 6)}`);
    github.addUser(other);
    await createAccountLogin(operatorPerson.accountId, { login_provider: 'github', login_subject: String(other.id) });
    const organization = await createOrganization();
    const res = await post(app, reassign, {
      token: (await withNewSession(operatorPerson)).token,
      body: {
        slug: organization.slug,
        admin: { provider: 'github', username: other.login, login_subject: String(other.id) },
      },
    });
    expect(res.status).toBe(400);
    expect(await problemsOf(res)).toEqual([
      expect.objectContaining({ path: 'admin.username', code: 'nominee_is_operator' }),
    ]);
    expect(await usersOf(organization.id)).toEqual([]);
  });
});

describe('ワークスペースの所属を持つ前の指名', () => {
  test('まだログインしていない指名の行がワークスペースの所属を持っていても、指名し直せ、所属のある行は消さず、取り消しの記録も残さない', async () => {
    const organization = await createOrganization();
    const admin = await createPerson({ organization, admin: true });
    const workspace = await createWorkspace(organization, admin.userId!);
    // 最初のリーダーの候補に、まだログインしていない指名の行が選ばれた
    const leader = await pendingGithubAdmin(organization, 'nagi-dev');
    await createMembership(organization, workspace.id, leader.id, { role: 'leader' });
    const other = await pendingGithubAdmin(organization, 'hoshi-dev');

    const result = await reassignOrganizationAdminForTest(env, organization.id, {
      operator: OPERATOR_LOGIN_ID,
      nominee: { provider: 'github', subject: '8430001', name: 'next-dev', accountId: null },
      now: new Date(),
    });
    expect(result).toMatchObject({ outcome: 'created', removed: 1 });
    const ids = (await usersOf(organization.id)).map((row) => row.id);
    expect(ids).toContain(leader.id);
    expect(ids).not.toContain(other.id);
    expect((await deleteLogsOf(organization.id)).map((log) => log.entity_id)).toEqual([other.id]);
  });
});

describe('batch() の失敗', () => {
  test('既にいる人を UPDATE する経路で batch() が失敗したら、409 にせず例外のまま投げる', async () => {
    const organization = await createOrganization();
    const person = await createPerson({
      organization,
      disabled: true,
      login: { provider: 'github', subject: '8430011' },
    });
    const failing = envWithD1Hooks(env, {
      beforeBatch: () => {
        throw new Error('D1 の一時的な失敗');
      },
    });
    await expect(
      reassignOrganizationAdminForTest(failing, organization.id, {
        operator: OPERATOR_LOGIN_ID,
        nominee: { provider: 'github', subject: '8430011', name: 'kasumi-dev', accountId: person.accountId },
        now: new Date(),
      }),
    ).rejects.toThrow();
  });

  test('既に有効な管理者の経路で batch() が失敗しても、409 にせず例外のまま投げる', async () => {
    const organization = await createOrganization();
    const person = await createPerson({ organization, admin: true, login: { provider: 'github', subject: '8430021' } });
    const failing = envWithD1Hooks(env, {
      beforeBatch: () => {
        throw new Error('D1 の一時的な失敗');
      },
    });
    await expect(
      reassignOrganizationAdminForTest(failing, organization.id, {
        operator: OPERATOR_LOGIN_ID,
        nominee: { provider: 'github', subject: '8430021', name: 'sumire-dev', accountId: person.accountId },
        now: new Date(),
      }),
    ).rejects.toThrow();
  });
});
