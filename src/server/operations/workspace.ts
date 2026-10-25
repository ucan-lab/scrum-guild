import { generateKeyBetween, generateNKeysBetween } from 'fractional-indexing';
import { monthIn, now, todayIn } from '../../shared/clock.ts';
import {
  workspaceCreate,
  workspaceInfo,
  workspaceLeaderCandidates,
  workspaceList,
} from '../../shared/operations/workspace/index.ts';
import { normalizeTimezone } from '../../shared/timezone.ts';
import {
  DEFAULT_HOURS_PER_POINT,
  DEFAULT_WEEK_START,
  defaultColumnNames,
  defaultDetailFieldNames,
} from '../../shared/workspace.ts';
import type { Insertable, OrganizationDb, OrganizationTables, QueryCreator } from '../db/index.ts';
import { ApiError } from '../errors.ts';
import { uuidv7 } from '../uuid.ts';
import { implement } from './implement.ts';

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

// INSERT ... SELECT <値> WHERE EXISTS (最初のリーダーが候補) の文。
// 読んでから書くまでに最初のリーダーが候補でなくなっても、どの表にも行が入らない（全部入るか何も入らないか）
function insertWhenLeaderIsCandidate<T extends keyof Tables>(
  db: OrganizationDb,
  table: T,
  row: Insertable<Tables[T]>,
  leaderUserId: string,
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
            eb.exists(candidateUsers(eb, db.organizationId).select('users.id').where('users.id', '=', leaderUserId)),
          ),
      ),
  );
}

export const workspaceCreateOperation = implement(workspaceCreate, async ({ db, actor, input }) => {
  // permission: 'admin' は users の行がある管理者だけを通す。型の上の null を 404 で閉じる
  const actorUserId = actor.userId;
  if (actorUserId === null) throw new ApiError(404, 'not_found');
  const timezone = normalizeTimezone(input.timezone);
  if (timezone === undefined) throw new ApiError(400, 'invalid_input');
  const organizationId = db.organizationId;

  // 先に読んで、候補でなければ書かずに 404。名前は change_logs に残す
  const leader = await db.first(
    db.statement((q) =>
      candidateUsers(q, organizationId).select(['users.id', 'users.name']).where('users.id', '=', input.leader_user_id),
    ),
  );
  if (leader === undefined) throw new ApiError(404, 'not_found');

  const at = now();
  const createdAt = at.toISOString();
  const workspaceId = uuidv7(at);
  const membershipId = uuidv7(at);
  // 完了の列は末尾の値を持つ（読むときは使わないが NOT NULL）
  const [positionA, positionB, positionC, positionDone] = generateNKeysBetween(null, null, 4);
  const columnPositions = [positionA, positionB, positionC];
  const insert = <T extends keyof Tables>(table: T, row: Insertable<Tables[T]>) =>
    insertWhenLeaderIsCandidate(db, table, row, leader.id);

  const results = await db.batch([
    insert('workspaces', {
      id: workspaceId,
      organization_id: organizationId,
      name: input.name,
      timezone,
      week_start: DEFAULT_WEEK_START,
      vocabulary: input.vocabulary,
      created_by: actorUserId,
      created_at: createdAt,
      updated_at: createdAt,
    }),
    insert('workspace_point_rates', {
      workspace_id: workspaceId,
      effective_month: monthIn(timezone, at),
      hours_per_point: DEFAULT_HOURS_PER_POINT,
      created_at: createdAt,
    }),
    ...defaultColumnNames[input.vocabulary].map((name, index) =>
      insert('board_columns', {
        id: uuidv7(at),
        workspace_id: workspaceId,
        name,
        is_done: 0,
        position: columnPositions[index]!,
        created_at: createdAt,
        updated_at: createdAt,
      }),
    ),
    insert('board_columns', {
      id: uuidv7(at),
      workspace_id: workspaceId,
      name: null,
      is_done: 1,
      position: positionDone!,
      created_at: createdAt,
      updated_at: createdAt,
    }),
    insert('detail_fields', {
      id: uuidv7(at),
      workspace_id: workspaceId,
      name: defaultDetailFieldNames[input.vocabulary],
      position: generateKeyBetween(null, null),
      created_at: createdAt,
      updated_at: createdAt,
    }),
    insert('memberships', {
      id: membershipId,
      workspace_id: workspaceId,
      user_id: leader.id,
      role: 'leader',
      joined_on: todayIn(timezone, at),
      joined_at: createdAt,
    }),
    insert('change_logs', {
      id: uuidv7(at),
      organization_id: organizationId,
      workspace_id: workspaceId,
      actor_user_id: actorUserId,
      entity_type: 'workspace',
      entity_id: workspaceId,
      action: 'create',
      changes_json: JSON.stringify({
        name: [null, input.name],
        timezone: [null, timezone],
        vocabulary: [null, input.vocabulary],
      }),
      created_at: createdAt,
    }),
    insert('change_logs', {
      id: uuidv7(at),
      organization_id: organizationId,
      workspace_id: workspaceId,
      actor_user_id: actorUserId,
      entity_type: 'membership',
      entity_id: membershipId,
      action: 'create',
      changes_json: JSON.stringify({ user: [null, { id: leader.id, name: leader.name }], role: [null, 'leader'] }),
      created_at: createdAt,
    }),
  ]);

  // どの文も同じ条件を持つので、先頭が入らなければ何も入っていない。読んだ後に最初のリーダーが候補でなくなった場合
  if ((results[0]?.changes ?? 0) === 0) throw new ApiError(404, 'not_found');
  return { workspace_id: workspaceId };
});

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
      created_on: todayIn(row.timezone, new Date(row.created_at)),
      closed_at: row.closed_at,
    })),
  };
});

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
