// 招待の URL から Google の人を結ぶ流れの結合テスト（docs/data-model.md の「メールアドレスで待つ指名と招待」）。
// Google への通信は差し替えた fetch（test/auth/fake-google.ts）に向け、アプリ（開始、戻り先、セッション）と D1 は本物を使う。
// 運用者による指名の API は test/operator-organizations.test.ts。指名し直し（#60）はまだ無いので、「指名し直した後の古い URL」は
// ファクトリーで秘密を差し替えた行で、招待（invitations）は招待を作る画面がまだ無いのでファクトリーの行で確かめる
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { randomToken, sha256Hex } from '../src/server/auth/tokens.ts';
import { commonDb, orgDb } from '../src/server/db/index.ts';
import {
  claimPendingLoginForTest,
  envWithD1Hooks,
  pendingClaimStatementsForTest,
  queryPlanForTest,
  verifiedOrganizationForTest,
} from '../src/server/db/testing.ts';
import { createOrganization as create } from '../src/shared/operations/operator/index.ts';
import { organizationInfo, myOrganizations } from '../src/shared/operations/organization/index.ts';
import { me } from '../src/shared/operations/session/index.ts';
import { createFakeGithub } from './auth/fake-github.ts';
import { createFakeGoogle } from './auth/fake-google.ts';
import { createLoginApp, FakeBrowser, loginEnv, SESSION_COOKIE, STATE_COOKIE } from './auth/browser.ts';
import {
  afterFirstQuery,
  countAccounts,
  githubUser,
  googleAccountLoginOf,
  googleUser,
  organizationWithAdmin,
  sessionRowsOf,
  stateRow,
} from './auth/helpers.ts';
import {
  createInvitation,
  createMembership,
  createOrganization,
  createWorkspace,
  createUser,
  type OrganizationFixture,
} from './factories.ts';
import { post } from './operations/harness.ts';
import { getOperator, withNewSession } from './operations/world.ts';

const github = createFakeGithub();
const google = createFakeGoogle();
const app = createLoginApp(github, google);
const newBrowser = (environment: Env = loginEnv) => new FakeBrowser(app, github, environment, undefined, google);

afterEach(() => {
  vi.restoreAllMocks();
});

const DAY_MS = 24 * 60 * 60 * 1000;
const inDays = (days: number) => new Date(Date.now() + days * DAY_MS).toISOString();
const INVITE_FAILED = '/login?error=invite';
const EMAIL = 'mio.hoshino@example.com';

async function secret() {
  const token = randomToken();
  return { token, hash: await sha256Hex(token) };
}

const orgDbOf = (organizationId: string) => orgDb(env, verifiedOrganizationForTest(organizationId));

async function usersOf(organizationId: string) {
  const db = orgDbOf(organizationId);
  return db.rows(db.statement((q) => q.selectFrom('users').selectAll().where('organization_id', '=', organizationId)));
}

async function invitationRow(organization: OrganizationFixture, id: string) {
  const db = orgDbOf(organization.id);
  return db.first(db.statement((q) => q.selectFrom('invitations').selectAll().where('id', '=', id)));
}

async function changeLogsOf(organizationId: string) {
  const db = orgDbOf(organizationId);
  return db.rows(
    db.statement((q) => q.selectFrom('change_logs').selectAll().where('organization_id', '=', organizationId)),
  );
}

// Google の指名で待つ行（運用者の指名が作る行と同じ形）
async function waitingAdmin(
  options: { email?: string; organization?: OrganizationFixture; expiresAt?: string; createdAt?: string } = {},
) {
  const organization = options.organization ?? (await createOrganization());
  const { token, hash } = await secret();
  const email = options.email ?? EMAIL;
  const row = await createUser(organization, {
    login_provider: 'google',
    login_subject: null,
    login_email: email,
    claim_token_hash: hash,
    claim_expires_at: options.expiresAt ?? inDays(14),
    name: email,
    is_admin: 1,
    ...(options.createdAt === undefined ? {} : { created_at: options.createdAt }),
  });
  return { organization, row, token, hash, email };
}

// Google の招待で待つ行（招待を作る画面ができるまでは、ファクトリーの行）
async function waitingInvitation(options: { email?: string; expiresAt?: string } = {}) {
  const { organization, admin, workspace } = await organizationWithAdmin();
  const { token, hash } = await secret();
  const email = options.email ?? EMAIL;
  const row = await createInvitation(
    organization,
    workspace.id,
    admin.id,
    { provider: 'google', subject: 'unused' },
    {
      login_subject: null,
      login_email: email,
      claim_token_hash: hash,
      claim_expires_at: options.expiresAt ?? inDays(14),
      login_name: email,
      created_at: new Date().toISOString(),
    },
  );
  return { organization, workspace, admin, row, token, hash, email };
}

// 出力された console の行をまとめる。ログに秘密、ハッシュ、メールアドレスが出ていないことを確かめるのに使う
function captureLogs() {
  const lines: string[] = [];
  for (const method of ['log', 'info', 'warn', 'error'] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    });
  }
  return lines;
}

