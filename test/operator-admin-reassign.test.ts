// 運用者による管理者の指名し直し（organization-admin-reassign、Issue #217）の結合テスト。
// GitHub と Google への通信は差し替えた fetch（test/auth/fake-github.ts、test/auth/fake-google.ts）に向け、アプリと D1 は本物を使う。
// 組織の分離と権限の一覧のテスト（test/operation-registry.test.ts）は、この操作も回す（運用者でない人の 403、Origin、未ログイン）。
// ここでは、指名し直しに固有の振る舞い（前の指名を消す範囲、既にいる人に当てる、一覧の状態、履歴、停止中、Google の URL、競合）を確かめる
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { WAITING_USER_NAME_IN_LOG } from '../src/shared/claim-token.ts';
import type { OutputOf } from '../src/shared/operations/define.ts';
import {
  createOrganization as create,
  listOrganizations,
  organizationAdminReassign as reassign,
} from '../src/shared/operations/operator/index.ts';
import { organizationHistory } from '../src/shared/operations/organization/organization-history.ts';
import { organizationInfo } from '../src/shared/operations/organization/index.ts';
import { randomToken, sha256Hex } from '../src/server/auth/tokens.ts';
import { commonDb, orgDb } from '../src/server/db/index.ts';
import {
  envWithD1Hooks,
  reassignOrganizationAdminForTest,
  verifiedOrganizationForTest,
} from '../src/server/db/testing.ts';
import { createFakeGithub } from './auth/fake-github.ts';
import { createFakeGoogle } from './auth/fake-google.ts';
import { createLoginApp, FakeBrowser, loginEnv } from './auth/browser.ts';
import { githubUser, googleUser } from './auth/helpers.ts';
import { AT, createAccount, createOrganization, createUser, type OrganizationFixture } from './factories.ts';
import { errorCodeOf, post } from './operations/harness.ts';
import {
  createLoginPerson,
  createPerson,
  createTarget,
  getOperator,
  OPERATOR_LOGIN_ID,
  withNewSession,
} from './operations/world.ts';

const github = createFakeGithub();
const google = createFakeGoogle();
const app = createLoginApp(github, google);
const newBrowser = () => new FakeBrowser(app, github, loginEnv, undefined, google);

afterEach(() => {
  vi.restoreAllMocks();
});

const DAY_MS = 24 * 60 * 60 * 1000;
const inDays = (days: number) => new Date(Date.now() + days * DAY_MS).toISOString();
const INVITE_FAILED = '/login?error=invite';

type History = OutputOf<typeof organizationHistory>;
type Problem = { path: string; code: string };

async function operatorToken(): Promise<string> {
  return (await withNewSession(await getOperator())).token;
}

async function problemsOf(res: Response): Promise<Problem[]> {
  const body = (await res.json()) as { error: { details?: Problem[] } };
  return body.error.details ?? [];
}

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

async function organizationRow(id: string) {
  const db = commonDb(env);
  return db.first(db.statement((q) => q.selectFrom('organizations').selectAll().where('id', '=', id)));
}

async function statusOf(token: string, slug: string) {
  const res = await post(app, listOrganizations, { token });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { organizations: { slug: string; admin_status: string }[] };
  return body.organizations.find((item) => item.slug === slug)?.admin_status;
}

type AdminInput =
  { provider: 'github'; username: string; login_subject: string } | { provider: 'google'; email: string };

function reassignBy(token: string, slug: string, admin: AdminInput, useEnv?: Env) {
  return post(app, reassign, { token, body: { slug, admin }, env: useEnv });
}

// 個人のアカウントの GitHub のユーザーを足して返す。呼ぶたびに別の人
function newGithubUser(prefix = 'reassign') {
  const user = githubUser(`${prefix}-${crypto.randomUUID().slice(0, 8)}`);
  github.addUser(user);
  return user;
}

function adminOf(user: { id: number; login: string }): AdminInput {
  return { provider: 'github', username: user.login, login_subject: String(user.id) };
}

// GitHub でまだログインしていない指名（運用者の指名が作る行と同じ形）
function pendingGithubAdmin(organization: OrganizationFixture, overrides: Parameters<typeof createUser>[1] = {}) {
  return createUser(organization, { account_id: null, is_admin: 1, name: 'sora-dev', ...overrides });
}

// Google の指名で待つ行（運用者の指名が作る行と同じ形）。秘密も返す
async function waitingGoogleAdmin(
  organization: OrganizationFixture,
  options: { email?: string; expiresAt?: string } = {},
) {
  const token = randomToken();
  const email = options.email ?? `wait-${crypto.randomUUID().slice(0, 8)}@example.com`;
  const row = await createUser(organization, {
    account_id: null,
    login_provider: 'google',
    login_subject: null,
    login_email: email,
    claim_token_hash: await sha256Hex(token),
    claim_expires_at: options.expiresAt ?? inDays(14),
    name: email,
    is_admin: 1,
  });
  return { row, token, email };
}

// 出力された console の行をまとめる。ログにメールアドレスや秘密が出ていないことを確かめるのに使う
function captureLogs() {
  const lines: string[] = [];
  for (const method of ['log', 'info', 'warn', 'error'] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    });
  }
  return lines;
}

