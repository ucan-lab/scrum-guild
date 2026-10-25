// 運用者の組織の操作（組織の一覧、GitHub のユーザー名の解決、組織の作成）の結合テスト。
// GitHub への通信は差し替えた fetch（test/auth/fake-github.ts）に向け、アプリと D1 は本物を使う。
// 組織の分離と権限の一覧のテスト（test/operation-registry.test.ts）は、この操作も回す
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createApp } from '../src/server/app.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import { operatorLoginIdOf } from '../src/server/auth/operators.ts';
import { sha256Hex } from '../src/server/auth/tokens.ts';
import { commonDb, insertOrganization, orgDb } from '../src/server/db/index.ts';
import {
  adminCountsStatementForTest,
  adminStatusesForTest,
  envWithD1Hooks,
  queryPlanForTest,
  verifiedOrganizationForTest,
  type FakeStatement,
} from '../src/server/db/testing.ts';
import {
  createOrganization as create,
  listOrganizations,
  resolveGithubUser,
} from '../src/shared/operations/operator/index.ts';
import { organizationInfo } from '../src/shared/operations/organization/index.ts';
import { createFakeGithub } from './auth/fake-github.ts';
import { createLoginApp, FakeBrowser } from './auth/browser.ts';
import { githubUser } from './auth/helpers.ts';
import {
  createAccount,
  createAccountLogin,
  createOrganization as createOrganizationRow,
  createUser,
} from './factories.ts';
import { errorCodeOf, post } from './operations/harness.ts';
import {
  createLoginPerson,
  createPerson,
  getOperator,
  OPERATOR_LOGIN_ID,
  testEnv,
  withNewSession,
} from './operations/world.ts';

const github = createFakeGithub();
const app = createApp(implementedOperations, { fetcher: github.fetcher });

afterEach(() => {
  vi.restoreAllMocks();
});

let slugCount = 0;
const newSlug = () => `op-test-${crypto.randomUUID().slice(0, 8)}-${slugCount++}`;

async function operatorToken(): Promise<string> {
  return (await withNewSession(await getOperator())).token;
}

type Problem = { path: string; code: string };

async function problemsOf(res: Response): Promise<Problem[]> {
  const body = (await res.json()) as { error: { details?: Problem[] } };
  return body.error.details ?? [];
}

// 組織の中の入口（作った組織の ID から。テストが確かめずに作る）
const orgDbOf = (organizationId: string) => orgDb(env, verifiedOrganizationForTest(organizationId));

async function organizationRow(slug: string) {
  const db = commonDb(env);
  return db.first(db.statement((q) => q.selectFrom('organizations').selectAll().where('slug', '=', slug)));
}

async function usersOf(organizationId: string) {
  const db = orgDbOf(organizationId);
  return db.rows(db.statement((q) => q.selectFrom('users').selectAll().where('organization_id', '=', organizationId)));
}

async function changeLogsOf(organizationId: string) {
  const db = orgDbOf(organizationId);
  return db.rows(
    db.statement((q) =>
      q
        .selectFrom('change_logs')
        .selectAll()
        .where('organization_id', '=', organizationId)
        .orderBy('entity_type', 'desc'),
    ),
  );
}

async function listed(token: string, slug: string) {
  const res = await post(app, listOrganizations, { token });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { organizations: { slug: string; admin_status: string }[] };
  return body.organizations.find((item) => item.slug === slug);
}

function adminOf(user: { id: number; login: string }) {
  return { provider: 'github', username: user.login, login_subject: String(user.id) };
}

