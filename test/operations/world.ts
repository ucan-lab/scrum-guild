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

// 運用者の一覧。Person.operator が持つログインの ID はこの先頭
export const OPERATOR_LOGIN_ID = 'github:9000000000000001';

export const testEnv: Env = Object.assign({}, baseEnv, { OPERATOR_LOGIN_IDS: `${OPERATOR_LOGIN_ID},google:424242` });

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
