// 操作を登録する関数の振る舞い。仮の操作（test/operations/provisional.ts）で、Origin、セッション、入力、組織に入れるかを確かめる。
// 一覧を回す組織の分離と権限のテストは test/operation-registry.test.ts
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { z } from 'zod';
import { callOperation } from '../src/lib/api.ts';
import { defineOperation } from '../src/shared/operations/define.ts';
import { sessionCookieName } from '../src/shared/session-cookie.ts';
import { createApp } from '../src/server/app.ts';
import { parseOperatorLoginIds } from '../src/server/auth/operators.ts';
import { hashSessionToken, readSession } from '../src/server/auth/session.ts';
import { commonDb, orgDb } from '../src/server/db/index.ts';
import { verifiedOrganizationForTest } from '../src/server/db/testing.ts';
import { implement, type ImplementedOperation } from '../src/server/operations/implement.ts';
import { createInvitation, createMembership, createOrganization, createUser, createWorkspace } from './factories.ts';
import { errorCodeOf, post } from './operations/harness.ts';
import {
  closeWorkspace,
  inviteeProfile,
  operatorPing,
  organizationProfile,
  provisionalOperations,
  renameWorkspace,
  whoAmI,
  workspaceSummary,
} from './operations/provisional.ts';
import {
  admitElsewhere,
  createLoginPerson,
  createPerson,
  createTarget,
  getOperator,
  testEnv,
} from './operations/world.ts';

const app = createApp(provisionalOperations);
const cookieName = sessionCookieName(testEnv.PUBLIC_ORIGIN);

afterEach(() => {
  vi.restoreAllMocks();
});

async function readSessionRow(token: string) {
  const hash = await hashSessionToken(token);
  const db = commonDb(env);
  const row = await db.first(db.statement((q) => q.selectFrom('sessions').selectAll().where('token_hash', '=', hash)));
  if (row === undefined) throw new Error('セッションが無い');
  return row;
}

// ブラウザが付ける Origin と Cookie を付けて、アプリに直に流す fetch
const browser =
  (token: string, target: ReturnType<typeof createApp> = app): typeof fetch =>
  async (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set('Origin', testEnv.PUBLIC_ORIGIN);
    headers.set('Cookie', `${cookieName}=${token}`);
    return target.request(String(input), { ...init, headers }, testEnv);
  };

describe('Cookie の名前', () => {
  test('https の公開 URL では __Host- を付け、http の localhost では付けない', () => {
    expect(sessionCookieName('https://scrum-guild.ucan-lab.workers.dev')).toBe('__Host-sg_session');
    expect(sessionCookieName('https://scrum-guild.dev')).toBe('__Host-sg_session');
    expect(sessionCookieName('http://localhost:5173')).toBe('sg_session');
    expect(sessionCookieName('http://localhost:8797')).toBe('sg_session');
  });

  test('公開 URL に合う名前の Cookie だけを読む', async () => {
    const person = await createLoginPerson();
    const httpEnv: Env = Object.assign({}, testEnv, { PUBLIC_ORIGIN: 'http://localhost:5173' });
    const httpOk = await post(app, whoAmI, { env: httpEnv, headers: { Cookie: `sg_session=${person.token}` } });
    expect(httpOk.status).toBe(200);
    const httpWrongName = await post(app, whoAmI, {
      env: httpEnv,
      headers: { Cookie: `__Host-sg_session=${person.token}` },
    });
    expect(httpWrongName.status).toBe(401);

    const httpsOk = await post(app, whoAmI, { headers: { Cookie: `__Host-sg_session=${person.token}` } });
    expect(httpsOk.status).toBe(200);
    // https の側では、サブドメインから上書きされうる名前の Cookie を読まない
    const httpsWrongName = await post(app, whoAmI, { headers: { Cookie: `sg_session=${person.token}` } });
    expect(httpsWrongName.status).toBe(401);
  });

  test('出し直す Cookie も同じ名前と属性', async () => {
    const person = await createLoginPerson({
      sessionOverrides: { last_used_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString() },
    });
    const httpEnv: Env = Object.assign({}, testEnv, { PUBLIC_ORIGIN: 'http://localhost:5173' });
    const res = await post(app, whoAmI, { env: httpEnv, token: person.token });
    expect(res.headers.get('Set-Cookie')).toContain(`sg_session=${person.token}`);
  });
});

