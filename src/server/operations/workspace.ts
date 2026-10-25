import { now, todayIn } from '../../shared/clock.ts';
import {
  workspaceCreate,
  workspaceInfo,
  workspaceLeaderCandidates,
  workspaceList,
} from '../../shared/operations/workspace/index.ts';
import type { Insertable, OrganizationDb, OrganizationTables, QueryCreator } from '../db/index.ts';
import { ApiError } from '../errors.ts';
import { implement } from './implement.ts';
import { newWorkspaceRows } from './workspace-rows.ts';

type Tables = OrganizationTables;

// 最初のリーダーに指せる人。同じ組織にいて、無効でなく、login_subject がある（Google で待っている行は除く）。
// 候補の一覧（workspace-leader-candidates）と、作る操作の書き込みの条件が同じ式を使う
function candidateUsers(from: Pick<QueryCreator<Tables>, 'selectFrom'>, organizationId: string) {
  return from
    .selectFrom('users')
    .where('users.organization_id', '=', organizationId)
    .where('users.disabled_at', 'is', null)
    .where('users.login_subject', 'is not', null);
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
  const actorUserId = actor.userId;
  if (actorUserId === null) throw new ApiError(404, 'not_found');
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

// 保存されたタイムゾーンが Intl で作れない行があっても、一覧全体を落とさない。その行だけ UTC の日付にする
function createdOn(timezone: string, createdAt: string): string {
  const at = new Date(createdAt);
  try {
    return todayIn(timezone, at);
  } catch {
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
      q
        .selectFrom('memberships as m')
        .innerJoin('workspaces as w', 'w.id', 'm.workspace_id')
        .select((eb) => [
          'm.workspace_id',
          eb.fn.countAll<number>().as('member_count'),
          eb.fn.countAll<number>().filterWhere('m.role', '=', 'leader').as('leader_count'),
        ])
        .where('w.organization_id', '=', organizationId)
        .where('m.left_at', 'is', null)
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
      created_on: createdOn(row.timezone, row.created_at),
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
