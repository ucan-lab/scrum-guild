// 操作のテストが使う人と組織。ファクトリーを通して必要な行だけを作る
import { env as baseEnv } from 'cloudflare:workers';
import {
  createAccount,
  createAccountLogin,
  createInvitation,
  createMembership,
  createOrganization,
  createSessionWithToken,
  createUser,
  createWorkspace,
  type OrganizationFixture,
} from '../factories.ts';
import { FAKE_CLIENT_ID, FAKE_CLIENT_SECRET } from '../auth/fake-github.ts';

// 運用者の一覧。Person.operator が持つログインの ID はこの先頭
export const OPERATOR_LOGIN_ID = 'github:9000000000000001';

// GitHub の資格情報は差し替えた GitHub（test/auth/fake-github.ts）に合わせた架空の値。運用者の操作が GitHub のユーザー名を解決する
export const testEnv: Env = Object.assign({}, baseEnv, {
  OPERATOR_LOGIN_IDS: `${OPERATOR_LOGIN_ID},google:424242`,
  GITHUB_CLIENT_ID: FAKE_CLIENT_ID,
  GITHUB_CLIENT_SECRET: FAKE_CLIENT_SECRET,
});

export type Person = {
  accountId: string;
  // この組織の users の ID。組織に属さない人は null
  userId: string | null;
  token: string;
  login: { provider: string; subject: string };
};

export type WorkspaceRoleName = 'leader' | 'member';

export async function createPerson(
  options: {
    organization?: OrganizationFixture;
    admin?: boolean;
    disabled?: boolean;
    login?: { provider: string; subject: string };
    // 今所属するワークスペースとロール
    membership?: { workspaceId: string; role: WorkspaceRoleName };
    sessionOverrides?: Parameters<typeof createSessionWithToken>[1];
  } = {},
): Promise<Person> {
  const account = await createAccount();
  const login = await createAccountLogin(
    account.id,
    options.login && {
      login_provider: options.login.provider,
      login_subject: options.login.subject,
    },
  );
  const { token } = await createSessionWithToken(account.id, options.sessionOverrides);
  let userId: string | null = null;
  if (options.organization !== undefined) {
    const user = await createUser(options.organization, {
      account_id: account.id,
      login_provider: login.login_provider,
      login_subject: login.login_subject,
      is_admin: options.admin ? 1 : 0,
      disabled_at: options.disabled ? '2026-10-21T00:00:00.000Z' : null,
    });
    userId = user.id;
    if (options.membership !== undefined) {
      await createMembership(options.organization, options.membership.workspaceId, user.id, {
        role: options.membership.role,
      });
    }
  }
  return {
    accountId: account.id,
    userId,
    token,
    login: { provider: login.login_provider, subject: login.login_subject },
  };
}

// ほかの組織の管理者でもある人にする。ある組織に入れない人の結果を、どの組織にも入れなくなった人の 401 と
// 区別して見るために使う（セッションは、ログインできる条件を失うと消える）
export async function admitElsewhere(person: Person): Promise<Person> {
  const elsewhere = await createOrganization();
  await createUser(elsewhere, {
    account_id: person.accountId,
    login_provider: person.login.provider,
    login_subject: person.login.subject,
    is_admin: 1,
  });
  return person;
}

// ログインできる人（どこかの組織の管理者）。組織の外の操作（permission: login）の呼び出しに使う
export async function createLoginPerson(
  options: { sessionOverrides?: Parameters<typeof createSessionWithToken>[1] } = {},
): Promise<Person> {
  return createPerson({ organization: await createOrganization(), admin: true, ...options });
}

// 同じ人の新しいセッション。セッションを消す操作（ログアウト）を一覧から回すとき、ほかの操作のテストが
// 同じ人のセッションを使えなくならないよう、操作ごとに別のセッションを持たせる
export async function withNewSession(person: Person): Promise<Person> {
  const { token } = await createSessionWithToken(person.accountId);
  return { ...person, token };
}

// どの組織にも属さない運用者。ファイルごとに1人（ログインの ID は一意）
let operator: Promise<Person> | undefined;
export function getOperator(): Promise<Person> {
  operator ??= createPerson({ login: { provider: 'github', subject: OPERATOR_LOGIN_ID.split(':')[1]! } });
  return operator;
}

// 組織1つと、その中の人とワークスペース。組織の分離のテストでは、2つ作って片方を相手にする
export type Target = {
  organization: OrganizationFixture;
  slug: string;
  workspace: { id: string };
  // 別のワークスペース。bystander だけが所属する
  otherWorkspace: { id: string };
  admin: Person;
  leader: Person;
  member: Person;
  // 組織には入れるが、workspace には所属しない人
  bystander: Person;
  // 承諾待ちの招待だけを持つ人（users の行を持たない）
  invitee: Person;
};

export async function createTarget(options: { closed?: boolean } = {}): Promise<Target> {
  const organization = await createOrganization();
  const admin = await createPerson({ organization, admin: true });
  const workspace = await createWorkspace(organization, admin.userId!, {
    closed_at: options.closed ? '2026-10-22T00:00:00.000Z' : null,
  });
  const otherWorkspace = await createWorkspace(organization, admin.userId!);
  const leader = await createPerson({ organization, membership: { workspaceId: workspace.id, role: 'leader' } });
  const member = await createPerson({ organization, membership: { workspaceId: workspace.id, role: 'member' } });
  const bystander = await createPerson({
    organization,
    membership: { workspaceId: otherWorkspace.id, role: 'member' },
  });
  const invitee = await createPerson();
  await createInvitation(organization, workspace.id, admin.userId!, invitee.login);
  return {
    organization,
    slug: organization.slug,
    workspace,
    otherWorkspace,
    admin,
    leader,
    member,
    bystander,
    invitee,
  };
}
