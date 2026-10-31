// API トークン（Authorization: Bearer sgp_...）での操作の呼び出し（src/server/operations/register.ts の execute）。
// 一覧を回す検査は test/operation-registry.test.ts。ここでは、トークンならではの取り決めを仮の操作と本番の logout で確かめる
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { z } from 'zod';
import { defineOperation } from '../src/shared/operations/define.ts';
import { logout } from '../src/shared/operations/session/index.ts';
import { operations } from '../src/shared/operations/index.ts';
import { createApp } from '../src/server/app.ts';
import { commonDb } from '../src/server/db/index.ts';
import { implement } from '../src/server/operations/implement.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import { createOrganization } from './factories.ts';
import { insertApiToken, rawApiToken, tokenRow, type TokenScope } from './operations/api-token.ts';
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
import { createLoginPerson, createPerson, createTarget, getOperator, admitElsewhere } from './operations/world.ts';

const app = createApp(provisionalOperations);
const realApp = createApp([...implementedOperations]);
const DAY_MS = 24 * 60 * 60 * 1000;
const future = () => new Date(Date.now() + 30 * DAY_MS).toISOString();
const past = () => new Date(Date.now() - 1000).toISOString();

afterEach(() => {
  vi.restoreAllMocks();
});

async function tokenOf(
  person: { accountId: string },
  scope: TokenScope = 'write',
  options: Parameters<typeof insertApiToken>[1] = {},
) {
  return insertApiToken(person.accountId, { scope, expiresAt: future(), ...options });
}

describe('有効なトークンで、Authorization だけで呼べる', () => {
  test('組織の外の操作（Origin も Cookie も付けない）', async () => {
    const person = await createLoginPerson();
    const { raw } = await tokenOf(person);
    const res = await post(app, whoAmI, { bearer: raw, origin: null });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ account_id: person.accountId });
  });

  test('組織の中の操作とワークスペースの下の操作（read と write）', async () => {
    const target = await createTarget();
    const admin = await tokenOf(target.admin);
    const leader = await tokenOf(target.leader);
    const profile = await post(app, organizationProfile, { slug: target.slug, bearer: admin.raw, origin: null });
    expect(profile.status).toBe(200);
    expect(await profile.json()).toMatchObject({
      organization_id: target.organization.id,
      user_id: target.admin.userId,
    });
    const summary = await post(app, workspaceSummary, {
      slug: target.slug,
      bearer: leader.raw,
      origin: null,
      body: { workspace_id: target.workspace.id },
    });
    expect(summary.status).toBe(200);
    const rename = await post(app, renameWorkspace, {
      slug: target.slug,
      bearer: leader.raw,
      origin: null,
      body: { workspace_id: target.workspace.id, name: '青葉チーム' },
    });
    expect(rename.status).toBe(200);
  });

  test('承諾待ちの招待だけの人も、invitee の操作を呼べる', async () => {
    const target = await createTarget();
    const { raw } = await tokenOf(target.invitee);
    const res = await post(app, inviteeProfile, { slug: target.slug, bearer: raw, origin: null });
    expect(res.status).toBe(200);
  });

  test('Cookie が壊れていても、有効なトークンがあれば通る（Cookie は読まない）', async () => {
    const person = await createLoginPerson();
    const { raw } = await tokenOf(person);
    const res = await post(app, whoAmI, { bearer: raw, token: 'broken', origin: null });
    expect(res.status).toBe(200);
  });
});