describe('GitHub のユーザー名で指名し直す', () => {
  test('新しい管理者の行と、運用者の操作としての change_logs ができ、応答は slug、ユーザー名、invite の null だけ', async () => {
    const organization = await createOrganization();
    const user = newGithubUser();
    const res = await reassignBy(await operatorToken(), organization.slug, adminOf(user));
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(await res.json()).toEqual({ slug: organization.slug, admin_login_name: user.login, invite: null });

    const users = await usersOf(organization.id);
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({
      organization_id: organization.id,
      account_id: null,
      login_provider: 'github',
      login_subject: String(user.id),
      login_email: null,
      name: user.login,
      is_admin: 1,
      disabled_at: null,
    });

    const logs = await userChangeLogsOf(organization.id);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      entity_id: users[0]!.id,
      action: 'create',
      actor_user_id: null,
      workspace_id: null,
      operator: OPERATOR_LOGIN_ID,
    });
    expect(JSON.parse(logs[0]!.changes_json)).toEqual({
      is_admin: [null, 1],
      name: [null, user.login],
      login_provider: [null, 'github'],
      login_subject: [null, String(user.id)],
    });
  });

  test('指名した人がログインすると、その組織に管理者として入れる', async () => {
    const organization = await createOrganization({ name: 'こもれび工房' });
    const user = newGithubUser();
    expect((await reassignBy(await operatorToken(), organization.slug, adminOf(user))).status).toBe(200);

    const browser = newBrowser();
    const login = await browser.login(user);
    expect(login.response.status).toBe(302);
    const entered = await post(app, organizationInfo, { slug: organization.slug, token: browser.sessionToken });
    expect(entered.status).toBe(200);
    expect(await entered.json()).toMatchObject({ organization: { name: 'こもれび工房' }, me: { is_admin: true } });
  });

  test('既にアカウントのある人を指名すると、users.account_id を埋め、ログインし直さずに入れる', async () => {
    const organization = await createOrganization();
    const user = newGithubUser();
    // 別の組織で使っている人。account_logins がある
    const person = await createPerson({
      organization: await createOrganization(),
      admin: true,
      login: { provider: 'github', subject: String(user.id) },
    });
    const token = await operatorToken();
    expect((await reassignBy(token, organization.slug, adminOf(user))).status).toBe(200);

    const [row] = await usersOf(organization.id);
    expect(row?.account_id).toBe(person.accountId);
    const [log] = await userChangeLogsOf(organization.id);
    expect(JSON.parse(log!.changes_json)).toMatchObject({ account_id: [null, person.accountId] });

    const entered = await post(app, organizationInfo, { slug: organization.slug, token: person.token });
    expect(entered.status).toBe(200);
    expect(await entered.json()).toMatchObject({ me: { is_admin: true } });
    expect(await statusOf(token, organization.slug)).toBe('active');
  });
});

