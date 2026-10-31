// 自分の組織を作る操作（create-my-organization）。組織の無い会員が30日のお試しで組織を作り、その管理者になる。
// お試し中の組織は1アカウントにつき1つまで。上限は INSERT 文の条件で守るので、同時に送っても組織は1つだけ
import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import { createApp } from '../src/server/app.ts';
import { commonDb, orgDb } from '../src/server/db/index.ts';
import { verifiedOrganizationForTest } from '../src/server/db/testing.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import { createOrganization as createByOperator, listOrganizations } from '../src/shared/operations/operator/index.ts';
import {
  createMyOrganization,
  createMyOrganizationConflictReasons,
  myOrganizations,
  organizationInfo,
} from '../src/shared/operations/organization/index.ts';
import { workspaceCreate } from '../src/shared/operations/workspace/workspace-create.ts';
import { createFakeGithub } from './auth/fake-github.ts';
import { githubUser } from './auth/helpers.ts';
import { consentRecord } from '../src/shared/operations/session/consent.ts';
import { PRIVACY_VERSION, TERMS_VERSION } from '../src/lib/legal/versions.ts';
import { createAccount, createAccountLogin, createOrganization, createSessionWithToken } from './factories.ts';
import { bearerFor } from './operations/api-token.ts';
import { errorCodeOf, post } from './operations/harness.ts';
import { createLoginPerson, createPerson, getOperator, OPERATOR_LOGIN_ID, withNewSession } from './operations/world.ts';

const github = createFakeGithub();
const app = createApp(implementedOperations, { fetcher: github.fetcher });

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MEMBER_LIMIT = 15;
const DEFAULT_ATTACHMENT_QUOTA_BYTES = 32212254720;

let counter = 0;
const newSlug = () => `mine-${crypto.randomUUID().slice(0, 8)}-${counter++}`;

// どの組織にも属さない会員（users の行を持たない）。ログイン名は loginName
async function newMember(loginName = 'mio-hoshino') {
  const account = await createAccount();
  await createAccountLogin(account.id, { login_name: loginName });
  const { token } = await createSessionWithToken(account.id);
  return { accountId: account.id, token };
}
type Member = Awaited<ReturnType<typeof newMember>>;

const create = (member: Pick<Member, 'token'>, slug: string, name = '青葉工房') =>
  post(app, createMyOrganization, { token: member.token, body: { slug, name } });

async function organizationRow(slug: string) {
  const db = commonDb(env);
  return db.first(db.statement((q) => q.selectFrom('organizations').selectAll().where('slug', '=', slug)));
}

async function organizationsOf(accountId: string) {
  const db = commonDb(env);
  return db.rows(
    db.statement((q) => q.selectFrom('organizations').selectAll().where('created_by_account_id', '=', accountId)),
  );
}

async function organizationCount() {
  const db = commonDb(env);
  const rows = await db.rows(db.statement((q) => q.selectFrom('organizations').select('id')));
  return rows.length;
}

const orgDbOf = (organizationId: string) => orgDb(env, verifiedOrganizationForTest(organizationId));

async function usersOf(organizationId: string) {
  const db = orgDbOf(organizationId);
  return db.rows(db.statement((q) => q.selectFrom('users').selectAll().where('organization_id', '=', organizationId)));
}

async function changeLogsOf(organizationId: string) {
  const db = orgDbOf(organizationId);
  return db.rows(
    db.statement((q) => q.selectFrom('change_logs').selectAll().where('organization_id', '=', organizationId)),
  );
}

type ErrorBody = { error: { code: string; details?: unknown } };
const detailsOf = async (res: Response) => ((await res.json()) as ErrorBody).error.details;

async function expectConflict(res: Response, reason: (typeof createMyOrganizationConflictReasons)[number]) {
  expect(res.status).toBe(409);
  const body = (await res.json()) as ErrorBody;
  expect(body.error.code).toBe('conflict');
  expect(body.error.details).toEqual({ reason });
}

