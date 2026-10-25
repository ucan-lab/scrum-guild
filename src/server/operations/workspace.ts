import { now, todayIn } from '../../shared/clock.ts';
import {
  memberList,
  workspaceClose,
  workspaceCreate,
  workspaceInfo,
  workspaceLeaderCandidates,
  workspaceList,
  workspaceReopen,
} from '../../shared/operations/workspace/index.ts';
import type { Insertable, OrganizationDb, OrganizationTables, QueryCreator } from '../db/index.ts';
import { ApiError } from '../errors.ts';
import { uuidv7 } from '../uuid.ts';
import { implement } from './implement.ts';
import { newWorkspaceRows } from './workspace-rows.ts';
import { actorUserIdOf, changeLogColumns } from './write-guards.ts';

type Tables = OrganizationTables;

// 最初のリーダーに指せる人。同じ組織にいて、無効でなく、login_subject があり（Google で待っている行は除く）、
// いまこの組織に入れる人（管理者か、いずれかのワークスペースに今所属している人。enterOrganization と同じ判定）。
// 所属の無い人を指せると、招待の人数の上限（member_limit）を通らず、本人の承諾も無いまま組織へ戻せてしまうため。
// 候補の一覧（workspace-leader-candidates）と、作る操作の書き込みの条件が同じ式を使う
function candidateUsers(from: Pick<QueryCreator<Tables>, 'selectFrom'>, organizationId: string) {
  return from
    .selectFrom('users')
    .where('users.organization_id', '=', organizationId)
    .where('users.disabled_at', 'is', null)
    .where('users.login_subject', 'is not', null)
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
            .where('w.organization_id', '=', organizationId),
        ),
      ]),
    );
}

// 作る人。同じ組織の、無効でない管理者
function adminUsers(from: Pick<QueryCreator<Tables>, 'selectFrom'>, organizationId: string) {
  return from
    .selectFrom('users')
    .where('users.organization_id', '=', organizationId)
    .where('users.disabled_at', 'is', null)
    .where('users.is_admin', '=', 1);
}

// INSERT ... SELECT <値> WHERE EXISTS (最初のリーダーが候補) AND EXISTS (作る人が管理者) の文。
// 読んでから書くまでに、最初のリーダーが候補でなくなっても、作る人が管理者でなくなっても、
// どの表にも行が入らない（全部入るか何も入らないか）
function insertWhenAllowed<T extends keyof Tables>(
  db: OrganizationDb,
  table: T,
  row: Insertable<Tables[T]>,
  ids: { leaderUserId: string; actorUserId: string },
) {
  const entries = Object.entries(row).filter(
    (entry): entry is [string, string | number | null] => entry[1] !== undefined,
  );
  return db.statement((q) =>
    q
      .insertInto(table)
      .columns(entries.map(([column]) => column) as never)
      .expression(
        q
          .selectNoFrom((eb) => entries.map(([column, value]) => eb.val(value).as(column)))
          .where((eb) =>
            eb.and([
              eb.exists(
                candidateUsers(eb, db.organizationId).select('users.id').where('users.id', '=', ids.leaderUserId),
              ),
              eb.exists(adminUsers(eb, db.organizationId).select('users.id').where('users.id', '=', ids.actorUserId)),
            ]),
          ),
      ),
  );
}

export const workspaceCreateOperation = implement(workspaceCreate, async ({ db, actor, input }) => {
  // permission: 'admin' は users の行がある管理者だけを通す。型の上の null を 404 で閉じる
  const actorUserId = actorUserIdOf(actor);
  const organizationId = db.organizationId;

  // 先に読んで、候補でなければ書かずに 404。名前は change_logs に残す
  const leader = await db.first(
    db.statement((q) =>
      candidateUsers(q, organizationId).select(['users.id', 'users.name']).where('users.id', '=', input.leader_user_id),
    ),
  );
  if (leader === undefined) throw new ApiError(404, 'not_found');

  const rows = newWorkspaceRows({
    at: now(),
    organizationId,
    actorUserId,
    leader,
    name: input.name,
    // 検証のときに正規の名前にそろっている（timezoneSchema）
    timezone: input.timezone,
    vocabulary: input.vocabulary,
  });
  const ids = { leaderUserId: leader.id, actorUserId };
  const results = await db.batch([
    insertWhenAllowed(db, 'workspaces', rows.workspace, ids),
    insertWhenAllowed(db, 'workspace_point_rates', rows.rate, ids),
    ...rows.columns.map((column) => insertWhenAllowed(db, 'board_columns', column, ids)),
    insertWhenAllowed(db, 'detail_fields', rows.detailField, ids),
    insertWhenAllowed(db, 'memberships', rows.membership, ids),
    ...rows.logs.map((log) => insertWhenAllowed(db, 'change_logs', log, ids)),
  ]);

  // どの文も同じ条件を持つので、先頭が入らなければ何も入っていない（読んだ後に条件が崩れた場合）
  if ((results[0]?.changes ?? 0) === 0) throw new ApiError(404, 'not_found');
  return { workspace_id: rows.workspaceId };
});

