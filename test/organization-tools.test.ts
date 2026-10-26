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
  createSessionWithToken,
  createUser,
  createWorkspace,
} from './factories.ts';
import { post } from './operations/harness.ts';
import {
  admitElsewhere,
  createPerson,
  getOperator,
  SUSPENDED_AT,
  suspendAfterEntering,
  testEnv,
} from './operations/world.ts';

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
    vocabulary: z.object({ from: z.enum(['game', 'scrum']), to: z.enum(['game', 'scrum']) }).optional(),
    theme: z.object({ from: z.enum(themes), to: z.enum(themes) }).optional(),
  }),
  output: z.object({ result: z.enum(['written', 'conflict', 'suspended']) }),
});

const endSessions = defineOperation({
  name: 'tools-end-sessions',
  description: 'ログインできる条件を失った人のセッションを消す',
  mode: 'write',
  permission: 'admin',
  input: z.object({ user_id: z.string() }),
  output: z.object({ ok: z.literal(true) }),
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
    implement(endSessions, async ({ tools, input }) => {
      await tools.endSessionsIfLoginLost(input.user_id);
      return { ok: true as const };
    }),
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
        { vocabulary: { from: 'game', to: 'scrum' } },
        new Date('2026-10-25T00:00:00.000Z'),
      ),
    })),
    implement(inviteeReadsOrganization, async ({ tools }) => ({
      member_limit: (await tools.readOrganization()).memberLimit,
    })),
  ],
  { fetcher: github.fetcher },
);

async function organizationRowOf(id: string) {
  const db = commonDb(env);
  return db.first(db.statement((q) => q.selectFrom('organizations').selectAll().where('id', '=', id)));
}