describe('Google のメールアドレスで指名し直す', () => {
  test('待つ行と change_logs ができ、応答の本文にだけ招待の URL と期限がある。記録とヘッダーに秘密とメールアドレスを入れない', async () => {
    const organization = await createOrganization();
    const res = await reassignBy(await operatorToken(), organization.slug, {
      provider: 'google',
      email: '  Nagi.Kurose@Example.com ',
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    const body = (await res.json()) as {
      slug: string;
      admin_login_name: string;
      invite: { url: string; expires_at: string };
    };
    expect(Object.keys(body).sort()).toEqual(['admin_login_name', 'invite', 'slug']);
    expect(Object.keys(body.invite).sort()).toEqual(['expires_at', 'url']);
    expect(body.slug).toBe(organization.slug);
    expect(body.admin_login_name).toBe('nagi.kurose@example.com');
    const url = new URL(body.invite.url);
    expect(url.origin + url.pathname).toBe(`${new URL(env.PUBLIC_ORIGIN).origin}/invite`);
    const claimToken = url.hash.slice(1);
    expect(claimToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    for (const [name, value] of res.headers) expect(value, name).not.toContain(claimToken);
    expect(Date.parse(body.invite.expires_at) - Date.now()).toBeGreaterThan(14 * DAY_MS - 60_000);
    expect(Date.parse(body.invite.expires_at) - Date.now()).toBeLessThanOrEqual(14 * DAY_MS);

    const users = await usersOf(organization.id);
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({
      account_id: null,
      login_provider: 'google',
      login_subject: null,
      login_email: 'nagi.kurose@example.com',
      claim_token_hash: await sha256Hex(claimToken),
      claim_expires_at: body.invite.expires_at,
      name: 'nagi.kurose@example.com',
      is_admin: 1,
    });

    const logs = await userChangeLogsOf(organization.id);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ action: 'create', operator: OPERATOR_LOGIN_ID, actor_user_id: null });
    expect(JSON.parse(logs[0]!.changes_json)).toEqual({
      is_admin: [null, 1],
      name: [null, WAITING_USER_NAME_IN_LOG],
      login_provider: [null, 'google'],
    });
    for (const secret of [claimToken, users[0]!.claim_token_hash!, 'nagi.kurose', users[0]!.claim_expires_at!]) {
      expect(logs[0]!.changes_json).not.toContain(secret);
    }
  });

  test('出た招待の URL を開いた本人が、確認済みの同じアドレスでログインすると、管理者として入れる', async () => {
    const organization = await createOrganization();
    const res = await reassignBy(await operatorToken(), organization.slug, {
      provider: 'google',
      email: 'kanade.mizuki@example.com',
    });
    expect(res.status).toBe(200);
    const claimToken = new URL(((await res.json()) as { invite: { url: string } }).invite.url).hash.slice(1);

    const browser = newBrowser();
    const result = await browser.loginWithInvite(
      googleUser('水城 奏', { email: 'kanade.mizuki@example.com' }),
      claimToken,
    );
    expect(result.location).toBe(`/${organization.slug}`);
    const entered = await post(app, organizationInfo, { slug: organization.slug, token: browser.sessionToken });
    expect(entered.status).toBe(200);
    expect(await entered.json()).toMatchObject({ me: { is_admin: true } });
  });

  test('同じメールアドレスで待つ行があっても、新しい待つ行を入れる。古い URL では結べず、新しい URL では結べる', async () => {
    const organization = await createOrganization();
    const email = 'tsumugi.aoki@example.com';
    const old = await waitingGoogleAdmin(organization, { email });
    const res = await reassignBy(await operatorToken(), organization.slug, { provider: 'google', email });
    expect(res.status).toBe(200);
    const fresh = new URL(((await res.json()) as { invite: { url: string } }).invite.url).hash.slice(1);
    expect(fresh).not.toBe(old.token);

    const users = await usersOf(organization.id);
    expect(users).toHaveLength(1);
    expect(users[0]!.id).not.toBe(old.row.id);
    expect(users[0]!.claim_token_hash).toBe(await sha256Hex(fresh));

    const user = googleUser('青木 紬', { email });
    const failed = await newBrowser().loginWithInvite(user, old.token);
    expect(failed.location).toBe(INVITE_FAILED);
    const linked = await newBrowser().loginWithInvite(user, fresh);
    expect(linked.location).toBe(`/${organization.slug}`);
  });

  test('組織の作成で出た招待の URL は、GitHub の人に指名し直した後は使えない', async () => {
    const token = await operatorToken();
    const slug = `reassign-${crypto.randomUUID().slice(0, 8)}`;
    const email = 'hinata.sato@example.com';
    const created = await post(app, create, {
      token,
      body: { slug, name: 'ひなた工房', admin: { provider: 'google', email } },
    });
    expect(created.status).toBe(200);
    const oldToken = new URL(((await created.json()) as { invite: { url: string } }).invite.url).hash.slice(1);

    expect((await reassignBy(token, slug, adminOf(newGithubUser()))).status).toBe(200);
    const failed = await newBrowser().loginWithInvite(googleUser('佐藤 陽向', { email }), oldToken);
    expect(failed.location).toBe(INVITE_FAILED);
  });

  test.each(['', '   ', 'みお@example.com', 'mio@', 'a@b@example.com'])(
    'メールアドレスの形が合わない（%j）と、400 の invalid_input（email_invalid）で、前の指名も消さない',
    async (email) => {
      const organization = await createOrganization();
      const pending = await pendingGithubAdmin(organization);
      const res = await reassignBy(await operatorToken(), organization.slug, { provider: 'google', email });
      expect(res.status).toBe(400);
      expect(await errorCodeOf(res.clone())).toBe('invalid_input');
      if (email.trim() !== '') {
        expect(await problemsOf(res)).toEqual([
          expect.objectContaining({ path: 'admin.email', code: 'email_invalid' }),
        ]);
      }
      expect((await usersOf(organization.id)).map((row) => row.id)).toEqual([pending.id]);
    },
  );
});

describe('前の指名を消す', () => {
  test('その組織の account_id が空の行（GitHub でまだログインしていない指名と、Google で待つ行）を消し、ログインした人の行と別の組織の行は残す', async () => {
    const organization = await createOrganization();
    const pendingGithub = await pendingGithubAdmin(organization, { name: 'sora-dev' });
    const waitingGoogle = await waitingGoogleAdmin(organization);
    // 期限切れの待つ行も消す
    const expiredGoogle = await waitingGoogleAdmin(organization, {
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    // アカウントに結ばれた前の管理者（辞めた人）。印は外さない
    const formerAdmin = await createPerson({ organization, admin: true });
    // アカウントに結ばれた無効の人
    const disabled = await createPerson({ organization, disabled: true });
    // 別の組織のまだログインしていない指名
    const elsewhere = await createOrganization();
    const elsewherePending = await pendingGithubAdmin(elsewhere);
    const elsewhereWaiting = await waitingGoogleAdmin(elsewhere);

    const user = newGithubUser();
    const res = await reassignBy(await operatorToken(), organization.slug, adminOf(user));
    expect(res.status).toBe(200);

    const users = await usersOf(organization.id);
    const ids = users.map((row) => row.id);
    expect(ids).not.toContain(pendingGithub.id);
    expect(ids).not.toContain(waitingGoogle.row.id);
    expect(ids).not.toContain(expiredGoogle.row.id);
    expect(users.find((row) => row.id === formerAdmin.userId)).toMatchObject({ is_admin: 1, disabled_at: null });
    expect(users.find((row) => row.id === disabled.userId)).toBeDefined();
    expect(users.filter((row) => row.login_subject === String(user.id))).toHaveLength(1);
    expect(users).toHaveLength(3);

    expect((await usersOf(elsewhere.id)).map((row) => row.id).sort()).toEqual(
      [elsewherePending.id, elsewhereWaiting.row.id].sort(),
    );
    expect(await userChangeLogsOf(elsewhere.id)).toEqual([]);

    // 消した行ごとに、user の delete の記録を運用者の操作として残す。待つ行の記録にメールアドレスと秘密を入れない
    const deletes = (await userChangeLogsOf(organization.id)).filter((log) => log.action === 'delete');
    expect(deletes.map((log) => log.entity_id).sort()).toEqual(
      [pendingGithub.id, waitingGoogle.row.id, expiredGoogle.row.id].sort(),
    );
    for (const log of deletes) {
      expect(log).toMatchObject({ operator: OPERATOR_LOGIN_ID, actor_user_id: null, workspace_id: null });
      for (const secret of [waitingGoogle.email, waitingGoogle.row.claim_token_hash!, waitingGoogle.token]) {
        expect(log.changes_json).not.toContain(secret);
      }
      for (const secret of [expiredGoogle.email, expiredGoogle.row.claim_token_hash!, expiredGoogle.token]) {
        expect(log.changes_json).not.toContain(secret);
      }
    }
  });

  test('消した Google の待つ行の招待の URL では、結べない', async () => {
    const organization = await createOrganization();
    const waiting = await waitingGoogleAdmin(organization, { email: 'ren.kagami@example.com' });
    expect((await reassignBy(await operatorToken(), organization.slug, adminOf(newGithubUser()))).status).toBe(200);
    const failed = await newBrowser().loginWithInvite(
      googleUser('各務 蓮', { email: 'ren.kagami@example.com' }),
      waiting.token,
    );
    expect(failed.location).toBe(INVITE_FAILED);
  });

  test('前の指名が無ければ、消さずに指名だけをする', async () => {
    const organization = await createOrganization();
    const formerAdmin = await createPerson({ organization, admin: true });
    expect((await reassignBy(await operatorToken(), organization.slug, adminOf(newGithubUser()))).status).toBe(200);
    expect((await usersOf(organization.id)).map((row) => row.id)).toContain(formerAdmin.userId);
    expect((await userChangeLogsOf(organization.id)).filter((log) => log.action === 'delete')).toEqual([]);
  });
});

describe('指名した人がその組織に既にいる（GitHub）', () => {
  test('無効にされた一般の人は、有効に戻って管理者になる。新しい行は入れず、有効化と管理者の指名を別の記録に残す', async () => {
    const organization = await createOrganization();
    const user = newGithubUser();
    const person = await createPerson({
      organization,
      disabled: true,
      login: { provider: 'github', subject: String(user.id) },
    });
    const before = (await usersOf(organization.id)).find((row) => row.id === person.userId)!;
    const pending = await pendingGithubAdmin(organization);

    const token = await operatorToken();
    const res = await reassignBy(token, organization.slug, adminOf(user));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ slug: organization.slug, admin_login_name: user.login, invite: null });

    const users = await usersOf(organization.id);
    expect(users.map((row) => row.id)).toEqual([person.userId]);
    expect(users[0]).toMatchObject({ is_admin: 1, disabled_at: null, account_id: person.accountId });
    expect(users.find((row) => row.id === pending.id)).toBeUndefined();

    const updates = (await userChangeLogsOf(organization.id)).filter((log) => log.action === 'update');
    expect(updates).toHaveLength(2);
    for (const log of updates) {
      expect(log).toMatchObject({ entity_id: person.userId, operator: OPERATOR_LOGIN_ID, actor_user_id: null });
    }
    expect(updates.map((log) => JSON.parse(log.changes_json) as unknown)).toEqual(
      expect.arrayContaining([{ disabled_at: [before.disabled_at, null] }, { is_admin: [0, 1] }]),
    );
    expect((await userChangeLogsOf(organization.id)).filter((log) => log.action === 'create')).toEqual([]);

    // ログインし直さずに、管理者として入れる。一覧の状態は active
    const entered = await post(app, organizationInfo, { slug: organization.slug, token: person.token });
    expect(entered.status).toBe(200);
    expect(await entered.json()).toMatchObject({ me: { is_admin: true } });
    expect(await statusOf(token, organization.slug)).toBe('active');
  });

  test('有効な一般の人は、管理者になる。記録は is_admin の1行だけ', async () => {
    const organization = await createOrganization();
    const user = newGithubUser();
    const person = await createPerson({ organization, login: { provider: 'github', subject: String(user.id) } });
    expect((await reassignBy(await operatorToken(), organization.slug, adminOf(user))).status).toBe(200);

    const [row] = await usersOf(organization.id);
    expect(row).toMatchObject({ id: person.userId, is_admin: 1, disabled_at: null });
    const logs = await userChangeLogsOf(organization.id);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ action: 'update', entity_id: person.userId, operator: OPERATOR_LOGIN_ID });
    expect(JSON.parse(logs[0]!.changes_json)).toEqual({ is_admin: [0, 1] });
  });

  test('無効にされた管理者は、有効に戻る。記録は disabled_at の1行だけ', async () => {
    const organization = await createOrganization();
    const user = newGithubUser();
    const person = await createPerson({
      organization,
      admin: true,
      disabled: true,
      login: { provider: 'github', subject: String(user.id) },
    });
    expect((await reassignBy(await operatorToken(), organization.slug, adminOf(user))).status).toBe(200);

    const [row] = await usersOf(organization.id);
    expect(row).toMatchObject({ id: person.userId, is_admin: 1, disabled_at: null });
    const logs = await userChangeLogsOf(organization.id);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ action: 'update', entity_id: person.userId, operator: OPERATOR_LOGIN_ID });
    expect(JSON.parse(logs[0]!.changes_json)).toEqual({ disabled_at: ['2026-10-21T00:00:00.000Z', null] });
  });

  test('既に有効な管理者なら users を書かず、前の指名を消すだけ', async () => {
    const organization = await createOrganization();
    const user = newGithubUser();
    const person = await createPerson({
      organization,
      admin: true,
      login: { provider: 'github', subject: String(user.id) },
    });
    const pending = await pendingGithubAdmin(organization);
    const res = await reassignBy(await operatorToken(), organization.slug, adminOf(user));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ slug: organization.slug, admin_login_name: user.login, invite: null });

    const users = await usersOf(organization.id);
    expect(users.map((row) => row.id)).toEqual([person.userId]);
    expect(users[0]).toMatchObject({ is_admin: 1, disabled_at: null, updated_at: AT });
    const logs = await userChangeLogsOf(organization.id);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ action: 'delete', entity_id: pending.id });
  });

  test('GitHub でまだログインしていない同じ人の指名は消さず、そのまま管理者として残す（新しい行も入れない）', async () => {
    const organization = await createOrganization();
    const user = newGithubUser();
    const own = await pendingGithubAdmin(organization, { login_subject: String(user.id), name: user.login });
    const other = await pendingGithubAdmin(organization, { name: 'other-dev' });
    const token = await operatorToken();
    expect((await reassignBy(token, organization.slug, adminOf(user))).status).toBe(200);

    const users = await usersOf(organization.id);
    expect(users.map((row) => row.id)).toEqual([own.id]);
    expect(users[0]).toMatchObject({ is_admin: 1, account_id: null, login_subject: String(user.id) });
    const logs = await userChangeLogsOf(organization.id);
    expect(logs.map((log) => [log.action, log.entity_id])).toEqual([['delete', other.id]]);
    expect(await statusOf(token, organization.slug)).toBe('pending');
  });

  test('別の組織にいる同じ人には当てず、この組織に新しい行を入れる', async () => {
    const organization = await createOrganization();
    const user = newGithubUser();
    const elsewhere = await createOrganization();
    const person = await createPerson({
      organization: elsewhere,
      disabled: true,
      login: { provider: 'github', subject: String(user.id) },
    });
    expect((await reassignBy(await operatorToken(), organization.slug, adminOf(user))).status).toBe(200);

    const [row] = await usersOf(organization.id);
    expect(row).toMatchObject({ login_subject: String(user.id), is_admin: 1, account_id: person.accountId });
    expect(row!.id).not.toBe(person.userId);
    // 別の組織の行は無効のまま
    expect((await usersOf(elsewhere.id))[0]).toMatchObject({ id: person.userId, is_admin: 0 });
    expect((await usersOf(elsewhere.id))[0]!.disabled_at).not.toBeNull();
  });
});

