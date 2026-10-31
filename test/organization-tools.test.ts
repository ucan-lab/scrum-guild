// 組織の中の操作に渡す組織の道具（src/server/operations/organization-tools.ts）。仮の操作をテストの中で定義し、
// 登録の関数が入った組織に結んだ道具を渡すこと、どの道具も別の組織の行に触れないことを、本物の D1 で確かめる。
// GitHub への通信は差し替えた fetch（test/auth/fake-github.ts）に向ける
import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import { z } from 'zod';
import { defineOperation } from '../src/shared/operations/define.ts';
import { themes } from '../src/shared/theme.ts';
import { createApp } from '../src/server/app.ts';
import { commonDb } from '../src/server/db/index.ts';
import { implement } from '../src/server/operations/implement.ts';
import { createFakeGithub } from './auth/fake-github.ts';
import { githubUser } from './auth/helpers.ts';
import {
  AT,
  createAccountLogin,
  createInvitation,
  createOrganization,
  createUser,
  createWorkspace,
} from './factories.ts';
import { post } from './operations/harness.ts';
import { createPerson, SUSPENDED_AT, suspendAfterEntering, testEnv } from './operations/world.ts';

const organizationRow = defineOperation({
  name: 'tools-organization-row',
  description: '自分の組織の人数の上限を返す',
  mode: 'read',
  permission: 'organization',
  input: z.object({}),
  output: z.object({ member_limit: z.number() }),
});

const workspaceOrganizationRow = defineOperation({
  name: 'tools-workspace-organization-row',
  description: 'ワークスペースの下の操作からも、自分の組織の人数の上限を返す',
  mode: 'read',
  permission: 'member',
  workspace: true,
  input: z.object({ workspace_id: z.string() }),
  output: z.object({ member_limit: z.number() }),
});

const writeSettings = defineOperation({
  name: 'tools-write-settings',
  description: '自分の組織の言葉づかいと既定のテーマを、読んだ値のままなら書く',
  mode: 'write',
  permission: 'admin',
  input: z.object({
    theme: z.object({ from: z.enum(themes), to: z.enum(themes) }).optional(),
  }),
  output: z.object({ result: z.enum(['written', 'conflict', 'suspended']) }),
});

const toolNames = defineOperation({
  name: 'tools-names',
  description: '組織の道具にセッションを消す道具があるかを返す',
  mode: 'read',
  permission: 'admin',
  input: z.object({}),
  output: z.object({ has_end_sessions: z.boolean() }),
});

const avatars = defineOperation({
  name: 'tools-avatars',
  description: 'users の ID ごとのアバターの URL を返す',
  mode: 'read',
  permission: 'organization',
  input: z.object({ user_ids: z.array(z.string()) }),
  output: z.object({ avatars: z.array(z.object({ user_id: z.string(), avatar_url: z.string().nullable() })) }),
});

const resolveGithub = defineOperation({
  name: 'tools-resolve-github',
  description: 'GitHub のユーザー名を解決する',
  mode: 'read',
  permission: 'admin',
  input: z.object({ provider: z.string(), username: z.string() }),
  output: z.object({ kind: z.string(), login_subject: z.string().nullable() }),
});

// 道具が入った人を確かめることを見るための操作。権限の検査は通し、道具の中で断られることを確かめる
const memberWritesSettings = defineOperation({
  name: 'tools-member-write-settings',
  description: '管理者でない人の操作から、組織の設定を書こうとする',
  mode: 'write',
  permission: 'organization',
  input: z.object({}),
  output: z.object({ result: z.enum(['written', 'conflict', 'suspended']) }),
});

const inviteeReadsOrganization = defineOperation({
  name: 'tools-invitee-organization-row',
  description: '承諾待ちの招待だけの人の操作から、組織の行を読もうとする',
  mode: 'read',
  permission: 'invitee',
  input: z.object({}),
  output: z.object({ member_limit: z.number() }),
});

const myLogins = defineOperation({
  name: 'tools-my-logins',
  description: '呼んだ人のアカウントに結んだログインを返す',
  mode: 'read',
  permission: 'invitee',
  input: z.object({}),
  output: z.object({
    logins: z.array(z.object({ provider: z.string(), subject: z.string(), login_name: z.string() })),
  }),
});