describe('Origin', () => {
  test('Origin の検査はセッションの読み取りより先に行う', async () => {
    const res = await post(app, whoAmI, { origin: 'https://evil.example' });
    expect(res.status).toBe(403);
    expect(await errorCodeOf(res)).toBe('forbidden');
  });

  test('Origin の検査は本文を読む前に行う（大きすぎる本文でも 403）', async () => {
    const res = await post(app, whoAmI, {
      origin: 'https://evil.example',
      rawBody: JSON.stringify({ note: 'x'.repeat(2 * 1024 * 1024) }),
    });
    expect(res.status).toBe(403);
  });
});

describe('ログインしていない呼び出し', () => {
  const unauthenticated = async (token: string | undefined) => {
    const res = await post(app, whoAmI, { token });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: { code: 'unauthenticated' } });
  };

  test('Cookie が無い', () => unauthenticated(undefined));
  test('トークンの形が違う', () => unauthenticated('short'));
  test('DB に無いトークン', () => unauthenticated('A'.repeat(43)));

  test('期限を過ぎたセッションは入れず、行も書き直さない', async () => {
    const expiresAt = new Date(Date.now() - 1000).toISOString();
    const lastUsedAt = '2026-01-01T00:00:00.000Z';
    const person = await createPerson({ sessionOverrides: { expires_at: expiresAt, last_used_at: lastUsedAt } });
    await unauthenticated(person.token);
    expect(await readSessionRow(person.token)).toMatchObject({ expires_at: expiresAt, last_used_at: lastUsedAt });
  });

  test('未ログインの呼び出しには本文を読ませない', async () => {
    const res = await post(app, whoAmI, { rawBody: JSON.stringify({ note: 'x'.repeat(2 * 1024 * 1024) }) });
    expect(res.status).toBe(401);
  });
});