// 作った日の UTC の日付の30日後。日付をまたぐ瞬間に走っても落ちないよう、呼ぶ前と後の両方を許す
function trialEndsOnCandidates(before: number, after: number): string[] {
  return [before, after].map((at) => new Date(at + 30 * DAY_MS).toISOString().slice(0, 10));
}

describe('定義', () => {
  test('ログインしていれば呼べる書き込みで、アカウントと操作ごとに10分に30回まで', () => {
    expect(createMyOrganization).toMatchObject({
      name: 'create-my-organization',
      mode: 'write',
      permission: 'login',
      rateLimit: { max: 30, windowSeconds: 600 },
    });
    // トークンでも呼べ、同意の門も通る
    expect(createMyOrganization).not.toHaveProperty('cookieOnly');
    expect(createMyOrganization).not.toHaveProperty('skipsConsent');
  });

  test('断る理由は slug_taken と trial_limit', () => {
    expect(createMyOrganizationConflictReasons).toEqual(['slug_taken', 'trial_limit']);
  });
});

describe('組織の無い会員が作る', () => {
  test('slug と名前を返し、組織の行に作った人、self-service、30日後のお試しの期限、小さい組織の既定を書く', async () => {
    const member = await newMember();
    const slug = newSlug();
    const before = Date.now();
    const res = await create(member, slug, '青葉工房');
    const after = Date.now();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ slug, name: '青葉工房' });

    const row = await organizationRow(slug);
    expect(row).toMatchObject({
      name: '青葉工房',
      created_by_account_id: member.accountId,
      created_by_operator: 'self-service',
      member_limit: DEFAULT_MEMBER_LIMIT,
      attachment_quota_bytes: DEFAULT_ATTACHMENT_QUOTA_BYTES,
      suspended_at: null,
      purge_on: null,
    });
    expect(trialEndsOnCandidates(before, after)).toContain(row?.trial_ends_on);
  });

  test('名前の前後の空白は落として保存する', async () => {
    const member = await newMember();
    const slug = newSlug();
    const res = await create(member, slug, '  青葉工房  ');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ slug, name: '青葉工房' });
    expect((await organizationRow(slug))?.name).toBe('青葉工房');
  });

  test('作った人が管理者の users の行になり、名前はアカウントのログイン名', async () => {
    const member = await newMember('hoshino-mio');
    const slug = newSlug();
    expect((await create(member, slug)).status).toBe(200);
    const organization = (await organizationRow(slug))!;

    const users = await usersOf(organization.id);
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({
      account_id: member.accountId,
      name: 'hoshino-mio',
      is_admin: 1,
      disabled_at: null,
    });
  });

  test('users の名前は、アカウントの最も早く作られたログインのログイン名', async () => {
    const account = await createAccount();
    await createAccountLogin(account.id, {
      login_provider: 'github',
      login_subject: `later-${crypto.randomUUID().slice(0, 8)}`,
      login_name: 'later-login',
      created_at: '2026-10-25T00:00:00.000Z',
    });
    await createAccountLogin(account.id, {
      login_provider: 'github',
      login_subject: `earlier-${crypto.randomUUID().slice(0, 8)}`,
      login_name: 'earlier-login',
      created_at: '2026-10-21T00:00:00.000Z',
    });
    const { token } = await createSessionWithToken(account.id);
    const slug = newSlug();
    expect((await create({ token }, slug)).status).toBe(200);
    const users = await usersOf((await organizationRow(slug))!.id);
    expect(users.map((user) => user.name)).toEqual(['earlier-login']);
  });

  test('change_logs に、作った人の users の ID で組織の作成が残る（operator は NULL）', async () => {
    const member = await newMember();
    const slug = newSlug();
    expect((await create(member, slug, '青葉工房')).status).toBe(200);
    const organization = (await organizationRow(slug))!;
    const [user] = await usersOf(organization.id);

    const logs = await changeLogsOf(organization.id);
    const created = logs.filter((log) => log.entity_type === 'organization');
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      organization_id: organization.id,
      entity_id: organization.id,
      action: 'create',
      actor_user_id: user!.id,
      operator: null,
    });
    expect(JSON.parse(created[0]!.changes_json!)).toEqual({ slug: [null, slug], name: [null, '青葉工房'] });
  });

  test('作った組織に slug で入れ、管理者としてワークスペースを作れる', async () => {
    const member = await newMember();
    const slug = newSlug();
    expect((await create(member, slug, '青葉工房')).status).toBe(200);

    const info = await post(app, organizationInfo, { slug, token: member.token });
    expect(info.status).toBe(200);
    expect(await info.json()).toMatchObject({ organization: { name: '青葉工房' }, me: { is_admin: true } });

    const [user] = await usersOf((await organizationRow(slug))!.id);
    const workspace = await post(app, workspaceCreate, {
      slug,
      token: member.token,
      body: { name: '保守チーム', timezone: 'Asia/Tokyo', leader_user_id: user!.id },
    });
    expect(workspace.status).toBe(200);
  });

  test('作った後の入れる組織の一覧に載る', async () => {
    const member = await newMember();
    const slug = newSlug();
    expect((await create(member, slug, '青葉工房')).status).toBe(200);
    const res = await post(app, myOrganizations, { token: member.token });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { organizations: { slug: string; name: string }[] };
    expect(body.organizations).toEqual([{ slug, name: '青葉工房' }]);
  });

  test('他の組織の人は、作った組織の slug で 404', async () => {
    const member = await newMember();
    const slug = newSlug();
    expect((await create(member, slug)).status).toBe(200);
    const outsider = await createLoginPerson();
    const res = await post(app, organizationInfo, { slug, token: outsider.token });
    expect(res.status).toBe(404);
    expect(await errorCodeOf(res)).toBe('not_found');
  });

  test('他の組織の管理者でもある人も作れる（運用者が作った組織の管理者であることは上限に数えない）', async () => {
    const organization = await createOrganization();
    const person = await createPerson({ organization, admin: true });
    const slug = newSlug();
    expect((await create(person, slug)).status).toBe(200);
    expect(await organizationsOf(person.accountId)).toHaveLength(1);
  });
});

