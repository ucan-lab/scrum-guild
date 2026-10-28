// 運用者による管理者の指名し直し（Issue #217）の、既にある組織の中の users と change_logs への書き込み。
// 組織の中の入口（OrganizationDb）は渡さず、指名し直すだけの関数にする。組織を確かめた結果（VerifiedOrganization）はこの関数の中で作り、
// 外へ出さない。組織の ID は、呼び出し側が共通の表の organizations から読んだ値を渡す（停止中の組織にも書ける）。
// この関数を import できるのは運用者の道具（src/server/operations/operator-tools.ts）だけで、
// eslint.config.db-entry.js が守る（appendOperatorChangeLog と同じ守り方）。
// 書き方は docs/data-model.md の「書き込みの単位」の管理者の指名し直し
import { sql, type ExpressionBuilder } from 'kysely';
import { WAITING_USER_NAME_IN_LOG } from '../../shared/claim-token.ts';
import { adminDesignationStatements, type AdminNominee } from '../organizations/designate-admin.ts';
import { uuidv7 } from '../uuid.ts';
import { orgDb, type OrganizationDb } from './entries.ts';
import type { Statement } from './entry.ts';
import { previousStatementChanged } from './previous-statement.ts';
import type { OrganizationTables } from './tables.ts';
import { uuidv7Sql } from './uuid-sql.ts';
import { issueVerifiedOrganization } from './verify-organization.ts';

export type AdminReassignment = {
  // 運用者のログインの ID（`github:12345` の形）。change_logs.operator に書く
  operator: string;
  nominee: AdminNominee;
  now: Date;
};

export type AdminReassignmentResult = {
  userId: string;
  // created: 新しい行を入れた。updated: 既にいる人を管理者にした（か、有効に戻した）。unchanged: 既に有効な管理者だった
  outcome: 'created' | 'updated' | 'unchanged';
  // 消した前の指名の数（消せずに管理者の印だけを外した、ワークスペースの所属を持つ行は数えない）。新しい行の書き込みの後に
  // 応答だけ失われて成功として返すときは、分からないので 0
  removed: number;
};

type CandidateRow = {
  id: string;
  account_id: string | null;
  login_provider: string;
  login_subject: string | null;
  name: string;
  is_admin: number;
  disabled_at: string | null;
};

// 指名する人の、この組織の中の行を見分ける条件。GitHub はログインの手段と ID が同じ行と、既にアカウントのある人なら
// そのアカウントに結ばれた行（別の手段でこの組織に入っている同じ人）。Google は sub が分からないので、いつも無い
function isNomineeRow(
  nominee: AdminNominee,
  row: { account_id: string | null; login_provider: string; login_subject: string | null },
) {
  if ('waiting' in nominee) return false;
  if (nominee.accountId !== null && row.account_id === nominee.accountId) return true;
  return row.login_provider === nominee.provider && row.login_subject === nominee.subject;
}

// 指名する人の行と、まだログインしていない前の指名（account_id が空の行）を、1つの文で読む。
// 1つの文にするのは、既にいる人の行と前の指名を同じ時点の値で読み、その値を書き込みの条件にするため
function candidatesStatement(db: OrganizationDb, nominee: AdminNominee) {
  return db.statement((q) =>
    q
      .selectFrom('users')
      .select(['id', 'account_id', 'login_provider', 'login_subject', 'name', 'is_admin', 'disabled_at'])
      .where('organization_id', '=', db.organizationId)
      .where((eb) => {
        if ('waiting' in nominee) return eb('account_id', 'is', null);
        const conditions = [
          eb('account_id', 'is', null),
          eb.and([eb('login_provider', '=', nominee.provider), eb('login_subject', '=', nominee.subject)]),
        ];
        if (nominee.accountId !== null) conditions.push(eb('account_id', '=', nominee.accountId));
        return eb.or(conditions);
      })
      .orderBy('created_at')
      .orderBy('id'),
  );
}