describe('セッションの更新', () => {
  test('前回から1時間たっていなければ書き直さない', async () => {
    const lastUsed = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const person = await createLoginPerson({ sessionOverrides: { last_used_at: lastUsed } });
    const res = await post(app, whoAmI, { token: person.token });
    expect(res.status).toBe(200);
    expect((await readSessionRow(person.token)).last_used_at).toBe(lastUsed);
    expect(res.headers.get('Set-Cookie')).toBeNull();
  });

  test('前回から1時間以上たっていれば書き直して期限と Cookie を延ばし、直後の呼び出しでは書き直さない', async () => {
    const before = Date.now();
    const person = await createLoginPerson({
      sessionOverrides: { last_used_at: new Date(before - 2 * 60 * 60 * 1000).toISOString() },
    });
    const first = await post(app, whoAmI, { token: person.token });
    expect(first.status).toBe(200);
    const row = await readSessionRow(person.token);
    expect(Date.parse(row.last_used_at)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(row.expires_at) - Date.parse(row.last_used_at)).toBe(30 * 24 * 60 * 60 * 1000);

    const cookie = first.headers.get('Set-Cookie') ?? '';
    expect(cookie).toContain(`${cookieName}=${person.token}`);
    for (const attribute of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/']) expect(cookie).toContain(attribute);

    const second = await post(app, whoAmI, { token: person.token });
    expect(second.status).toBe(200);
    expect(second.headers.get('Set-Cookie')).toBeNull();
    expect((await readSessionRow(person.token)).last_used_at).toBe(row.last_used_at);
  });

  test('並行した2つの呼び出しで書き直すのは1回だけで、日時は巻き戻らない', async () => {
    const now = new Date();
    const person = await createPerson({
      sessionOverrides: { last_used_at: new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString() },
    });
    const earlier = new Date(now.getTime() - 60 * 1000);
    const results = await Promise.all([
      readSession(env, person.token, now, 'request-a'),
      readSession(env, person.token, earlier, 'request-b'),
    ]);
    expect(results.filter((session) => session?.refreshed)).toHaveLength(1);
    // 古い時刻の呼び出しが後から書いても、新しい時刻のまま
    expect((await readSessionRow(person.token)).last_used_at).toBe(now.toISOString());
  });

  test('書き直しに失敗しても、セッションは読めて、ログには名前だけを残す', async () => {
    const person = await createPerson({
      sessionOverrides: { last_used_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString() },
    });
    // batch() だけが失敗する D1。例外の message には SQL や接続の詳細が混ざりうる
    const failing = new Proxy(env, {
      get(target, prop) {
        const value = Reflect.get(target, prop);
        if (prop !== 'DB') return value;
        return new Proxy(value as object, {
          get(d1, name) {
            if (name === 'batch') return () => Promise.reject(new Error('secret SQL detail'));
            const member = Reflect.get(d1, name);
            return typeof member === 'function' ? member.bind(d1) : member;
          },
        });
      },
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const session = await readSession(failing, person.token, new Date(), 'request-c');
    expect(session).toEqual({
      accountId: person.accountId,
      tokenHash: await hashSessionToken(person.token),
      refreshed: false,
    });
    const logged = error.mock.calls.flat().join('\n');
    expect(JSON.parse(logged)).toMatchObject({ level: 'error', requestId: 'request-c', error: 'Error' });
    expect(logged).not.toContain('secret');
  });
});

describe('入力', () => {
  test('項目ごとの details を付けた 400 の invalid_input', async () => {
    const target = await createTarget();
    const res = await post(app, renameWorkspace, {
      slug: target.slug,
      token: target.admin.token,
      body: { workspace_id: target.workspace.id, name: '', count: 1.5 },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; details: { path: string; code: string }[] } };
    expect(body.error.code).toBe('invalid_input');
    expect(body.error.details.map((issue) => issue.path).sort()).toEqual(['count', 'name']);
  });

  test('壊れた JSON と JSON でない Content-Type は invalid_input', async () => {
    const token = (await getOperator()).token;
    const broken = await post(app, whoAmI, { token, rawBody: '{token=secret' });
    expect(broken.status).toBe(400);
    expect(await errorCodeOf(broken)).toBe('invalid_input');

    const form = await post(app, whoAmI, { token, headers: { 'Content-Type': 'text/plain' }, body: {} });
    expect(form.status).toBe(400);
  });

  test('大きすぎる本文は 413 の invalid_input で、操作のログに残る', async () => {
    const token = (await getOperator()).token;
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const large = await post(app, whoAmI, { token, rawBody: JSON.stringify({ note: 'x'.repeat(1024 * 1024) }) });
    expect(large.status).toBe(413);
    expect(await errorCodeOf(large)).toBe('invalid_input');
    expect(JSON.parse(String(log.mock.calls.at(-1)![0]))).toMatchObject({
      operation: 'who-am-i',
      code: 'invalid_input',
      status: 413,
    });
  });

  test('Content-Length の無い本文も、読んだ分を数えて上限で止める', async () => {
    const token = (await getOperator()).token;
    const chunk = new Uint8Array(256 * 1024).fill(0x78);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < 6; i++) controller.enqueue(chunk);
        controller.close();
      },
    });
    const res = await post(app, whoAmI, { token, rawBody: stream });
    expect(res.status).toBe(413);
    expect(await errorCodeOf(res)).toBe('invalid_input');
  });

  test('ワークスペースの下の操作で workspace_id が無ければ 400', async () => {
    const target = await createTarget();
    const res = await post(app, closeWorkspace, { slug: target.slug, token: target.admin.token, body: {} });
    expect(res.status).toBe(400);
  });
});

