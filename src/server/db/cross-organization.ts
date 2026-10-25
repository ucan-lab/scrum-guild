// 組織をまたいで読む処理の置き場所（docs/data-model.md の「読み書きの入口」）。1つの関数にまとめ、
// 組織を分けるときはここだけを直す。当たるのは、ログインできるか（入れる組織と届いた招待があるか）、ログインの直後の組織の選択、
// 届いた招待の一覧、初めてのログインで users.account_id を埋めること、招待の URL の秘密のハッシュから待っている指名と招待を引くこと。
// 今あるのは組織の選択と届いた招待の一覧。残りは #52 と #58 で足す
import { commonDb, crossOrganizationEntries } from './entries.ts';
import type { LoginId } from './enter-organization.ts';

// 入れる組織と、承諾待ちの招待だけがある組織。入れる組織は管理者か、いずれかのワークスペースに今所属する組織。
// 招待だけの組織は組織の名前しか持たない（その組織の中を読ませないため）
export type AccountOrganizations = {
  readonly organizations: readonly { readonly slug: string; readonly name: string }[];
  readonly invitations: readonly { readonly organization_name: string }[];
};

// 停止した組織、無効にされた組織は含めない（enterOrganization と同じ条件）。
// 共通の表と組織の中の表は別の問い合わせで引き、アプリで合わせる。組織の中の表は、組織を分けたときは DB ごとに引く
export async function listAccountOrganizations(
  env: Env,
  account: { accountId: string; logins: readonly LoginId[] },
): Promise<AccountOrganizations> {
  const admins = new Set<string>();
  const users = new Set<string>();
  const members = new Set<string>();
  const disabled = new Set<string>();
  const invited = new Set<string>();

  for (const db of crossOrganizationEntries(env)) {
    const userRows = await db.rows(
      db.statement((q) =>
        q
          .selectFrom('users')
          .select(['organization_id', 'account_id', 'is_admin', 'disabled_at'])
          .where((eb) =>
            eb.or([
              eb('account_id', '=', account.accountId),
              // アカウントに結ばれる前に無効にされた行も、手段と ID で突き合わせて止める
              ...(account.logins.length === 0
                ? []
                : [
                    eb.and([
                      eb('disabled_at', 'is not', null),
                      eb.or(
                        account.logins.map((login) =>
                          eb.and([eb('login_provider', '=', login.provider), eb('login_subject', '=', login.subject)]),
                        ),
                      ),
                    ]),
                  ]),
            ]),
          ),
      ),
    );
    for (const row of userRows) {
      if (row.disabled_at !== null) disabled.add(row.organization_id);
      else if (row.account_id === account.accountId) {
        users.add(row.organization_id);
        if (row.is_admin === 1) admins.add(row.organization_id);
      }
    }

    const memberRows = await db.rows(
      db.statement((q) =>
        q
          .selectFrom('memberships as m')
          .innerJoin('users as u', 'u.id', 'm.user_id')
          .innerJoin('workspaces as w', 'w.id', 'm.workspace_id')
          .select('u.organization_id')
          .distinct()
          .where('u.account_id', '=', account.accountId)
          .whereRef('w.organization_id', '=', 'u.organization_id')
          .where('m.left_at', 'is', null),
      ),
    );
    for (const row of memberRows) members.add(row.organization_id);

    if (account.logins.length > 0) {
      const invitationRows = await db.rows(
        db.statement((q) =>
          q
            .selectFrom('invitations as i')
            .innerJoin('workspaces as w', 'w.id', 'i.workspace_id')
            .select('w.organization_id')
            .distinct()
            .where('i.status', '=', 'pending')
            .where((eb) =>
              eb.or(
                account.logins.map((login) =>
                  eb.and([eb('i.login_provider', '=', login.provider), eb('i.login_subject', '=', login.subject)]),
                ),
              ),
            ),
        ),
      );
      for (const row of invitationRows) invited.add(row.organization_id);
    }
  }

  const enterable = new Set([...users].filter((id) => !disabled.has(id) && (admins.has(id) || members.has(id))));
  const invitedOnly = new Set([...invited].filter((id) => !disabled.has(id) && !enterable.has(id)));
  const ids = [...enterable, ...invitedOnly];
  if (ids.length === 0) return { organizations: [], invitations: [] };

  const common = commonDb(env);
  const rows = await common.rows(
    common.statement((q) =>
      q
        .selectFrom('organizations')
        .select(['id', 'slug', 'name'])
        .where('id', 'in', ids)
        .where('suspended_at', 'is', null)
        .orderBy('name')
        .orderBy('slug'),
    ),
  );
  return {
    organizations: rows.filter((row) => enterable.has(row.id)).map(({ slug, name }) => ({ slug, name })),
    invitations: rows.filter((row) => invitedOnly.has(row.id)).map((row) => ({ organization_name: row.name })),
  };
}