describe('運用者が作る組織は変わらない', () => {
  test('create-organization の組織は、created_by_operator が運用者のログイン ID で、作った人のアカウントとお試しの期限が NULL', async () => {
    const operator = await withNewSession(await getOperator());
    const admin = githubUser('trial-unrelated-admin');
    github.addUser(admin);
    const slug = newSlug();
    const res = await post(app, createByOperator, {
      token: operator.token,
      body: {
        slug,
        name: '運用者が作った工房',
        admin: { provider: 'github', username: admin.login, login_subject: String(admin.id) },
      },
    });
    expect(res.status).toBe(200);
    expect((await organizationRow(slug))?.created_by_operator).toBe(OPERATOR_LOGIN_ID);
    // 作った人のアカウントとお試しの期限は空のまま（お試しにしない）
    expect(await organizationRow(slug)).toMatchObject({ created_by_account_id: null, trial_ends_on: null });
  });
});

describe('運用者の組織の一覧', () => {
  test('self_created は、自分で作った組織で true、運用者が作った組織で false', async () => {
    const operator = await withNewSession(await getOperator());
    const member = await newMember();
    const mine = newSlug();
    expect((await create(member, mine)).status).toBe(200);
    const byOperator = await createOrganization();

    const res = await post(app, listOrganizations, { token: operator.token });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { organizations: { slug: string; self_created: boolean }[] };
    expect(body.organizations.find((item) => item.slug === mine)?.self_created).toBe(true);
    expect(body.organizations.find((item) => item.slug === byOperator.slug)?.self_created).toBe(false);
  });
});