describe('出力', () => {
  test('定義の形でない戻り値は 500 の internal で、中身を応答に出さない', async () => {
    const badOutput = defineOperation({
      name: 'bad-output',
      description: '出力の検証を確かめる',
      mode: 'read',
      permission: 'login',
      input: z.object({}),
      output: z.object({ count: z.number() }),
    });
    const bad = createApp([implement(badOutput, async () => ({ count: 'secret-value' }) as never)]);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const res = await post(bad, badOutput, { token: (await getOperator()).token });
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain('secret-value');
  });

  test('定義に無い項目は落とす', async () => {
    const leaky = defineOperation({
      name: 'leaky',
      description: '出力の検証を確かめる',
      mode: 'read',
      permission: 'login',
      input: z.object({}),
      output: z.object({ name: z.string() }),
    });
    const leakyApp = createApp([
      implement(leaky, async () => ({ name: 'a', login_email: 'x@example.com' }) as { name: string }),
    ]);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const res = await post(leakyApp, leaky, { token: (await getOperator()).token });
    expect(await res.json()).toEqual({ name: 'a' });
  });

  test('変換を持つ出力のスキーマは、サーバーで1回だけ通し、画面は通し直さない', async () => {
    const shout = defineOperation({
      name: 'shout',
      description: '出力の変換を確かめる',
      mode: 'read',
      permission: 'login',
      input: z.object({}),
      // 通すたびに値が変わる変換。2回通すと a!! になる
      output: z.object({ label: z.string().transform((value) => `${value}!`) }),
    });
    const shoutApp = createApp([implement(shout, async () => ({ label: 'a' }))]);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const token = (await getOperator()).token;
    expect(await (await post(shoutApp, shout, { token })).json()).toEqual({ label: 'a!' });

    const result = await callOperation(shout, {}, { fetcher: browser(token, shoutApp) });
    expect(result).toEqual({ ok: true, data: { label: 'a!' } });
  });

  test('操作の名前が重なると登録で落ちる', () => {
    expect(() => createApp([...provisionalOperations, ...provisionalOperations])).toThrow(/重なって/);
  });
});

describe('定義の登録時の検査', () => {
  // 型の検査を抜けた定義（型を消した一覧、手で組んだオブジェクト）
  const forged = (overrides: Record<string, unknown>) =>
    ({ definition: { ...whoAmI, ...overrides }, handler: async () => ({}) }) as unknown as ImplementedOperation;

  test.each([
    ['権限の一覧に無い権限', { permission: 'owner' }, /権限の一覧/],
    ['workspace: true の無い member', { permission: 'member' }, /workspace: true が要る/],
    ['workspace: true の無い leader', { permission: 'leader' }, /workspace: true が要る/],
    ['workspace: true の組織の外の操作', { workspace: true }, /組織の外/],
    ['workspace: true の organization', { permission: 'organization', workspace: true }, /にできない/],
    ['workspace が真偽値でない', { workspace: 'yes' }, /workspace/],
    ['ワークスペースの下でない allowClosed', { allowClosed: true }, /allowClosed/],
    ['名前が URL の1語でない', { name: 'a/b' }, /名前/],
  ])('%s は登録で落ちる', (_label, overrides, message) => {
    expect(() => createApp([forged(overrides)])).toThrow(message);
  });

  test('処理が無い定義は登録で落ちる', () => {
    expect(() => createApp([{ definition: whoAmI, handler: undefined } as unknown as ImplementedOperation])).toThrow(
      /処理が無い/,
    );
  });
});

