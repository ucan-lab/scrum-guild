// 組織の人数に数える人（docs/data-model.md の organizations の「人数」）。数え方はここだけに置き、
// 招待の上限の検査と member-list の seats（1つの組織）と、運用者の組織の一覧（組織の ID の束）が同じ関数を通る。
// 組織の中の表だけを読み、どの文も organization_id IN (...) で組織に絞る
import type { ExpressionBuilder } from 'kysely';
import { chunksOf } from './chunks.ts';
import type { DbEntry } from './entry.ts';
import type { OrganizationDb } from './entries.ts';
import { MAX_BOUND_PARAMETERS } from './send.ts';
import type { OrganizationTables } from './tables.ts';

type OrganizationEntry = DbEntry<OrganizationTables, 'organization'>;

// 1人の見分け方。sub の行は (login_provider, login_subject)、Google で待つ行は (login_provider, login_email) で1人
// （docs/data-model.md の「メールアドレスで待つ指名と招待」）
export function personKey(row: {
  login_provider: string;
  login_subject: string | null;
  login_email: string | null;
}): string {
  return row.login_subject !== null
    ? `${row.login_provider}:subject:${row.login_subject}`
    : `${row.login_provider}:email:${row.login_email ?? ''}`;
}

// 人数に数える users の行。無効にしていない人のうち、管理者か、その組織のいずれかのワークスペースに今所属している人
export function seatUsersStatement(db: OrganizationEntry, organizationIds: readonly string[]) {
  return db.statement((q) =>
    q
      .selectFrom('users')
      .select(['users.organization_id', 'users.login_provider', 'users.login_subject', 'users.login_email'])
      .where('users.organization_id', 'in', organizationIds)
      .where('users.disabled_at', 'is', null)
      .where((eb) =>
        eb.or([
          eb('users.is_admin', '=', 1),
          eb.exists(
            eb
              .selectFrom('memberships as m')
              .innerJoin('workspaces as w', 'w.id', 'm.workspace_id')
              .select('m.id')
              .whereRef('m.user_id', '=', 'users.id')
              .where('m.left_at', 'is', null)
              .whereRef('w.organization_id', '=', 'users.organization_id'),
          ),
        ]),
      ),
  );
}

type InvitationJoin = OrganizationTables & {
  i: OrganizationTables['invitations'];
  w: OrganizationTables['workspaces'];
};

// 招待の人が、同じ組織で無効にされていないこと（同じログインの手段と ID で disabled_at の入った users の行が無いこと）。
// 人数に数える承諾待ちの招待を読む2つの文（組織全体と、1つのワークスペース）が同じ式を使い、除き方をそろえる
function inviteeNotDisabled(eb: ExpressionBuilder<InvitationJoin, 'i' | 'w'>) {
  return eb.not(
    eb.exists(
      eb
        .selectFrom('users as d')
        .select('d.id')
        .whereRef('d.organization_id', '=', 'w.organization_id')
        .where('d.disabled_at', 'is not', null)
        .whereRef('d.login_provider', '=', 'i.login_provider')
        .whereRef('d.login_subject', '=', 'i.login_subject'),
    ),
  );
}

// 期限の過ぎた Google の招待か。member-list の expired と同じく、文字列でなく時刻で比べる（at 以前で切れる）。
// 人数に数える招待を絞る2つの関数（組織全体と、1つのワークスペース）が同じ判定を通り、数え方が片方だけずれないようにする
function isExpiredClaim(claimExpiresAt: string | null, time: number): boolean {
  return claimExpiresAt !== null && Date.parse(claimExpiresAt) <= time;
}

// 人数に数える承諾待ちの招待。閉じたワークスペースへの招待と、同じ組織で無効にされた人（同じログインの手段と ID）への招待を除く。
// 期限の過ぎた Google の招待は、読んだ後に時刻で除く
export function seatInvitationsStatement(db: OrganizationEntry, organizationIds: readonly string[]) {
  return db.statement((q) =>
    q
      .selectFrom('invitations as i')
      .innerJoin('workspaces as w', 'w.id', 'i.workspace_id')
      .select(['w.organization_id', 'i.login_provider', 'i.login_subject', 'i.login_email', 'i.claim_expires_at'])
      .where('w.organization_id', 'in', organizationIds)
      .where('w.closed_at', 'is', null)
      .where('i.status', '=', 'pending')
      .where(inviteeNotDisabled),
  );
}