describe('入力を断る', () => {
  test.each(['A-b', 'a', '-ab', 'ab_c', 'あおば', 'a'.repeat(41), 'ab cd'])(
    '形の合わない slug %s は 400 の invalid_input（slug_format）で、組織を作らない',
    async (slug) => {
      const member = await newMember();
      const count = await organizationCount();
      const res = await create(member, slug);
      expect(res.status).toBe(400);
      expect(await errorCodeOf(res.clone())).toBe('invalid_input');
      expect(await detailsOf(res)).toEqual([expect.objectContaining({ path: 'slug', code: 'slug_format' })]);
      expect(await organizationCount()).toBe(count);
      expect(await organizationsOf(member.accountId)).toHaveLength(0);
    },
  );

  test.each(['api', 'login', 'operator', 'consent', 'cdn-cgi', 'invite'])(
    '予約した名前 %s は 400 の invalid_input（slug_reserved）で、組織を作らない',
    async (slug) => {
      const member = await newMember();
      const count = await organizationCount();
      const res = await create(member, slug);
      expect(res.status).toBe(400);
      expect(await errorCodeOf(res.clone())).toBe('invalid_input');
      expect(await detailsOf(res)).toEqual([expect.objectContaining({ path: 'slug', code: 'slug_reserved' })]);
      expect(await organizationCount()).toBe(count);
    },
  );

  test.each([
    ['空', ''],
    ['空白だけ', '   '],
    ['81 字', 'あ'.repeat(81)],
    ['ゼロ幅スペースを含む', '青葉​工房'],
    ['改行を含む', '青葉\n工房'],
    ['向きを変える文字を含む', '青葉‮工房'],
  ])('名前が%sなら 400 の invalid_input で、組織を作らない', async (_label, name) => {
    const member = await newMember();
    const count = await organizationCount();
    const res = await create(member, newSlug(), name);
    expect(res.status).toBe(400);
    expect(await errorCodeOf(res)).toBe('invalid_input');
    expect(await organizationCount()).toBe(count);
  });

  test('名前が 80 字ちょうどなら作れる', async () => {
    const member = await newMember();
    const res = await create(member, newSlug(), 'あ'.repeat(80));
    expect(res.status).toBe(200);
  });

  test('既にある slug は 409 の conflict（slug_taken）で、組織もお試しの枠も増えない', async () => {
    const existing = await createOrganization();
    const member = await newMember();
    const count = await organizationCount();
    await expectConflict(await create(member, existing.slug), 'slug_taken');
    expect(await organizationCount()).toBe(count);
    expect(await organizationsOf(member.accountId)).toHaveLength(0);
    // 断られた後に別の slug で作れる
    expect((await create(member, newSlug())).status).toBe(200);
  });

  test('自分で作った組織と同じ slug も、別のアカウントには 409（slug_taken）', async () => {
    const first = await newMember();
    const slug = newSlug();
    expect((await create(first, slug)).status).toBe(200);
    const second = await newMember();
    await expectConflict(await create(second, slug), 'slug_taken');
    expect(await organizationsOf(second.accountId)).toHaveLength(0);
  });
});

