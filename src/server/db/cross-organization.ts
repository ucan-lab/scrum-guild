// 組織をまたいで読む処理の置き場所（docs/data-model.md の「読み書きの入口」）。1つの関数にまとめ、
// 組織を分けるときはここだけを直す。当たるのは、ログインできるか（入れる組織と届いた招待があるか）、ログインの直後の組織の選択、
// 届いた招待の一覧、初めてのログインで users.account_id を埋めること、招待の URL の秘密のハッシュから待っている指名と招待を引くこと。
// 今あるのは、組織の選択と届いた招待の一覧、ログインできるか、users.account_id を埋めること。残りは #58 で足す。
// ログインできるか（hasLoginAccess）は、組織の選択と同じ読み取り（readAccountOrganizations）を使う。判定の元を1つにするため
import { commonDb, crossOrganizationEntries } from './entries.ts';
import type { LoginId } from './enter-organization.ts';
import { MAX_BOUND_PARAMETERS } from './send.ts';

// 入れる組織と、承諾待ちの招待がある組織。入れる組織は管理者か、いずれかのワークスペースに今所属する組織。
// 招待は入れる組織の分も含める（届いた招待はすべての組織の分をまとめて出す）。招待は組織の名前しか持たない
export type AccountOrganizations = {
  readonly organizations: readonly { readonly slug: string; readonly name: string }[];
  readonly invitations: readonly { readonly organization_name: string }[];
};

type Account = { accountId: string; logins: readonly LoginId[] };
// 読み取りの対象。accountId はアカウントがまだ無い（初めてのログイン）ときは undefined。
// includeUnlinked は、アカウントに結ばれる前の行（account_id が空で、手段と ID が一致する、指名で待っていた行）を、
// この人の行として数える。ログインのたびに結び直す行なので、ログインできるかには数え、組織の選択には数えない
// （enterOrganization は account_id で引くので、結ばれるまでその組織には入れない）
type Reading = { accountId: string | undefined; logins: readonly LoginId[]; includeUnlinked: boolean };
type OrganizationEntry = ReturnType<typeof crossOrganizationEntries>[number];

function chunksOf<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let start = 0; start < items.length; start += size) chunks.push(items.slice(start, start + size));
  return chunks;
}

// 手段と ID の一致で users_login（login_provider, login_subject）の索引に乗せ、account_id の一致はその上の絞り込みにする。
// 手段と ID の組ごとに1文にする（OR でつなぐと、索引を使わず全件を読む計画になることがある）。
// 引くのは、このアカウントの行（無効にされた行を含む）と、手段と ID が一致する無効にされた行（アカウントに結ばれる前の行を含む）
export function usersStatement(
  db: OrganizationEntry,
  accountId: string | undefined,
  login: LoginId,
  includeUnlinked: boolean = false,
) {
  return db.statement((q) =>
    q
      .selectFrom('users')
      .select(['id', 'organization_id', 'account_id', 'is_admin', 'disabled_at'])
      .where('login_provider', '=', login.provider)
      .where('login_subject', '=', login.subject)
      .where((eb) =>
        eb.or([
          ...(accountId === undefined ? [] : [eb('account_id', '=', accountId)]),
          ...(includeUnlinked ? [eb('account_id', 'is', null)] : []),
          eb('disabled_at', 'is not', null),
        ]),
      ),
  );
}

// ユーザーの今の所属。memberships_user_current（user_id、left_at が空）の索引に乗せる
export function membershipsStatement(db: OrganizationEntry, userIds: readonly string[]) {
  return db.statement((q) =>
    q
      .selectFrom('memberships as m')
      .innerJoin('workspaces as w', 'w.id', 'm.workspace_id')
      .select(['m.user_id', 'w.organization_id'])
      .where('m.user_id', 'in', userIds)
      .where('m.left_at', 'is', null),
  );
}

// 承諾待ちの招待がある組織。invitations_login_pending（手段と ID、status が pending）の索引に乗せる
export function invitationsStatement(db: OrganizationEntry, login: LoginId) {
  return db.statement((q) =>
    q
      .selectFrom('invitations as i')
      .innerJoin('workspaces as w', 'w.id', 'i.workspace_id')
      .select('w.organization_id')
      .distinct()
      .where('i.status', '=', 'pending')
      .where('i.login_provider', '=', login.provider)
      .where('i.login_subject', '=', login.subject),
  );
}

// 停止した組織は含めない。無効にされた人の扱いは enterOrganization と同じにする。
// - このアカウントの行が無効なら、入れず、招待も出さない
// - 管理者の行か今の所属があれば入れる。そのとき、手段と ID が一致する別の無効な行は見ない
// - 入れない組織の招待は、手段と ID が一致する無効な行があれば出さない
// 共通の表と組織の中の表は別の問い合わせで引き、アプリで合わせる。組織の中の表は、組織を分けたときは DB ごとに引く。
//
// この関数が前提にする不変条件（docs/data-model.md の「読み書きの入口」）:
// - アカウントは必ず1つ以上のログインを持つ。0件なら users の行を引き当てる手がかりが無いので、空を返す。
// - users の行のログイン（login_provider、login_subject）は、結んだアカウントのログインのどれかである。
// ログインの付け替えや統合を入れるときは、この関数を直す（enterOrganization は account_id で引くので、ずれが出る）
export function listAccountOrganizations(env: Env, account: Account): Promise<AccountOrganizations> {
  return listAccountOrganizationsIn(env, account, crossOrganizationEntries(env));
}