describe('無効なトークンは 401', () => {
  const unauthenticated = async (res: Response) => {
    expect(res.status).toBe(401);
    expect(await errorCodeOf(res)).toBe('unauthenticated');
  };

  test('期限切れ（expires_at <= now）', async () => {
    const person = await createLoginPerson();
    const { raw } = await tokenOf(person, 'write', { expiresAt: past() });
    await unauthenticated(await post(app, whoAmI, { bearer: raw }));
  });

  test('取消済み', async () => {
    const person = await createLoginPerson();
    const { raw } = await tokenOf(person, 'write', { revokedAt: past() });
    await unauthenticated(await post(app, whoAmI, { bearer: raw }));
  });

  test('DB に無い', async () => {
    await unauthenticated(await post(app, whoAmI, { bearer: rawApiToken() }));
  });

  test('形の違う値（sgp_ が無い、長さ違い、文字種違い、大文字小文字違い）は、行があっても 401', async () => {
    const person = await createLoginPerson();
    const body = 'm'.repeat(43);
    for (const raw of [body, `sgp_${body.slice(1)}`, `sgp_${body}m`, `sgp_${body.slice(1)}+`, `SGP_${body}`]) {
      await tokenOf(person, 'write', { raw });
      await unauthenticated(await post(app, whoAmI, { bearer: raw }));
    }
  });

  test('Authorization の書き方の違い（小文字の bearer、値が空、Bearer だけ）は 401', async () => {
    const person = await createLoginPerson();
    const { raw } = await tokenOf(person);
    for (const header of [`bearer ${raw}`, 'Bearer ']) {
      await unauthenticated(await post(app, whoAmI, { headers: { Authorization: header } }));
    }
  });

  test('無効な Bearer は、有効な Cookie があっても 401（Cookie に落とさない）', async () => {
    const person = await createLoginPerson();
    const expired = await tokenOf(person, 'write', { expiresAt: past() });
    for (const bearer of [expired.raw, rawApiToken(), 'garbage']) {
      await unauthenticated(await post(app, whoAmI, { token: person.token, bearer }));
    }
    // 無効な Bearer のときも Origin の検査はしない。Cookie の呼び出しなら Origin 無しは 403 だが、ここは 401
    await unauthenticated(await post(app, whoAmI, { token: person.token, bearer: rawApiToken(), origin: null }));
  });

  test('Cookie だけなら今までどおり通る', async () => {
    const person = await createLoginPerson();
    expect((await post(app, whoAmI, { token: person.token })).status).toBe(200);
  });
});

describe('範囲（read と write）', () => {
  test('read のトークンで write の操作は 403 の forbidden', async () => {
    const target = await createTarget();
    const { raw } = await tokenOf(target.leader, 'read');
    const res = await post(app, renameWorkspace, {
      slug: target.slug,
      bearer: raw,
      body: { workspace_id: target.workspace.id, name: '青葉チーム' },
    });
    expect(res.status).toBe(403);
    expect(await errorCodeOf(res)).toBe('forbidden');
  });

  test('write のトークンは write の操作を通す', async () => {
    const target = await createTarget();
    const { raw } = await tokenOf(target.leader, 'write');
    const res = await post(app, renameWorkspace, {
      slug: target.slug,
      bearer: raw,
      body: { workspace_id: target.workspace.id, name: '青葉チーム' },
    });
    expect(res.status).toBe(200);
  });

  test('read の操作は read も write も通す', async () => {
    const target = await createTarget();
    for (const scope of ['read', 'write'] as const) {
      const { raw } = await tokenOf(target.member, scope);
      const res = await post(app, workspaceSummary, {
        slug: target.slug,
        bearer: raw,
        body: { workspace_id: target.workspace.id },
      });
      expect(res.status, scope).toBe(200);
    }
  });

  test('範囲が足りなければ、書き込みの処理は動かない', async () => {
    const target = await createTarget();
    const { raw } = await tokenOf(target.leader, 'read');
    await post(app, renameWorkspace, {
      slug: target.slug,
      bearer: raw,
      body: { workspace_id: target.workspace.id, name: '書き換え' },
    });
    const ok = await post(app, workspaceSummary, {
      slug: target.slug,
      bearer: raw,
      body: { workspace_id: target.workspace.id },
    });
    expect(ok.status).toBe(200);
    // 範囲が足りない呼び出しの後も、write のトークンの書き込みは通り、名前は write の呼び出しのものになる
    const { raw: writeRaw } = await tokenOf(target.leader, 'write');
    const rename = await post(app, renameWorkspace, {
      slug: target.slug,
      bearer: writeRaw,
      body: { workspace_id: target.workspace.id, name: '青葉チーム' },
    });
    expect(await rename.json()).toEqual({ workspace_id: target.workspace.id, name: '青葉チーム' });
  });
});