describe('運用者の指名から結ぶまで', () => {
  test('運用者が Google のメールアドレスで指名し、出た招待の URL を開いた本人が、確認済みの同じアドレスでログインすると、管理者として /<slug> に入れる', async () => {
    const logs = captureLogs();
    const operator = await withNewSession(await getOperator());
    const slug = `invite-${crypto.randomUUID().slice(0, 8)}`;
    const created = await post(app, create, {
      token: operator.token,
      body: { slug, name: 'ひばり工房', admin: { provider: 'google', email: ` ${EMAIL.toUpperCase()} ` } },
    });
    expect(created.status).toBe(200);
    // 秘密は応答の本文にだけある
    expect(created.headers.get('Cache-Control')).toBe('no-store');
    const body = (await created.json()) as { invite_url: string; invite_expires_at: string; admin_login_name: string };
    expect(body.admin_login_name).toBe(EMAIL);
    const invite = new URL(body.invite_url);
    expect(invite.origin + invite.pathname).toBe(`${new URL(env.PUBLIC_ORIGIN).origin}/invite`);
    const claimToken = invite.hash.slice(1);
    expect(claimToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const claimHash = await sha256Hex(claimToken);
    expect(Date.parse(body.invite_expires_at) - Date.now()).toBeGreaterThan(14 * DAY_MS - 60_000);
    expect(Date.parse(body.invite_expires_at) - Date.now()).toBeLessThanOrEqual(14 * DAY_MS);
    for (const [name, value] of created.headers) {
      expect(value, name).not.toContain(claimToken);
    }

    const lookup = commonDb(env);
    const organization = await lookup.first(
      lookup.statement((q) => q.selectFrom('organizations').select('id').where('slug', '=', slug)),
    );
    const before = await usersOf(organization!.id);
    expect(before).toHaveLength(1);
    expect(before[0]).toMatchObject({
      login_provider: 'google',
      login_subject: null,
      login_email: EMAIL,
      claim_token_hash: claimHash,
      account_id: null,
      is_admin: 1,
      name: EMAIL,
    });

    // 本人が招待の URL を開き、確認済みの同じアドレスの Google アカウントでログインする
    const user = googleUser('星野 澪', { email: EMAIL });
    const browser = newBrowser();
    const started = await browser.startInvite(claimToken);
    expect(started.response.status).toBe(302);
    expect(started.location.origin).toBe('https://accounts.google.com');
    // 秘密は Google にもヘッダーにも渡さない。state の行にはハッシュだけ
    expect(started.location.href).not.toContain(claimToken);
    for (const [name, value] of started.response.headers) {
      expect(value, name).not.toContain(claimToken);
    }
    expect(await stateRow(started.state)).toMatchObject({
      login_provider: 'google',
      claim_token_hash: claimHash,
      return_to: '/',
    });
    const code = google.issueCode(user, started.location);
    browser.provider = 'google';
    const finished = await browser.callback({ code, state: started.state });
    expect(finished.response.status).toBe(302);
    expect(finished.location).toBe(`/${slug}`);
    for (const [name, value] of finished.response.headers) {
      expect(value, name).not.toContain(claimToken);
    }

    // sub を埋め、メールアドレス、秘密のハッシュ、期限を空にし、名前を Google のプロフィールの名前に書き直す
    const after = await usersOf(organization!.id);
    expect(after).toHaveLength(1);
    const account = await googleAccountLoginOf(user);
    expect(after[0]).toMatchObject({
      id: before[0]!.id,
      login_subject: user.sub,
      login_email: null,
      claim_token_hash: null,
      claim_expires_at: null,
      name: '星野 澪',
      is_admin: 1,
      account_id: account!.account_id,
    });

    const entered = await post(app, organizationInfo, { slug, token: browser.sessionToken });
    expect(entered.status).toBe(200);
    expect(await entered.json()).toMatchObject({ organization: { name: 'ひばり工房' }, me: { is_admin: true } });

    // 結んだ記録。実際の変更と、結んだ本人だけが残り、メールアドレス、秘密、ハッシュ、期限は入らない
    const logs2 = (await changeLogsOf(organization!.id)).filter((log) => log.entity_type === 'user');
    const claimLog = logs2.find((log) => log.action === 'update');
    expect(claimLog).toMatchObject({ entity_id: before[0]!.id, actor_user_id: before[0]!.id, operator: null });
    expect(JSON.parse(claimLog!.changes_json)).toEqual({
      login_subject: [null, user.sub],
      name: ['Google の招待（ログイン待ち）', '星野 澪'],
    });

    // 秘密は、ハッシュの列の外のどの表にも、ログにも、change_logs にも出ない
    const everything = JSON.stringify(
      await Promise.all(
        (['users', 'invitations', 'change_logs'] as const).map((table) => {
          const db = orgDbOf(organization!.id);
          return db.rows(db.statement((q) => q.selectFrom(table).selectAll()));
        }),
      ),
    );
    expect(everything).not.toContain(claimToken);
    const common = commonDb(env);
    const commonRows = JSON.stringify(
      await Promise.all(
        (['oauth_states', 'sessions', 'account_logins', 'accounts'] as const).map((table) =>
          common.rows(common.statement((q) => q.selectFrom(table).selectAll())),
        ),
      ),
    );
    expect(commonRows).not.toContain(claimToken);
    const logged = logs.join('\n');
    expect(logged).not.toContain(claimToken);
    expect(logged).not.toContain(claimHash);
    expect(logged).not.toContain(EMAIL);
    expect(logged).not.toContain(user.sub);
  });

  test('メールアドレスは大文字小文字と前後の空白の違いを同じものとして突き合わせ、ドットと + は読み替えない', async () => {
    const same = await waitingAdmin({ email: 'mio.hoshino+guild@example.com' });
    const user = googleUser('星野 澪', { email: '  Mio.Hoshino+Guild@Example.COM ' });
    const result = await newBrowser().loginWithInvite(user, same.token);
    expect(result.location).toBe(`/${same.organization.slug}`);

    for (const email of ['miohoshino+guild@example.com', 'mio.hoshino@example.com']) {
      const other = await waitingAdmin({ email: 'mio.hoshino+guild@example.com' });
      const failed = await newBrowser().loginWithInvite(googleUser('別の人', { email }), other.token);
      expect(failed.location, email).toBe(INVITE_FAILED);
    }
  });
});

describe('結べないとき', () => {
  async function expectUnusable(
    claimToken: string,
    user = googleUser('星野 澪', { email: EMAIL }),
    claims?: Record<string, unknown>,
    // 結ぶ前からアカウントを持つ人（前の戻りで結んだ人）
    hasAccount = false,
  ) {
    const browser = newBrowser();
    const result = await browser.loginWithInvite(user, claimToken, { claims });
    expect(result.response.status).toBe(302);
    expect(result.location).toBe(INVITE_FAILED);
    expect(browser.cookies.has(SESSION_COOKIE)).toBe(false);
    // 結べなかったログインは、アカウントも作らない
    if (!hasAccount) expect(await googleAccountLoginOf(user)).toBeUndefined();
    return result;
  }

  test('別のアドレスの Google アカウントでは結ばれない。行はそのまま待つ', async () => {
    const waiting = await waitingAdmin();
    await expectUnusable(waiting.token, googleUser('別の人', { email: 'someone.else@example.com' }));
    const [row] = await usersOf(waiting.organization.id);
    expect(row).toMatchObject({ login_subject: null, login_email: EMAIL, claim_token_hash: waiting.hash });
  });

  test('メールアドレスが確認済みでない、メールアドレスが無いアカウントでは結ばれない', async () => {
    const waiting = await waitingAdmin();
    await expectUnusable(waiting.token, googleUser('星野 澪', { email: EMAIL, email_verified: false }));
    // 文字列の "true" は真偽値の true ではない
    await expectUnusable(waiting.token, googleUser('星野 澪', { email: EMAIL, email_verified: 'true' }));
    await expectUnusable(waiting.token, googleUser('星野 澪'), { email: undefined });
    expect((await usersOf(waiting.organization.id))[0]).toMatchObject({
      login_subject: null,
      claim_token_hash: waiting.hash,
    });
  });

  test('期限切れでは結ばれない', async () => {
    const waiting = await waitingAdmin({ expiresAt: new Date(Date.now() - 1000).toISOString() });
    await expectUnusable(waiting.token);
    expect((await usersOf(waiting.organization.id))[0]).toMatchObject({ login_subject: null });
  });

  test('指名し直した後の古い URL（ファクトリーで秘密を差し替えた行）では結ばれない。新しい URL では結ばれる', async () => {
    const waiting = await waitingAdmin();
    const replaced = await secret();
    const db = orgDbOf(waiting.organization.id);
    await db.batch([
      db.statement((q) =>
        q.updateTable('users').set({ claim_token_hash: replaced.hash }).where('id', '=', waiting.row.id),
      ),
    ]);
    await expectUnusable(waiting.token);
    const result = await newBrowser().loginWithInvite(googleUser('星野 澪', { email: EMAIL }), replaced.token);
    expect(result.location).toBe(`/${waiting.organization.slug}`);
  });

  test('停止した組織では結ばれず、行は待ったまま', async () => {
    const waiting = await waitingAdmin({
      organization: await createOrganization({ suspended_at: '2026-10-22T00:00:00.000Z' }),
    });
    await expectUnusable(waiting.token);
    expect((await usersOf(waiting.organization.id))[0]).toMatchObject({ login_subject: null });
  });

  test('使い済みの URL では結ばれない。別の人が同じ URL を開いても、同じ文言でセッションができない', async () => {
    const waiting = await waitingAdmin();
    const first = googleUser('星野 澪', { email: EMAIL });
    expect((await newBrowser().loginWithInvite(first, waiting.token)).location).toBe(`/${waiting.organization.slug}`);
    // 同じ人が同じ URL をもう一度開いても、秘密は使い切っている
    await expectUnusable(waiting.token, first, undefined, true);
    await expectUnusable(waiting.token, googleUser('別の人', { email: EMAIL }));
    expect(await usersOf(waiting.organization.id)).toHaveLength(1);
  });

  test('当たらない秘密、ほかの組織に入れる人でも、セッションができない', async () => {
    const elsewhere = googleUser('管理者でもある人', { email: EMAIL });
    const other = await createOrganization();
    const adminRow = await createUser(other, {
      login_provider: 'google',
      login_subject: elsewhere.sub,
      is_admin: 1,
    });
    // この人は別の組織に入れるが、招待の URL から始めたログインが結べなければ、セッションを作らない
    const browser = newBrowser();
    const result = await browser.loginWithInvite(elsewhere, (await secret()).token);
    expect(result.location).toBe(INVITE_FAILED);
    expect(browser.cookies.has(SESSION_COOKIE)).toBe(false);
    expect(await googleAccountLoginOf(elsewhere)).toBeUndefined();
    expect((await usersOf(other.id))[0]).toMatchObject({ id: adminRow.id, account_id: null });

    // 別のアドレスで待つ指名にも、同じ扱い
    const waiting = await waitingAdmin({ email: 'someone.else@example.com' });
    const second = newBrowser();
    expect((await second.loginWithInvite(elsewhere, waiting.token)).location).toBe(INVITE_FAILED);
    expect(second.cookies.has(SESSION_COOKIE)).toBe(false);
  });

  test('どの失敗も同じ移動先で、どのメールアドレスに招待したかは出ない', async () => {
    const waiting = await waitingAdmin({ email: 'secret.target@example.com' });
    const results = [
      await expectUnusable(waiting.token, googleUser('他人', { email: 'other@example.com' })),
      await expectUnusable((await secret()).token),
    ];
    for (const result of results) {
      expect(result.location).toBe(INVITE_FAILED);
      expect(result.location).not.toContain('secret.target');
      expect(result.response.headers.get('Location')).not.toContain('secret.target');
    }
  });

  test('待っていた行より後に無効にされた同じ sub の人は、指名で無効が解けず、結ばれない', async () => {
    const user = googleUser('星野 澪', { email: EMAIL });
    const waiting = await waitingAdmin({ createdAt: '2026-10-20T00:00:00.000Z' });
    const disabled = await createUser(waiting.organization, {
      login_provider: 'google',
      login_subject: user.sub,
      is_admin: 0,
      disabled_at: '2026-10-22T00:00:00.000Z',
    });
    await expectUnusable(waiting.token, user);
    const rows = await usersOf(waiting.organization.id);
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.id === disabled.id)).toMatchObject({
      is_admin: 0,
      disabled_at: '2026-10-22T00:00:00.000Z',
    });
    expect(rows.find((row) => row.id === waiting.row.id)).toMatchObject({
      login_subject: null,
      claim_token_hash: waiting.hash,
    });
  });

  test('待っていた行より前に無効にされた同じ sub の人は、指名で無効が解け、管理者になり、待っていた行は消える', async () => {
    const user = googleUser('星野 澪', { email: EMAIL });
    const waiting = await waitingAdmin({ createdAt: '2026-10-22T00:00:00.000Z' });
    const disabled = await createUser(waiting.organization, {
      login_provider: 'google',
      login_subject: user.sub,
      name: '前の名前',
      is_admin: 0,
      disabled_at: '2026-10-20T00:00:00.000Z',
    });
    const result = await newBrowser().loginWithInvite(user, waiting.token);
    expect(result.location).toBe(`/${waiting.organization.slug}`);
    const rows = await usersOf(waiting.organization.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: disabled.id, is_admin: 1, disabled_at: null, name: '前の名前' });
    const log = (await changeLogsOf(waiting.organization.id)).find((item) => item.action === 'update');
    expect(log).toMatchObject({ entity_id: disabled.id, actor_user_id: disabled.id });
    expect(JSON.parse(log!.changes_json)).toEqual({
      is_admin: [0, 1],
      disabled_at: ['2026-10-20T00:00:00.000Z', null],
    });
  });

  test('同じ組織に同じ sub の一般の行があれば、その行を管理者にして、待っていた行を消す', async () => {
    const user = googleUser('星野 澪', { email: EMAIL });
    const waiting = await waitingAdmin();
    const member = await createUser(waiting.organization, {
      login_provider: 'google',
      login_subject: user.sub,
      is_admin: 0,
    });
    const result = await newBrowser().loginWithInvite(user, waiting.token);
    expect(result.location).toBe(`/${waiting.organization.slug}`);
    const rows = await usersOf(waiting.organization.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: member.id, is_admin: 1, disabled_at: null });
  });
});

