// 組織に入れるかの判定と、ワークスペースが組織のものかの判定（docs/requirements.md の「メンバーと権限」）。
// リクエストのたびに行う。共通の表（organizations）と組織の中の表（users、memberships、invitations）は別の問い合わせで引き、
// 1つの SQL で結合しない（docs/data-model.md の「データベースの分け方」）
import type { Theme } from '../../shared/theme.ts';
import type { Vocabulary } from '../../shared/vocabulary.ts';
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

// 組織の行（共通の表）のうち、処理が読むもの。処理に共通の入口を渡さず、入るときに引いた値を渡す
export type OrganizationSummary = {
  readonly slug: string;
  readonly name: string;
  readonly vocabulary: Vocabulary;
  readonly theme: Theme;
};

export type OrganizationEntry = {
  readonly db: OrganizationDb;
  readonly actor: OrganizationActor;
  readonly organization: OrganizationSummary;
};

// 停止した組織の結果。停止していなければ入れた人にだけ返す（組織の中の入口は渡さない。ログに残す組織の ID だけを持つ）。
// 呼び出し側は 403 の organization_suspended にする
export type SuspendedOrganization = { readonly suspended: true; readonly organizationId: string };

export type EnteredOrganization = OrganizationEntry | SuspendedOrganization | undefined;

export function isSuspendedOrganization(entered: EnteredOrganization): entered is SuspendedOrganization {
  return entered !== undefined && 'suspended' in entered;
}

// 組織を引けない、入れないは undefined を返す。呼び出し側はどちらも同じ 404 にする（組織があることを外に漏らさない）。
// 停止した組織は、停止していなければ入れた人（無効でない管理者、今の所属、承諾待ちの招待。停止していない組織と同じ判定）には
// SuspendedOrganization を返し、入れない人には undefined を返す。
// loadLogins は招待で入る分岐に来たときだけ呼ぶ（管理者と所属のある人には要らないので、引かない）
export async function enterOrganization(
  env: Env,
  slug: string,
  account: { accountId: string; loadLogins: () => Promise<readonly LoginId[]> },
): Promise<EnteredOrganization> {
  const common = commonDb(env);
  const organization = await common.first(
    common.statement((q) =>
      q
        .selectFrom('organizations')
        .select(['id', 'suspended_at', 'slug', 'name', 'vocabulary', 'theme'])
        .where('slug', '=', slug),
    ),
  );
  if (organization === undefined) return undefined;
  const suspended = organization.suspended_at !== null;

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

  // 入れる人と決まったところで、停止していれば入口を渡さずに停止を知らせる
  const entry = (isAdmin: boolean, invitedOnly: boolean): OrganizationEntry | SuspendedOrganization =>
    suspended
      ? { suspended: true, organizationId }
      : {
          db,
          actor: { accountId: account.accountId, userId: user?.id ?? null, isAdmin, invitedOnly },
          organization: {
            slug: organization.slug,
            name: organization.name,
            // 列の CHECK が守る値。列挙に無い値が来ても、操作の出力のスキーマ（z.enum）が 500 で止める
            vocabulary: organization.vocabulary as Vocabulary,
            theme: organization.theme as Theme,
          },
        };

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