describe('範囲の検査は権限の検査の後、入力を読む前', () => {
  test('入力が不正でも、範囲の足りない呼び出しは 400 でなく 403', async () => {
    const target = await createTarget();
    const read = await tokenOf(target.leader, 'read');
    const write = await tokenOf(target.leader, 'write');
    // 対照: 範囲が足りていれば、同じ入力は 400
    const invalid = { workspace_id: target.workspace.id, name: '' };
    const control = await post(app, renameWorkspace, { slug: target.slug, bearer: write.raw, body: invalid });
    expect(control.status).toBe(400);
    const res = await post(app, renameWorkspace, { slug: target.slug, bearer: read.raw, body: invalid });
    expect(res.status).toBe(403);
    expect(await errorCodeOf(res)).toBe('forbidden');
    const broken = await post(app, renameWorkspace, { slug: target.slug, bearer: read.raw, rawBody: '{broken' });
    expect(broken.status).toBe(403);
  });

  test('組織に入れない人は、範囲が足りなくても 404（権限の検査が先）', async () => {
    const [own, other] = await Promise.all([createTarget(), createTarget()]);
    const { raw } = await tokenOf(other.admin, 'read');
    const res = await post(app, renameWorkspace, {
      slug: own.slug,
      bearer: raw,
      body: { workspace_id: own.workspace.id, name: 'x' },
    });
    expect(res.status).toBe(404);
  });

  test('権限の無い人は、範囲が足りなくても 403 の forbidden で、別の組織のワークスペースは 404', async () => {
    const [own, other] = await Promise.all([createTarget(), createTarget()]);
    const { raw } = await tokenOf(own.member, 'read');
    const noPermission = await post(app, closeWorkspace, {
      slug: own.slug,
      bearer: raw,
      body: { workspace_id: own.workspace.id },
    });
    expect(noPermission.status).toBe(403);
    // 範囲より前に、ワークスペースの確かめ（入力を読む）は行わない。別の組織の ID は read のトークンなら 403 にとどまる
    const wrongScopeAdmin = await tokenOf(own.admin, 'read');
    const foreign = await post(app, closeWorkspace, {
      slug: own.slug,
      bearer: wrongScopeAdmin.raw,
      body: { workspace_id: other.workspace.id },
    });
    expect(foreign.status).toBe(403);
    const writeAdmin = await tokenOf(own.admin, 'write');
    const foreignWrite = await post(app, closeWorkspace, {
      slug: own.slug,
      bearer: writeAdmin.raw,
      body: { workspace_id: other.workspace.id },
    });
    expect(foreignWrite.status).toBe(404);
  });
});

describe('運用者の操作はトークンから一律 403', () => {
  test('運用者本人でも、read と write のどちらでも 403', async () => {
    const operator = await getOperator();
    for (const scope of ['read', 'write'] as const) {
      const { raw } = await tokenOf(operator, scope);
      const res = await post(app, operatorPing, { bearer: raw });
      expect(res.status, scope).toBe(403);
      expect(await errorCodeOf(res)).toBe('forbidden');
    }
  });

  test('運用者でない人も 403', async () => {
    const person = await createLoginPerson();
    const { raw } = await tokenOf(person, 'write');
    const res = await post(app, operatorPing, { bearer: raw });
    expect(res.status).toBe(403);
  });

  test('対照: 運用者の Cookie なら通る', async () => {
    const operator = await getOperator();
    expect((await post(app, operatorPing, { token: operator.token })).status).toBe(200);
  });

  test('本番の運用者の操作は、すべてトークンから 403', async () => {
    const operator = await getOperator();
    const { raw } = await tokenOf(operator, 'write');
    const names = implementedOperations
      .map((operation) => operation.definition)
      .filter((definition) => definition.permission === 'operator');
    expect(names.length).toBeGreaterThan(0);
    for (const definition of names) {
      const res = await post(realApp, definition, { bearer: raw, rawBody: '{}' });
      expect(res.status, definition.name).toBe(403);
    }
  });
});

describe('cookieOnly の logout', () => {
  test('定義が cookieOnly を持ち、cookieOnly を持つ本番の操作は logout とトークンの3操作だけ', () => {
    expect((logout as { cookieOnly?: true }).cookieOnly).toBe(true);
    expect(
      operations
        .filter((definition) => definition.cookieOnly === true)
        .map((definition) => definition.name)
        .sort(),
    ).toEqual(['logout', 'token-create', 'token-list', 'token-revoke']);
  });

  test('トークンから呼ぶと 403 の forbidden で、トークンもセッションも残る', async () => {
    const person = await createLoginPerson();
    const { raw, hash } = await tokenOf(person);
    const res = await post(realApp, logout, { bearer: raw, origin: null });
    expect(res.status).toBe(403);
    expect(await errorCodeOf(res)).toBe('forbidden');
    expect((await tokenRow(hash))!.revoked_at).toBeNull();
    const db = commonDb(env);
    const sessions = await db.rows(
      db.statement((q) => q.selectFrom('sessions').select('token_hash').where('account_id', '=', person.accountId)),
    );
    expect(sessions).toHaveLength(1);
    // 同じトークンで続けて呼べる
    expect((await post(realApp, whoAmIOfReal(), { bearer: raw })).status).toBe(200);
  });

  test('read のトークンでも 403', async () => {
    const person = await createLoginPerson();
    const { raw } = await tokenOf(person, 'read');
    expect((await post(realApp, logout, { bearer: raw })).status).toBe(403);
  });

  test('入力が不正でも 403（入力を読む前）', async () => {
    const person = await createLoginPerson();
    const { raw } = await tokenOf(person);
    expect((await post(realApp, logout, { bearer: raw, rawBody: '{broken' })).status).toBe(403);
  });

  test('対照: Cookie ならこれまでどおりセッションが消え、200', async () => {
    const person = await createLoginPerson();
    const res = await post(realApp, logout, { token: person.token });
    expect(res.status).toBe(200);
  });

  test('cookieOnly は組織の外の操作にだけ付けられる', () => {
    const base = {
      name: 'cookie-only-probe',
      description: 'テスト用',
      mode: 'read',
      input: z.object({}),
      output: z.object({}),
    } as const;
    expect(() => defineOperation({ ...base, permission: 'login', cookieOnly: true })).not.toThrow();
    expect(() => defineOperation({ ...base, permission: 'organization', cookieOnly: true })).toThrow(/cookieOnly/);
    expect(() =>
      defineOperation({
        ...base,
        permission: 'member',
        workspace: true,
        input: z.object({ workspace_id: z.string() }),
        cookieOnly: true,
      }),
    ).toThrow(/cookieOnly/);
  });
});