async function sessionCount(accountId: string): Promise<number> {
  const db = commonDb(env);
  const rows = await db.rows(
    db.statement((q) => q.selectFrom('sessions').select('token_hash').where('account_id', '=', accountId)),
  );
  return rows.length;
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
          body: { vocabulary: { from: 'game', to: 'scrum' }, theme: { from: 'simple', to: 'medieval' } },
        }),
      ),
    ).toEqual({ result: 'written' });
    expect(await organizationRowOf(own.id)).toMatchObject({
      vocabulary: 'scrum',
      theme: 'medieval',
      updated_at: '2026-10-25T00:00:00.000Z',
    });
    expect(await organizationRowOf(other.id)).toEqual(otherBefore);

    // 渡した項目だけを書く
    await ok(
      await post(app, writeSettings, {
        slug: own.slug,
        token: admin.token,
        body: { theme: { from: 'medieval', to: 'modern' } },
      }),
    );
    expect(await organizationRowOf(own.id)).toMatchObject({ vocabulary: 'scrum', theme: 'modern' });
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
    const own = await createOrganization({ vocabulary: 'scrum', theme: 'modern' });
    const admin = await createPerson({ organization: own, admin: true });
    const before = await organizationRowOf(own.id);
    for (const body of [
      { vocabulary: { from: 'game', to: 'scrum' } },
      { theme: { from: 'simple', to: 'medieval' } },
      // 片方の欄だけが古くても、もう片方も書かない
      { vocabulary: { from: 'scrum', to: 'game' }, theme: { from: 'simple', to: 'medieval' } },
    ]) {
      expect(await ok(await post(app, writeSettings, { slug: own.slug, token: admin.token, body }))).toEqual({
        result: 'conflict',
      });
    }
    expect(await organizationRowOf(own.id)).toEqual(before);
  });

  test('入ってから書くまでに組織が停止されたら suspended で、読んだ値が古くても conflict より先に返し、行は変わらない', async () => {
    for (const body of [
      { vocabulary: { from: 'game', to: 'scrum' } },
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

describe('ログインできる条件を失った人のセッション', () => {
  test('入れる組織も届いた招待も無い、自分の組織の人のセッションを消す', async () => {
    const own = await createOrganization();
    const admin = await createPerson({ organization: own, admin: true });
    // 所属が無い（離れた後の）人
    const left = await createPerson({ organization: own });
    await createSessionWithToken(left.accountId);
    expect(await sessionCount(left.accountId)).toBe(2);

    await ok(await post(app, endSessions, { slug: own.slug, token: admin.token, body: { user_id: left.userId } }));
    expect(await sessionCount(left.accountId)).toBe(0);
  });

  test('別の組織の users の ID は、その人が入れる組織を持たなくても何もしない', async () => {
    const own = await createOrganization();
    const other = await createOrganization();
    const admin = await createPerson({ organization: own, admin: true });
    const stranger = await createPerson({ organization: other });

    const res = await post(app, endSessions, {
      slug: own.slug,
      token: admin.token,
      body: { user_id: stranger.userId },
    });
    expect(res.status).toBe(200);
    expect(await sessionCount(stranger.accountId)).toBe(1);
  });

  test('ほかの組織に入れる人と、運用者のセッションは残す', async () => {
    const own = await createOrganization();
    const admin = await createPerson({ organization: own, admin: true });
    const elsewhere = await admitElsewhere(await createPerson({ organization: own }));
    const operator = await getOperator();
    const operatorUser = await createUser(own, {
      account_id: operator.accountId,
      login_provider: operator.login.provider,
      login_subject: operator.login.subject,
    });

    for (const userId of [elsewhere.userId, operatorUser.id]) {
      await ok(await post(app, endSessions, { slug: own.slug, token: admin.token, body: { user_id: userId } }));
    }
    expect(await sessionCount(elsewhere.accountId)).toBe(1);
    expect(await sessionCount(operator.accountId)).toBe(1);
  });

  test('ほかの入口が、別の組織のアカウントに結ばれる前の指名の行だけなら、セッションを消す', async () => {
    const own = await createOrganization();
    const other = await createOrganization();
    const admin = await createPerson({ organization: own, admin: true });
    const left = await createPerson({ organization: own });
    // 別の組織で管理者に指名されているが、まだ結ばれていない（account_id が空）行。セッションの判定では数えない
    await createUser(other, {
      account_id: null,
      login_provider: left.login.provider,
      login_subject: left.login.subject,
      is_admin: 1,
    });

    await ok(await post(app, endSessions, { slug: own.slug, token: admin.token, body: { user_id: left.userId } }));
    expect(await sessionCount(left.accountId)).toBe(0);
  });

  test('入れる組織が無くても、承諾待ちの招待があればセッションを残す', async () => {
    const own = await createOrganization();
    const admin = await createPerson({ organization: own, admin: true });
    const left = await createPerson({ organization: own });
    const other = await createOrganization();
    const owner = await createUser(other, { is_admin: 1 });
    const workspace = await createWorkspace(other, owner.id);
    await createInvitation(other, workspace.id, owner.id, left.login);

    await ok(await post(app, endSessions, { slug: own.slug, token: admin.token, body: { user_id: left.userId } }));
    expect(await sessionCount(left.accountId)).toBe(1);
  });

  test('判定した時刻より後に作られたセッションは残す', async () => {
    const own = await createOrganization();
    const admin = await createPerson({ organization: own, admin: true });
    const left = await createPerson({ organization: own });
    // 判定の後にログインし直したセッションの代わりに、作った時刻が先の行を入れる
    const later = await createSessionWithToken(left.accountId, { created_at: '2099-01-01T00:00:00.000Z' });

    await ok(await post(app, endSessions, { slug: own.slug, token: admin.token, body: { user_id: left.userId } }));
    expect(await sessionCount(left.accountId)).toBe(1);
    const db = commonDb(env);
    const rows = await db.rows(
      db.statement((q) => q.selectFrom('sessions').select('token_hash').where('account_id', '=', left.accountId)),
    );
    expect(rows.map((row) => row.token_hash)).toEqual([later.row.token_hash]);
  });

  test('アカウントに結ばれていない行と、無い ID は何もしない', async () => {
    const own = await createOrganization();
    const admin = await createPerson({ organization: own, admin: true });
    const waiting = await createUser(own);
    for (const userId of [waiting.id, 'no-such-user']) {
      await ok(await post(app, endSessions, { slug: own.slug, token: admin.token, body: { user_id: userId } }));
    }
    expect(await sessionCount(admin.accountId)).toBe(1);
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