describe('一覧の管理者の状態', () => {
  test('管理者のいない組織（none）は、GitHub の指名で pending、ログインした後は active', async () => {
    const organization = await createOrganization();
    const token = await operatorToken();
    expect(await statusOf(token, organization.slug)).toBe('none');
    const user = newGithubUser();
    expect((await reassignBy(token, organization.slug, adminOf(user))).status).toBe(200);
    expect(await statusOf(token, organization.slug)).toBe('pending');
    await newBrowser().login(user);
    expect(await statusOf(token, organization.slug)).toBe('active');
  });

  test('招待の URL が期限切れ（expired）の組織は、Google の指名し直しで pending', async () => {
    const organization = await createOrganization();
    await waitingGoogleAdmin(organization, { expiresAt: new Date(Date.now() - 1000).toISOString() });
    const token = await operatorToken();
    expect(await statusOf(token, organization.slug)).toBe('expired');
    const res = await reassignBy(token, organization.slug, { provider: 'google', email: 'yui.hoshi@example.com' });
    expect(res.status).toBe(200);
    expect(await statusOf(token, organization.slug)).toBe('pending');
  });

  test('ログイン待ち（pending）の組織は、指名し直しても pending のまま、前の指名は残らない', async () => {
    const organization = await createOrganization();
    const old = await pendingGithubAdmin(organization);
    const token = await operatorToken();
    expect(await statusOf(token, organization.slug)).toBe('pending');
    expect(
      (await reassignBy(token, organization.slug, { provider: 'google', email: 'aoi.mori@example.com' })).status,
    ).toBe(200);
    expect(await statusOf(token, organization.slug)).toBe('pending');
    expect((await usersOf(organization.id)).map((row) => row.id)).not.toContain(old.id);
  });

  test('active の組織（管理者が辞めて行が残る組織）にも指名でき、前の管理者の印は外さない', async () => {
    const organization = await createOrganization();
    const formerAdmin = await createPerson({ organization, admin: true });
    const token = await operatorToken();
    expect(await statusOf(token, organization.slug)).toBe('active');
    expect((await reassignBy(token, organization.slug, adminOf(newGithubUser()))).status).toBe(200);
    expect(await statusOf(token, organization.slug)).toBe('active');
    expect((await usersOf(organization.id)).find((row) => row.id === formerAdmin.userId)).toMatchObject({
      is_admin: 1,
    });
  });

  test('無効にされた管理者だけの組織（none）は、その人を指名し直すと active', async () => {
    const organization = await createOrganization();
    const user = newGithubUser();
    await createPerson({
      organization,
      admin: true,
      disabled: true,
      login: { provider: 'github', subject: String(user.id) },
    });
    const token = await operatorToken();
    expect(await statusOf(token, organization.slug)).toBe('none');
    expect((await reassignBy(token, organization.slug, adminOf(user))).status).toBe(200);
    expect(await statusOf(token, organization.slug)).toBe('active');
  });
});