function whoAmIOfReal() {
  const me = operations.find((definition) => definition.name === 'me');
  if (me === undefined) throw new Error('me が無い');
  return me;
}

describe('Cookie と同じ結果', () => {
  test('権限の無い操作は 403、別の組織のワークスペースは 404', async () => {
    const [own, other] = await Promise.all([createTarget(), createTarget()]);
    const cases = [
      {
        person: own.member,
        definition: renameWorkspace,
        body: { workspace_id: own.workspace.id, name: 'x' },
        status: 403,
      },
      { person: own.bystander, definition: workspaceSummary, body: { workspace_id: own.workspace.id }, status: 403 },
      { person: own.leader, definition: closeWorkspace, body: { workspace_id: own.workspace.id }, status: 403 },
      {
        person: own.leader,
        definition: renameWorkspace,
        body: { workspace_id: other.workspace.id, name: 'x' },
        status: 404,
      },
      { person: other.admin, definition: workspaceSummary, body: { workspace_id: own.workspace.id }, status: 404 },
    ] as const;
    for (const { person, definition, body, status } of cases) {
      const { raw } = await tokenOf(person);
      const byToken = await post(app, definition, { slug: own.slug, bearer: raw, body });
      const byCookie = await post(app, definition, { slug: own.slug, token: person.token, body });
      expect(byToken.status, definition.name).toBe(status);
      expect(byCookie.status, definition.name).toBe(status);
      expect(await errorCodeOf(byToken)).toBe(await errorCodeOf(byCookie));
    }
  });

  test('存在しない slug は 404', async () => {
    const person = await createLoginPerson();
    const { raw } = await tokenOf(person);
    expect((await post(app, organizationProfile, { slug: 'no-such-organization', bearer: raw })).status).toBe(404);
  });
});

describe('組織に入れなくなった人のトークン', () => {
  // #639: 入れる組織を失っても、トークンは取り消さない
  test('組織の外の操作は 200 で、トークンは取り消されず、入れるようになってもそのまま使える', async () => {
    const organization = await createOrganization();
    const person = await createPerson({ organization, admin: true, disabled: true });
    const { raw, hash } = await tokenOf(person);
    const res = await post(app, whoAmI, { bearer: raw });
    expect(res.status).toBe(200);
    expect((await tokenRow(hash))!.revoked_at).toBeNull();
    await admitElsewhere(person);
    expect((await post(app, whoAmI, { bearer: raw })).status).toBe(200);
  });

  test('組織の中の操作で入れなかったときは 404 で、取り消されない', async () => {
    const organization = await createOrganization();
    const person = await createPerson({ organization, admin: true, disabled: true });
    const { raw, hash } = await tokenOf(person);
    const res = await post(app, organizationProfile, { slug: organization.slug, bearer: raw });
    expect(res.status).toBe(404);
    expect(await errorCodeOf(res)).toBe('not_found');
    expect((await tokenRow(hash))!.revoked_at).toBeNull();
  });

  test('ほかの組織に入れる人は、404 で取り消されない', async () => {
    const [own, elsewhere] = await Promise.all([createTarget(), createLoginPerson()]);
    const { raw, hash } = await tokenOf(elsewhere);
    const res = await post(app, organizationProfile, { slug: own.slug, bearer: raw });
    expect(res.status).toBe(404);
    expect((await tokenRow(hash))!.revoked_at).toBeNull();
    expect((await post(app, whoAmI, { bearer: raw })).status).toBe(200);
  });

  test('運用者は入れる組織が無くても通る', async () => {
    const operator = await getOperator();
    const { raw } = await tokenOf(operator);
    expect((await post(app, whoAmI, { bearer: raw })).status).toBe(200);
  });

  test('判定の後に作ったトークンは取り消さない', async () => {
    const organization = await createOrganization();
    const person = await createPerson({ organization, admin: true, disabled: true });
    const later = await tokenOf(person, 'write', { createdAt: new Date(Date.now() + 60 * 1000).toISOString() });
    const earlier = await tokenOf(person);
    expect((await post(app, whoAmI, { bearer: earlier.raw })).status).toBe(401);
    expect((await tokenRow(earlier.hash))!.revoked_at).not.toBeNull();
    expect((await tokenRow(later.hash))!.revoked_at).toBeNull();
  });
});