const github = createFakeGithub();
const app = createApp(
  [
    implement(organizationRow, async ({ tools }) => ({ member_limit: (await tools.readOrganization()).memberLimit })),
    implement(workspaceOrganizationRow, async ({ tools }) => ({
      member_limit: (await tools.readOrganization()).memberLimit,
    })),
    implement(writeSettings, async ({ tools, input }) => ({
      result: await tools.writeOrganizationSettings(input, new Date('2026-10-25T00:00:00.000Z')),
    })),
    implement(toolNames, async ({ tools }) => ({ has_end_sessions: 'endSessionsIfLoginLost' in tools })),
    implement(avatars, async ({ tools, input }) => ({
      avatars: [...(await tools.avatarsOf(input.user_ids))].map(([user_id, avatar_url]) => ({ user_id, avatar_url })),
    })),
    implement(resolveGithub, async ({ tools, input }) => {
      const resolver = tools.inviteeResolver(input.provider);
      if (resolver === undefined) return { kind: 'no_resolver', login_subject: null };
      const result = await resolver.resolveInvitee(input.username);
      return { kind: result.kind, login_subject: result.kind === 'found' ? result.invitee.subject : null };
    }),
    implement(memberWritesSettings, async ({ tools }) => ({
      result: await tools.writeOrganizationSettings(
        { theme: { from: 'simple', to: 'medieval' } },
        new Date('2026-10-25T00:00:00.000Z'),
      ),
    })),
    implement(inviteeReadsOrganization, async ({ tools }) => ({
      member_limit: (await tools.readOrganization()).memberLimit,
    })),
    implement(myLogins, async ({ tools }) => ({
      logins: (await tools.myLogins()).map((login) => ({
        provider: login.provider,
        subject: login.subject,
        login_name: login.loginName,
      })),
    })),
  ],
  { fetcher: github.fetcher },
);

async function organizationRowOf(id: string) {
  const db = commonDb(env);
  return db.first(db.statement((q) => q.selectFrom('organizations').selectAll().where('id', '=', id)));
}

async function ok(res: Response): Promise<unknown> {
  expect(res.status).toBe(200);
  return res.json();
}

describe('組織の行', () => {
  test('組織の直下とワークスペースの下の操作が、入った組織の人数の上限を読む', async () => {
    const own = await createOrganization({ member_limit: 7 });
    await createOrganization({ member_limit: 30 });
    const admin = await createPerson({ organization: own, admin: true });
    const workspace = await createWorkspace(own, admin.userId!);

    expect(await ok(await post(app, organizationRow, { slug: own.slug, token: admin.token }))).toEqual({
      member_limit: 7,
    });
    expect(
      await ok(
        await post(app, workspaceOrganizationRow, {
          slug: own.slug,
          token: admin.token,
          body: { workspace_id: workspace.id },
        }),
      ),
    ).toEqual({ member_limit: 7 });
  });

  test('設定を書くと入った組織の行だけが変わり、別の組織の行は変わらない', async () => {
    const own = await createOrganization();
    const other = await createOrganization();
    const admin = await createPerson({ organization: own, admin: true });
    const otherBefore = await organizationRowOf(other.id);

    expect(
      await ok(
        await post(app, writeSettings, {
          slug: own.slug,
          token: admin.token,
          body: { theme: { from: 'simple', to: 'medieval' } },
        }),
      ),
    ).toEqual({ result: 'written' });
    expect(await organizationRowOf(own.id)).toMatchObject({
      theme: 'medieval',
      updated_at: '2026-10-25T00:00:00.000Z',
    });
    expect(await organizationRowOf(other.id)).toEqual(otherBefore);

    await ok(
      await post(app, writeSettings, {
        slug: own.slug,
        token: admin.token,
        body: { theme: { from: 'medieval', to: 'modern' } },
      }),
    );
    expect(await organizationRowOf(own.id)).toMatchObject({ theme: 'modern' });
  });

  test('書く項目が無ければ何も書かず、updated_at も変えない', async () => {
    const own = await createOrganization();
    const admin = await createPerson({ organization: own, admin: true });
    const before = await organizationRowOf(own.id);
    expect(await ok(await post(app, writeSettings, { slug: own.slug, token: admin.token, body: {} }))).toEqual({
      result: 'written',
    });
    expect(await organizationRowOf(own.id)).toEqual(before);
  });

  test('読んだ値が今の値と違えば conflict で、行は変わらない', async () => {
    const own = await createOrganization({ theme: 'modern' });
    const admin = await createPerson({ organization: own, admin: true });
    const before = await organizationRowOf(own.id);
    for (const body of [{ theme: { from: 'simple', to: 'medieval' } }]) {
      expect(await ok(await post(app, writeSettings, { slug: own.slug, token: admin.token, body }))).toEqual({
        result: 'conflict',
      });
    }
    expect(await organizationRowOf(own.id)).toEqual(before);
  });

  test('入ってから書くまでに組織が停止されたら suspended で、読んだ値が古くても conflict より先に返し、行は変わらない', async () => {
    for (const body of [
      { theme: { from: 'modern', to: 'simple' } },
      // 読んだ値が古い（今は modern）。停止を先に伝える
      { theme: { from: 'medieval', to: 'simple' } },
    ]) {
      const own = await createOrganization({ theme: 'modern' });
      const admin = await createPerson({ organization: own, admin: true });
      const racing = suspendAfterEntering(testEnv, own.id);
      const before = await organizationRowOf(own.id);
      expect(
        await ok(await post(app, writeSettings, { slug: own.slug, token: admin.token, body, env: racing.env })),
      ).toEqual({ result: 'suspended' });
      expect(racing.suspended()).toBe(true);
      expect(await organizationRowOf(own.id)).toEqual({ ...before, suspended_at: SUSPENDED_AT });
    }
  });
});