describe('組織の変更の履歴', () => {
  async function historyOf(target: Awaited<ReturnType<typeof createTarget>>) {
    const res = await post(app, organizationHistory, { slug: target.slug, token: target.admin.token });
    expect(res.status).toBe(200);
    return res;
  }

  test('前の指名を消した記録（GitHub はユーザー名、Google は null）と、新しい指名を、運用者の操作として出す。ログインの ID とメールアドレスは出さない', async () => {
    const target = await createTarget();
    await pendingGithubAdmin(target.organization, { name: 'sora-dev' });
    const waiting = await waitingGoogleAdmin(target.organization);
    const user = newGithubUser();
    expect((await reassignBy(await operatorToken(), target.slug, adminOf(user))).status).toBe(200);

    const res = await historyOf(target);
    const text = await res.text();
    expect(text).not.toContain(OPERATOR_LOGIN_ID);
    expect(text).not.toContain(waiting.email);
    expect(text).not.toContain(String(user.id));
    const entries = (JSON.parse(text) as History).entries.map((entry) => [entry.actor, entry.event]);
    expect(entries).toHaveLength(3);
    expect(entries).toEqual(
      expect.arrayContaining([
        [{ kind: 'operator' }, { kind: 'admin_designation_removed', name: 'sora-dev' }],
        [{ kind: 'operator' }, { kind: 'admin_designation_removed', name: null }],
        [{ kind: 'operator' }, { kind: 'admin_designated', name: user.login }],
      ]),
    );
  });

  test('既にいる無効の人を指名すると、有効化と管理者の指名を運用者の操作として出す', async () => {
    const target = await createTarget();
    const user = newGithubUser();
    await createPerson({
      organization: target.organization,
      disabled: true,
      login: { provider: 'github', subject: String(user.id) },
    });
    // 名前は users の今の名前（ファクトリーの既定）
    expect((await reassignBy(await operatorToken(), target.slug, adminOf(user))).status).toBe(200);

    const entries = (JSON.parse(await (await historyOf(target)).text()) as History).entries.map((entry) => [
      entry.actor,
      entry.event.kind,
    ]);
    expect(entries).toHaveLength(2);
    expect(entries).toEqual(
      expect.arrayContaining([
        [{ kind: 'operator' }, 'user_enabled'],
        [{ kind: 'operator' }, 'admin_designated'],
      ]),
    );
  });

  test('Google の指名し直しは、名前の分からない指名として出す', async () => {
    const target = await createTarget();
    expect(
      (await reassignBy(await operatorToken(), target.slug, { provider: 'google', email: 'mei.asahi@example.com' }))
        .status,
    ).toBe(200);
    const res = await historyOf(target);
    const text = await res.text();
    expect(text).not.toContain('mei.asahi');
    expect((JSON.parse(text) as History).entries.map((entry) => [entry.actor, entry.event])).toEqual([
      [{ kind: 'operator' }, { kind: 'admin_designated', name: null }],
    ]);
  });
});