describe('組織に入れる人', () => {
  async function org() {
    const organization = await createOrganization();
    const adminUser = await createPerson({ organization, admin: true });
    const workspace = await createWorkspace(organization, adminUser.userId!);
    return { organization, adminUser, workspace };
  }

  // 組織の中を読む操作（organization）と、招待の操作（invitee）
  const enter = (slug: string, token: string) => post(app, organizationProfile, { slug, token });
  const enterAsInvitee = (slug: string, token: string) => post(app, inviteeProfile, { slug, token });

  test('停止した組織には管理者も入れず 404', async () => {
    const { organization, adminUser } = await org();
    await admitElsewhere(adminUser);
    expect((await enter(organization.slug, adminUser.token)).status).toBe(200);
    const db = commonDb(env);
    await db.batch([
      db.statement((q) =>
        q
          .updateTable('organizations')
          .set({ suspended_at: '2026-10-22T00:00:00.000Z' })
          .where('id', '=', organization.id),
      ),
    ]);
    const res = await enter(organization.slug, adminUser.token);
    expect(res.status).toBe(404);
    expect(await errorCodeOf(res)).toBe('not_found');
  });

  test('無効にされた人は、管理者でも所属や招待があっても 404', async () => {
    const { organization, workspace } = await org();
    const disabledAdmin = await createPerson({ organization, admin: true, disabled: true });
    const disabledMember = await createPerson({
      organization,
      disabled: true,
      membership: { workspaceId: workspace.id, role: 'member' },
    });
    const disabledInvitee = await createPerson({ organization, disabled: true });
    await createInvitation(organization, workspace.id, disabledInvitee.userId!, disabledInvitee.login);
    for (const person of [disabledAdmin, disabledMember, disabledInvitee]) {
      await admitElsewhere(person);
      expect((await enter(organization.slug, person.token)).status).toBe(404);
      expect((await enterAsInvitee(organization.slug, person.token)).status).toBe(404);
    }
  });

  test('アカウントに結ばれる前に無効にされた行も、招待で入る経路で止める', async () => {
    const { organization, adminUser, workspace } = await org();
    const unclaimed = (disabledAt: string | null) =>
      createPerson()
        .then(admitElsewhere)
        .then(async (person) => {
          // account_id が空の users の行（ログインの手段と ID だけで待っている）
          await createUser(organization, {
            account_id: null,
            login_provider: person.login.provider,
            login_subject: person.login.subject,
            disabled_at: disabledAt,
          });
          await createInvitation(organization, workspace.id, adminUser.userId!, person.login);
          return person;
        });
    const disabled = await unclaimed('2026-10-21T00:00:00.000Z');
    const notDisabled = await unclaimed(null);
    expect((await enterAsInvitee(organization.slug, disabled.token)).status).toBe(404);
    expect((await enterAsInvitee(organization.slug, notDisabled.token)).status).toBe(200);
  });

  test('すべてのワークスペースから外れた人は 404、所属していれば入れる', async () => {
    const { organization, workspace } = await org();
    const person = await createPerson({ organization, membership: { workspaceId: workspace.id, role: 'member' } });
    await admitElsewhere(person);
    expect((await enter(organization.slug, person.token)).status).toBe(200);
    const db = orgDb(env, verifiedOrganizationForTest(organization.id));
    await db.batch([
      db.statement((q) =>
        q
          .updateTable('memberships')
          .set({ left_on: '2026-10-21', left_at: '2026-10-21T00:00:00.000Z' })
          .where('user_id', '=', person.userId!),
      ),
    ]);
    expect((await enter(organization.slug, person.token)).status).toBe(404);
  });

  test('ワークスペースに所属していない管理者は入れる', async () => {
    const { organization, adminUser } = await org();
    const res = await enter(organization.slug, adminUser.token);
    expect(await res.json()).toEqual({ organization_id: organization.id, user_id: adminUser.userId });
  });

  test('承諾待ちの招待だけの人は、招待の操作には入れるが、組織の中を読む操作には 404', async () => {
    const { organization, adminUser, workspace } = await org();
    const invitee = await createPerson();
    await createInvitation(organization, workspace.id, adminUser.userId!, invitee.login);
    const res = await enterAsInvitee(organization.slug, invitee.token);
    expect(await res.json()).toEqual({ organization_id: organization.id, user_id: null });
    const read = await enter(organization.slug, invitee.token);
    expect(read.status).toBe(404);
    expect(await errorCodeOf(read)).toBe('not_found');
  });

  test('以前の所属が終わり、承諾待ちの招待を受けた人も、招待の操作だけに入れる', async () => {
    const { organization, adminUser, workspace } = await org();
    const person = await admitElsewhere(await createPerson({ organization }));
    await createMembership(organization, workspace.id, person.userId!, {
      left_on: '2026-10-21',
      left_at: '2026-10-21T00:00:00.000Z',
    });
    expect((await enterAsInvitee(organization.slug, person.token)).status).toBe(404);
    await createInvitation(organization, workspace.id, adminUser.userId!, person.login);
    expect((await enterAsInvitee(organization.slug, person.token)).status).toBe(200);
    expect((await enter(organization.slug, person.token)).status).toBe(404);
  });

  test('招待が承諾済み、辞退、取り消しなら入れず、別の組織への招待では入れない', async () => {
    const { organization, adminUser, workspace } = await org();
    const other = await org();
    for (const status of ['accepted', 'declined', 'revoked']) {
      const invitee = await admitElsewhere(await createPerson());
      await createInvitation(organization, workspace.id, adminUser.userId!, invitee.login, { status });
      expect((await enterAsInvitee(organization.slug, invitee.token)).status, status).toBe(404);
    }
    const invitedElsewhere = await createPerson();
    await createInvitation(other.organization, other.workspace.id, other.adminUser.userId!, invitedElsewhere.login);
    expect((await enterAsInvitee(organization.slug, invitedElsewhere.token)).status).toBe(404);
  });

  test('users の行がアカウントに結ばれていなければ入れない', async () => {
    const { organization } = await org();
    const person = await createPerson();
    await createUser(organization, {
      account_id: null,
      login_provider: person.login.provider,
      login_subject: person.login.subject,
      is_admin: 1,
    });
    expect((await enter(organization.slug, person.token)).status).toBe(404);
  });

  test('別の組織の管理者は、その組織では何の権限も持たない', async () => {
    const mine = await org();
    const theirs = await org();
    expect((await enter(mine.organization.slug, theirs.adminUser.token)).status).toBe(404);
  });

  test('別の組織のワークスペースの ID は、管理者でも 404', async () => {
    const mine = await org();
    const theirs = await org();
    const res = await post(app, closeWorkspace, {
      slug: mine.organization.slug,
      token: mine.adminUser.token,
      body: { workspace_id: theirs.workspace.id },
    });
    expect(res.status).toBe(404);
    expect(await errorCodeOf(res)).toBe('not_found');
  });

  test('離脱したワークスペースの下の操作は 403、今所属しているワークスペースは成功する', async () => {
    const { organization, adminUser, workspace } = await org();
    const left = await createWorkspace(organization, adminUser.userId!);
    const person = await createPerson({ organization, membership: { workspaceId: workspace.id, role: 'member' } });
    await createMembership(organization, left.id, person.userId!, {
      left_on: '2026-10-21',
      left_at: '2026-10-21T00:00:00.000Z',
    });
    const summary = (workspaceId: string) =>
      post(app, workspaceSummary, {
        slug: organization.slug,
        token: person.token,
        body: { workspace_id: workspaceId },
      });
    expect(await (await summary(workspace.id)).json()).toEqual({ workspace_id: workspace.id, role: 'member' });
    expect((await summary(left.id)).status).toBe(403);
  });
});