// 既にいる人の行に、指名の書き込みで結ぶアカウント。行がまだ結ばれておらず、指名する人が既にアカウントを持つときだけ
function accountToLink(nominee: AdminNominee, row: CandidateRow): string | null {
  return row.account_id === null && nominee.accountId !== null ? nominee.accountId : null;
}

// 既にいる人の行を、読んだ値のままであることを条件に管理者にする（無効にされていれば戻す）。変えた列ごとに change_logs を1行ずつ足す
// （履歴の「有効化」と「管理者の指名」にそのまま当たる）。2つめの記録は1つめの記録が入ったときだけ入る（直前の文が行を変えた）
function promoteStatements(
  db: OrganizationDb,
  row: CandidateRow,
  input: AdminReassignment,
): Statement<'organization'>[] {
  const at = input.now.toISOString();
  const changes: Record<string, readonly [unknown, unknown]>[] = [];
  if (row.disabled_at !== null) changes.push({ disabled_at: [row.disabled_at, null] });
  if (row.is_admin !== 1) changes.push({ is_admin: [row.is_admin, 1] });
  // アカウントのある人の、まだ結ばれていない自分の行は、組織の作成と同じく指名の書き込みで account_id を埋める
  // （ログインの結び直し linkLoginToAccount と同じく、記録には残さない）
  const accountId = accountToLink(input.nominee, row);
  return [
    db.statement((q) =>
      q
        .updateTable('users')
        .set({
          is_admin: 1,
          disabled_at: null,
          updated_at: at,
          ...(accountId === null ? {} : { account_id: accountId }),
        })
        .where('id', '=', row.id)
        .where('organization_id', '=', db.organizationId)
        .where('is_admin', '=', row.is_admin)
        .where('disabled_at', 'is', row.disabled_at)
        .where('account_id', 'is', row.account_id),
    ),
    ...changes.map((change) => userLogStatement(db, input, { userId: row.id, action: 'update', changes: change })),
  ];
}

// 指名する人の行の、前の指名を消してよい状態。
//   active: 有効な管理者であること（新しい行を入れた後と、既に有効な管理者だった場合。どちらも指名の文の後ろに置く）
//   read: 読んだ値（is_admin、disabled_at、account_id）のままであること（既にいる人を UPDATE する場合。UPDATE の前に置き、
//         UPDATE と同じ述語にする。同じトランザクションで UPDATE の前に評価するので、UPDATE が外れるときはこちらも外れる）
// 時刻や書いた値の一致で「自分の書き込みか」は見分けない（src/server/db/previous-statement.ts）
type NomineeState = { kind: 'active' } | { kind: 'read'; row: CandidateRow };

// 取り消す前の指名の条件（書く時点の行に当てる）。その組織の account_id が空の行で、指名する人自身の行ではなく、
// 指名する人の行が NomineeState の状態であること。読んだ ID には絞らない。読んでから書くまでに別の指名し直しが入れた、
// まだログインしていない指名も取り消す。読んだ後に結ばれた行（account_id が埋まった行）は当たらない。
// membership は、ワークスペースの所属を持つ行か（with）、持たない行か（without）。持たない行は消し、持つ行は消せない
// （memberships.user_id が行を指す。組織の管理者が、まだログインしていない指名の行をワークスペースの最初のリーダーに選べる）
// ので、残して管理者の印を外す（is_admin = 1 の行だけ）。所属を持つ行はリーダーの候補（login_subject のある行）なので、
// Google で待つ行（login_subject が空で、招待の秘密を持つ）は含まれない
function removableWhere(
  db: OrganizationDb,
  nomineeUserId: string,
  state: NomineeState,
  membership: 'with' | 'without',
) {
  return (eb: ExpressionBuilder<OrganizationTables, 'users'>) => {
    const hasMembership = eb.exists(
      eb
        .selectFrom('memberships')
        .innerJoin('workspaces', 'workspaces.id', 'memberships.workspace_id')
        .select('memberships.id')
        .whereRef('memberships.user_id', '=', 'users.id')
        .where('workspaces.organization_id', '=', db.organizationId),
    );
    return eb.and([
      eb('users.organization_id', '=', db.organizationId),
      eb('users.account_id', 'is', null),
      eb('users.id', '!=', nomineeUserId),
      ...(membership === 'with' ? [hasMembership, eb('users.is_admin', '=', 1)] : [eb.not(hasMembership)]),
      eb.exists(
        eb
          .selectFrom('users as nominee')
          .select('nominee.id')
          .where('nominee.id', '=', nomineeUserId)
          .where('nominee.organization_id', '=', db.organizationId)
          .where((inner) =>
            state.kind === 'active'
              ? inner.and([inner('nominee.is_admin', '=', 1), inner('nominee.disabled_at', 'is', null)])
              : inner.and([
                  inner('nominee.is_admin', '=', state.row.is_admin),
                  inner('nominee.disabled_at', 'is', state.row.disabled_at),
                  inner('nominee.account_id', 'is', state.row.account_id),
                ]),
          ),
      ),
    ]);
  };
}