describe('停止中と人数の上限', () => {
  test('停止中の組織にも指名し直せ、停止の状態は変えない', async () => {
    const organization = await createOrganization({ suspended_at: '2026-10-20T00:00:00.000Z', purge_on: '2026-11-19' });
    const pending = await pendingGithubAdmin(organization);
    const user = newGithubUser();
    const token = await operatorToken();
    const res = await reassignBy(token, organization.slug, adminOf(user));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ slug: organization.slug, admin_login_name: user.login, invite: null });

    const users = await usersOf(organization.id);
    expect(users.map((row) => row.login_subject)).toEqual([String(user.id)]);
    expect(users.map((row) => row.id)).not.toContain(pending.id);
    expect(await organizationRow(organization.id)).toMatchObject({
      suspended_at: '2026-10-20T00:00:00.000Z',
      purge_on: '2026-11-19',
    });
    expect(await statusOf(token, organization.slug)).toBe('pending');
  });

  test('停止中の組織にも Google で指名し直せ、招待の URL が出る', async () => {
    const organization = await createOrganization({ suspended_at: '2026-10-20T00:00:00.000Z' });
    const res = await reassignBy(await operatorToken(), organization.slug, {
      provider: 'google',
      email: 'kai.tsukishiro@example.com',
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { invite: unknown }).invite).toEqual({
      url: expect.any(String),
      expires_at: expect.any(String),
    });
  });

  test('人数の上限に達した組織にも指名できる', async () => {
    const organization = await createOrganization({ member_limit: 1 });
    await createPerson({ organization, admin: true });
    const res = await reassignBy(await operatorToken(), organization.slug, adminOf(newGithubUser()));
    expect(res.status).toBe(200);
    expect(await usersOf(organization.id)).toHaveLength(2);
  });
});

describe('応答とログ', () => {
  test('応答に組織の中のデータ（人の名前や ID、消した行の ID、新しい行の ID）を入れない', async () => {
    const organization = await createOrganization();
    const former = await createUser(organization, {
      account_id: (await createAccount()).id,
      is_admin: 1,
      name: '漏れてはいけない管理者',
    });
    const pending = await pendingGithubAdmin(organization, { name: 'leak-check-dev' });
    const user = newGithubUser();
    const res = await reassignBy(await operatorToken(), organization.slug, adminOf(user));
    expect(res.status).toBe(200);
    const text = await res.text();
    const [created] = (await usersOf(organization.id)).filter((row) => row.login_subject === String(user.id));
    for (const leaked of [
      '漏れてはいけない管理者',
      'leak-check-dev',
      former.id,
      pending.id,
      created!.id,
      organization.id,
    ]) {
      expect(text).not.toContain(leaked);
    }
    expect(Object.keys(JSON.parse(text) as object).sort()).toEqual(['admin_login_name', 'invite', 'slug']);
  });

  test('ログにメールアドレス、招待の秘密、消した行の名前を出さない', async () => {
    const logs = captureLogs();
    const organization = await createOrganization();
    const waiting = await waitingGoogleAdmin(organization, { email: 'old.wait@example.com' });
    const res = await reassignBy(await operatorToken(), organization.slug, {
      provider: 'google',
      email: 'riku.amano@example.com',
    });
    expect(res.status).toBe(200);
    const claimToken = new URL(((await res.json()) as { invite: { url: string } }).invite.url).hash.slice(1);
    const logged = logs.join('\n');
    for (const secret of ['riku.amano', 'old.wait', claimToken, waiting.token, await sha256Hex(claimToken)]) {
      expect(logged).not.toContain(secret);
    }
  });
});

