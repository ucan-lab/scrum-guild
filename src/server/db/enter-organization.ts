// 組織に入れるかの判定と、ワークスペースが組織のものかの判定（docs/requirements.md の「メンバーと権限」）。
// リクエストのたびに行う。共通の表（organizations）と組織の中の表（users、memberships、invitations）は別の問い合わせで引き、
// 1つの SQL で結合しない（docs/data-model.md の「データベースの分け方」）
import { commonDb, orgDb, type OrganizationDb } from './entries.ts';
import { issueVerifiedOrganization } from './verify-organization.ts';
import { issueVerifiedWorkspace, type VerifiedWorkspace, type WorkspaceRole } from './verify-workspace.ts';

// アカウントに結んだログインの手段と、手段の中の ID。承諾待ちの招待はこれで突き合わせる
export type LoginId = { readonly provider: string; readonly subject: string };

export type OrganizationActor = {
  readonly accountId: string;
  // この組織の users の行の ID。承諾待ちの招待だけで入った人は行を持たないので null
  readonly userId: string | null;
  readonly isAdmin: boolean;
};

export type OrganizationEntry = { readonly db: OrganizationDb; readonly actor: OrganizationActor };

// 組織を引けない、停止している、入れない、のどれでも undefined を返す。呼び出し側はどれも同じ 404 にする
export async function enterOrganization(
  env: Env,
  slug: string,
  account: { accountId: string; logins: readonly LoginId[] },
): Promise<OrganizationEntry | undefined> {
  const common = commonDb(env);
  const organization = await common.first(
    common.statement((q) => q.selectFrom('organizations').select(['id', 'suspended_at']).where('slug', '=', slug)),
  );
  if (organization === undefined || organization.suspended_at !== null) return undefined;

  // 組織の中の表を引くための入口。判定に通るまで、この入口は呼び出し側へ渡さない
  const db = orgDb(env, issueVerifiedOrganization(organization.id));
  const organizationId = db.organizationId;

  // users は account_id で引く。ログインのたびに account_id が空の行を埋めるので、結ばれていない行は入れないものとして扱う
  const user = await db.first(
    db.statement((q) =>
      q
        .selectFrom('users')
        .select(['id', 'is_admin', 'disabled_at'])
        .where('organization_id', '=', organizationId)
        .where('account_id', '=', account.accountId),
    ),
  );
  // 無効にされた人は、管理者でも所属や招待があっても入れない
  if (user !== undefined && user.disabled_at !== null) return undefined;

  const actor = (isAdmin: boolean): OrganizationEntry => ({
    db,
    actor: { accountId: account.accountId, userId: user?.id ?? null, isAdmin },
  });

  if (user !== undefined && user.is_admin === 1) return actor(true);

  if (user !== undefined) {
    const membership = await db.first(
      db.statement((q) =>
        q
          .selectFrom('memberships as m')
          .innerJoin('workspaces as w', 'w.id', 'm.workspace_id')
          .select('m.id')
          .where('w.organization_id', '=', organizationId)
          .where('m.user_id', '=', user.id)
          .where('m.left_at', 'is', null)
          .limit(1),
      ),
    );
    if (membership !== undefined) return actor(false);
  }

  if (account.logins.length === 0) return undefined;
  const invitation = await db.first(
    db.statement((q) =>
      q
        .selectFrom('invitations as i')
        .innerJoin('workspaces as w', 'w.id', 'i.workspace_id')
        .select('i.id')
        .where('w.organization_id', '=', organizationId)
        .where('i.status', '=', 'pending')
        .where((eb) =>
          eb.or(
            account.logins.map((login) =>
              eb.and([eb('i.login_provider', '=', login.provider), eb('i.login_subject', '=', login.subject)]),
            ),
          ),
        )
        .limit(1),
    ),
  );
  return invitation === undefined ? undefined : actor(false);
}

// ワークスペースが、入口の組織のものであることを確かめる。別の組織のものと存在しないものは、どちらも undefined
export async function verifyWorkspace(
  db: OrganizationDb,
  actor: OrganizationActor,
  workspaceId: string,
): Promise<VerifiedWorkspace | undefined> {
  const organizationId = db.organizationId;
  const workspace = await db.first(
    db.statement((q) =>
      q
        .selectFrom('workspaces')
        .select('id')
        .where('id', '=', workspaceId)
        .where('organization_id', '=', organizationId),
    ),
  );
  if (workspace === undefined) return undefined;

  let role: WorkspaceRole = null;
  if (actor.userId !== null) {
    const userId = actor.userId;
    const membership = await db.first(
      db.statement((q) =>
        q
          .selectFrom('memberships')
          .select('role')
          .where('workspace_id', '=', workspace.id)
          .where('user_id', '=', userId)
          .where('left_at', 'is', null),
      ),
    );
    if (membership !== undefined) role = membership.role === 'leader' ? 'leader' : 'member';
  }
  return issueVerifiedWorkspace(organizationId, workspace.id, role);
}