describe('GitHub のユーザー名の解決', () => {
  test('ユーザー ID、ユーザー名、表示名、アバターの URL を返す', async () => {
    const user = githubUser('minato-aoba', { name: '星野 湊' });
    github.addUser(user);
    const res = await post(app, resolveGithubUser, { token: await operatorToken(), body: { username: 'Minato-Aoba' } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      login_subject: String(user.id),
      login_name: 'minato-aoba',
      display_name: '星野 湊',
      avatar_url: 'https://avatars.githubusercontent.com/u/7000000',
    });
  });

  test('いないユーザー名は 400 の invalid_input で、理由が github_user_not_found', async () => {
    const res = await post(app, resolveGithubUser, { token: await operatorToken(), body: { username: 'nobody-xyz' } });
    expect(res.status).toBe(400);
    expect(await errorCodeOf(res.clone())).toBe('invalid_input');
    expect(await problemsOf(res)).toEqual([
      expect.objectContaining({ path: 'username', code: 'github_user_not_found' }),
    ]);
  });

  test('GitHub の組織アカウントは、個人のアカウントでないことを示して断る', async () => {
    github.addUser({ id: 8_100_001, login: 'acme-guild', type: 'Organization' });
    const res = await post(app, resolveGithubUser, { token: await operatorToken(), body: { username: 'acme-guild' } });
    expect(res.status).toBe(400);
    expect(await errorCodeOf(res.clone())).toBe('invalid_input');
    expect(await problemsOf(res)).toEqual([expect.objectContaining({ path: 'username', code: 'github_not_a_user' })]);
  });

  test.each(['rate-limited', 'server-error'] as const)(
    'GitHub の上限や障害（%s）で届かないときは、入力の誤りと分けて 503 の unavailable',
    async (failure) => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      github.failNext.lookup = failure;
      const res = await post(app, resolveGithubUser, { token: await operatorToken(), body: { username: 'octo-cat' } });
      expect(res.status).toBe(503);
      expect(await errorCodeOf(res)).toBe('unavailable');
    },
  );

  test('GitHub の資格情報が未設定なら 503 の unavailable', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const unconfigured: Env = Object.assign({}, testEnv, { GITHUB_CLIENT_ID: '', GITHUB_CLIENT_SECRET: '' });
    const res = await post(app, resolveGithubUser, {
      token: await operatorToken(),
      body: { username: 'octo-cat' },
      env: unconfigured,
    });
    expect(res.status).toBe(503);
  });

  test('空のユーザー名は 400', async () => {
    const res = await post(app, resolveGithubUser, { token: await operatorToken(), body: { username: '  ' } });
    expect(res.status).toBe(400);
  });

  test('運用者でない人は 403', async () => {
    const person = await createLoginPerson();
    const res = await post(app, resolveGithubUser, { token: person.token, body: { username: 'octo-cat' } });
    expect(res.status).toBe(403);
  });
});