describe('使っても期限を延ばさない', () => {
  test('呼ぶと last_used_at を今に書き直し、expires_at はそのまま', async () => {
    const person = await createLoginPerson();
    const expiresAt = new Date(Date.now() + 5 * DAY_MS).toISOString();
    const { raw, hash } = await tokenOf(person, 'write', {
      expiresAt,
      createdAt: '2026-10-01T00:00:00.000Z',
      lastUsedAt: '2026-10-02T00:00:00.000Z',
    });
    const startedAt = Date.now();
    expect((await post(app, whoAmI, { bearer: raw })).status).toBe(200);
    const row = await tokenRow(hash);
    expect(row!.expires_at).toBe(expiresAt);
    expect(Date.parse(row!.last_used_at!)).toBeGreaterThanOrEqual(startedAt - 1000);
  });
});

describe('操作のログの credential', () => {
  const lastLog = (log: ReturnType<typeof vi.spyOn>) => JSON.parse(String(log.mock.calls.at(-1)![0]));

  test('トークンは token、Cookie は cookie', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const person = await createLoginPerson();
    const { raw } = await tokenOf(person);
    await post(app, whoAmI, { bearer: raw, origin: null });
    expect(lastLog(log)).toMatchObject({ operation: 'who-am-i', status: 200, credential: 'token' });
    await post(app, whoAmI, { token: person.token });
    expect(lastLog(log)).toMatchObject({ operation: 'who-am-i', status: 200, credential: 'cookie' });
  });

  test('組織の中の操作の失敗にも credential が付く', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const target = await createTarget();
    const { raw } = await tokenOf(target.member);
    await post(app, renameWorkspace, {
      slug: target.slug,
      bearer: raw,
      body: { workspace_id: target.workspace.id, name: 'x' },
    });
    expect(lastLog(log)).toMatchObject({ operation: 'rename-workspace', status: 403, credential: 'token' });
  });

  test('ログにトークンの値もハッシュも出ない', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const person = await createLoginPerson();
    const { raw, hash } = await tokenOf(person);
    expect((await post(app, whoAmI, { bearer: raw, origin: null })).status).toBe(200);
    await post(app, whoAmI, { bearer: rawApiToken() });
    const output = [...log.mock.calls, ...error.mock.calls].flat().map(String).join('\n');
    expect(output).not.toContain(raw);
    expect(output).not.toContain(raw.slice(4));
    expect(output).not.toContain(hash);
  });
});

describe('回数の上限はトークンと Cookie で同じ枠', () => {
  const limited = defineOperation({
    name: 'limited-token-ping',
    description: '回数の上限を確かめる',
    mode: 'write',
    permission: 'login',
    input: z.object({}),
    output: z.object({ ok: z.literal(true) }),
    rateLimit: { max: 2, windowSeconds: 60 },
  });
  const limitedApp = createApp([implement(limited, async () => ({ ok: true as const }))]);

  test('Cookie とトークンの呼び出しを合わせて数え、キーは operation:<名>:<accountId>', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const person = await createLoginPerson();
    const { raw } = await tokenOf(person);
    expect((await post(limitedApp, limited, { token: person.token })).status).toBe(200);
    expect((await post(limitedApp, limited, { bearer: raw })).status).toBe(200);
    const over = await post(limitedApp, limited, { bearer: raw });
    expect(over.status).toBe(429);
    expect(await errorCodeOf(over)).toBe('rate_limited');
    expect((await post(limitedApp, limited, { token: person.token })).status).toBe(429);
    const db = commonDb(env);
    const row = await db.first(
      db.statement((q) =>
        q.selectFrom('rate_limits').select('key').where('key', '=', `operation:limited-token-ping:${person.accountId}`),
      ),
    );
    expect(row).toBeDefined();
  });
});