describe('閉じたワークスペース', () => {
  test('書き込みは 409 の workspace_closed で、権限の無い人は先に 403', async () => {
    const target = await createTarget({ closed: true });
    const rename = (token: string) =>
      post(app, renameWorkspace, {
        slug: target.slug,
        token,
        body: { workspace_id: target.workspace.id, name: '青葉チーム' },
      });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    const closed = await rename(target.leader.token);
    expect(closed.status).toBe(409);
    expect(await errorCodeOf(closed)).toBe('workspace_closed');
    expect(JSON.parse(String(log.mock.calls.at(-1)![0]))).toMatchObject({ code: 'workspace_closed', status: 409 });

    expect((await rename(target.member.token)).status).toBe(403);
  });

  test('読み取りは通り、開き直す操作（allowClosed）で書き込めるようになる', async () => {
    const target = await createTarget({ closed: true });
    const workspaceId = target.workspace.id;
    const call = (definition: Parameters<typeof post>[1], token: string) =>
      post(app, definition, { slug: target.slug, token, body: { workspace_id: workspaceId, name: '青葉チーム' } });
    const reopen = provisionalOperations.find((operation) => operation.definition.name === 'reopen-workspace')!;

    expect((await call(workspaceSummary, target.member.token)).status).toBe(200);
    expect((await call(renameWorkspace, target.leader.token)).status).toBe(409);
    expect((await call(reopen.definition, target.admin.token)).status).toBe(200);
    expect((await call(renameWorkspace, target.leader.token)).status).toBe(200);
  });
});