describe('組織の作成', () => {
  test('organizations と、最初の管理者の users、change_logs の2行ができる', async () => {
    const user = githubUser('minato-aoba');
    github.addUser(user);
    const slug = newSlug();
    const res = await post(app, create, {
      token: await operatorToken(),
      body: { slug, name: ' さくら開発 ', admin: adminOf(user) },
    });
    expect(res.status).toBe(200);
    // 応答は組織の表示名、slug、指名した人の GitHub のユーザー名だけ。招待の URL は Google の指名だけ
    expect(await res.json()).toEqual({
      slug,
      name: 'さくら開発',
      admin_login_name: 'minato-aoba',
      invite_url: null,
      invite_expires_at: null,
    });

    const organization = await organizationRow(slug);
    expect(organization).toMatchObject({
      slug,
      name: 'さくら開発',
      vocabulary: 'game',
      theme: 'simple',
      suspended_at: null,
      member_limit: 15,
      attachment_quota_bytes: 32212254720,
      stores_source_payload: 0,
      created_by_operator: OPERATOR_LOGIN_ID,
    });

    const users = await usersOf(organization!.id);
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({
      organization_id: organization!.id,
      account_id: null,
      login_provider: 'github',
      login_subject: String(user.id),
      login_email: null,
      name: 'minato-aoba',
      is_admin: 1,
      disabled_at: null,
    });

    const logs = await changeLogsOf(organization!.id);
    expect(logs).toHaveLength(2);
    expect(logs[0]).toMatchObject({
      entity_type: 'user',
      entity_id: users[0]!.id,
      action: 'create',
      actor_user_id: null,
      workspace_id: null,
      operator: OPERATOR_LOGIN_ID,
    });
    expect(logs[1]).toMatchObject({
      entity_type: 'organization',
      entity_id: organization!.id,
      action: 'create',
      actor_user_id: null,
      workspace_id: null,
      operator: OPERATOR_LOGIN_ID,
    });
    expect(JSON.parse(logs[1]!.changes_json)).toEqual({ slug: [null, slug], name: [null, 'さくら開発'] });
  });

  test('運用者のログインの ID は、複数のログインを持つ運用者では運用者の一覧に載っているものを残す', async () => {
    const operator = await withNewSession(await getOperator());
    // 一覧に載っていないログインも結ぶ。載っている方を使う
    await createAccountLogin(operator.accountId, { login_provider: 'github', login_subject: '123' });
    const user = githubUser('haruka-aoi');
    github.addUser(user);
    const slug = newSlug();
    const res = await post(app, create, {
      token: operator.token,
      body: { slug, name: '青葉工房', admin: adminOf(user) },
    });
    expect(res.status).toBe(200);
    expect((await organizationRow(slug))?.created_by_operator).toBe(OPERATOR_LOGIN_ID);
  });

  test('指名した人がログインするまで pending で、ログインした後は active。ログインしてその組織の管理者として入れる', async () => {
    const token = await operatorToken();
    const user = githubUser('rin-hibari');
    github.addUser(user);
    const slug = newSlug();
    expect((await post(app, create, { token, body: { slug, name: 'ひばり工房', admin: adminOf(user) } })).status).toBe(
      200,
    );
    expect((await listed(token, slug))?.admin_status).toBe('pending');

    const browser = new FakeBrowser(createLoginApp(github), github);
    const login = await browser.login(user);
    expect(login.response.status).toBe(302);

    const res = await post(app, organizationInfo, { slug, token: browser.sessionToken });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      organization: { name: 'ひばり工房' },
      me: { name: 'rin-hibari', is_admin: true },
    });
    expect((await listed(token, slug))?.admin_status).toBe('active');
  });

  test('既にアカウントのある人を指名すると、users.account_id を同じ書き込みで埋め、ログインし直さずに入れる', async () => {
    const user = githubUser('kotone-dev');
    github.addUser(user);
    // 別の組織で使っている人。account_logins がある
    const person = await createPerson({
      organization: await createOrganizationRow(),
      admin: true,
      login: { provider: 'github', subject: String(user.id) },
    });
    const slug = newSlug();
    const res = await post(app, create, {
      token: await operatorToken(),
      body: { slug, name: '新しい工房', admin: adminOf(user) },
    });
    expect(res.status).toBe(200);

    const organization = await organizationRow(slug);
    const users = await usersOf(organization!.id);
    expect(users[0]?.account_id).toBe(person.accountId);
    // 管理者の指名の change_logs に、結んだアカウントも残る
    const designation = (await changeLogsOf(organization!.id)).find((log) => log.entity_type === 'user');
    expect(JSON.parse(designation!.changes_json)).toMatchObject({ account_id: [null, person.accountId] });

    // セッションはそのまま。ログインし直さずに入れる
    const entered = await post(app, organizationInfo, { slug, token: person.token });
    expect(entered.status).toBe(200);
    expect(await entered.json()).toMatchObject({ me: { is_admin: true } });
    expect((await listed(await operatorToken(), slug))?.admin_status).toBe('active');
  });

  test('運用者は組織の中に特権を持たず、指名されていない組織には入れない', async () => {
    const slug = newSlug();
    const other = githubUser('someone-else');
    github.addUser(other);
    const token = await operatorToken();
    await post(app, create, { token, body: { slug, name: '別の工房', admin: adminOf(other) } });
    const res = await post(app, organizationInfo, { slug, token });
    expect(res.status).toBe(404);
  });

  test('運用者自身を管理者に指名すると、管理者として入れる', async () => {
    // 運用者のログイン（github:9000000000000001）のアカウントは account_logins にあるので、指名のときに結ばれる
    const operatorUser = { id: 9000000000000001, login: 'ops-user', name: '運用担当' };
    github.addUser(operatorUser);
    const slug = newSlug();
    const token = await operatorToken();
    const res = await post(app, create, { token, body: { slug, name: '運用者の工房', admin: adminOf(operatorUser) } });
    expect(res.status).toBe(200);
    const entered = await post(app, organizationInfo, { slug, token });
    expect(entered.status).toBe(200);
    expect(await entered.json()).toMatchObject({ me: { is_admin: true } });
  });

  test('組織の表示名に絵文字の結合（ZWJ）や方向の印は使える', async () => {
    const user = githubUser('emoji-name');
    github.addUser(user);
    const [zwj, zwnj, lrm, rlm] = [0x200d, 0x200c, 0x200e, 0x200f].map((code) => String.fromCodePoint(code));
    for (const name of [`👩${zwj}💻 工房`, `工${zwnj}房`, `工${lrm}房${rlm}`]) {
      const slug = newSlug();
      const res = await post(app, create, {
        token: await operatorToken(),
        body: { slug, name, admin: adminOf(user) },
      });
      expect(res.status, JSON.stringify(name)).toBe(200);
      expect((await organizationRow(slug))?.name).toBe(name);
    }
  });

  test('組織の表示名に制御文字、双方向の制御、ゼロ幅スペース、BOM は使えない', async () => {
    const user = githubUser('hidden-name');
    github.addUser(user);
    const [rlo, zwsp, lri, bom] = [0x202e, 0x200b, 0x2066, 0xfeff].map((code) => String.fromCodePoint(code));
    for (const name of [`工房${rlo}`, `工${zwsp}房`, '工\u0007房', `工${lri}房`, `工${bom}房`]) {
      const slug = newSlug();
      const res = await post(app, create, {
        token: await operatorToken(),
        body: { slug, name, admin: adminOf(user) },
      });
      expect(res.status, JSON.stringify(name)).toBe(400);
      expect(await organizationRow(slug)).toBeUndefined();
    }
  });

  test.each([
    ['大文字を含む', 'Sakura'],
    ['1文字', 'a'],
    ['41文字', 'a'.repeat(41)],
    ['アンダースコア', 'sakura_dev'],
    ['ハイフンで始まる', '-sakura'],
    ['日本語', 'さくら'],
    ['空', ''],
  ])('slug が%sなら slug_format で断り、GitHub に問い合わせず、行も作らない', async (_label, slug) => {
    const before = github.calls.length;
    const user = githubUser('format-check');
    github.addUser(user);
    const res = await post(app, create, {
      token: await operatorToken(),
      body: { slug, name: '工房', admin: adminOf(user) },
    });
    expect(res.status).toBe(400);
    expect(await problemsOf(res)).toEqual([expect.objectContaining({ path: 'slug', code: 'slug_format' })]);
    expect(github.calls.length).toBe(before);
    if (slug !== '') expect(await organizationRow(slug)).toBeUndefined();
  });

  test.each(['api', 'login', 'logout', 'invite', 'operator', 'auth'])(
    '予約した名前 %s は slug_reserved で断る',
    async (slug) => {
      const before = github.calls.length;
      const user = githubUser('reserved-check');
      github.addUser(user);
      const res = await post(app, create, {
        token: await operatorToken(),
        body: { slug, name: '工房', admin: adminOf(user) },
      });
      expect(res.status).toBe(400);
      expect(await problemsOf(res)).toEqual([expect.objectContaining({ path: 'slug', code: 'slug_reserved' })]);
      expect(github.calls.length).toBe(before);
      expect(await organizationRow(slug)).toBeUndefined();
    },
  );

  test('重なる slug は 409 の conflict で、GitHub に問い合わせない', async () => {
    const taken = await createOrganizationRow();
    const before = github.calls.length;
    const user = githubUser('conflict-check');
    github.addUser(user);
    const res = await post(app, create, {
      token: await operatorToken(),
      body: { slug: taken.slug, name: '工房', admin: adminOf(user) },
    });
    expect(res.status).toBe(409);
    expect(await errorCodeOf(res)).toBe('conflict');
    expect(github.calls.length).toBe(before);
  });

  test('読んだ後、書く前に同じ slug が作られて UNIQUE に当たったときも 409 で、管理者の行は書かない', async () => {
    const slug = newSlug();
    const user = githubUser('race-check');
    github.addUser(user);
    let racing: Awaited<ReturnType<typeof createOrganizationRow>> | undefined;
    let armed = true;
    const racingEnv = envWithD1Hooks(testEnv, {
      // slug の重なりを読んだ直後に、別の運用者が同じ slug の組織を作る
      afterQuery: async (sql) => {
        if (!armed || !sql.includes('from "organizations"') || !sql.includes('"slug"')) return;
        armed = false;
        racing = await createOrganizationRow({ slug });
      },
    });
    const res = await post(app, create, {
      token: await operatorToken(),
      body: { slug, name: '工房', admin: adminOf(user) },
      env: racingEnv,
    });
    expect(res.status).toBe(409);
    expect(await errorCodeOf(res)).toBe('conflict');
    expect(await usersOf(racing!.id)).toEqual([]);
  });

  test('確かめたユーザー ID と解決し直した ID が違うと、invalid_input の github_user_changed で、行も作らない', async () => {
    const user = githubUser('swap-check');
    github.addUser(user);
    const slug = newSlug();
    const res = await post(app, create, {
      token: await operatorToken(),
      body: { slug, name: '工房', admin: { ...adminOf(user), login_subject: String(user.id + 1) } },
    });
    expect(res.status).toBe(400);
    expect(await errorCodeOf(res.clone())).toBe('invalid_input');
    expect(await problemsOf(res)).toEqual([
      expect.objectContaining({ path: 'admin.login_subject', code: 'github_user_changed' }),
    ]);
    expect(await organizationRow(slug)).toBeUndefined();
  });

  test('GitHub の組織アカウントを指すと、個人のアカウントでないことで断り、行も作らない', async () => {
    github.addUser({ id: 8_100_002, login: 'acme-works', type: 'Organization' });
    const slug = newSlug();
    const res = await post(app, create, {
      token: await operatorToken(),
      body: { slug, name: '工房', admin: { provider: 'github', username: 'acme-works', login_subject: '8100002' } },
    });
    expect(res.status).toBe(400);
    expect(await problemsOf(res)).toEqual([
      expect.objectContaining({ path: 'admin.username', code: 'github_not_a_user' }),
    ]);
    expect(await organizationRow(slug)).toBeUndefined();
  });

  test('いないユーザー名は github_user_not_found で断り、行も作らない', async () => {
    const slug = newSlug();
    const res = await post(app, create, {
      token: await operatorToken(),
      body: { slug, name: '工房', admin: { provider: 'github', username: 'nobody-abc', login_subject: '1' } },
    });
    expect(res.status).toBe(400);
    expect(await problemsOf(res)).toEqual([
      expect.objectContaining({ path: 'admin.username', code: 'github_user_not_found' }),
    ]);
    expect(await organizationRow(slug)).toBeUndefined();
  });

  test.each(['', '   ', 'みお@example.com', 'mio@', 'mio example@example.com', 'a@b@example.com'])(
    'Google のメールアドレスの形が合わない（%j）と、email_invalid で断り、行も作らない',
    async (email) => {
      const slug = newSlug();
      const res = await post(app, create, {
        token: await operatorToken(),
        body: { slug, name: '工房', admin: { provider: 'google', email } },
      });
      expect(res.status).toBe(400);
      expect(await errorCodeOf(res.clone())).toBe('invalid_input');
      if (email.trim() !== '') {
        expect(await problemsOf(res)).toEqual([
          expect.objectContaining({ path: 'admin.email', code: 'email_invalid' }),
        ]);
      }
      expect(await organizationRow(slug)).toBeUndefined();
    },
  );

  test('重なる slug は Google の指名でも 409 で、行も作らない', async () => {
    const existing = await createOrganizationRow();
    const res = await post(app, create, {
      token: await operatorToken(),
      body: { slug: existing.slug, name: '工房', admin: { provider: 'google', email: 'mio@example.com' } },
    });
    expect(res.status).toBe(409);
    expect(await usersOf(existing.id)).toEqual([]);
  });

  test('GitHub に届かないときは 503 の unavailable で、行も作らない', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const user = githubUser('down-check');
    github.addUser(user);
    github.failNext.lookup = 'rate-limited';
    const slug = newSlug();
    const res = await post(app, create, {
      token: await operatorToken(),
      body: { slug, name: '工房', admin: adminOf(user) },
    });
    expect(res.status).toBe(503);
    expect(await errorCodeOf(res)).toBe('unavailable');
    expect(await organizationRow(slug)).toBeUndefined();
  });

  test('運用者でない人は 403 で、何も作らない', async () => {
    const person = await createLoginPerson();
    const user = githubUser('forbidden-check');
    github.addUser(user);
    const slug = newSlug();
    const res = await post(app, create, { token: person.token, body: { slug, name: '工房', admin: adminOf(user) } });
    expect(res.status).toBe(403);
    expect(await organizationRow(slug)).toBeUndefined();
  });

  test('users の書き込みが失敗すると organizations だけが残り、一覧では管理者の状態が none になる', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const user = githubUser('write-fail');
    github.addUser(user);
    const slug = newSlug();
    const failing = envWithD1Hooks(testEnv, {
      beforeBatch: (sqls) => {
        if (sqls.some((sql) => sql.startsWith('insert into "users"'))) throw new Error('secret SQL detail');
      },
    });
    const token = await operatorToken();
    const res = await post(app, create, { token, body: { slug, name: '工房', admin: adminOf(user) }, env: failing });
    expect(res.status).toBe(500);
    expect(await errorCodeOf(res)).toBe('internal');

    const organization = await organizationRow(slug);
    expect(organization).toBeDefined();
    expect(await usersOf(organization!.id)).toEqual([]);
    // 同じ batch() の change_logs も書かれない
    expect(await changeLogsOf(organization!.id)).toEqual([]);
    expect((await listed(token, slug))?.admin_status).toBe('none');

    // ログに残るのは例外の名前と組織の ID だけ。SQL や接続の詳細は出さない
    const logged = errorLog.mock.calls.map((call) => String(call[0])).join('\n');
    expect(logged).toContain(organization!.id);
    expect(logged).not.toContain('secret SQL detail');
  });
});