// 前の指名を取り消す4つの文。
//   0. 消す行ごとの change_logs（user の delete）を、同じ条件の INSERT ... SELECT で作る
//   1. 所属を持たない前の指名を DELETE する
//   2. 所属を持つ前の指名ごとの change_logs（user の update、{"is_admin":[1,0]}。履歴の「管理者の解除」）を作る
//   3. 所属を持つ前の指名の管理者の印を外す（UPDATE で is_admin = 0）
// 同じ batch() の中なので、記録の文と書く文は同じ行に当たる。消す記録は行の前の値を残す。Google で待つ行（login_subject が空）は、
// メールアドレス、秘密のハッシュ、期限を入れず、名前は仮の名前にし、login_subject の列を持たない
function removeStatements(
  db: OrganizationDb,
  nomineeUserId: string,
  input: AdminReassignment,
  state: NomineeState,
): [Statement<'organization'>, Statement<'organization'>, Statement<'organization'>, Statement<'organization'>] {
  const where = removableWhere(db, nomineeUserId, state, 'without');
  const demotable = removableWhere(db, nomineeUserId, state, 'with');
  return [
    db.statement((q) =>
      q
        .insertInto('change_logs')
        .columns(changeLogColumns)
        .expression(
          q
            .selectFrom('users')
            .select((eb) => [
              uuidv7Sql(input.now).as('id'),
              eb.val(db.organizationId).as('organization_id'),
              eb.val(null).as('workspace_id'),
              eb.val(null).as('actor_user_id'),
              eb.val(input.operator).as('operator'),
              eb.val('user').as('entity_type'),
              eb.ref('users.id').as('entity_id'),
              eb.val('delete').as('action'),
              sql<string>`case when users.login_subject is null
                then json_object('is_admin', json_array(users.is_admin, null), 'name', json_array(${WAITING_USER_NAME_IN_LOG}, null), 'login_provider', json_array(users.login_provider, null))
                else json_object('is_admin', json_array(users.is_admin, null), 'name', json_array(users.name, null), 'login_provider', json_array(users.login_provider, null), 'login_subject', json_array(users.login_subject, null))
                end`.as('changes_json'),
              eb.val(input.now.toISOString()).as('created_at'),
            ])
            .where(where),
        ),
    ),
    db.statement((q) => q.deleteFrom('users').where(where)),
    db.statement((q) =>
      q
        .insertInto('change_logs')
        .columns(changeLogColumns)
        .expression(
          q
            .selectFrom('users')
            .select((eb) => [
              uuidv7Sql(input.now).as('id'),
              eb.val(db.organizationId).as('organization_id'),
              eb.val(null).as('workspace_id'),
              eb.val(null).as('actor_user_id'),
              eb.val(input.operator).as('operator'),
              eb.val('user').as('entity_type'),
              eb.ref('users.id').as('entity_id'),
              eb.val('update').as('action'),
              eb.val(JSON.stringify({ is_admin: [1, 0] })).as('changes_json'),
              eb.val(input.now.toISOString()).as('created_at'),
            ])
            .where(demotable),
        ),
    ),
    db.statement((q) =>
      q.updateTable('users').set({ is_admin: 0, updated_at: input.now.toISOString() }).where(demotable),
    ),
  ];
}