describe('お試し中の組織は1アカウントにつき1つまで', () => {
  test('2つ目は 409 の conflict（trial_limit）で、組織の行が増えない', async () => {
    const member = await newMember();
    const first = newSlug();
    expect((await create(member, first)).status).toBe(200);
    const count = await organizationCount();

    const second = newSlug();
    await expectConflict(await create(member, second), 'trial_limit');
    expect(await organizationCount()).toBe(count);
    expect(await organizationRow(second)).toBeUndefined();
    expect((await organizationsOf(member.accountId)).map((row) => row.slug)).toEqual([first]);
  });

  test('別のアカウントは、自分の1つ目を作れる', async () => {
    const first = await newMember();
    const second = await newMember();
    expect((await create(first, newSlug())).status).toBe(200);
    expect((await create(second, newSlug())).status).toBe(200);
  });

  test('お試しの期限が NULL の組織（払って使い続ける）しか持たない人は、作れる', async () => {
    const member = await newMember();
    await createOrganization({ created_by_account_id: member.accountId, trial_ends_on: null });
    const slug = newSlug();
    expect((await create(member, slug)).status).toBe(200);
    expect((await organizationRow(slug))?.created_by_account_id).toBe(member.accountId);
  });

  test('期限の列が NULL になったら、次のお試しの組織を作れる', async () => {
    const member = await newMember();
    expect((await create(member, newSlug())).status).toBe(200);
    const db = commonDb(env);
    await db.run(
      db.statement((q) =>
        q
          .updateTable('organizations')
          .set({ trial_ends_on: null })
          .where('created_by_account_id', '=', member.accountId),
      ),
    );
    expect((await create(member, newSlug())).status).toBe(200);
  });

  test('期限の日付が過ぎていても、列が NULL でなければ数える（期限での停止は別の仕事）', async () => {
    const member = await newMember();
    await createOrganization({ created_by_account_id: member.accountId, trial_ends_on: '2020-01-01' });
    await expectConflict(await create(member, newSlug()), 'trial_limit');
  });

  test('停止した組織でも、期限の列が NULL でなければ数える', async () => {
    const member = await newMember();
    await createOrganization({
      created_by_account_id: member.accountId,
      trial_ends_on: '2099-01-01',
      suspended_at: '2026-10-20T00:00:00.000Z',
    });
    await expectConflict(await create(member, newSlug()), 'trial_limit');
  });

  test('運用者が作った組織の管理者であることは数えない', async () => {
    const organization = await createOrganization({ created_by_account_id: null, trial_ends_on: null });
    const person = await createPerson({ organization, admin: true });
    expect((await create(person, newSlug())).status).toBe(200);
  });

  test('slug が重なり、しかもお試しの上限にも当たるときは、どちらかの理由で 409 になり、行は増えない', async () => {
    const member = await newMember();
    const first = newSlug();
    expect((await create(member, first)).status).toBe(200);
    const count = await organizationCount();
    const res = await create(member, first);
    expect(res.status).toBe(409);
    const body = (await res.json()) as ErrorBody;
    expect(createMyOrganizationConflictReasons).toContain((body.error.details as { reason: string }).reason);
    expect(await organizationCount()).toBe(count);
  });
});

describe('同時に送る', () => {
  test.each([2, 5])('同じアカウントが別の slug を %s つ同時に送っても、組織は1つだけ', async (n) => {
    const member = await newMember();
    const slugs = Array.from({ length: n }, () => newSlug());
    const responses = await Promise.all(slugs.map((slug) => create(member, slug)));
    const statuses = responses.map((res) => res.status).sort();
    expect(statuses).toEqual([200, ...Array.from({ length: n - 1 }, () => 409)]);
    for (const res of responses.filter((r) => r.status === 409)) {
      expect(((await res.json()) as ErrorBody).error.details).toEqual({ reason: 'trial_limit' });
    }
    const created = await organizationsOf(member.accountId);
    expect(created).toHaveLength(1);
    // 通った1つだけが、管理者の users と作成の change_logs を持つ
    expect(await usersOf(created[0]!.id)).toHaveLength(1);
    expect((await changeLogsOf(created[0]!.id)).filter((log) => log.action === 'create')).toHaveLength(1);
    for (const slug of slugs) {
      if (slug !== created[0]!.slug) expect(await organizationRow(slug)).toBeUndefined();
    }
  });

  test('別のアカウントが同じ slug を同時に送ると、片方だけ成功し、もう片方は 409（slug_taken）', async () => {
    const a = await newMember();
    const b = await newMember();
    const slug = newSlug();
    const [resA, resB] = await Promise.all([create(a, slug), create(b, slug)]);
    expect([resA.status, resB.status].sort()).toEqual([200, 409]);
    const loser = resA.status === 409 ? resA : resB;
    expect(((await loser.json()) as ErrorBody).error.details).toEqual({ reason: 'slug_taken' });

    const row = (await organizationRow(slug))!;
    expect([a.accountId, b.accountId]).toContain(row.created_by_account_id);
    expect(await usersOf(row.id)).toHaveLength(1);
    const loserAccount = row.created_by_account_id === a.accountId ? b.accountId : a.accountId;
    expect(await organizationsOf(loserAccount)).toHaveLength(0);
  });

  test('同じアカウントが同じ slug を同時に送っても、組織は1つだけ', async () => {
    const member = await newMember();
    const slug = newSlug();
    const responses = await Promise.all([create(member, slug), create(member, slug)]);
    expect(responses.map((res) => res.status).sort()).toEqual([200, 409]);
    expect(await organizationsOf(member.accountId)).toHaveLength(1);
  });
});