describe('同じ戻りを2回流す', () => {
  test('同じ code と state の戻りを2回流すと、2回目は state を使い切っていて、行は1つのまま', async () => {
    const waiting = await waitingAdmin();
    const user = googleUser('星野 澪', { email: EMAIL });
    const browser = newBrowser();
    browser.provider = 'google';
    const started = await browser.startInvite(waiting.token);
    const code = google.issueCode(user, started.location);
    const state = started.state;
    const cookie = browser.cookies.get(STATE_COOKIE)!;
    const first = await browser.callback({ code, state });
    expect(first.location).toBe(`/${waiting.organization.slug}`);
    // 2回目は state の Cookie を付け直して流す（同じ戻りの再送）
    browser.cookies.set(STATE_COOKIE, cookie);
    const second = await browser.callback({ code, state });
    expect(second.location).toBe('/login?error=retry');
    expect(await usersOf(waiting.organization.id)).toHaveLength(1);
    expect((await changeLogsOf(waiting.organization.id)).filter((log) => log.action === 'update')).toHaveLength(1);
  });

  test('同じ URL から始めた2つのログインが同時に結ぶ書き込みまで進んでも、行が1つで、記録も1つ。後の1つは何も書かず、セッションを作らない', async () => {
    const waiting = await waitingAdmin();
    const user = googleUser('星野 澪', { email: EMAIL });

    // 1つ目は待つ行を読んだ直後に止め、その間に2つ目を最後まで進める
    const second = newBrowser();
    let secondResult: Awaited<ReturnType<typeof second.loginWithInvite>> | undefined;
    const interrupted = afterFirstQuery(
      loginEnv,
      (sql) => sql.includes('"claim_token_hash"') && sql.startsWith('select') && sql.includes('from "users"'),
      async () => {
        secondResult = await second.loginWithInvite(user, waiting.token);
      },
    );
    const first = newBrowser(interrupted);
    const firstResult = await first.loginWithInvite(user, waiting.token);

    expect(secondResult?.location).toBe(`/${waiting.organization.slug}`);
    expect(firstResult.location).toBe(INVITE_FAILED);
    expect(first.cookies.has(SESSION_COOKIE)).toBe(false);
    const rows = await usersOf(waiting.organization.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ login_subject: user.sub, claim_token_hash: null });
    expect((await changeLogsOf(waiting.organization.id)).filter((log) => log.action === 'update')).toHaveLength(1);
    expect(await countAccounts()).toBeGreaterThan(0);
  });
});