const changeLogColumns = [
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
] as const;

// users の change_logs を、直前の文が行を変えたときだけ入れる。operator に運用者のログインの ID を入れ、actor_user_id は空
function userLogStatement(
  db: OrganizationDb,
  input: AdminReassignment,
  log: { userId: string; action: 'update' | 'delete'; changes: Record<string, readonly [unknown, unknown]> },
): Statement<'organization'> {
  return db.statement((q) =>
    q
      .insertInto('change_logs')
      .columns(changeLogColumns)
      .expression(
        q
          .selectNoFrom((eb) => [
            eb.val(uuidv7(input.now.getTime())).as('id'),
            eb.val(db.organizationId).as('organization_id'),
            eb.val(null).as('workspace_id'),
            eb.val(null).as('actor_user_id'),
            eb.val(input.operator).as('operator'),
            eb.val('user').as('entity_type'),
            eb.val(log.userId).as('entity_id'),
            eb.val(log.action).as('action'),
            eb.val(JSON.stringify(log.changes)).as('changes_json'),
            eb.val(input.now.toISOString()).as('created_at'),
          ])
          .where(previousStatementChanged),
      ),
  );
}

// 指名する人の行が、今この組織の有効な管理者か（既に有効な管理者だったときに、書き込みと同じバッチの中で確かめる）
function activeAdminStatement(db: OrganizationDb, userId: string) {
  return db.statement((q) =>
    q
      .selectFrom('users')
      .select('id')
      .where('id', '=', userId)
      .where('organization_id', '=', db.organizationId)
      .where('is_admin', '=', 1)
      .where('disabled_at', 'is', null),
  );
}

// 新しい行を入れる書き込みが例外で終わったときに、何が起きたかを読み直して見分ける。
//   written: 自分が採番した行がある（書き込みは済み、応答だけが失われた）
//   raced: 自分の行は無いが、指名する人の行がある（読んでから書くまでに同じ人の行が入って一意に当たった）
//   unknown: どちらでもない（元の例外を投げる）
async function afterFailedInsert(
  db: OrganizationDb,
  nominee: AdminNominee,
  userId: string,
): Promise<'written' | 'raced' | 'unknown'> {
  const own = await db.first(
    db.statement((q) =>
      q.selectFrom('users').select('id').where('id', '=', userId).where('organization_id', '=', db.organizationId),
    ),
  );
  if (own !== undefined) return 'written';
  if ('waiting' in nominee) return 'unknown';
  const rows = await db.rows(candidatesStatement(db, nominee));
  return rows.some((row) => isNomineeRow(nominee, row)) ? 'raced' : 'unknown';
}

