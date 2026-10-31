// 組織の操作（user-disable、membership-leave）でログインできる条件を失った人は、API トークンも取り消される（#580）。
// 経路は endSessionsIfLoginLost。セッションを消すだけだと、Bearer だけで呼ぶトークンが、その人が別の組織に入れた後に使えてしまう。
// 判定の後に発行したトークンが残る性質は test/api-token-breakers-2.test.ts が見ているので、ここでは重ねない
/* eslint-disable db-entry/guard -- api_tokens の行を、入口を通さず D1 に直に読んで確かめるため */
import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import { me } from '../src/shared/operations/session/index.ts';
import { userDisable } from '../src/shared/operations/organization/index.ts';
import { membershipLeave } from '../src/shared/operations/workspace/index.ts';
import { createApp } from '../src/server/app.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import { insertApiToken } from './operations/api-token.ts';
import { post } from './operations/harness.ts';
import { admitElsewhere, createTarget, type Person, type Target } from './operations/world.ts';

const app = createApp([...implementedOperations]);

async function revokedAt(hash: string): Promise<string | null | undefined> {
  const row = await env.DB.prepare('select revoked_at from api_tokens where token_hash = ?')
    .bind(hash)
    .first<{ revoked_at: string | null }>();
  return row === null ? undefined : row.revoked_at;
}

function callMe(bearer: string) {
  return post(app, me, { bearer, origin: null });
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

describe('ログインできる条件を失った人のトークン', () => {
  test('user-disable: この組織だけに入っていた人のトークンが取り消され、別の組織に入れた後も Bearer で 401', async () => {
    const target = await createTarget();
    const { raw, hash } = await insertApiToken(target.member.accountId, { scope: 'write' });
    expect((await callMe(raw)).status).toBe(200);
    expect((await disable(target, target.member.userId!)).status).toBe(200);
    expect(await revokedAt(hash)).not.toBeNull();
    await admitElsewhere(target.member);
    expect((await callMe(raw)).status).toBe(401);
  });

  test('membership-leave: 自分で抜けて組織に入れなくなった人のトークンが取り消され、別の組織に入れた後も 401', async () => {
    const target = await createTarget();
    const { raw, hash } = await insertApiToken(target.member.accountId, { scope: 'write' });
    expect((await leave(target, target.member, target.member.userId!)).status).toBe(200);
    expect(await revokedAt(hash)).not.toBeNull();
    await admitElsewhere(target.member);
    expect((await callMe(raw)).status).toBe(401);
  });

  test('membership-leave: リーダーに外されて組織に入れなくなった人のトークンが取り消される', async () => {
    const target = await createTarget();
    const { raw, hash } = await insertApiToken(target.member.accountId, { scope: 'write' });
    expect((await leave(target, target.leader, target.member.userId!)).status).toBe(200);
    expect(await revokedAt(hash)).not.toBeNull();
    await admitElsewhere(target.member);
    expect((await callMe(raw)).status).toBe(401);
  });

  test('membership-leave: 管理者に外されて組織に入れなくなった人のトークンが取り消される', async () => {
    const target = await createTarget();
    const { raw, hash } = await insertApiToken(target.member.accountId, { scope: 'read' });
    expect((await leave(target, target.admin, target.member.userId!)).status).toBe(200);
    expect(await revokedAt(hash)).not.toBeNull();
    await admitElsewhere(target.member);
    expect((await callMe(raw)).status).toBe(401);
  });

  test('対照: ほかに入れる組織が残る人は、無効にされても、トークンが取り消されない', async () => {
    const target = await createTarget();
    await admitElsewhere(target.member);
    const { raw, hash } = await insertApiToken(target.member.accountId, { scope: 'write' });
    expect((await disable(target, target.member.userId!)).status).toBe(200);
    expect(await revokedAt(hash)).toBeNull();
    expect((await callMe(raw)).status).toBe(200);
  });

  test('対照: ほかに入れる組織が残る人は、離脱しても、外されても、トークンが取り消されない', async () => {
    const target = await createTarget();
    await admitElsewhere(target.member);
    await admitElsewhere(target.leader);
    const mine = await insertApiToken(target.member.accountId, { scope: 'write' });
    const led = await insertApiToken(target.leader.accountId, { scope: 'write' });
    expect((await leave(target, target.member, target.member.userId!)).status).toBe(200);
    expect((await leave(target, target.admin, target.leader.userId!)).status).toBe(200);
    expect(await revokedAt(mine.hash)).toBeNull();
    expect(await revokedAt(led.hash)).toBeNull();
    expect((await callMe(mine.raw)).status).toBe(200);
    expect((await callMe(led.raw)).status).toBe(200);
  });
});
