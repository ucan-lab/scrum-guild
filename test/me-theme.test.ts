// 自分のテーマの変更（me-theme-update）の振る舞い。
// 組織の分離と権限の種類ごとの許可と拒否は、一覧を回す test/operation-registry.test.ts が確かめる。
// ここでは、呼んだ人の行だけが変わること、別の組織の同じアカウントの行と同じ組織の別の人の行が変わらないこと、
// NULL（組織の既定に従う）に戻せること、変更の履歴に出ないこと、入力の検証を確かめる
import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import { meThemeUpdate, organizationHistory, organizationInfo } from '../src/shared/operations/organization/index.ts';
import { createApp } from '../src/server/app.ts';
import { orgDb } from '../src/server/db/index.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import { createUser, type OrganizationFixture } from './factories.ts';
import { errorCodeOf, post } from './operations/harness.ts';
import { createTarget, type Person, type Target } from './operations/world.ts';

const app = createApp(implementedOperations);

function update(target: Target, person: Person, body: unknown) {
  return post(app, meThemeUpdate, { slug: target.slug, token: person.token, body });
}

async function userRow(organization: OrganizationFixture, userId: string) {
  const db = orgDb(env, organization.verified);
  const row = await db.first(
    db.statement((q) => q.selectFrom('users').select(['theme', 'updated_at']).where('id', '=', userId)),
  );
  return row!;
}

async function changeLogCount(organization: OrganizationFixture): Promise<number> {
  const db = orgDb(env, organization.verified);
  return (
    await db.rows(
      db.statement((q) => q.selectFrom('change_logs').select('id').where('organization_id', '=', organization.id)),
    )
  ).length;
}

async function infoOf(target: Target, person: Person) {
  const res = await post(app, organizationInfo, { slug: target.slug, token: person.token });
  expect(res.status).toBe(200);
  return (await res.json()) as { organization: { theme: string }; me: { theme: string | null } };
}