// 前の指名（その組織の account_id が空の users の行。指名する人自身の行は除く）を取り消し、続けて指名する。1回の batch() で書く。
// 前の指名を取り消す文は4つ（消す記録の INSERT ... SELECT、DELETE、所属を持つ行の解除の記録の INSERT ... SELECT、印を外す UPDATE）。
// 文の順は、新しい行を入れるときと既に有効な管理者のときは、指名（INSERT。既に有効な管理者なら無し）、4つの文
// （指名する人が有効な管理者であることが条件）。既にいる人を UPDATE するときは、4つの文（指名する人の行が読んだ値のままで
// あることが条件。UPDATE と同じ述語）、指名の UPDATE、指名する人の記録の順。
// 前の指名は読んだ ID でなく書く時点の条件（account_id が空、指名する人の行でない）で当てるので、読んでから書くまでに
// 別の指名し直しが入れた行も消す。UPDATE が条件に外れたら、前の指名も記録も書かない。
// 既にいる人の UPDATE が条件に外れたときと、新しい行が一意に当たったときは 'conflict'
export async function reassignOrganizationAdmin(
  env: Env,
  organizationId: string,
  input: AdminReassignment,
): Promise<AdminReassignmentResult | 'conflict'> {
  const db = orgDb(env, issueVerifiedOrganization(organizationId));
  const { nominee } = input;
  const candidates = await db.rows(candidatesStatement(db, nominee));
  // アカウントに結ばれた行を、ログインの手段と ID が同じだけの行より先に選ぶ（結ばれていない方は前の指名として消す）
  const existing =
    candidates.find((row) => row.account_id !== null && isNomineeRow(nominee, row)) ??
    candidates.find((row) => isNomineeRow(nominee, row));

  let userId: string;
  let outcome: AdminReassignmentResult['outcome'];
  let designation: Statement<'organization'>[];
  if (existing === undefined) {
    const created = adminDesignationStatements(db, { nominee, operatorLoginId: input.operator, now: input.now });
    userId = created.userId;
    outcome = 'created';
    designation = created.statements;
  } else if (existing.is_admin === 1 && existing.disabled_at === null && accountToLink(nominee, existing) === null) {
    userId = existing.id;
    outcome = 'unchanged';
    designation = [];
  } else {
    userId = existing.id;
    outcome = 'updated';
    designation = promoteStatements(db, existing, input);
  }
  // 既にいる人を UPDATE するときは、前の指名の記録と DELETE を UPDATE の前に置き、UPDATE と同じ読んだ値の条件を付ける
  // （UPDATE が外れるときは、前の指名も記録も書かない）。新しい行は INSERT の後ろに置き、INSERT が失敗すれば batch() ごと戻る。
  // 既に有効な管理者なら users を書かず、後ろの読み取りで今も有効な管理者かを確かめる
  const updating = outcome === 'updated' && existing !== undefined;
  const removal = removeStatements(db, userId, input, updating ? { kind: 'read', row: existing } : { kind: 'active' });
  const check = outcome === 'unchanged' ? [activeAdminStatement(db, userId)] : [];
  const statements = updating ? [...removal, ...designation] : [...designation, ...removal, ...check];
  // 結果の位置。前の指名の DELETE（removeStatements の 1）と、既にいる人の UPDATE（removeStatements の4つの文の後ろ）。
  // 管理者の印を外した行の数は返さない（removed は消した行の数のまま）
  const deleteIndex = (updating ? 0 : designation.length) + 1;
  const updateIndex = updating ? removal.length : -1;

  let results: readonly { changes: number; rows: readonly unknown[] }[];
  try {
    results = await db.batch(statements);
  } catch (err) {
    // 一意に当たりうるのは新しい行を入れるときだけ。ほかの経路（既にいる人の UPDATE、既に有効な管理者）の失敗は、
    // D1 の一時的な失敗や外部キーの失敗なので、409 にせずそのまま投げる（500 としてログに残る）
    if (outcome !== 'created') throw err;
    // 一意に当たったかは例外の文面でなく、行を読み直して見分ける。自分が採番した行があれば、書き込みは済んで応答だけが
    // 失われたので成功として返す（消した前の指名の数は分からないので removed は 0）
    let found: Awaited<ReturnType<typeof afterFailedInsert>>;
    try {
      found = await afterFailedInsert(db, nominee, userId);
    } catch {
      throw new Error('指名する人の行を読み直せなかったので、指名し直せたか分からない', { cause: err });
    }
    if (found === 'written') return { userId, outcome, removed: 0 };
    if (found === 'raced') return 'conflict';
    throw err;
  }

  // 既にいる人を読んだ後、書く前にその行が変えられた（UPDATE が条件に外れた）。前の指名も消えていない
  if (updating && results[updateIndex]?.changes === 0) return 'conflict';
  // 既に有効な管理者だと読んだ後、書く前に無効にされたか、管理者を外された。前の指名も消えていない
  if (outcome === 'unchanged' && results.at(-1)?.rows.length === 0) return 'conflict';
  // 前の指名の DELETE（記録の INSERT ... SELECT の後ろ）が消した行の数
  const removed = results[deleteIndex]?.changes ?? 0;
  return { userId, outcome, removed };
}