// 一覧に数える今の所属。今所属し（left_at が空）、同じ組織の無効でなく login_subject のある人。
// メンバーの一覧（member-list）と、管理者の一覧の人数（workspace-list）が同じ式を使い、画面ごとに数がずれないようにする
function currentMemberships(from: Pick<QueryCreator<Tables>, 'selectFrom'>, organizationId: string) {
  return from
    .selectFrom('memberships as m')
    .innerJoin('users as u', 'u.id', 'm.user_id')
    .where('m.left_at', 'is', null)
    .where('u.organization_id', '=', organizationId)
    .where('u.disabled_at', 'is', null)
    .where('u.login_subject', 'is not', null);
}

// 保存されたタイムゾーンが Intl で作れない行があっても、一覧全体を落とさない。その行だけ UTC の日付にする。
// operation は、ログに残す呼び出し元の操作の名前
function createdOn(timezone: string, createdAt: string, operation: string): string {
  const at = new Date(createdAt);
  try {
    return todayIn(timezone, at);
  } catch (err) {
    // 気づけるよう、例外の名前だけをログに残す（タイムゾーンの値、名前、日時は出さない）
    console.error(
      JSON.stringify({
        level: 'error',
        code: 'internal',
        operation,
        reason: '保存されたタイムゾーンが使えない',
        error: err instanceof Error ? err.name : typeof err,
      }),
    );
    return todayIn('UTC', at);
  }
}

// 件数に上限を付けない。ワークスペースは組織あたり数十の想定（docs/data-model.md の workspaces の節）
export const workspaceListOperation = implement(workspaceList, async ({ db }) => {
  const organizationId = db.organizationId;
  const [workspaceResult, countResult] = await db.batch([
    db.statement((q) =>
      q
        .selectFrom('workspaces')
        .select(['id', 'name', 'timezone', 'created_at', 'closed_at'])
        .where('organization_id', '=', organizationId)
        .orderBy('name')
        .orderBy('id'),
    ),
    db.statement((q) =>
      currentMemberships(q, organizationId)
        .innerJoin('workspaces as w', 'w.id', 'm.workspace_id')
        .select((eb) => [
          'm.workspace_id',
          eb.fn.countAll<number>().as('member_count'),
          eb.fn.countAll<number>().filterWhere('m.role', '=', 'leader').as('leader_count'),
        ])
        .where('w.organization_id', '=', organizationId)
        .groupBy('m.workspace_id'),
    ),
  ] as const);

  const counts = new Map(countResult.rows.map((row) => [row.workspace_id, row]));
  return {
    workspaces: workspaceResult.rows.map((row) => ({
      id: row.id,
      name: row.name,
      member_count: Number(counts.get(row.id)?.member_count ?? 0),
      leader_count: Number(counts.get(row.id)?.leader_count ?? 0),
      created_on: createdOn(row.timezone, row.created_at, workspaceList.name),
      closed_at: row.closed_at,
    })),
  };
});

// 件数に上限を付けない。ユーザーの数は member_limit で抑えられる（docs/data-model.md の workspaces の節）
export const workspaceLeaderCandidatesOperation = implement(workspaceLeaderCandidates, async ({ db }) => {
  const users = await db.rows(
    db.statement((q) =>
      candidateUsers(q, db.organizationId).select(['users.id', 'users.name']).orderBy('users.name').orderBy('users.id'),
    ),
  );
  return { users };
});

