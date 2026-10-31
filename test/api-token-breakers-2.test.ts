// API トークンの認証を崩す手口の2周目（#580）。api-token-operations と api-token-breakers と重ならないものだけ:
// 範囲の検査と、閉じたワークスペース／存在しないワークスペース／停止／招待だけの人との順、入れる組織を失った人の判定と範囲の検査の順、
// 同じ人の複数のトークン、Cookie の呼び出しからの失効、回数の上限と範囲の順（組織の中と運用者の操作）、
// セッションを使う操作のトークンでの呼び出し、Cookie の延長と消去、ログの accountId と organizationId、掃除のログ、seed の期限
/* eslint-disable db-entry/guard -- ワークスペースやセッションの行を、入口を通さず D1 に直に読み書きして確かめるため */
import { createScheduledController } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { z } from 'zod';
import { defineOperation, operationPath } from '../src/shared/operations/define.ts';
import { operations } from '../src/shared/operations/index.ts';
import { sessionCookieName } from '../src/shared/session-cookie.ts';
import { createApp } from '../src/server/app.ts';
import { hashApiToken, readApiToken } from '../src/server/auth/api-token.ts';
import worker from '../src/server/index.ts';
import { implement } from '../src/server/operations/implement.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import { createAccount, uuidv7 } from './factories.ts';
import { insertApiToken, rawApiToken } from './operations/api-token.ts';
import { errorCodeOf, post } from './operations/harness.ts';
import {
  operatorPing,
  organizationProfile,
  provisionalOperations,
  renameWorkspace,
  reopenWorkspace,
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

const DAY_MS = 24 * 60 * 60 * 1000;
const future = () => new Date(Date.now() + 30 * DAY_MS).toISOString();
type Spy = { mock: { calls: unknown[][] } };
const okOutput = z.object({ ok: z.literal(true) });
const ok = async () => ({ ok: true as const });

function pingOperation(name: string, shape: Partial<Parameters<typeof defineOperation>[0]> = {}) {
  return defineOperation({
    name,
    description: '順序を確かめる仮の操作',
    mode: 'write',
    permission: 'login',
    input: z.object({}),
    output: okOutput,
    ...shape,
  } as Parameters<typeof defineOperation>[0]);
}

const loginWrite = pingOperation('login-write-ping');
const strictWrite = pingOperation('strict-write-ping', {
  input: z.object({ n: z.number() }),
  rateLimit: { max: 1, windowSeconds: 60 },
});
const orgLimited = pingOperation('org-limited-ping', {
  permission: 'organization',
  rateLimit: { max: 1, windowSeconds: 60 },
});
const operatorLimited = pingOperation('operator-limited-ping', {
  permission: 'operator',
  rateLimit: { max: 1, windowSeconds: 60 },
});
const sessionTouch = defineOperation({
  name: 'session-touch-ping',
  description: 'セッションを使う仮の操作',
  mode: 'read',
  permission: 'login',
  input: z.object({}),
  output: z.object({ id: z.string() }),
});
const sessionClear = defineOperation({
  name: 'session-clear-ping',
  description: 'セッションの Cookie を消す仮の操作',
  mode: 'read',
  permission: 'login',
  input: z.object({}),
  output: okOutput,
});

const app = createApp([
  ...provisionalOperations,
  implement(loginWrite, ok),
  implement(strictWrite, ok),
  implement(orgLimited, ok),
  implement(operatorLimited, ok),
  implement(sessionTouch, async ({ session }) => ({ id: session.tokenHash })),
  implement(sessionClear, async ({ session }) => {
    session.clearCookie();
    return { ok: true as const };
  }),
]);
const realApp = createApp([...implementedOperations]);

afterEach(() => {
  vi.restoreAllMocks();
});

async function tokens(accountId: string) {
  const [read, write] = await Promise.all([
    insertApiToken(accountId, { scope: 'read', expiresAt: future() }),
    insertApiToken(accountId, { scope: 'write', expiresAt: future() }),
  ]);
  return { read, write };
}

async function revokedAt(hash: string): Promise<string | null | undefined> {
  const row = await env.DB.prepare('select revoked_at from api_tokens where token_hash = ?')
    .bind(hash)
    .first<{ revoked_at: string | null }>();
  return row === null ? undefined : row.revoked_at;
}

function operationLogs(spies: Spy[], operation: string) {
  return spies
    .flatMap((spy) => spy.mock.calls.map((call) => String(call[0])))
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((entry) => entry.operation === operation);
}

function realDefinition(name: string) {
  const definition = operations.find((candidate) => candidate.name === name);
  if (definition === undefined) throw new Error(`本番の操作に ${name} が無い`);
  return definition;
}

describe('範囲の検査と、ワークスペースの確かめ・状態の順', () => {
  const renameBody = (workspaceId: string) => ({ workspace_id: workspaceId, name: '青葉' });

  test('閉じたワークスペース: read のトークンは 403 forbidden（409 でなく）、write のトークンは 409 workspace_closed', async () => {
    const target = await createTarget({ closed: true });
    const { read, write } = await tokens(target.leader.accountId);
    const forbidden = await post(app, renameWorkspace, {
      slug: target.slug,
      bearer: read.raw,
      origin: null,
      body: renameBody(target.workspace.id),
    });
    expect(forbidden.status).toBe(403);
    expect(await errorCodeOf(forbidden)).toBe('forbidden');
    const closed = await post(app, renameWorkspace, {
      slug: target.slug,
      bearer: write.raw,
      origin: null,
      body: renameBody(target.workspace.id),
    });
    expect(closed.status).toBe(409);
    expect(await errorCodeOf(closed)).toBe('workspace_closed');
  });

  test('閉じたワークスペースの読み取りは read のトークンで通る', async () => {
    const target = await createTarget({ closed: true });
    const { read } = await tokens(target.member.accountId);
    const res = await post(app, workspaceSummary, {
      slug: target.slug,
      bearer: read.raw,
      origin: null,
      body: { workspace_id: target.workspace.id },
    });
    expect(res.status).toBe(200);
  });

  test('存在しない・別の組織の workspace_id: read のトークンは 403（範囲が先）、write のトークンは 404', async () => {
    const [target, other] = await Promise.all([createTarget(), createTarget()]);
    const { read, write } = await tokens(target.leader.accountId);
    for (const workspaceId of [uuidv7(), other.workspace.id]) {
      const forbidden = await post(app, renameWorkspace, {
        slug: target.slug,
        bearer: read.raw,
        origin: null,
        body: renameBody(workspaceId),
      });
      expect(forbidden.status, workspaceId).toBe(403);
      const missing = await post(app, renameWorkspace, {
        slug: target.slug,
        bearer: write.raw,
        origin: null,
        body: renameBody(workspaceId),
      });
      expect(missing.status, workspaceId).toBe(404);
      expect(await errorCodeOf(missing)).toBe('not_found');
    }
  });

  test('allowClosed の書き込み（開き直す）も read のトークンは 403 で、閉じたまま。write のトークンなら開く', async () => {
    const target = await createTarget({ closed: true });
    const { read, write } = await tokens(target.admin.accountId);
    const closedAt = () =>
      env.DB.prepare('select closed_at from workspaces where id = ?')
        .bind(target.workspace.id)
        .first<{ closed_at: string | null }>();
    const refused = await post(app, reopenWorkspace, {
      slug: target.slug,
      bearer: read.raw,
      origin: null,
      body: { workspace_id: target.workspace.id },
    });
    expect(refused.status).toBe(403);
    expect((await closedAt())!.closed_at).not.toBeNull();
    const reopened = await post(app, reopenWorkspace, {
      slug: target.slug,
      bearer: write.raw,
      origin: null,
      body: { workspace_id: target.workspace.id },
    });
    expect(reopened.status).toBe(200);
    expect((await closedAt())!.closed_at).toBeNull();
  });

  test('停止した組織（ほかにも入れる人）: read のトークンで書き込みを呼んでも 403 organization_suspended（範囲より先）', async () => {
    const target = await createTarget({ suspended: true });
    await admitElsewhere(target.leader);
    const { read } = await tokens(target.leader.accountId);
    const res = await post(app, renameWorkspace, {
      slug: target.slug,
      bearer: read.raw,
      origin: null,
      body: renameBody(target.workspace.id),
    });
    expect(res.status).toBe(403);
    expect(await errorCodeOf(res)).toBe('organization_suspended');
  });

  test('承諾待ちの招待だけの人: 範囲の足りない書き込みも、権限の検査の 404（403 にしない）', async () => {
    const target = await createTarget();
    const { read, write } = await tokens(target.invitee.accountId);
    for (const bearer of [read.raw, write.raw]) {
      const res = await post(app, renameWorkspace, {
        slug: target.slug,
        bearer,
        origin: null,
        body: renameBody(target.workspace.id),
      });
      expect(res.status).toBe(404);
    }
  });
});

// #639: 入れる組織の有無を判定しなくなったので、組織の無い人も、入れる組織のある人と同じ範囲の検査だけを通る
describe('組織の無い人のトークンの範囲の検査（組織の外の操作）', () => {
  test('組織の無い人が read のトークンで書き込みの login 操作を呼ぶと 403、write なら 200。どちらも取り消されない', async () => {
    const person = await createPerson();
    const { read, write } = await tokens(person.accountId);
    const refused = await post(app, loginWrite, { bearer: read.raw, origin: null });
    expect(refused.status).toBe(403);
    expect(await errorCodeOf(refused)).toBe('forbidden');
    expect((await post(app, loginWrite, { bearer: write.raw, origin: null })).status).toBe(200);
    expect(await revokedAt(read.hash)).toBeNull();
    expect(await revokedAt(write.hash)).toBeNull();
  });

  test('組織の無い非運用者が運用者の操作を呼ぶと、トークンの 403 で、取り消されない', async () => {
    const person = await createPerson();
    const { write } = await tokens(person.accountId);
    const res = await post(app, operatorPing, { bearer: write.raw, origin: null });
    expect(res.status).toBe(403);
    expect(await revokedAt(write.hash)).toBeNull();
    expect((await post(app, whoAmI, { bearer: write.raw, origin: null })).status).toBe(200);
  });
});

describe('運用者のトークン', () => {
  test('運用者の操作は 403。ほかの組織の外の操作は通り、組織の中の操作は組織が無いときと同じ 404 で、取り消されない', async () => {
    const operator = await getOperator();
    const target = await createTarget();
    const { write } = await tokens(operator.accountId);

    expect((await post(app, operatorPing, { bearer: write.raw, origin: null })).status).toBe(403);
    expect((await post(app, whoAmI, { bearer: write.raw, origin: null })).status).toBe(200);
    const inside = await post(app, organizationProfile, { slug: target.slug, bearer: write.raw, origin: null });
    expect(inside.status).toBe(404);
    expect(await revokedAt(write.hash)).toBeNull();
    expect((await post(app, whoAmI, { bearer: write.raw, origin: null })).status).toBe(200);
  });

  test('本番の me と my-organizations は通り（operator: true）、organization-suspend は入力を読む前に 403', async () => {
    const operator = await getOperator();
    const { read } = await tokens(operator.accountId);
    const me = await post(realApp, realDefinition('me'), { bearer: read.raw, origin: null });
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ account_id: operator.accountId });
    const mine = await post(realApp, realDefinition('my-organizations'), { bearer: read.raw, origin: null });
    expect(mine.status).toBe(200);
    expect(await mine.json()).toMatchObject({ operator: true });
    const suspend = realDefinition('organization-suspend');
    const res = await realApp.request(
      operationPath(suspend),
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${read.raw}`, 'Content-Type': 'application/json' },
        body: '{broken',
      },
      testEnv,
    );
    expect(res.status).toBe(403);
  });
});

// #639: 入れる組織を失ってもトークンは取り消さない。取り消し済みの行は、今どおり通らない
describe('入れる組織を失った人の複数のトークン', () => {
  test('無効にされた人の有効なトークンはどれも通り、取り消されない。取消済みのトークンは 401 のまま、日時も書き直さない', async () => {
    const organization = (await createTarget()).organization;
    const lost = await createPerson({ organization, disabled: true });
    const early = '2026-10-01T00:00:00.000Z';
    const [a, b, alreadyRevoked] = await Promise.all([
      insertApiToken(lost.accountId, { scope: 'read', expiresAt: future() }),
      insertApiToken(lost.accountId, { scope: 'write', expiresAt: future() }),
      insertApiToken(lost.accountId, { expiresAt: future(), revokedAt: early }),
    ]);
    for (const token of [a, b]) {
      expect((await post(app, whoAmI, { bearer: token.raw, origin: null })).status).toBe(200);
      expect(await revokedAt(token.hash)).toBeNull();
    }
    expect((await post(app, whoAmI, { bearer: alreadyRevoked.raw, origin: null })).status).toBe(401);
    expect(await revokedAt(alreadyRevoked.hash)).toBe(early);
  });

  test('Cookie の呼び出しでも、入れる組織を失った人のトークンは取り消されず、セッションも残る', async () => {
    const organization = (await createTarget()).organization;
    const lost = await createPerson({ organization, disabled: true });
    const { read, write } = await tokens(lost.accountId);
    expect((await post(app, whoAmI, { token: lost.token })).status).toBe(200);
    expect(await revokedAt(read.hash)).toBeNull();
    expect(await revokedAt(write.hash)).toBeNull();
    expect((await post(app, whoAmI, { token: lost.token })).status).toBe(200);
  });

  test('入れる組織に戻った後も、同じトークンがそのまま通る', async () => {
    const organization = (await createTarget()).organization;
    const lost = await createPerson({ organization, disabled: true });
    const { write } = await tokens(lost.accountId);
    expect((await post(app, whoAmI, { bearer: write.raw, origin: null })).status).toBe(200);
    await admitElsewhere(lost);
    expect((await post(app, whoAmI, { bearer: write.raw, origin: null })).status).toBe(200);
    expect((await post(app, whoAmI, { token: lost.token })).status).toBe(200);
  });
});

describe('回数の上限と範囲の順', () => {
  test('入力が不正でも、枠を使い切った write のトークンは 400 でなく 429（回数の上限は入力を読む前）', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const person = await createLoginPerson();
    const { write } = await tokens(person.accountId);
    expect((await post(app, strictWrite, { bearer: write.raw, origin: null, body: { n: 1 } })).status).toBe(200);
    const over = await post(app, strictWrite, { bearer: write.raw, origin: null, body: { n: 'x' } });
    expect(over.status).toBe(429);
    const fresh = await createLoginPerson();
    const { write: freshWrite } = await tokens(fresh.accountId);
    expect((await post(app, strictWrite, { bearer: freshWrite.raw, origin: null, body: { n: 'x' } })).status).toBe(400);
  });

  test('組織の中の操作: 範囲が足りずに 403 の呼び出しは枠を使わない', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const target = await createTarget();
    const { read, write } = await tokens(target.member.accountId);
    for (let i = 0; i < 4; i++) {
      expect((await post(app, orgLimited, { slug: target.slug, bearer: read.raw, origin: null })).status).toBe(403);
    }
    expect((await post(app, orgLimited, { slug: target.slug, bearer: write.raw, origin: null })).status).toBe(200);
    expect((await post(app, orgLimited, { slug: target.slug, bearer: write.raw, origin: null })).status).toBe(429);
  });

  test('運用者の操作: トークンの 403 は運用者の枠を使わない（Cookie の呼び出しが1回通る）', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const operator = await getOperator();
    const { write } = await tokens(operator.accountId);
    for (let i = 0; i < 3; i++) {
      expect((await post(app, operatorLimited, { bearer: write.raw, origin: null })).status).toBe(403);
    }
    expect((await post(app, operatorLimited, { token: operator.token })).status).toBe(200);
    expect((await post(app, operatorLimited, { token: operator.token })).status).toBe(429);
  });
});

describe('セッションを使う操作のトークンでの呼び出し（cookieOnly の付け忘れ）', () => {
  test('tokenHash を読むと 500 internal で、ログの credential は token。Cookie なら通る', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const person = await createLoginPerson();
    const { write } = await tokens(person.accountId);
    const res = await post(app, sessionTouch, { bearer: write.raw, origin: null });
    expect(res.status).toBe(500);
    expect(await errorCodeOf(res)).toBe('internal');
    expect(operationLogs([log, error], 'session-touch-ping')).toContainEqual(
      expect.objectContaining({ credential: 'token', status: 500, accountId: person.accountId }),
    );
    expect((await post(app, sessionTouch, { token: person.token })).status).toBe(200);
  });

  test('clearCookie を呼んでも、Set-Cookie は付かず、セッションの行も消えない', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const person = await createLoginPerson();
    const { write } = await tokens(person.accountId);
    const res = await post(app, sessionClear, { bearer: write.raw, origin: null });
    expect(res.status).toBe(500);
    expect(res.headers.get('Set-Cookie')).toBeNull();
    expect((await post(app, whoAmI, { token: person.token })).status).toBe(200);
  });
});

describe('Cookie の延長と消去', () => {
  const stale = { last_used_at: '2026-10-01T00:00:00.000Z' };
  const sessionRow = (accountId: string) =>
    env.DB.prepare('select last_used_at, expires_at from sessions where account_id = ?')
      .bind(accountId)
      .first<{ last_used_at: string; expires_at: string }>();

  test('古いセッションの Cookie と有効な Bearer: 成功しても Cookie を延ばさず、セッションの行も書き直さない（対照: Cookie だけなら延びる）', async () => {
    const control = await createPerson({
      organization: (await createTarget()).organization,
      admin: true,
      sessionOverrides: stale,
    });
    const controlRes = await post(app, whoAmI, { token: control.token });
    expect(controlRes.status).toBe(200);
    expect(controlRes.headers.get('Set-Cookie') ?? '').toContain(sessionCookieName(testEnv.PUBLIC_ORIGIN));

    const person = await createPerson({
      organization: (await createTarget()).organization,
      admin: true,
      sessionOverrides: stale,
    });
    const before = await sessionRow(person.accountId);
    const { write } = await tokens(person.accountId);
    const res = await post(app, whoAmI, { token: person.token, bearer: write.raw });
    expect(res.status).toBe(200);
    expect(res.headers.get('Set-Cookie')).toBeNull();
    expect(await sessionRow(person.accountId)).toEqual(before);
  });

  test('古いセッションの Cookie と有効な Bearer: 403 の失敗の応答にも Cookie を付けない（対照: Cookie だけなら付く）', async () => {
    const target = await createTarget();
    const make = () =>
      createPerson({
        organization: target.organization,
        membership: { workspaceId: target.workspace.id, role: 'member' },
        sessionOverrides: stale,
      });
    const [viaCookie, viaToken] = await Promise.all([make(), make()]);
    const body = { workspace_id: target.workspace.id, name: 'x' };
    const cookieRes = await post(app, renameWorkspace, { slug: target.slug, token: viaCookie.token, body });
    expect(cookieRes.status).toBe(403);
    expect(cookieRes.headers.get('Set-Cookie') ?? '').toContain(sessionCookieName(testEnv.PUBLIC_ORIGIN));
    const { write } = await tokens(viaToken.accountId);
    const tokenRes = await post(app, renameWorkspace, {
      slug: target.slug,
      token: viaToken.token,
      bearer: write.raw,
      body,
    });
    expect(tokenRes.status).toBe(403);
    expect(tokenRes.headers.get('Set-Cookie')).toBeNull();
  });
});

describe('操作のログの accountId・organizationId・code', () => {
  test('無効なトークンは credential token・accountId null・401。Basic は cookie・accountId null', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const person = await createLoginPerson();
    const { write } = await tokens(person.accountId);
    await post(app, whoAmI, { headers: { Authorization: 'Bearer sgp_invalid' }, origin: null });
    await post(app, whoAmI, { headers: { Authorization: 'Bearer' }, origin: null });
    await post(app, whoAmI, { headers: { Authorization: `Basic ${btoa(`u:${write.raw}`)}` } });
    const entries = operationLogs([log, error], 'who-am-i');
    expect(entries).toHaveLength(3);
    expect(entries[0]).toMatchObject({ credential: 'token', accountId: null, status: 401, code: 'unauthenticated' });
    expect(entries[1]).toMatchObject({ credential: 'token', accountId: null, status: 401 });
    expect(entries[2]).toMatchObject({ credential: 'cookie', accountId: null, status: 401 });
  });

  test('組織に入れない 404 は accountId だけ、停止した組織の 403 は organizationId も残る', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const [target, suspended] = await Promise.all([createTarget(), createTarget({ suspended: true })]);
    const outsider = await createLoginPerson();
    await admitElsewhere(suspended.member);
    const [outsiderToken, memberToken] = await Promise.all([
      insertApiToken(outsider.accountId, { expiresAt: future() }),
      insertApiToken(suspended.member.accountId, { expiresAt: future() }),
    ]);
    await post(app, organizationProfile, { slug: target.slug, bearer: outsiderToken.raw, origin: null });
    await post(app, organizationProfile, { slug: suspended.slug, bearer: memberToken.raw, origin: null });
    const entries = operationLogs([log, error], 'organization-profile');
    expect(entries[0]).toMatchObject({
      accountId: outsider.accountId,
      organizationId: null,
      userId: null,
      status: 404,
      credential: 'token',
    });
    expect(entries[1]).toMatchObject({
      accountId: suspended.member.accountId,
      organizationId: suspended.organization.id,
      status: 403,
      code: 'organization_suspended',
      credential: 'token',
    });
  });
});

describe('毎分の掃除のログ', () => {
  const run = () => worker.scheduled(createScheduledController({ scheduledTime: Date.now(), cron: '* * * * *' }), env);
  const sweepLines = (info: Spy) =>
    info.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.startsWith('{'))
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((entry) => entry.table === 'api_tokens');

  test('消した回だけ表名と件数を1行出し（ハッシュは出さない）、消す行が無い回は api_tokens の行を出さない', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const account = await createAccount();
    const expired = await insertApiToken(account.id, { expiresAt: '2020-01-01T00:00:00.000Z' });
    const revokedButValid = await insertApiToken(account.id, {
      expiresAt: future(),
      revokedAt: '2026-10-21T00:00:00.000Z',
    });
    await run();
    const lines = sweepLines(info);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ table: 'api_tokens', deleted: 1 });
    expect(info.mock.calls.flat().map(String).join('\n')).not.toContain(expired.hash);
    // 取り消し済みでも期限までは残す
    expect(await revokedAt(revokedButValid.hash)).not.toBeUndefined();
    expect(await revokedAt(expired.hash)).toBeUndefined();

    info.mockClear();
    await run();
    expect(sweepLines(info)).toHaveLength(0);
  });
});

describe('マイグレーションと seed の期限', () => {
  test('account_id の索引があり、列は account_id だけ', async () => {
    const list = await env.DB.prepare(
      "select name from pragma_index_list('api_tokens') where name = 'api_tokens_account_id'",
    ).all<{ name: string }>();
    expect(list.results).toHaveLength(1);
    const columns = await env.DB.prepare("select name from pragma_index_info('api_tokens_account_id')").all<{
      name: string;
    }>();
    expect(columns.results.map((column) => column.name)).toEqual(['account_id']);
  });

  test('seed の期限の式は、ISO の形で今から90日後になり、その行を readApiToken が読める', async () => {
    const seedSql = (await import('../seed/data.sql?raw')).default;
    const expression = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+90 days')";
    expect(seedSql.split(expression)).toHaveLength(4);
    const account = await createAccount();
    const raw = rawApiToken();
    const hash = await hashApiToken(raw);
    await env.DB.prepare(
      `insert into api_tokens (token_hash, account_id, name, scope, created_at, last_used_at, expires_at, revoked_at) values (?, ?, 'seed', 'read', '2026-10-20T00:00:00.000Z', NULL, ${expression}, NULL)`,
    )
      .bind(hash, account.id)
      .run();
    const row = await env.DB.prepare('select expires_at from api_tokens where token_hash = ?')
      .bind(hash)
      .first<{ expires_at: string }>();
    expect(row!.expires_at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    const days = (Date.parse(row!.expires_at) - Date.now()) / DAY_MS;
    expect(days).toBeGreaterThan(89.9);
    expect(days).toBeLessThan(90.1);
    // 実装が読む形（ISO の文字列の比較）で、期限内に読める。読み方が違えば undefined になる
    expect(await readApiToken(env, raw, new Date())).toMatchObject({ accountId: account.id, scope: 'read' });
    expect(await readApiToken(env, raw, new Date(Date.now() + 91 * DAY_MS))).toBeUndefined();
  });
});
