// 操作を登録する関数の振る舞い。仮の操作（test/operations/provisional.ts）で、Origin、セッション、入力、組織に入れるかを確かめる。
// 一覧を回す組織の分離と権限のテストは test/operation-registry.test.ts
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { z } from 'zod';
import { callOperation } from '../src/lib/api.ts';
import { defineOperation } from '../src/shared/operations/define.ts';
import { SESSION_COOKIE_NAME } from '../src/shared/session-cookie.ts';
import { createApp } from '../src/server/app.ts';
import { parseOperatorLoginIds } from '../src/server/auth/operators.ts';
import { hashSessionToken } from '../src/server/auth/session.ts';
import { commonDb, orgDb } from '../src/server/db/index.ts';
import { verifiedOrganizationForTest } from '../src/server/db/testing.ts';
import { implement } from '../src/server/operations/implement.ts';
import { createInvitation, createMembership, createOrganization, createUser, createWorkspace } from './factories.ts';
import { errorCodeOf, post } from './operations/harness.ts';
import {
  closeWorkspace,
  operatorPing,
  organizationProfile,
  provisionalOperations,
  renameWorkspace,
  whoAmI,
  workspaceSummary,
} from './operations/provisional.ts';
import { createPerson, createTarget, getOperator, testEnv } from './operations/world.ts';

const app = createApp(provisionalOperations);

afterEach(() => {
  vi.restoreAllMocks();
});

async function readSession(token: string) {
  const hash = await hashSessionToken(token);
  const db = commonDb(env);
  const row = await db.first(db.statement((q) => q.selectFrom('sessions').selectAll().where('token_hash', '=', hash)));
  if (row === undefined) throw new Error('セッションが無い');
  return row;
}

describe('Origin', () => {
  test('Origin の検査はセッションの読み取りより先に行う', async () => {
    const res = await post(app, whoAmI, { origin: 'https://evil.example' });
    expect(res.status).toBe(403);
    expect(await errorCodeOf(res)).toBe('forbidden');
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
    expect(await readSession(person.token)).toMatchObject({ expires_at: expiresAt, last_used_at: lastUsedAt });
  });
});

describe('セッションの更新', () => {
  test('前回から1時間たっていなければ書き直さない', async () => {
    const lastUsed = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const person = await createPerson({ sessionOverrides: { last_used_at: lastUsed } });
    const res = await post(app, whoAmI, { token: person.token });
    expect(res.status).toBe(200);
    expect((await readSession(person.token)).last_used_at).toBe(lastUsed);
    expect(res.headers.get('Set-Cookie')).toBeNull();
  });

  test('前回から1時間以上たっていれば書き直して期限と Cookie を延ばし、直後の呼び出しでは書き直さない', async () => {
    const before = Date.now();
    const person = await createPerson({
      sessionOverrides: { last_used_at: new Date(before - 2 * 60 * 60 * 1000).toISOString() },
    });
    const first = await post(app, whoAmI, { token: person.token });
    expect(first.status).toBe(200);
    const row = await readSession(person.token);
    expect(Date.parse(row.last_used_at)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(row.expires_at) - Date.parse(row.last_used_at)).toBe(30 * 24 * 60 * 60 * 1000);

    const cookie = first.headers.get('Set-Cookie') ?? '';
    expect(cookie).toContain(`${SESSION_COOKIE_NAME}=${person.token}`);
    for (const attribute of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/']) expect(cookie).toContain(attribute);

    const second = await post(app, whoAmI, { token: person.token });
    expect(second.status).toBe(200);
    expect(second.headers.get('Set-Cookie')).toBeNull();
    expect((await readSession(person.token)).last_used_at).toBe(row.last_used_at);
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

  test('壊れた JSON、JSON でない Content-Type、大きすぎる本文は invalid_input', async () => {
    const token = (await getOperator()).token;
    const broken = await post(app, whoAmI, { token, rawBody: '{token=secret' });
    expect(broken.status).toBe(400);
    expect(await errorCodeOf(broken)).toBe('invalid_input');

    const form = await post(app, whoAmI, { token, headers: { 'Content-Type': 'text/plain' }, body: {} });
    expect(form.status).toBe(400);

    const large = await post(app, whoAmI, { token, rawBody: JSON.stringify({ note: 'x'.repeat(1024 * 1024) }) });
    expect(large.status).toBe(413);
    expect(await errorCodeOf(large)).toBe('invalid_input');
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

  test('操作の名前が重なると登録で落ちる', () => {
    expect(() => createApp([...provisionalOperations, ...provisionalOperations])).toThrow(/重なって/);
  });
});

describe('組織に入れる人', () => {
  async function org() {
    const organization = await createOrganization();
    const adminUser = await createPerson({ organization, admin: true });
    const workspace = await createWorkspace(organization, adminUser.userId!);
    return { organization, adminUser, workspace };
  }

  const enter = (slug: string, token: string) => post(app, organizationProfile, { slug, token });

  test('停止した組織には管理者も入れず 404', async () => {
    const { organization, adminUser } = await org();
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
      expect((await enter(organization.slug, person.token)).status).toBe(404);
    }
  });

  test('すべてのワークスペースから外れた人は 404、所属していれば入れる', async () => {
    const { organization, workspace } = await org();
    const person = await createPerson({ organization, membership: { workspaceId: workspace.id, role: 'member' } });
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

  test('承諾待ちの招待だけの人は users の行が無くても入れ、user_id は null', async () => {
    const { organization, adminUser, workspace } = await org();
    const invitee = await createPerson();
    await createInvitation(organization, workspace.id, adminUser.userId!, invitee.login);
    const res = await enter(organization.slug, invitee.token);
    expect(await res.json()).toEqual({ organization_id: organization.id, user_id: null });
  });

  test('招待が承諾済み、辞退、取り消しなら入れず、別の組織への招待では入れない', async () => {
    const { organization, adminUser, workspace } = await org();
    const other = await org();
    for (const status of ['accepted', 'declined', 'revoked']) {
      const invitee = await createPerson();
      await createInvitation(organization, workspace.id, adminUser.userId!, invitee.login, { status });
      expect((await enter(organization.slug, invitee.token)).status, status).toBe(404);
    }
    const invitedElsewhere = await createPerson();
    await createInvitation(other.organization, other.workspace.id, other.adminUser.userId!, invitedElsewhere.login);
    expect((await enter(organization.slug, invitedElsewhere.token)).status).toBe(404);
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
            Cookie: `${SESSION_COOKIE_NAME}=${operator.token}`,
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
    for (const secret of ['ひみつの名前', target.leader.token, SESSION_COOKIE_NAME]) {
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
});

describe('画面から呼ぶ関数', () => {
  // ブラウザが付ける Origin と Cookie を付けて、アプリに直に流す
  const browser =
    (token: string): typeof fetch =>
    async (input, init) => {
      const headers = new Headers(init?.headers);
      headers.set('Origin', testEnv.PUBLIC_ORIGIN);
      headers.set('Cookie', `${SESSION_COOKIE_NAME}=${token}`);
      return app.request(String(input), { ...init, headers }, testEnv);
    };

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

  test('出力が定義の形でなければ失敗として扱う', async () => {
    const result = await callOperation(whoAmI, {}, { fetcher: async () => new Response('<html></html>') });
    expect(result).toEqual({ ok: false, status: 200, error: null });
  });

  test('通信に失敗したら status 0 で返す', async () => {
    const result = await callOperation(whoAmI, {}, { fetcher: () => Promise.reject(new TypeError('offline')) });
    expect(result).toEqual({ ok: false, status: 0, error: null });
  });
});