describe('権限', () => {
  test('同意していない人は 403 の terms_required で、組織を作らない', async () => {
    const person = await createPerson({ consented: false });
    const res = await create(person, newSlug());
    expect(res.status).toBe(403);
    expect(await errorCodeOf(res)).toBe('terms_required');
    expect(await organizationsOf(person.accountId)).toHaveLength(0);
  });

  test('同意した後は同じ人が作れる', async () => {
    const person = await createPerson({ consented: false });
    const consent = await post(app, consentRecord, {
      token: person.token,
      body: { terms_version: TERMS_VERSION, privacy_version: PRIVACY_VERSION },
    });
    expect(consent.status).toBe(200);
    expect((await create(person, newSlug())).status).toBe(200);
  });

  test('ログインしていないと 401 の unauthenticated', async () => {
    const count = await organizationCount();
    const res = await post(app, createMyOrganization, { body: { slug: newSlug(), name: '青葉工房' } });
    expect(res.status).toBe(401);
    expect(await errorCodeOf(res)).toBe('unauthenticated');
    expect(await organizationCount()).toBe(count);
  });

  test('Origin が違う Cookie の呼び出しは 403 で、組織を作らない', async () => {
    const member = await newMember();
    const res = await post(app, createMyOrganization, {
      token: member.token,
      origin: 'https://evil.example',
      body: { slug: newSlug(), name: '青葉工房' },
    });
    expect(res.status).toBe(403);
    expect(await organizationsOf(member.accountId)).toHaveLength(0);
  });

  test('write の API トークンでも呼べる', async () => {
    const member = await newMember();
    const slug = newSlug();
    const res = await post(app, createMyOrganization, {
      bearer: await bearerFor(member, 'write'),
      body: { slug, name: '青葉工房' },
    });
    expect(res.status).toBe(200);
    expect((await organizationRow(slug))?.created_by_account_id).toBe(member.accountId);
  });

  test('read の API トークンは 403 で、組織を作らない', async () => {
    const member = await newMember();
    const res = await post(app, createMyOrganization, {
      bearer: await bearerFor(member, 'read'),
      body: { slug: newSlug(), name: '青葉工房' },
    });
    expect(res.status).toBe(403);
    expect(await errorCodeOf(res)).toBe('forbidden');
    expect(await organizationsOf(member.accountId)).toHaveLength(0);
  });
});

describe('回数の上限', () => {
  test('アカウントと操作ごとに10分に30回まで。31回目は 429 の rate_limited で、組織を作らない', async () => {
    const member = await newMember();
    // 入力の誤り（名前が空）で断られる呼び出しも1回に数える
    for (let i = 0; i < 30; i++) {
      expect((await create(member, newSlug(), '')).status).toBe(400);
    }
    const slug = newSlug();
    const res = await create(member, slug);
    expect(res.status).toBe(429);
    expect(await errorCodeOf(res)).toBe('rate_limited');
    expect(await organizationRow(slug)).toBeUndefined();
  });

  test('ほかのアカウントの回数には及ばない', async () => {
    const member = await newMember();
    for (let i = 0; i < 30; i++) {
      expect((await create(member, newSlug(), '')).status).toBe(400);
    }
    const other = await newMember();
    expect((await create(other, newSlug())).status).toBe(200);
  });
});