describe('組織の一覧', () => {
  test('slug、名前、停止の有無、作った日時、管理者の状態だけを返し、組織の中のデータは返さない', async () => {
    const organization = await createOrganizationRow({ name: '一覧の工房', suspended_at: '2026-10-20T00:00:00.000Z' });
    await createUser(organization, { is_admin: 1, name: '漏れてはいけない名前', account_id: null });
    const res = await post(app, listOrganizations, { token: await operatorToken() });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain('漏れてはいけない名前');
    const item = (JSON.parse(text) as { organizations: Record<string, unknown>[] }).organizations.find(
      (entry) => entry.slug === organization.slug,
    );
    expect(item).toEqual({
      slug: organization.slug,
      name: '一覧の工房',
      suspended_at: '2026-10-20T00:00:00.000Z',
      created_at: organization.created_at,
      admin_status: 'pending',
    });
  });

  test('管理者の状態: 管理者の行が無ければ none、アカウントに結ばれていなければ pending、結ばれていれば active', async () => {
    const token = await operatorToken();
    const none = await createOrganizationRow();
    const pending = await createOrganizationRow();
    await createUser(pending, { is_admin: 1, account_id: null });
    const active = await createOrganizationRow();
    const account = await createAccount();
    await createUser(active, { is_admin: 1, account_id: account.id });
    // 管理者でない人と、無効にした管理者は数えない
    const onlyMembers = await createOrganizationRow();
    await createUser(onlyMembers, { is_admin: 0, account_id: (await createAccount()).id });
    const onlyDisabled = await createOrganizationRow();
    await createUser(onlyDisabled, {
      is_admin: 1,
      account_id: (await createAccount()).id,
      disabled_at: '2026-10-21T00:00:00.000Z',
    });
    // 結ばれていない管理者と結ばれた管理者がいれば active
    const mixed = await createOrganizationRow();
    await createUser(mixed, { is_admin: 1, account_id: null });
    await createUser(mixed, { is_admin: 1, account_id: (await createAccount()).id });

    const statusOf = async (organization: { slug: string }) => (await listed(token, organization.slug))?.admin_status;
    expect(await statusOf(none)).toBe('none');
    expect(await statusOf(pending)).toBe('pending');
    expect(await statusOf(active)).toBe('active');
    expect(await statusOf(onlyMembers)).toBe('none');
    expect(await statusOf(onlyDisabled)).toBe('none');
    expect(await statusOf(mixed)).toBe('active');
  });

  test('組織の ID が束縛の上限を超えても、区切って1組織ずつ状態を返す', async () => {
    const pending = await createOrganizationRow();
    await createUser(pending, { is_admin: 1, account_id: null });
    const filler = Array.from({ length: 250 }, () => crypto.randomUUID());
    const ids = [...filler.slice(0, 120), pending.id, ...filler.slice(120)];
    const statuses = await adminStatusesForTest(env, ids, []);
    expect(statuses.size).toBe(ids.length);
    expect(statuses.get(pending.id)).toBe('pending');
    expect(statuses.get(filler[0]!)).toBe('none');
  });

  test('組織の中の DB が複数でも、DB ごとの数を足し合わせる', async () => {
    const organization = await createOrganizationRow();
    await createUser(organization, { is_admin: 1, account_id: null });
    const queries: string[] = [];
    const second = {
      prepare: (text: string) => ({
        bind: () => ({
          text,
          all: async () => {
            queries.push(text);
            return { results: [{ organization_id: organization.id, admins: 1, linked: 1 }], meta: { changes: 0 } };
          },
        }),
      }),
      batch: async (statements: FakeStatement[]) => statements.map(() => ({ results: [], meta: { changes: 0 } })),
    };
    const statuses = await adminStatusesForTest(env, [organization.id], [second]);
    // 1つ目の DB は pending、2つ目の DB は結ばれた管理者がいる。足し合わせて active
    expect(statuses.get(organization.id)).toBe('active');
    expect(queries).toHaveLength(1);
  });

  test('管理者の状態を数える文は users_organization_login の索引に乗る', async () => {
    const plan = await queryPlanForTest(env, adminCountsStatementForTest(env, ['x']));
    for (const line of plan) expect(line).not.toMatch(/^SCAN users\b/);
    expect(plan.join('\n')).toMatch(/users_organization_login|users_organization_account/);
  });
});