// 件数に上限を付けない。1つのワークスペースの所属と招待は数十人の想定（docs/data-model.md の workspaces の節）。
// 招待を返すのは、管理者（所属していなくてもよい）とリーダー。一般のメンバーには、読みもせず null を返す
export const memberListOperation = implement(memberList, async ({ db, actor, workspace }) => {
  const workspaceId = workspace.workspaceId;
  const organizationId = workspace.organizationId;
  const canSeeInvitations = actor.isAdmin || workspace.actorRole === 'leader';

  const workspaceStatement = db.statement((q) =>
    q
      .selectFrom('workspaces')
      .select('timezone')
      .where('id', '=', workspaceId)
      .where('organization_id', '=', organizationId),
  );
  // role の CHECK は 'leader' と 'member' だけなので、昇順でリーダーが先になる
  const membersStatement = db.statement((q) =>
    currentMemberships(q, organizationId)
      .select(['u.id', 'u.name', 'm.role', 'm.joined_on'])
      .where('m.workspace_id', '=', workspaceId)
      .orderBy('m.role')
      .orderBy('m.joined_on')
      .orderBy('u.name')
      .orderBy('u.id'),
  );
  // 期限（claim_expires_at）は Google の招待だけが持つ。切れた招待も返し、一覧に「期限切れ」と出す
  const invitationsStatement = db.statement((q) =>
    q
      .selectFrom('invitations')
      .select(['id', 'login_name', 'login_provider', 'role', 'created_at', 'claim_expires_at'])
      .where('workspace_id', '=', workspaceId)
      .where('status', '=', 'pending')
      .orderBy('created_at')
      .orderBy('id'),
  );

  const [workspaceResult, memberResult, invitationResult] = canSeeInvitations
    ? await db.batch([workspaceStatement, membersStatement, invitationsStatement] as const)
    : [...(await db.batch([workspaceStatement, membersStatement] as const)), undefined];

  const timezone = workspaceResult.rows[0]?.timezone;
  if (timezone === undefined) throw new ApiError(404, 'not_found');
  const at = now().getTime();

  return {
    members: memberResult.rows.map((row) => ({
      id: row.id,
      name: row.name,
      // role は列の CHECK が守る値。列挙に無い値が来ても、出力のスキーマ（z.enum）が 500 で止める
      role: row.role as 'leader' | 'member',
      joined_on: row.joined_on,
    })),
    invitations:
      invitationResult === undefined
        ? null
        : invitationResult.rows.map((row) => ({
            id: row.id,
            login_name: row.login_name,
            login_provider: row.login_provider as 'github' | 'google',
            role: row.role as 'leader' | 'member',
            invited_on: createdOn(timezone, row.created_at, memberList.name),
            expires_on:
              row.claim_expires_at === null ? null : createdOn(timezone, row.claim_expires_at, memberList.name),
            // 文字列の順でなく時刻で比べる（書き手の形の違いで、切れた招待を有効と見ないため）
            expired: row.claim_expires_at !== null && Date.parse(row.claim_expires_at) <= at,
          })),
  };
});

export const workspaceInfoOperation = implement(workspaceInfo, async ({ db, workspace }) => {
  const row = await db.first(
    db.statement((q) =>
      q
        .selectFrom('workspaces')
        .select(['name', 'vocabulary', 'closed_at'])
        .where('id', '=', workspace.workspaceId)
        .where('organization_id', '=', workspace.organizationId),
    ),
  );
  if (row === undefined) throw new ApiError(404, 'not_found');
  // vocabulary は列の CHECK が守る値。列挙に無い値が来ても、出力のスキーマ（z.enum）が 500 で止める
  return {
    name: row.name,
    vocabulary: row.vocabulary as 'game' | 'scrum',
    closed_at: row.closed_at,
    role: workspace.actorRole,
  };
});

// 閉じると開き直しの文が持つ条件。ワークスペースが今 before の状態（null は開いている、日時はその日時で閉じている）であること（inState）と、
// 操作する人が同じ組織の無効でない管理者であること（isAdmin）。履歴の INSERT と workspaces の UPDATE が同じ関数から組む。
// UPDATE の中は、update の式の組み立て（eb）が selectFrom の型で adminUsers に渡せないため、文の QueryCreator（q）から組む
function closeGuard(
  from: Pick<QueryCreator<Tables>, 'selectFrom'>,
  organizationId: string,
  workspaceId: string,
  actorUserId: string,
  before: string | null,
) {
  return {
    inState: from
      .selectFrom('workspaces')
      .select('workspaces.id')
      .where('workspaces.id', '=', workspaceId)
      .where('workspaces.organization_id', '=', organizationId)
      .where((eb) =>
        before === null ? eb('workspaces.closed_at', 'is', null) : eb('workspaces.closed_at', '=', before),
      ),
    isAdmin: adminUsers(from, organizationId).select('users.id').where('users.id', '=', actorUserId),
  };
}