describe('断る場合', () => {
  test('運用者でない人は 403 で、何も書かない', async () => {
    const organization = await createOrganization();
    const pending = await pendingGithubAdmin(organization);
    const person = await createLoginPerson();
    const res = await reassignBy(person.token, organization.slug, adminOf(newGithubUser()));
    expect(res.status).toBe(403);
    expect(await errorCodeOf(res)).toBe('forbidden');
    expect((await usersOf(organization.id)).map((row) => row.id)).toEqual([pending.id]);
    expect(await userChangeLogsOf(organization.id)).toEqual([]);
  });

  test('その組織の管理者でも、運用者でなければ 403', async () => {
    const target = await createTarget();
    const res = await reassignBy(target.admin.token, target.slug, adminOf(newGithubUser()));
    expect(res.status).toBe(403);
  });

  test('無い slug は 404 の not_found', async () => {
    const res = await reassignBy(
      await operatorToken(),
      `no-such-${crypto.randomUUID().slice(0, 8)}`,
      adminOf(newGithubUser()),
    );
    expect(res.status).toBe(404);
    expect(await errorCodeOf(res)).toBe('not_found');
  });

  test('無い slug は Google の指名でも 404 で、招待の URL を出さない', async () => {
    const res = await reassignBy(await operatorToken(), `no-such-${crypto.randomUUID().slice(0, 8)}`, {
      provider: 'google',
      email: 'nobody.here@example.com',
    });
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain('/invite');
  });

  test('いないユーザー名は github_user_not_found で断り、前の指名も消さない', async () => {
    const organization = await createOrganization();
    const pending = await pendingGithubAdmin(organization);
    const res = await reassignBy(await operatorToken(), organization.slug, {
      provider: 'github',
      username: 'nobody-reassign',
      login_subject: '1',
    });
    expect(res.status).toBe(400);
    expect(await errorCodeOf(res.clone())).toBe('invalid_input');
    expect(await problemsOf(res)).toEqual([
      expect.objectContaining({ path: 'admin.username', code: 'github_user_not_found' }),
    ]);
    expect((await usersOf(organization.id)).map((row) => row.id)).toEqual([pending.id]);
  });

  test('GitHub の組織アカウントは github_not_a_user で断り、前の指名も消さない', async () => {
    github.addUser({ id: 8_200_001, login: 'acme-reassign', type: 'Organization' });
    const organization = await createOrganization();
    const pending = await pendingGithubAdmin(organization);
    const res = await reassignBy(await operatorToken(), organization.slug, {
      provider: 'github',
      username: 'acme-reassign',
      login_subject: '8200001',
    });
    expect(res.status).toBe(400);
    expect(await problemsOf(res)).toEqual([
      expect.objectContaining({ path: 'admin.username', code: 'github_not_a_user' }),
    ]);
    expect((await usersOf(organization.id)).map((row) => row.id)).toEqual([pending.id]);
  });

  test('確かめたユーザー ID と解決し直した ID が違うと github_user_changed で断り、前の指名も消さない', async () => {
    const organization = await createOrganization();
    const pending = await pendingGithubAdmin(organization);
    const user = newGithubUser();
    const res = await reassignBy(await operatorToken(), organization.slug, {
      provider: 'github',
      username: user.login,
      login_subject: String(user.id + 1),
    });
    expect(res.status).toBe(400);
    expect(await problemsOf(res)).toEqual([
      expect.objectContaining({ path: 'admin.login_subject', code: 'github_user_changed' }),
    ]);
    expect((await usersOf(organization.id)).map((row) => row.id)).toEqual([pending.id]);
  });

  test.each(['rate-limited', 'server-error'] as const)(
    'GitHub に届かない（%s）ときは 503 の unavailable で、前の指名も消さない',
    async (failure) => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const organization = await createOrganization();
      const pending = await pendingGithubAdmin(organization);
      const user = newGithubUser();
      github.failNext.lookup = failure;
      const res = await reassignBy(await operatorToken(), organization.slug, adminOf(user));
      expect(res.status).toBe(503);
      expect(await errorCodeOf(res)).toBe('unavailable');
      expect((await usersOf(organization.id)).map((row) => row.id)).toEqual([pending.id]);
    },
  );

  test('入力の形が違う（admin が無い、知らない手段）と 400', async () => {
    const organization = await createOrganization();
    const token = await operatorToken();
    for (const body of [{ slug: organization.slug }, { slug: organization.slug, admin: { provider: 'gitlab' } }]) {
      const res = await post(app, reassign, { token, body });
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(await errorCodeOf(res)).toBe('invalid_input');
    }
  });
});