describe('道具を使える人', () => {
  test('管理者でない人の操作から組織の設定を書くと、書かずに 500 になる', async () => {
    const own = await createOrganization();
    const admin = await createPerson({ organization: own, admin: true });
    const workspace = await createWorkspace(own, admin.userId!);
    const member = await createPerson({
      organization: own,
      membership: { workspaceId: workspace.id, role: 'leader' },
    });
    const before = await organizationRowOf(own.id);

    const res = await post(app, memberWritesSettings, { slug: own.slug, token: member.token });
    expect(res.status).toBe(500);
    expect(await organizationRowOf(own.id)).toEqual(before);
  });

  test('承諾待ちの招待だけの人の操作からは、道具を使えず 500 になる', async () => {
    const own = await createOrganization();
    const owner = await createUser(own, { is_admin: 1 });
    const workspace = await createWorkspace(own, owner.id);
    const invitee = await createPerson();
    await createInvitation(own, workspace.id, owner.id, invitee.login);

    const res = await post(app, inviteeReadsOrganization, { slug: own.slug, token: invitee.token });
    expect(res.status).toBe(500);
  });
});

describe('自分のログイン', () => {
  test('承諾待ちの招待だけの人の操作からも使え、呼んだ人のアカウントに結んだログインだけを返す', async () => {
    const own = await createOrganization();
    const owner = await createUser(own, { is_admin: 1 });
    const workspace = await createWorkspace(own, owner.id);
    const invitee = await createPerson();
    await createAccountLogin(invitee.accountId, {
      login_provider: 'google',
      login_subject: '118000000000000000042',
      login_name: 'mio@example.com',
    });
    await createInvitation(own, workspace.id, owner.id, invitee.login);
    // 同じ組織のほかの人のログインは出ない
    await createPerson({ organization: own, admin: true });

    const result = (await ok(await post(app, myLogins, { slug: own.slug, token: invitee.token }))) as {
      logins: { provider: string; subject: string; login_name: string }[];
    };
    expect(result.logins).toEqual([
      { provider: 'github', subject: invitee.login.subject, login_name: 'mio-hoshino' },
      { provider: 'google', subject: '118000000000000000042', login_name: 'mio@example.com' },
    ]);
  });

  test('組織に入れる人の操作からも使える', async () => {
    const own = await createOrganization();
    const admin = await createPerson({ organization: own, admin: true });
    const result = (await ok(await post(app, myLogins, { slug: own.slug, token: admin.token }))) as {
      logins: { subject: string }[];
    };
    expect(result.logins.map((login) => login.subject)).toEqual([admin.login.subject]);
  });
});

// #639: 組織を失ったことでセッションを消す道具（endSessionsIfLoginLost）は無くした
describe('セッションを消す道具が無いこと', () => {
  test('組織の道具は endSessionsIfLoginLost を持たない', async () => {
    const own = await createOrganization();
    const admin = await createPerson({ organization: own, admin: true });
    expect(await ok(await post(app, toolNames, { slug: own.slug, token: admin.token }))).toMatchObject({
      has_end_sessions: false,
    });
  });
});