// 閉じると開き直しの書き込み。change_logs の INSERT を先に、workspaces の UPDATE を後に置き、2つが同じ条件（closeGuard）を持つ。
// 1回の batch は1つのトランザクションで文が順に走るので、先の文が通ったときは UPDATE も同じ状態を見て必ず通り、
// 通らなかったときは UPDATE も通らない。UPDATE の後に履歴の条件を置くと、同じ時刻の2つの要求の両方に履歴が入りうる。
// 当たらなかったときは読み直して、状態が変わっていれば 409、そうでなければ（呼んだ人が管理者でなくなった）404
async function writeClosedState(
  db: OrganizationDb,
  actor: { userId: string | null },
  workspaceId: string,
  change: { action: 'close' } | { action: 'reopen'; closedAt: string },
): Promise<string> {
  // permission: 'admin' は users の行がある管理者だけを通す。型の上の null を 404 で閉じる
  const actorUserId = actorUserIdOf(actor);
  const organizationId = db.organizationId;
  const at = now();
  const stamp = at.toISOString();
  const before = change.action === 'close' ? null : change.closedAt;
  const after = change.action === 'close' ? stamp : null;

  const results = await db.batch([
    db.statement((q) =>
      q
        .insertInto('change_logs')
        .columns(changeLogColumns)
        .expression(
          q
            .selectNoFrom((eb) => [
              eb.val(uuidv7(at)).as('id'),
              eb.val(organizationId).as('organization_id'),
              eb.val(workspaceId).as('workspace_id'),
              eb.val(actorUserId).as('actor_user_id'),
              eb.val('workspace').as('entity_type'),
              eb.val(workspaceId).as('entity_id'),
              eb.val(change.action).as('action'),
              eb.val(JSON.stringify({ closed_at: [before, after] })).as('changes_json'),
              eb.val(stamp).as('created_at'),
            ])
            .where((eb) => {
              const guard = closeGuard(eb, organizationId, workspaceId, actorUserId, before);
              return eb.and([eb.exists(guard.inState), eb.exists(guard.isAdmin)]);
            }),
        ),
    ),
    db.statement((q) =>
      q
        .updateTable('workspaces')
        .set({ closed_at: after, updated_at: stamp })
        .where('workspaces.id', '=', workspaceId)
        .where('workspaces.organization_id', '=', organizationId)
        .where((eb) => {
          const guard = closeGuard(q, organizationId, workspaceId, actorUserId, before);
          return eb.and([eb.exists(guard.inState), eb.exists(guard.isAdmin)]);
        }),
    ),
  ]);
  if ((results[1]?.changes ?? 0) > 0) return stamp;

  // 読んでから書くまでに、ワークスペースの状態が変わったか、呼んだ人が管理者でなくなった
  const row = await db.first(
    db.statement((q) =>
      q
        .selectFrom('workspaces')
        .select('workspaces.closed_at')
        .where('workspaces.id', '=', workspaceId)
        .where('workspaces.organization_id', '=', organizationId),
    ),
  );
  if (row === undefined) throw new ApiError(404, 'not_found');
  if (row.closed_at !== before) {
    throw new ApiError(409, change.action === 'close' ? 'workspace_closed' : 'conflict');
  }
  throw new ApiError(404, 'not_found');
}

export const workspaceCloseOperation = implement(workspaceClose, async ({ db, actor, workspace }) => {
  const closedAt = await writeClosedState(db, actor, workspace.workspaceId, { action: 'close' });
  return { workspace_id: workspace.workspaceId, closed_at: closedAt };
});

export const workspaceReopenOperation = implement(workspaceReopen, async ({ db, actor, workspace }) => {
  const row = await db.first(
    db.statement((q) =>
      q
        .selectFrom('workspaces')
        .select('workspaces.closed_at')
        .where('workspaces.id', '=', workspace.workspaceId)
        .where('workspaces.organization_id', '=', db.organizationId),
    ),
  );
  if (row === undefined) throw new ApiError(404, 'not_found');
  // 開いているものは開き直せない。何も書かない
  if (row.closed_at === null) throw new ApiError(409, 'conflict');
  await writeClosedState(db, actor, workspace.workspaceId, { action: 'reopen', closedAt: row.closed_at });
  return { workspace_id: workspace.workspaceId };
});