describe('運用者の一覧', () => {
  test.each([
    ['', [1]],
    ['github:1,', [2]],
    ['github:1, google:2', [2]],
    ['github:abc', [1]],
    ['Github:1', [1]],
    ['github:1,google:', [2]],
    ['github:1;google:2', [1]],
    ['github:-1', [1]],
  ])('形の合わない項目があると失敗する（%j）', (raw, positions) => {
    expect(parseOperatorLoginIds(raw)).toEqual({ ok: false, invalidPositions: positions });
  });

  test('github:<数字> と google:<数字> のカンマ区切りと、未設定は受け付ける', () => {
    expect(parseOperatorLoginIds('github:9000000000000001,google:123456789012345678901')).toEqual({
      ok: true,
      ids: new Set(['github:9000000000000001', 'google:123456789012345678901']),
    });
    expect(parseOperatorLoginIds(undefined)).toEqual({ ok: true, ids: new Set() });
  });

  test('形の合わない項目があると、すべての API が 500 になり、ログに値を出さない', async () => {
    const broken: Env = Object.assign({}, env, { OPERATOR_LOGIN_IDS: 'github:1,hunter2-secret' });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const operator = await getOperator();
    const brokenApp = createApp(provisionalOperations);
    const responses = await Promise.all([
      brokenApp.request('/api/health', {}, broken),
      brokenApp.request('/api/no-such', {}, broken),
      brokenApp.request(
        '/api/who-am-i',
        {
          method: 'POST',
          headers: {
            Origin: broken.PUBLIC_ORIGIN,
            Cookie: `${cookieName}=${operator.token}`,
            'Content-Type': 'application/json',
          },
          body: '{}',
        },
        broken,
      ),
    ]);
    for (const res of responses) {
      expect(res.status).toBe(500);
      expect(await errorCodeOf(res)).toBe('internal');
    }
    const logged = error.mock.calls.flat().join('\n');
    expect(logged).toContain('invalidPositions');
    expect(logged).not.toContain('hunter2');
    expect(logged).not.toContain('github:1');
  });

  test('手段と ID の完全一致だけで運用者になる', async () => {
    const sameNumberOtherProvider = await createPerson({ login: { provider: 'google', subject: '9000000000000001' } });
    const listed = await createPerson({ login: { provider: 'google', subject: '424242' } });
    const call = (token: string) => post(app, operatorPing, { token });
    expect((await call(sameNumberOtherProvider.token)).status).toBe(403);
    expect((await call(listed.token)).status).toBe(200);
  });
});