describe('アバター', () => {
  test('自分の組織の人のアバターだけを返し、別の組織の ID はキーを持たない', async () => {
    const own = await createOrganization();
    const other = await createOrganization();
    const admin = await createPerson({ organization: own, admin: true });
    const withAvatar = await createPerson({ organization: own });
    const avatarUrl = 'https://avatars.githubusercontent.com/u/7100001';
    const db = commonDb(env);
    await db.run(
      db.statement((q) =>
        q
          .updateTable('account_logins')
          .set({ avatar_url: avatarUrl })
          .where('login_provider', '=', withAvatar.login.provider)
          .where('login_subject', '=', withAvatar.login.subject),
      ),
    );
    // 指名で待っている人（まだログインしていない）と、Google の指名で待っている人（login_subject が空）
    const waiting = await createUser(own);
    const googleWaiting = await createUser(own, {
      login_provider: 'google',
      login_subject: null,
      login_email: 'kaede@example.com',
      claim_token_hash: 'a'.repeat(64),
      claim_expires_at: AT,
    });
    // 別の組織の人。アバターを持つ
    const stranger = await createPerson({ organization: other });
    await createAccountLogin(stranger.accountId, {
      login_provider: 'google',
      login_subject: '118000000000000000001',
      avatar_url: 'https://lh3.googleusercontent.com/a/stranger',
    });

    const result = (await ok(
      await post(app, avatars, {
        slug: own.slug,
        token: admin.token,
        body: { user_ids: [withAvatar.userId, admin.userId, waiting.id, googleWaiting.id, stranger.userId, 'none'] },
      }),
    )) as { avatars: { user_id: string; avatar_url: string | null }[] };
    expect(new Map(result.avatars.map((item) => [item.user_id, item.avatar_url]))).toEqual(
      new Map([
        [withAvatar.userId, avatarUrl],
        [admin.userId, null],
        [waiting.id, null],
        [googleWaiting.id, null],
      ]),
    );
  });

  test('アカウントに結ばれる前の行は、同じログインの account_logins があっても null', async () => {
    const own = await createOrganization();
    const other = await createOrganization();
    const admin = await createPerson({ organization: own, admin: true });
    // 別の組織でログインしている人。アバターを持つ
    const elsewhere = await createPerson({ organization: other });
    const db = commonDb(env);
    await db.run(
      db.statement((q) =>
        q
          .updateTable('account_logins')
          .set({ avatar_url: 'https://avatars.githubusercontent.com/u/7100002' })
          .where('login_provider', '=', elsewhere.login.provider)
          .where('login_subject', '=', elsewhere.login.subject),
      ),
    );
    // 自分の組織で、同じログインを指名して待っている行（まだ結ばれていない）
    const waiting = await createUser(own, {
      account_id: null,
      login_provider: elsewhere.login.provider,
      login_subject: elsewhere.login.subject,
    });

    const result = (await ok(
      await post(app, avatars, { slug: own.slug, token: admin.token, body: { user_ids: [waiting.id] } }),
    )) as { avatars: { user_id: string; avatar_url: string | null }[] };
    expect(result.avatars).toEqual([{ user_id: waiting.id, avatar_url: null }]);
  });

  test('束縛の上限を超える数の ID も区切って引く', async () => {
    const own = await createOrganization();
    const admin = await createPerson({ organization: own, admin: true });
    const ids = Array.from({ length: 150 }, (_, index) => `missing-${index}`);
    const result = (await ok(
      await post(app, avatars, { slug: own.slug, token: admin.token, body: { user_ids: [...ids, admin.userId] } }),
    )) as { avatars: { user_id: string }[] };
    expect(result.avatars.map((item) => item.user_id)).toEqual([admin.userId]);
  });
});

describe('招待する人の解決器', () => {
  const resolve = async (username: string, provider = 'github') => {
    const own = await createOrganization();
    const admin = await createPerson({ organization: own, admin: true });
    return ok(await post(app, resolveGithub, { slug: own.slug, token: admin.token, body: { provider, username } }));
  };

  test('GitHub のユーザー名をユーザー ID に解決する', async () => {
    const user = githubUser('sora-kiriya');
    github.addUser(user);
    expect(await resolve('sora-kiriya')).toEqual({ kind: 'found', login_subject: String(user.id) });
  });

  test('いないユーザー名は not_found、組織のアカウントは not_a_user', async () => {
    expect(await resolve('nobody-tools')).toEqual({ kind: 'not_found', login_subject: null });
    github.addUser({ id: 8_200_001, login: 'kiriya-works', type: 'Organization' });
    expect(await resolve('kiriya-works')).toEqual({ kind: 'not_a_user', login_subject: null });
  });

  test('解決器を持たない手段は undefined', async () => {
    expect(await resolve('kaede@example.com', 'google')).toEqual({ kind: 'no_resolver', login_subject: null });
  });
});
