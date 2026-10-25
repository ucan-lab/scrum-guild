// 組織をまたいで読む処理の置き場所（docs/data-model.md の「読み書きの入口」）。1つの関数にまとめ、
// 組織を分けるときはここだけを直す。当たるのは、ログインできるか（入れる組織と届いた招待があるか）、ログインの直後の組織の選択、
// 届いた招待の一覧、初めてのログインで users.account_id を埋めること、招待の URL の秘密のハッシュから待っている指名と招待を引くこと。
// 今あるのは、組織の選択と届いた招待の一覧、ログインできるか、users.account_id を埋めること、運用者の一覧の管理者の状態、
// 招待の URL の秘密のハッシュから待っている指名と招待を引いて結ぶこと（claimPendingLogin）。
// ログインできるか（hasLoginAccess）は、組織の選択と同じ読み取り（readAccountOrganizations）を使う。判定の元を1つにするため。
// 使うのはログインのとき（login.ts）だけで、アカウントに結ばれる前の指名の行も数える。セッションの判定（register.ts）は、
// 組織の選択と同じ結果（結ばれる前の行を数えない）を使う。結ばれる前の行だけを持つ人のセッションを、結べないまま残さないため
//
// 書き込みは linkLoginToAccount と claimPendingLogin だけ。
//   - linkLoginToAccount: 組織で絞らずに users.account_id と updated_at を書く、この関数だけの例外
//     （組織の中の入口は organizationId で絞るが、これは組織をまたぐ入口で、ログインの手段と ID と account_id が空であることで絞る）。
//     1つのアカウントに複数のログインを結ぶとき（#57）は、同じ組織に同じアカウントの行が2つできて、users_organization_account
//     （organization_id と account_id の一意）に当たりうる。そのとき、この UPDATE を見直す
//   - claimPendingLogin: 招待の URL の秘密のハッシュで引いた1行の組織の ID（と、招待ならその組織のワークスペース）で絞って書く
import { sql, type Expression, type ExpressionBuilder, type SqlBool } from 'kysely';
import { WAITING_USER_NAME_IN_LOG } from '../../shared/claim-token.ts';
import type { AdminStatus } from '../../shared/operations/operator/list-organizations.ts';
import { uuidv7 } from '../uuid.ts';
import { commonDb, crossOrganizationEntries } from './entries.ts';
import type { LoginId } from './enter-organization.ts';
import { MAX_BOUND_PARAMETERS } from './send.ts';
import type { OrganizationTables } from './tables.ts';

// 入れる組織と、承諾待ちの招待がある組織。入れる組織は管理者か、いずれかのワークスペースに今所属する組織。
// 招待は入れる組織の分も含める（届いた招待はすべての組織の分をまとめて出す）。招待は組織の名前しか持たない
export type AccountOrganizations = {
  readonly organizations: readonly { readonly slug: string; readonly name: string }[];
  readonly invitations: readonly { readonly organization_name: string }[];
};

type Account = { accountId: string; logins: readonly LoginId[] };
// 読み取りの対象。accountId はアカウントがまだ無い（初めてのログイン）ときは undefined。
// includeUnlinked は、アカウントに結ばれる前の行（account_id が空で、手段と ID が一致する、指名で待っていた行）を、
// この人の行として数える。ログインのたびに結び直す行なので、ログインのとき（hasLoginAccess）だけ数え、組織の選択と
// セッションの判定には数えない（enterOrganization は account_id で引くので、結ばれるまでその組織には入れない。
// セッションの判定で数えると、結ばれる前の行だけの人が、どこにも入れないままセッションを持ち続ける）
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
export function hasLoginAccess(env: Env, who: LoginAccessTarget): Promise<boolean> {
  return hasLoginAccessIn(env, who, crossOrganizationEntries(env));
}

export type LoginAccessTarget = { accountId: string | undefined; logins: readonly LoginId[] };

