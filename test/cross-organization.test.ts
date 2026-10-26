// 組織をまたいで読み書きする処理のうち、ログインのための部分（src/server/db/cross-organization.ts）を、
// 本物の DB 1つで確かめる。確かめる範囲は次の3つ。
//   - ログインのときの判定（hasLoginAccess）の条件: 管理者、今の所属、承諾待ちの招待、停止、無効、アカウントに結ばれる前の行
//     （組織の選択には数えない）、初めてのログイン（アカウントが無い）、ログインの手段と ID が無いアカウント
//   - 指名で待っていた行を結ぶこと（linkLoginToAccount）が、結ぶ行があるときだけ書くこと
//   - 組織の選択（listAccountOrganizations）との違い（結ばれる前の行を数えるか）
// 確かめない範囲: 組織の選択と共通の読み取りの形（索引、束縛の上限）は test/organization.test.ts が、
// DB が2つのときの合わせ方（hasLoginAccess と linkLoginToAccount を含む）は test/cross-organization-databases.test.ts が、
// セッションの判定（結ばれる前の行を数えない）は test/session-access.test.ts と test/login.test.ts が確かめる
import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import {
  commonDb,
  hasLoginAccess,
  linkLoginToAccount,
  listAccountOrganizations,
  readLoginAccess,
} from '../src/server/db/index.ts';
import { failUserWrites } from './auth/helpers.ts';
import {
  AT,
  createAccount,
  createAccountLogin,
  createInvitation,
  createMembership,
  createOrganization,
  createUser,
  createWorkspace,
} from './factories.ts';

async function visitor() {
  const account = await createAccount();
  const login = await createAccountLogin(account.id);
  const identity = { provider: login.login_provider, subject: login.login_subject };
  const join = (organization: Awaited<ReturnType<typeof createOrganization>>, overrides = {}) =>
    createUser(organization, {
      account_id: account.id,
      login_provider: identity.provider,
      login_subject: identity.subject,
      ...overrides,
    });
  return { account, identity, join, who: { accountId: account.id, logins: [identity] } };
}

async function organizationWithOwner() {
  const organization = await createOrganization();
  const owner = await createUser(organization, { is_admin: 1 });
  const workspace = await createWorkspace(organization, owner.id);
  return { organization, owner, workspace };
}

