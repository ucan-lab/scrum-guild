// 組織の操作（user-disable、membership-leave）で入れる組織を失った人の、API トークンとセッション（#639）。
// 組織を失ってもログインできる条件（アカウントがある）は失われないので、トークンは取り消さず、セッションも消さない。
// トークンは組織の外の操作（me、my-organizations）で 200 のまま通り、失った組織の中の操作は 404 になる
/* eslint-disable db-entry/guard -- api_tokens と sessions の行を、入口を通さず D1 に直に読んで確かめるため */
import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import { me } from '../src/shared/operations/session/index.ts';
import { myOrganizations, organizationInfo, userDisable } from '../src/shared/operations/organization/index.ts';
import { membershipLeave } from '../src/shared/operations/workspace/index.ts';
import { createApp } from '../src/server/app.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import { insertApiToken } from './operations/api-token.ts';
import { post } from './operations/harness.ts';
import { admitElsewhere, createPerson, createTarget, type Person, type Target } from './operations/world.ts';

const app = createApp([...implementedOperations]);

async function revokedAt(hash: string): Promise<string | null | undefined> {
  const row = await env.DB.prepare('select revoked_at from api_tokens where token_hash = ?')
    .bind(hash)
    .first<{ revoked_at: string | null }>();
  return row === null ? undefined : row.revoked_at;
}

async function sessionCount(accountId: string): Promise<number> {
  const row = await env.DB.prepare('select count(*) as n from sessions where account_id = ?')
    .bind(accountId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

function callMe(bearer: string) {
  return post(app, me, { bearer, origin: null });
}

function callMyOrganizations(bearer: string) {
  return post(app, myOrganizations, { bearer, origin: null });
}

function disable(target: Target, userId: string) {
  return post(app, userDisable, { slug: target.slug, token: target.admin.token, body: { user_id: userId } });
}

function leave(target: Target, caller: Person, userId: string) {
  return post(app, membershipLeave, {
    slug: target.slug,
    token: caller.token,
    body: { workspace_id: target.workspace.id, user_id: userId },
  });
}

// 失った人のトークンとセッションが残り、組織の外の操作が通り、失った組織の中は 404 になること
async function expectKept(target: Target, person: Person, token: { raw: string; hash: string }) {
  expect(await revokedAt(token.hash)).toBeNull();
  expect((await callMe(token.raw)).status).toBe(200);
  const listed = await callMyOrganizations(token.raw);
  expect(listed.status).toBe(200);
  expect(await listed.json()).toMatchObject({ organizations: [], invitations: [], operator: false });
  expect(await sessionCount(person.accountId)).toBe(1);
  expect((await post(app, me, { token: person.token })).status).toBe(200);
  const inside = await post(app, organizationInfo, { slug: target.slug, bearer: token.raw, origin: null });
  expect(inside.status).toBe(404);
}

describe('入れる組織を失った人のトークンとセッション', () => {
  test('user-disable: この組織だけに入っていた人のトークンは取り消されず、組織の外の操作で 200', async () => {
    const target = await createTarget();
    const token = await insertApiToken(target.member.accountId, { scope: 'write' });
    expect((await callMe(token.raw)).status).toBe(200);
    expect((await disable(target, target.member.userId!)).status).toBe(200);
    await expectKept(target, target.member, token);
  });

  test('membership-leave: 自分で抜けて組織に入れなくなった人のトークンもセッションも残る', async () => {
    const target = await createTarget();
    const token = await insertApiToken(target.member.accountId, { scope: 'write' });
    expect((await leave(target, target.member, target.member.userId!)).status).toBe(200);
    await expectKept(target, target.member, token);
  });

  test('membership-leave: リーダーに外されて組織に入れなくなった人のトークンもセッションも残る', async () => {
    const target = await createTarget();
    const token = await insertApiToken(target.member.accountId, { scope: 'write' });
    expect((await leave(target, target.leader, target.member.userId!)).status).toBe(200);
    await expectKept(target, target.member, token);
  });

  test('membership-leave: 管理者に外されて組織に入れなくなった人の read のトークンも残る', async () => {
    const target = await createTarget();
    const token = await insertApiToken(target.member.accountId, { scope: 'read' });
    expect((await leave(target, target.admin, target.member.userId!)).status).toBe(200);
    await expectKept(target, target.member, token);
  });

  test('失った後に別の組織に入れば、同じトークンでその組織が一覧に出る', async () => {
    const target = await createTarget();
    const token = await insertApiToken(target.member.accountId, { scope: 'write' });
    expect((await disable(target, target.member.userId!)).status).toBe(200);
    await admitElsewhere(target.member);
    const listed = await callMyOrganizations(token.raw);
    expect(listed.status).toBe(200);
    expect(((await listed.json()) as { organizations: unknown[] }).organizations).toHaveLength(1);
  });

  test('はじめから組織も招待も無い人のトークンも、組織の外の操作で 200 で、取り消されない', async () => {
    const person = await createPerson();
    const token = await insertApiToken(person.accountId, { scope: 'read' });
    expect((await callMe(token.raw)).status).toBe(200);
    expect((await callMyOrganizations(token.raw)).status).toBe(200);
    expect(await revokedAt(token.hash)).toBeNull();
  });

  test('対照: ほかに入れる組織が残る人も、無効にされた後、トークンは取り消されない', async () => {
    const target = await createTarget();
    await admitElsewhere(target.member);
    const { raw, hash } = await insertApiToken(target.member.accountId, { scope: 'write' });
    expect((await disable(target, target.member.userId!)).status).toBe(200);
    expect(await revokedAt(hash)).toBeNull();
    expect((await callMe(raw)).status).toBe(200);
  });
});