describe('ログインを始める POST', () => {
  async function countStatesAndLimits() {
    const db = commonDb(env);
    const states = await db.rows(db.statement((q) => q.selectFrom('oauth_states').select('state')));
    const limits = await db.rows(db.statement((q) => q.selectFrom('rate_limits').select('key')));
    return { states: states.length, limits: limits.length };
  }

  test('ほかのサイトからのフォームの POST（Sec-Fetch-Site: cross-site）では、ログインが始まらず、行も書かれない', async () => {
    const queries: string[] = [];
    const recording = envWithD1Hooks(loginEnv, {
      afterQuery: async (sql) => {
        queries.push(sql);
      },
      beforeBatch: (sqls) => {
        queries.push(...sqls);
      },
    });
    const { token } = await secret();
    const before = await countStatesAndLimits();
    for (const site of ['cross-site', 'same-site']) {
      const browser = newBrowser(recording);
      const started = await browser.startInvite(token, { headers: { 'Sec-Fetch-Site': site } });
      expect(started.response.status, site).toBe(302);
      expect(started.response.headers.get('Location'), site).toBe('/login');
      expect(browser.cookies.size, site).toBe(0);
    }
    // 画面の移動でない POST（fetch()、<iframe>）も同じ
    const notNavigations: Record<string, string>[] = [
      { 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty' },
      { 'Sec-Fetch-Dest': 'iframe' },
    ];
    for (const headers of notNavigations) {
      const started = await newBrowser(recording).startInvite(token, { headers });
      expect(started.response.headers.get('Location')).toBe('/login');
    }
    expect(queries).toEqual([]);
    expect(await countStatesAndLimits()).toEqual(before);
  });

  test('同じオリジンの画面の移動（フォームの POST）は始まる', async () => {
    const { token } = await secret();
    const started = await newBrowser().startInvite(token);
    expect(started.location.origin).toBe('https://accounts.google.com');
  });

  test.each([
    ['42文字', 'A'.repeat(42)],
    ['44文字', 'A'.repeat(44)],
    ['base64url の外の文字', `${'A'.repeat(42)}+`],
    ['空', ''],
    ['末尾の改行', `${'A'.repeat(43)}\n`],
    ['日本語', 'あ'.repeat(43)],
  ])('形の合わない秘密（%s）は、DB に問い合わせる前に断る', async (_label, claimToken) => {
    const queries: string[] = [];
    const recording = envWithD1Hooks(loginEnv, {
      afterQuery: async (sql) => {
        queries.push(sql);
      },
      beforeBatch: (sqls) => {
        queries.push(...sqls);
      },
    });
    const before = await countStatesAndLimits();
    const browser = newBrowser(recording);
    const started = await browser.startInvite(claimToken);
    expect(started.response.status).toBe(302);
    expect(started.response.headers.get('Location')).toBe(INVITE_FAILED);
    expect(browser.cookies.size).toBe(0);
    expect(queries).toEqual([]);
    expect(await countStatesAndLimits()).toEqual(before);
  });

  test.each([
    ['欄が無い', { body: 'other=1' }],
    ['欄が2つ', { body: `claim_token=${'A'.repeat(43)}&claim_token=${'B'.repeat(43)}` }],
    ['JSON の本文', { body: JSON.stringify({ claim_token: 'A'.repeat(43) }), contentType: 'application/json' }],
    ['multipart', { body: `claim_token=${'A'.repeat(43)}`, contentType: 'multipart/form-data; boundary=x' }],
    ['大きすぎる本文', { body: `claim_token=${'A'.repeat(43)}&pad=${'x'.repeat(2000)}` }],
  ])('本文の形が違う（%s）は、DB に問い合わせる前に断る', async (_label, options) => {
    const queries: string[] = [];
    const recording = envWithD1Hooks(loginEnv, {
      afterQuery: async (sql) => {
        queries.push(sql);
      },
      beforeBatch: (sqls) => {
        queries.push(...sqls);
      },
    });
    const started = await newBrowser(recording).startInvite('', options);
    expect(started.response.headers.get('Location')).toBe(INVITE_FAILED);
    expect(queries).toEqual([]);
  });

  test('秘密を URL のクエリで渡しても受け付けない', async () => {
    const { token } = await secret();
    const browser = newBrowser();
    const response = await browser.request(`/api/auth/google/start?claim_token=${token}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Site': 'same-origin',
      },
      body: '',
    });
    expect(response.headers.get('Location')).toBe(INVITE_FAILED);
  });

  test('GitHub には招待の URL の開始が無い', async () => {
    const { token } = await secret();
    const response = await newBrowser().request('/api/auth/github/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ claim_token: token }).toString(),
    });
    expect(response.status).toBe(404);
  });

  test('ログインのレート制限で数え、超えたら too_many で、state の行を書かない', async () => {
    const { token } = await secret();
    const browser = newBrowser();
    let last: Awaited<ReturnType<typeof browser.startInvite>> | undefined;
    // 開始と戻り先を合わせて 10分に60回まで。開始だけで使い切る
    for (let count = 0; count < 61; count++) last = await browser.startInvite(token);
    expect(last?.response.headers.get('Location')).toBe('/login?error=too_many');
    const before = await countStatesAndLimits();
    await browser.startInvite(token);
    expect(await countStatesAndLimits()).toEqual(before);
  });

  test('Google の資格情報が未設定なら unavailable で、state の行も書かない', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const unconfigured: Env = Object.assign({}, loginEnv, { GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '' });
    const { token } = await secret();
    const started = await newBrowser(unconfigured).startInvite(token);
    expect(started.response.headers.get('Location')).toBe('/login?error=unavailable');
  });
});

describe('GitHub でログイン済みの人が招待の URL を開く', () => {
  test('Google のアカウントのセッションに替わり、GitHub のセッションは消える。アカウントはまとめない', async () => {
    const githubPerson = githubUser('rin-hibari');
    github.addUser(githubPerson);
    const { organization: githubOrganization } = await organizationWithAdmin();
    await createUser(githubOrganization, {
      login_provider: 'github',
      login_subject: String(githubPerson.id),
      is_admin: 1,
    });
    const browser = newBrowser();
    const githubLogin = await browser.login(githubPerson);
    expect(githubLogin.response.status).toBe(302);
    const githubSession = browser.sessionToken!;
    const githubAccount = (await browser.post(me).then((res) => res.json())) as { account_id: string };

    const waiting = await waitingAdmin();
    const user = googleUser('星野 澪', { email: EMAIL });
    const result = await browser.loginWithInvite(user, waiting.token);
    expect(result.location).toBe(`/${waiting.organization.slug}`);
    expect(browser.sessionToken).not.toBe(githubSession);

    const mine = (await browser.post(me).then((res) => res.json())) as { account_id: string; login_provider: string };
    expect(mine.login_provider).toBe('google');
    expect(mine.account_id).not.toBe(githubAccount.account_id);
    // 古いセッションの行は消え、GitHub のアカウントは別のまま残る
    expect(await sessionRowsOf(githubAccount.account_id)).toHaveLength(0);
    expect(await githubLoginRow(githubPerson.id)).toMatchObject({ account_id: githubAccount.account_id });
  });

  test('結べなかったときは、GitHub のセッションを替えず、新しいセッションも作らない', async () => {
    const githubPerson = githubUser('mio-hibari');
    github.addUser(githubPerson);
    const { organization } = await organizationWithAdmin();
    await createUser(organization, { login_provider: 'github', login_subject: String(githubPerson.id), is_admin: 1 });
    const browser = newBrowser();
    await browser.login(githubPerson);
    const githubSession = browser.sessionToken;

    const waiting = await waitingAdmin({ email: 'someone.else@example.com' });
    const result = await browser.loginWithInvite(googleUser('星野 澪', { email: EMAIL }), waiting.token);
    expect(result.location).toBe(INVITE_FAILED);
    expect(browser.sessionToken).toBe(githubSession);
  });
});

async function githubLoginRow(id: number) {
  const db = commonDb(env);
  return db.first(
    db.statement((q) =>
      q
        .selectFrom('account_logins')
        .selectAll()
        .where('login_provider', '=', 'github')
        .where('login_subject', '=', String(id)),
    ),
  );
}

describe('招待（invitations）の結び', () => {
  test('招待の URL から結ぶと、sub を埋め、メールアドレス、秘密のハッシュ、期限を空にして、/ へ移す。届いた招待が出る', async () => {
    const waiting = await waitingInvitation();
    const user = googleUser('星野 澪', { email: EMAIL });
    const browser = newBrowser();
    const result = await browser.loginWithInvite(user, waiting.token);
    expect(result.location).toBe('/');

    const row = await invitationRow(waiting.organization, waiting.row.id);
    expect(row).toMatchObject({
      status: 'pending',
      login_subject: user.sub,
      login_email: null,
      claim_token_hash: null,
      claim_expires_at: null,
    });
    const list = (await browser.post(myOrganizations).then((res) => res.json())) as {
      invitations: { organization_name: string }[];
    };
    expect(list.invitations).toEqual([{ organization_name: waiting.organization.name }]);

    const log = (await changeLogsOf(waiting.organization.id)).find((item) => item.entity_type === 'invitation');
    expect(log).toMatchObject({
      entity_id: waiting.row.id,
      action: 'update',
      workspace_id: waiting.workspace.id,
      operator: null,
    });
    expect(JSON.parse(log!.changes_json)).toEqual({ login_subject: [null, user.sub] });
    expect(log!.changes_json).not.toContain(waiting.token);
    expect(log!.changes_json).not.toContain(EMAIL);
  });

  test('別のアドレス、期限切れ、使い済み、取り消し済みでは結ばれず、どれも同じ文言でセッションができない', async () => {
    const user = googleUser('星野 澪', { email: EMAIL });
    const mismatch = await waitingInvitation({ email: 'someone.else@example.com' });
    const expired = await waitingInvitation({ expiresAt: new Date(Date.now() - 1000).toISOString() });
    const revoked = await waitingInvitation();
    const db = orgDbOf(revoked.organization.id);
    await db.batch([
      db.statement((q) => q.updateTable('invitations').set({ status: 'revoked' }).where('id', '=', revoked.row.id)),
    ]);
    for (const target of [mismatch, expired, revoked]) {
      const browser = newBrowser();
      expect((await browser.loginWithInvite(user, target.token)).location).toBe(INVITE_FAILED);
      expect(browser.cookies.has(SESSION_COOKIE)).toBe(false);
    }
    expect(await googleAccountLoginOf(user)).toBeUndefined();

    const used = await waitingInvitation();
    expect((await newBrowser().loginWithInvite(user, used.token)).location).toBe('/');
    expect((await newBrowser().loginWithInvite(user, used.token)).location).toBe(INVITE_FAILED);
  });

  test('同じワークスペースに同じ sub の承諾待ちの別の招待があれば、待っていた招待を取り消す', async () => {
    const waiting = await waitingInvitation();
    const user = googleUser('星野 澪', { email: EMAIL });
    const other = await createInvitation(
      waiting.organization,
      waiting.workspace.id,
      waiting.admin.id,
      { provider: 'google', subject: user.sub },
      { created_at: new Date().toISOString() },
    );
    const result = await newBrowser().loginWithInvite(user, waiting.token);
    // 別の招待が承諾待ちのまま残るので、ログインはできる
    expect(result.location).toBe('/');
    expect(await invitationRow(waiting.organization, waiting.row.id)).toMatchObject({
      status: 'revoked',
      login_subject: null,
    });
    expect(await invitationRow(waiting.organization, other.id)).toMatchObject({ status: 'pending' });
    const log = (await changeLogsOf(waiting.organization.id)).find((item) => item.entity_id === waiting.row.id);
    expect(JSON.parse(log!.changes_json)).toEqual({ status: ['pending', 'revoked'] });
  });

  test('その人がもうそのワークスペースに所属していれば、待っていた招待を取り消す', async () => {
    const waiting = await waitingInvitation();
    const user = googleUser('星野 澪', { email: EMAIL });
    const member = await createUser(waiting.organization, {
      login_provider: 'google',
      login_subject: user.sub,
      is_admin: 0,
    });
    await createMembership(waiting.organization, waiting.workspace.id, member.id);
    const result = await newBrowser().loginWithInvite(user, waiting.token);
    expect(result.location).toBe('/');
    expect(await invitationRow(waiting.organization, waiting.row.id)).toMatchObject({
      status: 'revoked',
      login_subject: null,
      claim_token_hash: waiting.hash,
    });
    const log = (await changeLogsOf(waiting.organization.id)).find((item) => item.entity_id === waiting.row.id);
    expect(log).toMatchObject({ actor_user_id: member.id });
  });

  test('所属が別のワークスペースだけなら取り消さず、sub を埋める', async () => {
    const waiting = await waitingInvitation();
    const user = googleUser('星野 澪', { email: EMAIL });
    const member = await createUser(waiting.organization, {
      login_provider: 'google',
      login_subject: user.sub,
      is_admin: 0,
    });
    // 同じ組織の別のワークスペースに所属
    const elsewhere = await createWorkspace(waiting.organization, waiting.admin.id);
    await createMembership(waiting.organization, elsewhere.id, member.id);
    const result = await newBrowser().loginWithInvite(user, waiting.token);
    expect(result.location).toBe('/');
    expect(await invitationRow(waiting.organization, waiting.row.id)).toMatchObject({
      status: 'pending',
      login_subject: user.sub,
    });
  });
});

describe('待つ行を引く文', () => {
  test('秘密のハッシュの一意の索引に乗る（全件を読まない）', async () => {
    const statements = pendingClaimStatementsForTest(env, 'a'.repeat(64));
    for (const statement of [statements.user, statements.invitation]) {
      const plan = (await queryPlanForTest(env, statement)).join('\n');
      expect(plan).toMatch(/USING (COVERING )?INDEX sqlite_autoindex_(users|invitations)_\d/);
      expect(plan).not.toMatch(/^SCAN (users|invitations)\b/m);
    }
  });

  test('組織の中の DB が複数でも、持つ DB に結ぶ。どの DB にも無い秘密は、全部の DB を引いて当たらない', async () => {
    const waiting = await waitingAdmin();
    const queries: string[] = [];
    const empty = {
      prepare: (text: string) => ({
        bind: () => ({
          text,
          all: async () => {
            queries.push(text);
            return { results: [], meta: { changes: 0 } };
          },
        }),
      }),
      batch: async () => [],
    };
    const input = {
      email: EMAIL,
      login: { provider: 'google', subject: googleUser('星野 澪').sub },
      name: '星野 澪',
      now: new Date(),
    };
    const unknown = await claimPendingLoginForTest(env, { ...input, tokenHash: (await secret()).hash }, [empty]);
    expect(unknown).toBeUndefined();
    // 追加の DB（空）でも、ユーザーと招待の2回引く
    expect(queries).toHaveLength(2);

    const outcome = await claimPendingLoginForTest(env, { ...input, tokenHash: waiting.hash }, [empty]);
    expect(outcome).toEqual({ kind: 'user', organizationSlug: waiting.organization.slug });
  });
});

describe('結んだ後のアカウント', () => {
  test('アカウントの作成が失敗して再試行になっても、sub を埋めた行は残り、次の Google のログインで入れる', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const waiting = await waitingAdmin();
    const user = googleUser('星野 澪', { email: EMAIL });
    // accounts を書く batch() だけが失敗する D1
    const failing = envWithD1Hooks(loginEnv, {
      beforeBatch: (sqls) => {
        if (sqls.some((sql) => sql.startsWith('insert into "accounts"'))) throw new Error('secret SQL detail');
      },
    });
    const first = await newBrowser(failing).loginWithInvite(user, waiting.token);
    expect(first.location).toBe('/login?error=retry');
    expect((await usersOf(waiting.organization.id))[0]).toMatchObject({ login_subject: user.sub, account_id: null });

    // 次に Google でログインすれば sub で当たり、アカウントの作成に進む（招待の URL は使い切っている）
    const second = await newBrowser().loginWithGoogle(user);
    expect(second.location).toBe('/');
    expect((await usersOf(waiting.organization.id))[0]).toMatchObject({ account_id: expect.any(String) });
  });

  test('結べたあと、入れる組織が無い人のアカウントは作らない', async () => {
    // 結べなかったとき（招待が取り消し済み）はアカウントを作らないことを、アカウントの数で確かめる
    const waiting = await waitingInvitation();
    const db = orgDbOf(waiting.organization.id);
    await db.batch([
      db.statement((q) => q.updateTable('invitations').set({ status: 'revoked' }).where('id', '=', waiting.row.id)),
    ]);
    const before = await countAccounts();
    await newBrowser().loginWithInvite(googleUser('星野 澪', { email: EMAIL }), waiting.token);
    expect(await countAccounts()).toBe(before);
  });
});