describe('書き込みの途中の失敗と割り込み', () => {
  const isOrganizationInsert = (sqls: readonly string[]) =>
    sqls.some((sql) => sql.startsWith('insert into "organizations"'));

  test('INSERT がコミットされた後に応答だけ失敗しても、行が自分のものなら成功として続け、管理者も書く', async () => {
    const user = githubUser('lost-response');
    github.addUser(user);
    const slug = newSlug();
    let lost = false;
    const lossyEnv = envWithD1Hooks(testEnv, {
      afterBatch: (sqls) => {
        if (lost || !isOrganizationInsert(sqls)) return;
        lost = true;
        throw new Error('connection lost');
      },
    });
    const res = await post(app, create, {
      token: await operatorToken(),
      body: { slug, name: '工房', admin: adminOf(user) },
      env: lossyEnv,
    });
    expect(lost).toBe(true);
    expect(res.status).toBe(200);
    const organization = await organizationRow(slug);
    expect(await usersOf(organization!.id)).toHaveLength(1);
    expect(await changeLogsOf(organization!.id)).toHaveLength(2);
  });

  test('応答が失敗し、行も読み直せないときは、元の例外を cause に付けて投げる', async () => {
    const slug = newSlug();
    const original = new Error('connection lost');
    const brokenEnv = envWithD1Hooks(testEnv, {
      afterBatch: (sqls) => {
        if (isOrganizationInsert(sqls)) throw original;
      },
      afterQuery: async (sql) => {
        if (sql.includes('from "organizations"')) throw new Error('read failed');
      },
    });
    const failure = await insertOrganization(brokenEnv, {
      slug,
      name: '工房',
      createdByOperator: OPERATOR_LOGIN_ID,
      now: new Date(),
    }).catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).cause).toBe(original);
  });

  test('応答が失敗し、同じ slug の行が別の ID で既にあれば、slug_taken', async () => {
    const taken = await createOrganizationRow();
    const failingEnv = envWithD1Hooks(testEnv, {
      beforeBatch: (sqls) => {
        if (isOrganizationInsert(sqls)) throw new Error('write failed');
      },
    });
    const result = await insertOrganization(failingEnv, {
      slug: taken.slug,
      name: '工房',
      createdByOperator: OPERATOR_LOGIN_ID,
      now: new Date(),
    });
    expect(result).toBe('slug_taken');
  });

  test('アカウントが無いと読んだ後、書くまでの間にその人が初めてログインを終えても、users.account_id を結ぶ', async () => {
    const user = githubUser('first-login-window');
    github.addUser(user);
    const slug = newSlug();
    let accountId: string | undefined;
    const racingEnv = envWithD1Hooks(testEnv, {
      // users を書いた直後に、その人の最初のログイン（accounts と account_logins）が完了する
      afterBatch: async (sqls) => {
        if (accountId !== undefined || !sqls.some((sql) => sql.startsWith('insert into "users"'))) return;
        const account = await createAccount();
        accountId = account.id;
        await createAccountLogin(account.id, { login_provider: 'github', login_subject: String(user.id) });
      },
    });
    const res = await post(app, create, {
      token: await operatorToken(),
      body: { slug, name: '工房', admin: adminOf(user) },
      env: racingEnv,
    });
    expect(res.status).toBe(200);
    expect(accountId).toBeDefined();
    const organization = await organizationRow(slug);
    expect((await usersOf(organization!.id))[0]?.account_id).toBe(accountId);
  });
});