describe('DB の関数（reassignOrganizationAdmin）', () => {
  const now = () => new Date();
  const githubNominee = (subject: string, name: string, accountId: string | null = null) => ({
    provider: 'github',
    subject,
    name,
    accountId,
  });

  test('新しい行を入れたら created と消した数、既にいる人を変えたら updated、既に有効な管理者なら unchanged', async () => {
    const organization = await createOrganization();
    await pendingGithubAdmin(organization);
    await waitingGoogleAdmin(organization);
    const created = await reassignOrganizationAdminForTest(env, organization.id, {
      operator: OPERATOR_LOGIN_ID,
      nominee: githubNominee('8300001', 'mint-dev'),
      now: now(),
    });
    expect(created).toEqual({ userId: expect.any(String), outcome: 'created', removed: 2 });
    const rows = await usersOf(organization.id);
    expect(rows.map((row) => row.id)).toEqual([(created as { userId: string }).userId]);

    const member = await createPerson({ organization, login: { provider: 'github', subject: '8300002' } });
    const updated = await reassignOrganizationAdminForTest(env, organization.id, {
      operator: OPERATOR_LOGIN_ID,
      nominee: githubNominee('8300002', 'lime-dev', member.accountId),
      now: now(),
    });
    // 前の指名（8300001 のまだログインしていない行）を消す
    expect(updated).toEqual({ userId: member.userId, outcome: 'updated', removed: 1 });

    const unchanged = await reassignOrganizationAdminForTest(env, organization.id, {
      operator: OPERATOR_LOGIN_ID,
      nominee: githubNominee('8300002', 'lime-dev', member.accountId),
      now: now(),
    });
    expect(unchanged).toEqual({ userId: member.userId, outcome: 'unchanged', removed: 0 });
  });

  test('Google の指名は、いつも新しい待つ行を入れる（created）', async () => {
    const organization = await createOrganization();
    const result = await reassignOrganizationAdminForTest(env, organization.id, {
      operator: OPERATOR_LOGIN_ID,
      nominee: {
        provider: 'google',
        waiting: { email: 'sena.kiri@example.com', claimTokenHash: 'd'.repeat(64), claimExpiresAt: inDays(14) },
        name: 'sena.kiri@example.com',
        accountId: null,
      },
      now: now(),
    });
    expect(result).toEqual({ userId: expect.any(String), outcome: 'created', removed: 0 });
    expect((await usersOf(organization.id))[0]).toMatchObject({
      login_provider: 'google',
      login_subject: null,
      claim_token_hash: 'd'.repeat(64),
      is_admin: 1,
    });
  });

  test('既にいる人を読んだ後、書く前にその行が変えられて条件に外れたら conflict', async () => {
    const organization = await createOrganization();
    const person = await createPerson({
      organization,
      disabled: true,
      login: { provider: 'github', subject: '8300011' },
    });
    let armed = true;
    let raced = false;
    const racingEnv = envWithD1Hooks(env, {
      // 既にいる人を読んだ直後に、組織の管理者がその人を無効にし直す（disabled_at が読んだ値と変わる）
      afterQuery: async (sql) => {
        if (!armed || !sql.includes('from "users"')) return;
        armed = false;
        raced = true;
        const db = orgDbOf(organization.id);
        await db.run(
          db.statement((q) =>
            q
              .updateTable('users')
              .set({ disabled_at: '2026-10-25T00:00:00.000Z' })
              .where('id', '=', person.userId!)
              .where('organization_id', '=', organization.id),
          ),
        );
      },
    });
    const result = await reassignOrganizationAdminForTest(racingEnv, organization.id, {
      operator: OPERATOR_LOGIN_ID,
      nominee: githubNominee('8300011', 'race-dev', person.accountId),
      now: now(),
    });
    expect(raced).toBe(true);
    expect(result).toBe('conflict');
    // 条件に外れた UPDATE は書かず、その記録も残さない
    expect((await usersOf(organization.id))[0]).toMatchObject({
      is_admin: 0,
      disabled_at: '2026-10-25T00:00:00.000Z',
    });
    expect((await userChangeLogsOf(organization.id)).filter((log) => log.action === 'update')).toEqual([]);
  });

  test('いないと読んだ後、書く前に同じ人の行が入って一意に当たったら conflict で、前の指名も消さない', async () => {
    const organization = await createOrganization();
    const pending = await pendingGithubAdmin(organization);
    const account = await createAccount();
    let armed = true;
    let raced = false;
    const racingEnv = envWithD1Hooks(env, {
      // 指名する人がいないと読んだ直後に、その人が招待を承諾して行ができる（アカウントに結ばれた行）
      afterQuery: async (sql) => {
        if (!armed || !sql.includes('from "users"')) return;
        armed = false;
        raced = true;
        await createUser(organization, { account_id: account.id, login_subject: '8300021', name: 'late-dev' });
      },
    });
    const result = await reassignOrganizationAdminForTest(racingEnv, organization.id, {
      operator: OPERATOR_LOGIN_ID,
      nominee: githubNominee('8300021', 'late-dev'),
      now: now(),
    });
    expect(raced).toBe(true);
    expect(result).toBe('conflict');
    // batch() は1つのトランザクションなので、前の指名の DELETE も戻る
    const ids = (await usersOf(organization.id)).map((row) => row.id);
    expect(ids).toContain(pending.id);
    expect(ids).toHaveLength(2);
    expect(await userChangeLogsOf(organization.id)).toEqual([]);
  });

  test('API では、競合は 409 の conflict', async () => {
    const organization = await createOrganization();
    const user = newGithubUser();
    const account = await createAccount();
    const token = await operatorToken();
    const lookupsBefore = github.calls.length;
    let raced = false;
    const racingEnv = envWithD1Hooks(loginEnv, {
      // GitHub でユーザー名を解決した後の、最初の users の読み取り（指名し直しの読み取り）の直後に、同じ人の行を入れる。
      // セッションの確かめが読む users は、解決より前なので当たらない
      afterQuery: async (sql) => {
        if (raced || github.calls.length === lookupsBefore || !sql.includes('from "users"')) return;
        raced = true;
        await createUser(organization, { account_id: account.id, login_subject: String(user.id), name: user.login });
      },
    });
    const res = await reassignBy(token, organization.slug, adminOf(user), racingEnv);
    expect(raced).toBe(true);
    expect(res.status).toBe(409);
    expect(await errorCodeOf(res)).toBe('conflict');
  });
});