// 入口の一覧を受け取る本体。index.ts は出さない。DB を複数にした場合を、テストが testing.ts から確かめる
export async function hasLoginAccessIn(
  env: Env,
  who: LoginAccessTarget,
  entries: readonly OrganizationEntry[],
): Promise<boolean> {
  const { organizations, invitations } = await readAccountOrganizations(
    env,
    { ...who, includeUnlinked: true },
    entries,
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
export function linkLoginToAccount(env: Env, accountId: string, login: LoginId, now: Date): Promise<void> {
  return linkLoginToAccountIn(env, accountId, login, now, crossOrganizationEntries(env));
}

// 結ぶ行を探す文。users_login（手段と ID）の索引に乗せ、account_id が空であることで絞る
export function waitingUserStatement(db: OrganizationEntry, login: LoginId) {
  return db.statement((q) =>
    q
      .selectFrom('users')
      .select('id')
      .where('login_provider', '=', login.provider)
      .where('login_subject', '=', login.subject)
      .where('account_id', 'is', null)
      .limit(1),
  );
}

// 結ぶ文。読んでから書くまでに別のログインが結んだ行は、account_id が空の条件で外れる
export function linkUserStatement(db: OrganizationEntry, accountId: string, login: LoginId, now: Date) {
  return db.statement((q) =>
    q
      .updateTable('users')
      .set({ account_id: accountId, updated_at: now.toISOString() })
      .where('account_id', 'is', null)
      .where('login_provider', '=', login.provider)
      .where('login_subject', '=', login.subject),
  );
}

// 組織ごとの管理者の状態（運用者の組織の一覧）。人の名前や ID は返さず、状態だけを返す。
//   none: 無効でない管理者（is_admin = 1）の行が無い
//   pending: その行はあるが、どれも account_id が空（指名した人がまだログインしていない）
//   expired: pending のうち、空の行がどれも Google の指名で待つ行（login_subject が空）で、招待の URL の期限が過ぎている
//   active: それ以外
// 組織の ID の束を organization_id IN (...) で渡し、DB ごとに1回で数える（束縛の上限で区切る）。users_organization_login の索引に乗る。
// 引数の組織の ID すべてに状態を返す（行が無い組織は none）
export function adminStatusesOf(
  env: Env,
  organizationIds: readonly string[],
  now: Date,
): Promise<Map<string, AdminStatus>> {
  return adminStatusesIn(organizationIds, crossOrganizationEntries(env), now);
}

// 管理者の数と、アカウントに結ばれた管理者の数と、期限の過ぎた待つ行の数を数える文。
// DB を複数にしたときは、DB ごとの結果を足し合わせる
export function adminCountsStatement(db: OrganizationEntry, organizationIds: readonly string[], now: Date) {
  return db.statement((q) =>
    q
      .selectFrom('users')
      .select((eb) => [
        'organization_id',
        eb.fn.countAll<number>().as('admins'),
        eb.fn.count<number>('account_id').as('linked'),
        eb.fn
          .countAll<number>()
          .filterWhere('login_subject', 'is', null)
          .filterWhere('claim_expires_at', '<=', now.toISOString())
          .as('expired'),
      ])
      .where('organization_id', 'in', organizationIds)
      .where('is_admin', '=', 1)
      .where('disabled_at', 'is', null)
      .groupBy('organization_id'),
  );
}

// 入口の一覧を受け取る本体。index.ts は出さない。DB を複数にした場合を、テストが testing.ts から確かめる
export async function adminStatusesIn(
  organizationIds: readonly string[],
  entries: readonly OrganizationEntry[],
  now: Date,
): Promise<Map<string, AdminStatus>> {
  const counts = new Map<string, { admins: number; linked: number; expired: number }>();
  for (const db of entries) {
    // is_admin = 1 と現在の時刻の値も束縛するので、組織の ID は上限より2つ少なく区切る
    for (const chunk of chunksOf(organizationIds, MAX_BOUND_PARAMETERS - 2)) {
      for (const row of await db.rows(adminCountsStatement(db, chunk, now))) {
        const total = counts.get(row.organization_id) ?? { admins: 0, linked: 0, expired: 0 };
        total.admins += Number(row.admins);
        total.linked += Number(row.linked);
        total.expired += Number(row.expired);
        counts.set(row.organization_id, total);
      }
    }
  }
  return new Map(
    organizationIds.map((id): [string, AdminStatus] => {
      const total = counts.get(id);
      if (total === undefined || total.admins === 0) return [id, 'none'];
      if (total.linked > 0) return [id, 'active'];
      return [id, total.expired === total.admins ? 'expired' : 'pending'];
    }),
  );
}

// 入口の一覧を受け取る本体。index.ts は出さない。DB を複数にした場合を、テストが testing.ts から確かめる
export async function linkLoginToAccountIn(
  env: Env,
  accountId: string,
  login: LoginId,
  now: Date,
  entries: readonly OrganizationEntry[],
): Promise<void> {
  for (const db of entries) {
    if ((await db.first(waitingUserStatement(db, login))) === undefined) continue;
    await db.batch([linkUserStatement(db, accountId, login, now)]);
  }
}

// ---- 招待の URL から、メールアドレスで待つ指名と招待に結ぶ ----
// 手順は docs/data-model.md の「メールアドレスで待つ指名と招待」の 5 と 6。

export type ClaimInput = {
  // 招待の URL の秘密の SHA-256（小文字の16進）
  tokenHash: string;
  // ID トークンのメールアドレスをそろえた値（normalizeEmail）。待つ行の login_email と完全に一致したときだけ結ぶ
  email: string;
  // 結ぶ人のログイン（Google の sub）
  login: LoginId;
  // users.name に書き直す、Google のプロフィールの名前
  name: string;
  now: Date;
};

// user: 運用者の指名。結んだ組織の slug を返す（結んだ後に入る先）。invitation: 招待
export type ClaimOutcome = { kind: 'user'; organizationSlug: string } | { kind: 'invitation' };

type PendingClaim = {
  kind: 'user' | 'invitation';
  id: string;
  organizationId: string;
  // 招待のときだけ
  workspaceId: string | null;
  email: string | null;
  createdAt: string;
};

// 結ぶ文の条件を組む式の入れ物。UPDATE と DELETE の WHERE と INSERT ... SELECT の WHERE のどれからも渡せるよう、表の名前は全部にする
type Builder = ExpressionBuilder<OrganizationTables, keyof OrganizationTables>;

// 待っている指名の行。claim_token_hash の UNIQUE の索引で引き、期限と login_subject が空であることで絞る
export function pendingUserStatement(db: OrganizationEntry, tokenHash: string, now: Date) {
  return db.statement((q) =>
    q
      .selectFrom('users')
      .select(['id', 'organization_id', 'login_email', 'created_at'])
      .where('claim_token_hash', '=', tokenHash)
      .where('login_subject', 'is', null)
      .where('disabled_at', 'is', null)
      .where('claim_expires_at', '>', now.toISOString()),
  );
}

// 待っている招待の行。承諾待ちのものだけ。組織の ID はワークスペースから取る
export function pendingInvitationStatement(db: OrganizationEntry, tokenHash: string, now: Date) {
  return db.statement((q) =>
    q
      .selectFrom('invitations as i')
      .innerJoin('workspaces as w', 'w.id', 'i.workspace_id')
      .select(['i.id', 'i.workspace_id', 'w.organization_id', 'i.login_email', 'i.created_at'])
      .where('i.claim_token_hash', '=', tokenHash)
      .where('i.login_subject', 'is', null)
      .where('i.status', '=', 'pending')
      .where('i.claim_expires_at', '>', now.toISOString()),
  );
}

async function findPendingClaim(
  db: OrganizationEntry,
  tokenHash: string,
  now: Date,
): Promise<PendingClaim | undefined> {
  const user = await db.first(pendingUserStatement(db, tokenHash, now));
  if (user !== undefined) {
    return {
      kind: 'user',
      id: user.id,
      organizationId: user.organization_id,
      workspaceId: null,
      email: user.login_email,
      createdAt: user.created_at,
    };
  }
  const invitation = await db.first(pendingInvitationStatement(db, tokenHash, now));
  if (invitation === undefined) return undefined;
  return {
    kind: 'invitation',
    id: invitation.id,
    organizationId: invitation.organization_id,
    workspaceId: invitation.workspace_id,
    email: invitation.login_email,
    createdAt: invitation.created_at,
  };
}

// 停止していない組織の slug。停止した組織の待つ行は、当たらなかったものとする
async function activeOrganizationSlug(env: Env, organizationId: string): Promise<string | undefined> {
  const common = commonDb(env);
  const row = await common.first(
    common.statement((q) =>
      q.selectFrom('organizations').select('slug').where('id', '=', organizationId).where('suspended_at', 'is', null),
    ),
  );
  return row?.slug;
}

// 結ぶ文が共有する値。どの文も、待っている行の ID と組織の ID、秘密のハッシュ、時刻を同じ値で条件に持つ
type ClaimContext = {
  pending: PendingClaim;
  tokenHash: string;
  nowIso: string;
  login: LoginId;
};

// 待っている行がまだ有効: 同じ行が、まだ sub が空で、秘密のハッシュが同じで、期限が過ぎていない
// （招待は承諾待ちのままであることも）。読んでから書くまでに、指名し直し、取り消し、期限切れ、同じ URL の二重の戻りが起こりうる
// ので、書くどの文にも同じ条件を付ける。1つの batch() の中で先の文が行を変えた後は、後ろの文のこの条件が外れる
function waitingUserIsValid(eb: Builder, c: ClaimContext) {
  return eb.exists(
    eb
      .selectFrom('users as wu')
      .select('wu.id')
      .where('wu.id', '=', c.pending.id)
      .where('wu.organization_id', '=', c.pending.organizationId)
      .where('wu.login_subject', 'is', null)
      // 無効にされた待つ行は結べない（読んでから書くまでに無効にされた場合も外す）
      .where('wu.disabled_at', 'is', null)
      .where('wu.claim_token_hash', '=', c.tokenHash)
      .where('wu.claim_expires_at', '>', c.nowIso),
  );
}

function waitingInvitationIsValid(eb: Builder, c: ClaimContext) {
  return eb.exists(
    eb
      .selectFrom('invitations as wi')
      .innerJoin('workspaces as ww', 'ww.id', 'wi.workspace_id')
      .select('wi.id')
      .where('wi.id', '=', c.pending.id)
      .where('ww.organization_id', '=', c.pending.organizationId)
      .where('wi.login_subject', 'is', null)
      .where('wi.claim_token_hash', '=', c.tokenHash)
      .where('wi.claim_expires_at', '>', c.nowIso)
      .where('wi.status', '=', 'pending'),
  );
}

// 同じ組織の、結ぶ人のログインの行（待っている行ではない行。待っている行は login_subject が空）
function sameLoginUsers(eb: Builder, c: ClaimContext) {
  return eb
    .selectFrom('users as su')
    .where('su.organization_id', '=', c.pending.organizationId)
    .where('su.login_provider', '=', c.login.provider)
    .where('su.login_subject', '=', c.login.subject);
}

// 待っていた行より後に無効にされた、同じ sub の行。後から下した無効の判断を、前の指名で覆さない
function disabledAfterWaiting(eb: Builder, c: ClaimContext) {
  return eb.exists(sameLoginUsers(eb, c).select('su.id').where('su.disabled_at', '>', c.pending.createdAt));
}

// 指名を結べる: 待っている行が有効で、同じ sub の行が待っている行より後に無効にされていない
function userClaimIsOpen(eb: Builder, c: ClaimContext) {
  return eb.and([waitingUserIsValid(eb, c), eb.not(disabledAfterWaiting(eb, c))]);
}

// 招待が、別の承諾待ちの招待（同じワークスペースの同じ sub）か、今の所属で足りている
function invitationIsSuperseded(eb: Builder, c: ClaimContext) {
  const { pending, login } = c;
  return eb.or([
    eb.exists(
      eb
        .selectFrom('invitations as oi')
        .select('oi.id')
        .where('oi.workspace_id', '=', pending.workspaceId ?? '')
        .where('oi.login_provider', '=', login.provider)
        .where('oi.login_subject', '=', login.subject)
        .where('oi.status', '=', 'pending')
        .where('oi.id', '<>', pending.id),
    ),
    eb.exists(
      eb
        .selectFrom('users as mu')
        .innerJoin('memberships as mm', 'mm.user_id', 'mu.id')
        .select('mu.id')
        .where('mu.organization_id', '=', pending.organizationId)
        .where('mu.login_provider', '=', login.provider)
        .where('mu.login_subject', '=', login.subject)
        .where('mm.workspace_id', '=', pending.workspaceId ?? '')
        .where('mm.left_at', 'is', null),
    ),
  ]);
}

// change_logs の entity_id と actor_user_id に入れる、同じ組織の同じ sub の行の ID
const SAME_LOGIN_USER = Symbol('same login user');
type IdRef = string | null | typeof SAME_LOGIN_USER;
// changes_json を、同じ sub の行の今の is_admin と disabled_at から SQL で作る（統合の記録）
const MERGE_CHANGES = Symbol('merge changes');

type ClaimLog = {
  workspaceId: string | null;
  entityType: 'user' | 'invitation';
  entityId: IdRef;
  actorUserId: IdRef;
  // 秘密、メールアドレス、期限は入れない
  changes: string | typeof MERGE_CHANGES;
};

// 結んだ記録。guard が真のときだけ入る INSERT ... SELECT。operator は空（結んだのは本人）。
// 記録は書く文の前に置く。後ろに置くと、先の文が待っている行を変えた後は「待っている行がまだ有効」が外れて入らないため。
// guard は書く文のうち、実際に行を変えるものと同じ条件にする（変える文だけ記録が入り、変えない戻りには入らない）
function claimLogStatement(
  db: OrganizationEntry,
  c: ClaimContext,
  log: ClaimLog,
  guard: (eb: Builder) => Expression<SqlBool>,
) {
  return db.statement((q) =>
    q
      .insertInto('change_logs')
      .columns([
        'id',
        'organization_id',
        'workspace_id',
        'actor_user_id',
        'operator',
        'entity_type',
        'entity_id',
        'action',
        'changes_json',
        'created_at',
      ])
      .expression(
        q
          .selectNoFrom((eb) => {
            const ref = (value: IdRef, alias: 'actor_user_id' | 'entity_id') =>
              value === SAME_LOGIN_USER
                ? sameLoginUsers(eb, c).select('su.id').limit(1).as(alias)
                : eb.val(value).as(alias);
            return [
              eb.val(uuidv7(new Date(c.nowIso))).as('id'),
              eb.val(c.pending.organizationId).as('organization_id'),
              eb.val(log.workspaceId).as('workspace_id'),
              ref(log.actorUserId, 'actor_user_id'),
              eb.val(null).as('operator'),
              eb.val(log.entityType).as('entity_type'),
              ref(log.entityId, 'entity_id'),
              eb.val('update').as('action'),
              log.changes === MERGE_CHANGES
                ? sql<string>`json_object(
                    'is_admin', json_array(${sameLoginUsers(eb, c).select('su.is_admin').limit(1)}, 1),
                    'disabled_at', json_array(${sameLoginUsers(eb, c).select('su.disabled_at').limit(1)}, null)
                  )`.as('changes_json')
                : eb.val(log.changes).as('changes_json'),
              eb.val(c.nowIso).as('created_at'),
            ];
          })
          .where(guard),
      ),
  );
}

// 運用者の指名（users）を結ぶ文。書く文の並びは、統合を先に、sub を埋める文を後にする（docs/data-model.md の 6）。
//   - 同じ組織に同じ sub の行があれば、その行を管理者にして無効を解き、待っていた行を消す
//   - 無ければ、待っていた行に sub を埋め、メールアドレス、秘密のハッシュ、期限を空にし、名前を Google のプロフィールの名前に書き直す
// 待っていた行より後に無効にされた同じ sub の行があれば、どの文も何も書かない
function userClaimStatements(db: OrganizationEntry, c: ClaimContext, name: string) {
  const { pending, login, nowIso } = c;
  const sameLoginExists = (eb: Builder) => eb.exists(sameLoginUsers(eb, c).select('su.id'));
  return [
    claimLogStatement(
      db,
      c,
      {
        workspaceId: null,
        entityType: 'user',
        entityId: SAME_LOGIN_USER,
        actorUserId: SAME_LOGIN_USER,
        changes: MERGE_CHANGES,
      },
      (eb) => eb.and([userClaimIsOpen(eb, c), sameLoginExists(eb)]),
    ),
    claimLogStatement(
      db,
      c,
      {
        workspaceId: null,
        entityType: 'user',
        entityId: pending.id,
        actorUserId: pending.id,
        changes: JSON.stringify({
          login_subject: [null, login.subject],
          name: [WAITING_USER_NAME_IN_LOG, name],
        }),
      },
      (eb) => eb.and([userClaimIsOpen(eb, c), eb.not(sameLoginExists(eb))]),
    ),
    db.statement((q) =>
      q
        .updateTable('users')
        .set({ is_admin: 1, disabled_at: null, updated_at: nowIso })
        .where('organization_id', '=', pending.organizationId)
        .where('login_provider', '=', login.provider)
        .where('login_subject', '=', login.subject)
        .where((eb) => userClaimIsOpen(eb, c)),
    ),
    // 統合した後に、待っていた行を消す。統合先が無効でない管理者になっていることも条件にする
    db.statement((q) =>
      q
        .deleteFrom('users')
        .where('id', '=', pending.id)
        .where('organization_id', '=', pending.organizationId)
        .where('login_subject', 'is', null)
        .where('disabled_at', 'is', null)
        .where('claim_token_hash', '=', c.tokenHash)
        .where('claim_expires_at', '>', nowIso)
        .where((eb) =>
          eb.exists(
            sameLoginUsers(eb, c).select('su.id').where('su.is_admin', '=', 1).where('su.disabled_at', 'is', null),
          ),
        ),
    ),
    db.statement((q) =>
      q
        .updateTable('users')
        .set({
          login_subject: login.subject,
          login_email: null,
          claim_token_hash: null,
          claim_expires_at: null,
          name,
          updated_at: nowIso,
        })
        .where('id', '=', pending.id)
        .where('organization_id', '=', pending.organizationId)
        .where((eb) => eb.and([userClaimIsOpen(eb, c), eb.not(eb.exists(sameLoginUsers(eb, c).select('su.id')))])),
    ),
  ];
}

// 招待（invitations）を結ぶ文。取り消しを先に、sub を埋める文を後にする。
//   - 同じワークスペースに同じ sub の承諾待ちの別の招待があるか、その人がもうそのワークスペースに所属していれば、待っていた招待を取り消す
//   - 無ければ、sub を埋め、メールアドレス、秘密のハッシュ、期限を空にする
function invitationClaimStatements(db: OrganizationEntry, c: ClaimContext) {
  const { pending, login, nowIso } = c;
  const open = (eb: Builder) => waitingInvitationIsValid(eb, c);
  const log = (changes: string): ClaimLog => ({
    workspaceId: pending.workspaceId,
    entityType: 'invitation',
    entityId: pending.id,
    // その人が組織に users の行を持つときだけ（承諾の前は持たないことが多い）
    actorUserId: SAME_LOGIN_USER,
    changes,
  });
  return [
    claimLogStatement(db, c, log(JSON.stringify({ status: ['pending', 'revoked'] })), (eb) =>
      eb.and([open(eb), invitationIsSuperseded(eb, c)]),
    ),
    claimLogStatement(db, c, log(JSON.stringify({ login_subject: [null, login.subject] })), (eb) =>
      eb.and([open(eb), eb.not(invitationIsSuperseded(eb, c))]),
    ),
    db.statement((q) =>
      q
        .updateTable('invitations')
        .set({ status: 'revoked', responded_at: nowIso })
        .where('id', '=', pending.id)
        .where((eb) => eb.and([waitingInvitationIsValid(eb, c), invitationIsSuperseded(eb, c)])),
    ),
    db.statement((q) =>
      q
        .updateTable('invitations')
        .set({ login_subject: login.subject, login_email: null, claim_token_hash: null, claim_expires_at: null })
        .where('id', '=', pending.id)
        .where((eb) => eb.and([waitingInvitationIsValid(eb, c), eb.not(invitationIsSuperseded(eb, c))])),
    ),
  ];
}

// 招待の URL の秘密のハッシュで待っている指名か招待を引き、メールアドレスが一致すれば、その組織の DB に1回の batch() で結ぶ。
// 結べなければ undefined（秘密が当たらない、期限切れ、使い済み、取り消し済み、停止した組織、メールアドレスが違う、
// 待っていた行より後に無効にされた人、読んでから書くまでに待つ行が使えなくなった、のどれも同じ）。理由は分けない。
// 結んだ後にもう一度流しても、待つ行が無いので何も書かず undefined になる。batch() が失敗したときは投げる（行は待ったままで、結び直せる）
export function claimPendingLogin(env: Env, input: ClaimInput): Promise<ClaimOutcome | undefined> {
  return claimPendingLoginIn(env, input, crossOrganizationEntries(env));
}

// 書き込みの時点の時刻。待つ行を読んでから batch() を組むまでに時間がたつので、期限の判定は input.now ではなく、組む直前のこの時刻で行う
type WriteClock = () => Date;

// 入口の一覧を受け取る本体。index.ts は出さない。DB を複数にした場合を、テストが testing.ts から確かめる
export async function claimPendingLoginIn(
  env: Env,
  input: ClaimInput,
  entries: readonly OrganizationEntry[],
  writeClock: WriteClock = () => new Date(),
): Promise<ClaimOutcome | undefined> {
  for (const db of entries) {
    const pending = await findPendingClaim(db, input.tokenHash, input.now);
    if (pending === undefined) continue;
    if (pending.email !== input.email) return undefined;
    const slug = await activeOrganizationSlug(env, pending.organizationId);
    if (slug === undefined) return undefined;

    const context: ClaimContext = {
      pending,
      tokenHash: input.tokenHash,
      // 読み取りを終えた後の時刻。読んだ後で期限を越えた待つ行は、書く文の「有効」の条件で外れる
      nowIso: writeClock().toISOString(),
      login: input.login,
    };
    const results = await db.batch(
      pending.kind === 'user' ? userClaimStatements(db, context, input.name) : invitationClaimStatements(db, context),
    );
    // どの文も行を変えなかったら、待つ行は使えなくなっていた
    if (results.every((result) => result.changes === 0)) return undefined;
    return pending.kind === 'user' ? { kind: 'user', organizationSlug: slug } : { kind: 'invitation' };
  }
  return undefined;
}