describe('me-theme-update', () => {
  test('呼んだ人の users.theme だけを書き、書いた後の値を返す。ほかの人の行と組織の既定は変わらない', async () => {
    const target = await createTarget();
    const before = await userRow(target.organization, target.member.userId!);
    const others = {
      admin: await userRow(target.organization, target.admin.userId!),
      leader: await userRow(target.organization, target.leader.userId!),
    };

    const res = await update(target, target.member, { theme: 'medieval' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ theme: 'medieval' });

    const after = await userRow(target.organization, target.member.userId!);
    expect(after.theme).toBe('medieval');
    expect(after.updated_at).not.toBe(before.updated_at);
    expect(await userRow(target.organization, target.admin.userId!)).toEqual(others.admin);
    expect(await userRow(target.organization, target.leader.userId!)).toEqual(others.leader);

    // 組織の枠の値: 自分のテーマが入り、組織の既定は変わらない。ほかの人の自分のテーマは空のまま
    const info = await infoOf(target, target.member);
    expect(info.me.theme).toBe('medieval');
    expect(info.organization.theme).toBe('simple');
    expect((await infoOf(target, target.leader)).me.theme).toBeNull();
  });

  test('5つのテーマをどれも書ける', async () => {
    const target = await createTarget();
    for (const theme of ['simple', 'simple_light', 'simple_dark', 'medieval', 'modern']) {
      const res = await update(target, target.leader, { theme });
      expect(res.status).toBe(200);
      expect((await userRow(target.organization, target.leader.userId!)).theme).toBe(theme);
    }
  });

  test('null を送ると自分のテーマが空に戻り、組織の枠の値は組織の既定に従う', async () => {
    const target = await createTarget();
    await update(target, target.member, { theme: 'modern' });
    const res = await update(target, target.member, { theme: null });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ theme: null });
    expect((await userRow(target.organization, target.member.userId!)).theme).toBeNull();
    expect((await infoOf(target, target.member)).me.theme).toBeNull();
  });

  test('同じ値をもう一度送っても成功する（最後に書いた値が残る）', async () => {
    const target = await createTarget();
    expect((await update(target, target.member, { theme: 'simple_dark' })).status).toBe(200);
    expect((await update(target, target.member, { theme: 'simple_dark' })).status).toBe(200);
    expect((await userRow(target.organization, target.member.userId!)).theme).toBe('simple_dark');
  });

  test('ワークスペースに所属しない管理者も、所属しないでも組織に入れる人も、自分の行を書ける', async () => {
    const target = await createTarget();
    expect((await update(target, target.admin, { theme: 'simple_light' })).status).toBe(200);
    expect((await userRow(target.organization, target.admin.userId!)).theme).toBe('simple_light');
    expect((await update(target, target.bystander, { theme: 'modern' })).status).toBe(200);
    expect((await userRow(target.organization, target.bystander.userId!)).theme).toBe('modern');
  });

  test('変更の履歴（change_logs）に残さず、組織の変更の履歴の画面にも出ない', async () => {
    const target = await createTarget();
    const before = await changeLogCount(target.organization);
    await update(target, target.member, { theme: 'medieval' });
    await update(target, target.member, { theme: null });
    expect(await changeLogCount(target.organization)).toBe(before);

    const history = await post(app, organizationHistory, { slug: target.slug, token: target.admin.token, body: {} });
    expect(history.status).toBe(200);
    const body = (await history.json()) as { entries: unknown[] };
    expect(JSON.stringify(body.entries)).not.toContain('medieval');
  });

  test('同じアカウントの別の組織の users の行は変わらない（組織で絞る）', async () => {
    const target = await createTarget();
    const other = await createTarget();
    // target の一般のメンバーと同じアカウントの行を、other の組織にも作る
    const there = await createUser(other.organization, {
      account_id: target.member.accountId,
      login_provider: target.member.login.provider,
      login_subject: target.member.login.subject,
    });

    const res = await post(app, meThemeUpdate, {
      slug: target.slug,
      token: target.member.token,
      body: { theme: 'medieval' },
    });
    expect(res.status).toBe(200);
    expect((await userRow(target.organization, target.member.userId!)).theme).toBe('medieval');
    expect((await userRow(other.organization, there.id)).theme).toBeNull();
  });

  test('別の組織の slug で呼ぶと、自分の組織の行は変わらない（その組織に入れない人は 404）', async () => {
    const target = await createTarget();
    const other = await createTarget();
    const res = await update(other, target.member, { theme: 'medieval' });
    expect(res.status).toBe(404);
    expect(await errorCodeOf(res)).toBe('not_found');
    expect((await userRow(target.organization, target.member.userId!)).theme).toBeNull();
    expect((await userRow(other.organization, other.member.userId!)).theme).toBeNull();
  });

  test('承諾待ちの招待だけの人（users の行が無い人）は 404 で、何も書かれない', async () => {
    const target = await createTarget();
    const res = await update(target, target.invitee, { theme: 'medieval' });
    expect(res.status).toBe(404);
    const db = orgDb(env, target.organization.verified);
    const themed = await db.rows(
      db.statement((q) =>
        q
          .selectFrom('users')
          .select('id')
          .where('organization_id', '=', target.organization.id)
          .where('theme', 'is not', null),
      ),
    );
    expect(themed).toEqual([]);
  });

  test('テーマの値でない文字、欠けた項目は 400 で、何も書かれない。入力に user_id を足しても捨てられ、ほかの人の行は書けない', async () => {
    const target = await createTarget();
    for (const body of [{ theme: 'neon' }, {}, { theme: '' }, { theme: 3 }]) {
      const res = await update(target, target.member, body);
      expect(res.status).toBe(400);
    }
    expect((await userRow(target.organization, target.member.userId!)).theme).toBeNull();

    const res = await update(target, target.member, { theme: 'modern', user_id: target.admin.userId });
    expect(res.status).toBe(200);
    expect((await userRow(target.organization, target.admin.userId!)).theme).toBeNull();
    expect((await userRow(target.organization, target.member.userId!)).theme).toBe('modern');
  });
});
