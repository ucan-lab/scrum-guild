// 組織に入れるかの判定と、ワークスペースが組織のものかの判定（docs/requirements.md の「メンバーと権限」）。
// リクエストのたびに行う。共通の表（organizations）と組織の中の表（users、memberships、invitations）は別の問い合わせで引き、
// 1つの SQL で結合しない（docs/data-model.md の「データベースの分け方」）
import { commonDb, orgDb, type OrganizationDb } from './entries.ts';
import { issueVerifiedOrganization } from './verify-organization.ts';
import { issueVerifiedWorkspace, type VerifiedWorkspace, type WorkspaceRole } from './verify-workspace.ts';

// アカウントに結んだログインの手段と、手段の中の ID。承諾待ちの招待と、無効にされた人の行はこれで突き合わせる
export type LoginId = { readonly provider: string; readonly subject: string };

export type OrganizationActor = {
  readonly accountId: string;
  // この組織の users の行の ID。承諾待ちの招待だけで入った人は行を持たないので null
  readonly userId: string | null;
  readonly isAdmin: boolean;
  // 承諾待ちの招待だけで入った人（管理者でも、いずれかのワークスペースに今所属している人でもない）。
  // 組織の中を読む操作には通さず、招待の一覧、承諾、辞退（invitee の権限）だけに通す
  readonly invitedOnly: boolean;
};

export type OrganizationEntry = { readonly db: OrganizationDb; readonly actor: OrganizationActor };

// 組織を引けない、停止している、入れない、のどれでも undefined を返す。呼び出し側はどれも同じ 404 にする。
// loadLogins は招待で入る分岐に来たときだけ呼ぶ（管理者と所属のある人には要らないので、引かない）
export async function enterOrganization(
  env: Env,
  slug: string,
  account: { accountId: string; loadLogins: () => Promise<readonly LoginId[]> },
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

  const entry = (isAdmin: boolean, invitedOnly: boolean): OrganizationEntry => ({
    db,
    actor: { accountId: account.accountId, userId: user?.id ?? null, isAdmin, invitedOnly },
  });

  if (user !== undefined && user.is_admin === 1) return entry(true, false);

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
    if (membership !== undefined) return entry(false, false);
  }

  const logins = await account.loadLogins();
  if (logins.length === 0) return undefined;

  // 招待は手段と ID に結ぶので、アカウントが結ばれる前に無効にされた行（account_id が空）も、手段と ID で突き合わせて止める
  const disabledByLogin = await db.first(
    db.statement((q) =>
      q
        .selectFrom('users')
        .select('id')
        .where('organization_id', '=', organizationId)
        .where('disabled_at', 'is not', null)
        .where((eb) =>
          eb.or(
            logins.map((login) =>
              eb.and([eb('login_provider', '=', login.provider), eb('login_subject', '=', login.subject)]),
            ),
          ),
        )
        .limit(1),
    ),
  );
  if (disabledByLogin !== undefined) return undefined;

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
            logins.map((login) =>
              eb.and([eb('i.login_provider', '=', login.provider), eb('i.login_subject', '=', login.subject)]),
            ),
          ),
        )
        .limit(1),
    ),
  );
  return invitation === undefined ? undefined : entry(false, true);
}

// ワークスペースが、入口の組織のものであることを確かめる。別の組織のものと存在しないものは、どちらも undefined。
// ワークスペースと、その人の今の所属は、どちらも組織の中の表なので1つの問い合わせで引く
export async function verifyWorkspace(
  db: OrganizationDb,
  actor: OrganizationActor,
  workspaceId: string,
): Promise<VerifiedWorkspace | undefined> {
  // users の行を持たない人はワークスペースの下の操作に通らない
  if (actor.userId === null) return undefined;
  const userId = actor.userId;
  const organizationId = db.organizationId;
  const row = await db.first(
    db.statement((q) =>
      q
        .selectFrom('workspaces as w')
        .leftJoin('memberships as m', (join) =>
          join.onRef('m.workspace_id', '=', 'w.id').on('m.user_id', '=', userId).on('m.left_at', 'is', null),
        )
        .select(['w.id', 'w.closed_at', 'm.role'])
        .where('w.id', '=', workspaceId)
        .where('w.organization_id', '=', organizationId),
    ),
  );
  if (row === undefined) return undefined;

  const role: WorkspaceRole = row.role === null ? null : row.role === 'leader' ? 'leader' : 'member';
  return issueVerifiedWorkspace(organizationId, row.id, role, row.closed_at !== null);
}