describe('結び直しの失敗', () => {
  test('書いた後の結び直しが失敗しても 200 を返し、organizations と users は残り、ログには組織の ID が出て SQL は出ない', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const user = githubUser('link-fails');
    github.addUser(user);
    const slug = newSlug();
    let accountId: string | undefined;
    const failingEnv = envWithD1Hooks(testEnv, {
      // users を書いた直後にその人の最初のログインが完了し、結ぶ UPDATE は失敗する
      beforeBatch: (sqls) => {
        if (sqls.some((sql) => sql.startsWith('update "users"'))) throw new Error('secret SQL detail');
      },
      afterBatch: async (sqls) => {
        if (accountId !== undefined || !sqls.some((sql) => sql.startsWith('insert into "users"'))) return;
        const account = await createAccount();
        accountId = account.id;
        await createAccountLogin(account.id, { login_provider: 'github', login_subject: String(user.id) });
      },
    });
    const res = await post(app, create, {
      token: await operatorToken(),
      body: { slug, name: '工房', admin: adminOf(user) },
      env: failingEnv,
    });
    expect(res.status).toBe(200);
    const organization = await organizationRow(slug);
    expect(organization).toBeDefined();
    const users = await usersOf(organization!.id);
    expect(users).toHaveLength(1);
    expect(users[0]?.account_id).toBeNull();

    const logged = errorLog.mock.calls.map((call) => String(call[0])).join('\n');
    expect(logged).toContain(organization!.id);
    expect(logged).toContain('create-organization');
    expect(logged).not.toContain('secret SQL detail');
  });
});