describe('hasLoginAccess', () => {
  test('管理者、今の所属、承諾待ちの招待のどれかが、停止していない組織にあれば通す', async () => {
    const admin = await visitor();
    await admin.join(await createOrganization(), { is_admin: 1 });
    expect(await hasLoginAccess(env, admin.who)).toBe(true);

    const member = await visitor();
    const { organization, workspace } = await organizationWithOwner();
    await createMembership(organization, workspace.id, (await member.join(organization)).id);
    expect(await hasLoginAccess(env, member.who)).toBe(true);

    const invited = await visitor();
    const other = await organizationWithOwner();
    await createInvitation(other.organization, other.workspace.id, other.owner.id, invited.identity);
    expect(await hasLoginAccess(env, invited.who)).toBe(true);
  });

  test('入れる組織も招待も無い、管理者でも所属もない行だけ、離れた所属だけ、辞退した招待だけは通さない', async () => {
    const nobody = await visitor();
    expect(await hasLoginAccess(env, nobody.who)).toBe(false);

    const idle = await visitor();
    await idle.join(await createOrganization());
    const left = await organizationWithOwner();
    const leftUser = await idle.join(left.organization);
    await createMembership(left.organization, left.workspace.id, leftUser.id, { left_at: AT, left_on: '2026-10-10' });
    const declined = await organizationWithOwner();
    await createInvitation(declined.organization, declined.workspace.id, declined.owner.id, idle.identity, {
      status: 'declined',
      responded_at: AT,
    });
    expect(await hasLoginAccess(env, idle.who)).toBe(false);
  });

  test('停止した組織と、無効にされた人は通さない。無効な行があれば、招待があっても通さない', async () => {
    const suspended = await visitor();
    await suspended.join(await createOrganization({ suspended_at: AT }), { is_admin: 1 });
    expect(await hasLoginAccess(env, suspended.who)).toBe(false);

    const disabled = await visitor();
    await disabled.join(await createOrganization(), { is_admin: 1, disabled_at: AT });
    expect(await hasLoginAccess(env, disabled.who)).toBe(false);

    const blocked = await visitor();
    const invitedTo = await organizationWithOwner();
    await blocked.join(invitedTo.organization, { disabled_at: AT });
    await createInvitation(invitedTo.organization, invitedTo.workspace.id, invitedTo.owner.id, blocked.identity);
    expect(await hasLoginAccess(env, blocked.who)).toBe(false);
  });

  test('ある組織で無効にされていても、別の組織に入れれば通す', async () => {
    const person = await visitor();
    await person.join(await createOrganization(), { is_admin: 1, disabled_at: AT });
    await person.join(await createOrganization(), { is_admin: 1 });
    expect(await hasLoginAccess(env, person.who)).toBe(true);
  });

  test('アカウントに結ばれる前の指名の行は、ログインできるかには数え、組織の選択には数えない', async () => {
    const person = await visitor();
    const organization = await createOrganization();
    await createUser(organization, {
      account_id: null,
      login_provider: person.identity.provider,
      login_subject: person.identity.subject,
      is_admin: 1,
    });
    expect(await hasLoginAccess(env, person.who)).toBe(true);
    // 結ばれるまで、その組織には入れない（enterOrganization は account_id で引く）ので、一覧には出さない
    expect(await listAccountOrganizations(env, person.who)).toEqual({
      organizations: [],
      invitations: [],
      suspended: false,
    });
  });

  test('初めてのログイン（アカウントが無い）でも、指名の行と招待を、ログインの手段と ID で引ける', async () => {
    const identity = { provider: 'github', subject: `new-${crypto.randomUUID()}` };
    const newcomer = { accountId: undefined, logins: [identity] };
    expect(await hasLoginAccess(env, newcomer)).toBe(false);

    const nominated = await createOrganization();
    await createUser(nominated, {
      account_id: null,
      login_provider: identity.provider,
      login_subject: identity.subject,
      is_admin: 1,
    });
    expect(await hasLoginAccess(env, newcomer)).toBe(true);

    const other = { provider: 'github', subject: `new-${crypto.randomUUID()}` };
    const { organization, owner, workspace } = await organizationWithOwner();
    await createInvitation(organization, workspace.id, owner.id, other);
    expect(await hasLoginAccess(env, { accountId: undefined, logins: [other] })).toBe(true);
  });

  test('ほかのアカウントに結ばれた行は、アカウントが無い人にも、別のアカウントにも数えない', async () => {
    const owner = await visitor();
    await owner.join(await createOrganization(), { is_admin: 1 });
    expect(await hasLoginAccess(env, { accountId: undefined, logins: [owner.identity] })).toBe(false);
    const stranger = await createAccount();
    expect(await hasLoginAccess(env, { accountId: stranger.id, logins: [owner.identity] })).toBe(false);
  });

  test('ログインの手段と ID が無いアカウントは通さない', async () => {
    const account = await createAccount();
    expect(await hasLoginAccess(env, { accountId: account.id, logins: [] })).toBe(false);
  });

  test('組織が停止されたかを、共通の DB の organizations で見る', async () => {
    const person = await visitor();
    const organization = await createOrganization();
    await person.join(organization, { is_admin: 1 });
    expect(await hasLoginAccess(env, person.who)).toBe(true);
    const db = commonDb(env);
    await db.batch([
      db.statement((q) => q.updateTable('organizations').set({ suspended_at: AT }).where('id', '=', organization.id)),
    ]);
    expect(await hasLoginAccess(env, person.who)).toBe(false);
  });

  test('停止した組織に入れたはずの人は、停止した組織を一覧に出さず、suspended だけを返す。入れたはずでない人には返さない', async () => {
    const admin = await visitor();
    await admin.join(await createOrganization({ suspended_at: AT }), { is_admin: 1 });
    expect(await listAccountOrganizations(env, admin.who)).toEqual({
      organizations: [],
      invitations: [],
      suspended: true,
    });
    expect(await readLoginAccess(env, admin.who)).toEqual({ allowed: false, suspended: true });

    const invited = await visitor();
    const { organization, workspace, owner } = await organizationWithOwner();
    await createInvitation(organization, workspace.id, owner.id, invited.identity);
    const db = commonDb(env);
    await db.batch([
      db.statement((q) => q.updateTable('organizations').set({ suspended_at: AT }).where('id', '=', organization.id)),
    ]);
    expect(await readLoginAccess(env, invited.who)).toEqual({ allowed: false, suspended: true });

    // 停止した組織で無効にされた人は、停止していなければ入れた人ではない
    const disabled = await visitor();
    await disabled.join(await createOrganization({ suspended_at: AT }), { is_admin: 1, disabled_at: AT });
    expect(await readLoginAccess(env, disabled.who)).toEqual({ allowed: false, suspended: false });

    // 停止していない組織にも入れる人は、通して suspended も知らせる（使うのは通らなかったときだけ）
    const both = await visitor();
    await both.join(await createOrganization({ suspended_at: AT }), { is_admin: 1 });
    await both.join(await createOrganization(), { is_admin: 1 });
    expect((await readLoginAccess(env, both.who)).allowed).toBe(true);
    expect((await listAccountOrganizations(env, both.who)).organizations).toHaveLength(1);
  });
});

describe('指名で待っていた行を結ぶ', () => {
  const waiting = async () => {
    const organization = await createOrganization();
    const account = await createAccount();
    const login = await createAccountLogin(account.id);
    return { organization, account, login };
  };
  const loginOf = (login: { login_provider: string; login_subject: string }) => ({
    provider: login.login_provider,
    subject: login.login_subject,
  });

  test('結ぶ行が無いときは、書き込みを送らない', async () => {
    const { account, login } = await waiting();
    // users への書き込みを含む batch() が失敗する D1。送っていれば落ちる
    await expect(
      linkLoginToAccount(failUserWrites(env), account.id, loginOf(login), new Date()),
    ).resolves.toBeUndefined();
  });

  test('結ぶ行があるときは、書き込みを送って結ぶ', async () => {
    const { organization, account, login } = await waiting();
    await createUser(organization, {
      account_id: null,
      login_provider: login.login_provider,
      login_subject: login.login_subject,
      is_admin: 1,
    });
    await expect(linkLoginToAccount(failUserWrites(env), account.id, loginOf(login), new Date())).rejects.toThrow();
    await linkLoginToAccount(env, account.id, loginOf(login), new Date());
    // 結んだ行は当たらなくなり、もう一度流しても書かない
    await expect(
      linkLoginToAccount(failUserWrites(env), account.id, loginOf(login), new Date()),
    ).resolves.toBeUndefined();
  });
});