// 組織ごとの、人数に数える人（personKey の集合）。無効にしていない人のうち、管理者か、いずれかのワークスペースに今所属している人と、
// 承諾待ちの招待（まだアカウントのない人への招待を含む）を持つ人を、同じ人は1人として数える。招待のうち、期限の過ぎた Google の招待、
// 閉じたワークスペースへの招待、同じ組織で無効にされた人（同じログインの手段と ID）への招待は数えない。
// 保存せず、呼ばれるたびに数える。数える人は member_limit でおおよそ抑えられ、読む行もワークスペースの所属と承諾待ちの招待
// （1つのワークスペースで数十件の想定）なので、件数で区切らずに読み、アプリで重なりと期限切れを除く。
// 組織の ID は束縛の上限で区切り、DB ごと、区切りごとに2文を1回の batch() で読む。DB を複数にしたときは、DB ごとの集合を合わせる。
// 引数の組織の ID すべてに集合を返す（数える人がいない組織は空の集合）。
// DB を分けるときに直す場所の1つ（docs/data-model.md の users の節の、運用者の組織の一覧の集計の「DB を分けるとき」）。
// 今は全部の入口に全部の組織の ID を渡す
export async function seatHoldersIn(
  entries: readonly OrganizationEntry[],
  organizationIds: readonly string[],
  at: Date,
): Promise<Map<string, Set<string>>> {
  const people = new Map(organizationIds.map((id): [string, Set<string>] => [id, new Set()]));
  const time = at.getTime();
  for (const db of entries) {
    // is_admin = 1 と status = 'pending' を1つずつ束縛するので、組織の ID は上限より1つ少なく区切る
    for (const chunk of chunksOf(organizationIds, MAX_BOUND_PARAMETERS - 1)) {
      const [userResult, invitationResult] = await db.batch([
        seatUsersStatement(db, chunk),
        seatInvitationsStatement(db, chunk),
      ] as const);
      for (const row of userResult.rows) people.get(row.organization_id)?.add(personKey(row));
      for (const row of invitationResult.rows) {
        if (isExpiredClaim(row.claim_expires_at, time)) continue;
        people.get(row.organization_id)?.add(personKey(row));
      }
    }
  }
  return people;
}

// あるワークスペースの承諾待ちの招待のうち、人数に数えられる人（personKey の集合）。期限の過ぎた Google の招待と、
// 同じ組織で無効にされた人への招待は含めない。ワークスペースが閉じていても数える（開き直しで新しく数えられる人を求めるため）。
// ワークスペースも組織で絞るので、ほかの組織のワークスペースの ID を渡しても何も数えない
export async function seatHoldersOfWorkspaceInvitations(
  db: OrganizationDb,
  workspaceId: string,
  at: Date,
): Promise<Set<string>> {
  const rows = await db.rows(
    db.statement((q) =>
      q
        .selectFrom('invitations as i')
        .innerJoin('workspaces as w', 'w.id', 'i.workspace_id')
        .select(['i.login_provider', 'i.login_subject', 'i.login_email', 'i.claim_expires_at'])
        .where('w.organization_id', '=', db.organizationId)
        .where('i.workspace_id', '=', workspaceId)
        .where('i.status', '=', 'pending')
        .where(inviteeNotDisabled),
    ),
  );
  const time = at.getTime();
  const people = new Set<string>();
  for (const row of rows) {
    if (isExpiredClaim(row.claim_expires_at, time)) continue;
    people.add(personKey(row));
  }
  return people;
}

// 無効にされた人を有効に戻すと、人数に数えられる承諾待ちの招待（開いたワークスペース、期限内、同じ組織）が、そのログイン
// （手段と ID）にあるか。無効の間は人数に数えない招待なので、inviteeNotDisabled では除かず、有効に戻した後の数え方で見る。
// 数えるのは seatInvitationsStatement と同じ条件（承諾待ち、開いたワークスペース、期限内）。同じ人への招待が複数でも、あるかどうかだけを返す。
// 組織の ID は入口の organizationId から取り、ほかの組織の招待は見ない
export async function hasSeatInvitationOfLogin(
  db: OrganizationDb,
  login: { provider: string; subject: string },
  at: Date,
): Promise<boolean> {
  const rows = await db.rows(
    db.statement((q) =>
      q
        .selectFrom('invitations as i')
        .innerJoin('workspaces as w', 'w.id', 'i.workspace_id')
        .select(['i.claim_expires_at'])
        .where('w.organization_id', '=', db.organizationId)
        .where('w.closed_at', 'is', null)
        .where('i.status', '=', 'pending')
        .where('i.login_provider', '=', login.provider)
        .where('i.login_subject', '=', login.subject),
    ),
  );
  const time = at.getTime();
  return rows.some((row) => !isExpiredClaim(row.claim_expires_at, time));
}

// 確かめた組織の人数に数える人。組織の ID は入口の organizationId から取り、ほかの組織を数えられない
export async function seatHoldersOf(db: OrganizationDb, at: Date): Promise<Set<string>> {
  const organizationId = db.organizationId;
  return (await seatHoldersIn([db], [organizationId], at)).get(organizationId) ?? new Set();
}