describe('Google のメールアドレスでの指名', () => {
  async function createWithGoogle(email: string) {
    const slug = newSlug();
    const res = await post(app, create, {
      token: await operatorToken(),
      body: { slug, name: 'ひばり工房', admin: { provider: 'google', email } },
    });
    return { slug, res };
  }

  test('待つ行（login_subject が空、メールアドレス、秘密のハッシュ、14日の期限）と change_logs の2行ができ、応答の本文にだけ招待の URL がある', async () => {
    const { slug, res } = await createWithGoogle('  Mio.Hoshino@Example.com ');
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    const body = (await res.json()) as Record<string, string>;
    expect(Object.keys(body).sort()).toEqual(['admin_login_name', 'invite_expires_at', 'invite_url', 'name', 'slug']);
    expect(body.admin_login_name).toBe('mio.hoshino@example.com');
    const url = new URL(body.invite_url!);
    expect(url.pathname).toBe('/invite');
    const claimToken = url.hash.slice(1);
    expect(claimToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // ヘッダーのどれにも秘密を入れない
    for (const [name, value] of res.headers) expect(value, name).not.toContain(claimToken);

    const organization = await organizationRow(slug);
    const users = await usersOf(organization!.id);
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({
      account_id: null,
      login_provider: 'google',
      login_subject: null,
      login_email: 'mio.hoshino@example.com',
      claim_token_hash: await sha256Hex(claimToken),
      claim_expires_at: body.invite_expires_at,
      name: 'mio.hoshino@example.com',
      is_admin: 1,
    });
    const span = Date.parse(users[0]!.claim_expires_at!) - Date.parse(users[0]!.created_at);
    expect(span).toBe(14 * 24 * 60 * 60 * 1000);

    const logs = await changeLogsOf(organization!.id);
    expect(logs).toHaveLength(2);
    // 記録に秘密、ハッシュ、メールアドレス、期限を入れない
    for (const log of logs) {
      for (const secret of [claimToken, users[0]!.claim_token_hash!, 'mio.hoshino', users[0]!.claim_expires_at!]) {
        expect(log.changes_json, log.entity_type).not.toContain(secret);
      }
    }
    expect(JSON.parse(logs.find((log) => log.entity_type === 'user')!.changes_json)).toEqual({
      is_admin: [null, 1],
      name: [null, 'Google の招待（ログイン待ち）'],
      login_provider: [null, 'google'],
    });
  });

  test('一覧の管理者の状態は、待つ間は pending、期限が過ぎると expired。結ばれていない別の指名が混ざれば pending', async () => {
    const token = await operatorToken();
    const { slug } = await createWithGoogle('mio@example.com');
    expect((await listed(token, slug))?.admin_status).toBe('pending');

    const organization = (await organizationRow(slug))!;
    const db = orgDbOf(organization.id);
    await db.batch([
      db.statement((q) =>
        q
          .updateTable('users')
          .set({ claim_expires_at: new Date(Date.now() - 1000).toISOString() })
          .where('organization_id', '=', organization.id),
      ),
    ]);
    expect((await listed(token, slug))?.admin_status).toBe('expired');

    // 期限切れの待つ行と、まだ結ばれていない GitHub の指名が混ざるときは、待つ人がいるので pending
    await createUser(
      { ...organization, verified: verifiedOrganizationForTest(organization.id) },
      { is_admin: 1, account_id: null },
    );
    expect((await listed(token, slug))?.admin_status).toBe('pending');
  });

  test('一覧は招待の URL を返さない（応答の本文にも、一覧の項目にもない）', async () => {
    const token = await operatorToken();
    const { slug, res } = await createWithGoogle('mio2@example.com');
    const claimToken = new URL(((await res.json()) as { invite_url: string }).invite_url).hash.slice(1);
    const listedRes = await post(app, listOrganizations, { token });
    expect(await listedRes.text()).not.toContain(claimToken);
    expect(slug).toBeTruthy();
  });

  test('organizations と users の書き込みの途中で失敗すると、管理者のいない組織が残る（none）', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const failing = envWithD1Hooks(testEnv, {
      beforeBatch: (sqls) => {
        if (sqls.some((sql) => sql.startsWith('insert into "users"'))) throw new Error('secret SQL detail');
      },
    });
    const slug = newSlug();
    const res = await post(app, create, {
      token: await operatorToken(),
      env: failing,
      body: { slug, name: '工房', admin: { provider: 'google', email: 'mio3@example.com' } },
    });
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain('mio3@example.com');
    expect((await listed(await operatorToken(), slug))?.admin_status).toBe('none');
  });

  test('運用者でない人は 403 で、何も作らない', async () => {
    const slug = newSlug();
    const person = await createLoginPerson();
    const res = await post(app, create, {
      token: person.token,
      body: { slug, name: '工房', admin: { provider: 'google', email: 'mio4@example.com' } },
    });
    expect(res.status).toBe(403);
    expect(await organizationRow(slug)).toBeUndefined();
  });
});

describe('運用者のログインの ID', () => {
  const logins = [
    { provider: 'github', subject: '9' },
    { provider: 'github', subject: '1' },
    { provider: 'github', subject: '2' },
  ];

  test('一覧に2つ載っていても、一覧の並びで先のものを選び、ログインを引く順に左右されない', () => {
    const list = { OPERATOR_LOGIN_IDS: 'github:2,github:1' };
    expect(operatorLoginIdOf(list, logins)).toBe('github:2');
    expect(operatorLoginIdOf(list, [...logins].reverse())).toBe('github:2');
  });

  test('一覧に載っていないログインだけなら undefined。載っていないログインが先に返っても、載っている方を選ぶ', () => {
    const list = { OPERATOR_LOGIN_IDS: 'github:1' };
    expect(operatorLoginIdOf(list, logins.slice(0, 1))).toBeUndefined();
    expect(operatorLoginIdOf(list, logins)).toBe('github:1');
  });
});