describe('操作のログ', () => {
  test('JSON の1行で、本文と Cookie とトークンを含まない', async () => {
    const target = await createTarget();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const res = await post(app, renameWorkspace, {
      slug: target.slug,
      token: target.leader.token,
      body: { workspace_id: target.workspace.id, name: 'ひみつの名前' },
      headers: { 'cf-ray': 'ray-1' },
    });
    expect(res.status).toBe(200);
    expect(log).toHaveBeenCalledTimes(1);
    const line = String(log.mock.calls[0]![0]);
    expect(line.split('\n')).toHaveLength(1);
    expect(JSON.parse(line)).toEqual({
      level: 'info',
      requestId: 'ray-1',
      operation: 'rename-workspace',
      organizationId: target.organization.id,
      userId: target.leader.userId,
      accountId: target.leader.accountId,
      code: 'ok',
      status: 200,
      durationMs: expect.any(Number),
    });
    for (const secret of ['ひみつの名前', target.leader.token, cookieName]) {
      expect(line).not.toContain(secret);
    }
  });

  test('失敗した呼び出しも code を付けて1行出す', async () => {
    const target = await createTarget();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await post(app, renameWorkspace, {
      slug: target.slug,
      token: target.member.token,
      body: { workspace_id: target.workspace.id, name: 'x' },
    });
    await post(app, whoAmI, {});
    const lines = log.mock.calls.map((call) => JSON.parse(String(call[0])));
    expect(lines).toMatchObject([
      { operation: 'rename-workspace', code: 'forbidden', status: 403, organizationId: target.organization.id },
      { operation: 'who-am-i', code: 'unauthenticated', status: 401, organizationId: null, userId: null },
    ]);
  });

  test('操作のログとエラーのログの requestId が揃う', async () => {
    const boom = defineOperation({
      name: 'boom',
      description: '想定外の例外を投げる',
      mode: 'read',
      permission: 'login',
      input: z.object({}),
      output: z.object({}),
    });
    const boomApp = createApp([
      implement(boom, async () => {
        throw new Error('秘密の中身');
      }),
    ]);
    // 500 は、操作のログも onError のログも console.error に出る（操作のログが先）
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const lines = () => error.mock.calls.map((call) => JSON.parse(String(call[0])));
    const token = (await getOperator()).token;

    await post(boomApp, boom, { token, headers: { 'cf-ray': 'ray-2' } });
    expect(lines()).toMatchObject([
      { operation: 'boom', requestId: 'ray-2', status: 500 },
      { code: 'internal', requestId: 'ray-2', method: 'POST' },
    ]);

    // cf-ray の無いリクエストには乱数を振り、2つのログで同じ値にする
    error.mockClear();
    await post(boomApp, boom, { token });
    const [operationLog, errorLog] = lines();
    expect(operationLog.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(errorLog.requestId).toBe(operationLog.requestId);
  });
});

describe('画面から呼ぶ関数', () => {
  test('定義から入力と出力の型を推論し、成功は data で返す', async () => {
    const target = await createTarget();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const result = await callOperation(
      renameWorkspace,
      { workspace_id: target.workspace.id, name: '青葉チーム' },
      { slug: target.slug, fetcher: browser(target.leader.token) },
    );
    expect(result).toEqual({ ok: true, data: { workspace_id: target.workspace.id, name: '青葉チーム' } });
  });

  test('失敗は status と error の code で返す', async () => {
    const target = await createTarget();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const result = await callOperation(
      renameWorkspace,
      { workspace_id: target.workspace.id, name: '青葉チーム' },
      { slug: target.slug, fetcher: browser(target.member.token) },
    );
    expect(result).toMatchObject({ ok: false, status: 403, error: { code: 'forbidden' } });
  });

  test('応答が JSON でなければ失敗として扱う', async () => {
    const result = await callOperation(whoAmI, {}, { fetcher: async () => new Response('<html></html>') });
    expect(result).toEqual({ ok: false, status: 200, error: null });
  });

  test('通信に失敗したら status 0 で返す', async () => {
    const result = await callOperation(whoAmI, {}, { fetcher: () => Promise.reject(new TypeError('offline')) });
    expect(result).toEqual({ ok: false, status: 0, error: null });
  });
});