// 組織の中の表を持つ DB ごとの入口を受け取る本体。index.ts は出さない。DB を複数にした場合を、テストが testing.ts から確かめる
export function listAccountOrganizationsIn(
  env: Env,
  account: Account,
  entries: readonly OrganizationEntry[],
): Promise<AccountOrganizations> {
  return readAccountOrganizations(env, { ...account, includeUnlinked: false }, entries);
}

// ログインできるか: 入れる組織か、承諾待ちの招待が、停止していない組織に1つでもあるか。
// 組織の選択と同じ読み取りを通し、アカウントに結ばれる前の行も数える。accountId は初めてのログインなら undefined。
// 運用者の例外（入れる組織が無くてもログインできる）は呼び出し側が先に見る
export async function hasLoginAccess(
  env: Env,
  who: { accountId: string | undefined; logins: readonly LoginId[] },
): Promise<boolean> {
  const { organizations, invitations } = await readAccountOrganizations(
    env,
    { ...who, includeUnlinked: true },
    crossOrganizationEntries(env),
  );
  return organizations.length > 0 || invitations.length > 0;
}

async function readAccountOrganizations(
  env: Env,
  account: Reading,
  entries: readonly OrganizationEntry[],
): Promise<AccountOrganizations> {
  if (account.logins.length === 0) return { organizations: [], invitations: [] };

  const enterable = new Set<string>();
  // 入れず、招待も出さない組織
  const blocked = new Set<string>();
  // 手段と ID が一致する無効な行がある組織
  const loginDisabled = new Set<string>();
  const invited = new Set<string>();

  for (const db of entries) {
    const userRows = (
      await Promise.all(
        account.logins.map((login) => db.rows(usersStatement(db, account.accountId, login, account.includeUnlinked))),
      )
    ).flat();
    // 管理者でなく、所属を確かめる行（ユーザーの ID と組織の ID）
    const memberCandidates = new Map<string, string>();
    for (const row of userRows) {
      if (row.disabled_at !== null) loginDisabled.add(row.organization_id);
      const mine = row.account_id === account.accountId || (account.includeUnlinked && row.account_id === null);
      if (!mine) continue;
      if (row.disabled_at !== null) blocked.add(row.organization_id);
      else if (row.is_admin === 1) enterable.add(row.organization_id);
      else memberCandidates.set(row.id, row.organization_id);
    }

    for (const userIds of chunksOf([...memberCandidates.keys()], MAX_BOUND_PARAMETERS)) {
      const memberRows = await db.rows(membershipsStatement(db, userIds));
      for (const row of memberRows) {
        // 別の組織のワークスペースを指す所属は、その人の組織の所属に数えない
        if (memberCandidates.get(row.user_id) === row.organization_id) enterable.add(row.organization_id);
      }
    }

    const invitationRows = await Promise.all(account.logins.map((login) => db.rows(invitationsStatement(db, login))));
    for (const row of invitationRows.flat()) invited.add(row.organization_id);
  }

  const invitedShown = [...invited].filter((id) => enterable.has(id) || (!blocked.has(id) && !loginDisabled.has(id)));
  const ids = [...new Set([...enterable, ...invitedShown])];

  const common = commonDb(env);
  const rows = [];
  for (const chunk of chunksOf(ids, MAX_BOUND_PARAMETERS)) {
    rows.push(
      ...(await common.rows(
        common.statement((q) =>
          q
            .selectFrom('organizations')
            .select(['id', 'slug', 'name'])
            .where('id', 'in', chunk)
            .where('suspended_at', 'is', null),
        ),
      )),
    );
  }
  rows.sort((a, b) => (a.name === b.name ? (a.slug < b.slug ? -1 : 1) : a.name < b.name ? -1 : 1));

  const shown = new Set(invitedShown);
  return {
    organizations: rows.filter((row) => enterable.has(row.id)).map(({ slug, name }) => ({ slug, name })),
    invitations: rows.filter((row) => shown.has(row.id)).map((row) => ({ organization_name: row.name })),
  };
}

// 指名で待っていた users の行（account_id が空で、ログインの手段と ID が同じ）にアカウントを結ぶ。
// ログインのたびに流し、何度流しても同じ結果になる（結んだ行は account_id が空でなくなり、当たらない）。
// 結ぶ行を先に読み、当たったときだけ書く（空振りのログインで組織の DB に書かない）。
// 共通の表への書き込みとは別の batch() で書く。失敗したら呼び出し側がセッションを作らず、次のログインで結ばれる
export async function linkLoginToAccount(env: Env, accountId: string, login: LoginId, now: Date): Promise<void> {
  for (const db of crossOrganizationEntries(env)) {
    const waiting = await db.first(
      db.statement((q) =>
        q
          .selectFrom('users')
          .select('id')
          .where('login_provider', '=', login.provider)
          .where('login_subject', '=', login.subject)
          .where('account_id', 'is', null)
          .limit(1),
      ),
    );
    if (waiting === undefined) continue;
    // 読んでから書くまでに別のログインが結んだ行は、account_id が空の条件で外れる
    await db.batch([
      db.statement((q) =>
        q
          .updateTable('users')
          .set({ account_id: accountId, updated_at: now.toISOString() })
          .where('account_id', 'is', null)
          .where('login_provider', '=', login.provider)
          .where('login_subject', '=', login.subject),
      ),
    ]);
  }
}
