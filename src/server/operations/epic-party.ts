import { now } from '../../shared/clock.ts';
import {
  epicPartyAssign,
  epicPartyJoin,
  epicPartyLeave,
  type EpicJoinedVia,
} from '../../shared/operations/epic/index.ts';
import {
  previousStatementChanged,
  type OrganizationDb,
  type OrganizationTables,
  type QueryCreator,
  type VerifiedWorkspace,
} from '../db/index.ts';
import { ApiError } from '../errors.ts';
import { uuidv7 } from '../uuid.ts';
import { implement } from './implement.ts';
import {
  activeMemberName,
  actorUserIdOf,
  changeLogColumns,
  isLeaderOrAdmin,
  openWorkspace,
  throwIfClosed,
} from './write-guards.ts';

// 討伐隊（epic_party_members）の受注、抜ける、割り振りと、配下のタスクの担当で加わる文（docs/data-model.md の epic_party_members と
// 「書き込みの単位」）。epic_party_members は workspace_id を持たないので、読む文も書く文も、ワークスペースで絞ったエピックを結ぶか、
// その EXISTS を条件にする（別のワークスペースのエピックの討伐隊を、自分のワークスペースの ID で触れない）

type Tables = OrganizationTables;

// 同時の書き込みに負けたときにやり直す回数の上限。超えたら 409 の conflict（task-assign と同じ）
const MAX_ATTEMPTS = 3;

type PartyMemberLog = { id: string; name: string; via: EpicJoinedVia };

// 同じワークスペースの、削除していない、クリアも中止もしていないエピック。書く文の条件に入れ、読んでから書くまでの間に
// エピックが終わった、消えた競合を止める
function liveEpic(from: Pick<QueryCreator<Tables>, 'selectFrom'>, workspaceId: string, epicId: string) {
  return from
    .selectFrom('epics')
    .select('epics.id')
    .where('epics.id', '=', epicId)
    .where('epics.workspace_id', '=', workspaceId)
    .where('epics.deleted_at', 'is', null)
    .where('epics.completed_at', 'is', null)
    .where('epics.canceled_at', 'is', null);
}

// エピック（同じワークスペースの削除していないもの）と、その討伐隊の userId の行、userId の人が討伐隊に入れるか（activeMemberName）と、
// その人の今の名前（抜けるときの履歴に使う。組織で絞る）を1回で読む
async function readPartyState(db: OrganizationDb, workspaceId: string, epicId: string, userId: string) {
  const organizationId = db.organizationId;
  const [epicResult, activeResult, userResult] = await db.batch([
    db.statement((q) =>
      q
        .selectFrom('epics')
        .leftJoin('epic_party_members as p', (join) =>
          join.onRef('p.epic_id', '=', 'epics.id').on('p.user_id', '=', userId),
        )
        .select(['epics.id', 'epics.requester_user_id', 'epics.completed_at', 'epics.canceled_at', 'p.joined_via'])
        .where('epics.id', '=', epicId)
        .where('epics.workspace_id', '=', workspaceId)
        .where('epics.deleted_at', 'is', null),
    ),
    db.statement((q) => activeMemberName(q, organizationId, workspaceId, userId)),
    db.statement((q) =>
      q
        .selectFrom('users')
        .select('users.name')
        .where('users.id', '=', userId)
        .where('users.organization_id', '=', organizationId),
    ),
  ] as const);
  const epic = epicResult.rows[0];
  return {
    epic:
      epic === undefined
        ? undefined
        : {
            requesterUserId: epic.requester_user_id,
            finished: epic.completed_at !== null || epic.canceled_at !== null,
            // 討伐隊にいなければ null。joined_via は列の CHECK が守る値
            via: epic.joined_via as EpicJoinedVia | null,
          },
    activeName: activeResult.rows[0]?.name,
    name: userResult.rows[0]?.name,
  };
}

// 討伐隊の履歴の1行。直前の文が行を変えたときだけ入れる
function partyLogStatement(
  db: OrganizationDb,
  params: {
    workspaceId: string;
    actorUserId: string;
    epicId: string;
    at: Date;
    change: [PartyMemberLog | null, PartyMemberLog | null];
  },
) {
  const { workspaceId, actorUserId, epicId, at, change } = params;
  const organizationId = db.organizationId;
  return db.statement((q) =>
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
            eb.val('epic').as('entity_type'),
            eb.val(epicId).as('entity_id'),
            eb.val('update').as('action'),
            eb.val(JSON.stringify({ party_member: change })).as('changes_json'),
            eb.val(at.toISOString()).as('created_at'),
          ])
          .where(previousStatementChanged),
      ),
  );
}

// 受注と割り振りの共通の処理。userId の人を via で討伐隊に足す。
// 読んで断る順は、エピックが無い（404）、割り振りで依頼主でもリーダーでもない（403）、入れる人でない（404）、終わったエピック（409）、
// 既に討伐隊にいる（何もしない）。書く文は INSERT ... SELECT ... WHERE（進行中のエピック、閉じていないワークスペース、入れる人、
// 割り振りでリーダーでなければ依頼主のまま）... ON CONFLICT DO NOTHING で、同時の受注でも1行にする。
// 入らなかったら、閉じていれば 409 の workspace_closed、そうでなければ読み直して、上の順で決め直す
async function addToParty(params: {
  db: OrganizationDb;
  actor: { userId: string | null; isAdmin: boolean };
  workspace: VerifiedWorkspace;
  epicId: string;
  userId: string;
  via: 'self' | 'assigned';
}): Promise<{ changed: boolean }> {
  const { db, actor, workspace, epicId, userId, via } = params;
  const actorUserId = actorUserIdOf(actor);
  const organizationId = db.organizationId;
  const workspaceId = workspace.workspaceId;
  // 割り振りで、リーダー（管理者を含む）でない人は、依頼主であることを書く文の条件にも入れる
  // （読んでから書くまでに依頼主が替わった競合を止める）
  const requesterOnly = via === 'assigned' && !isLeaderOrAdmin(actor, workspace);

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const state = await readPartyState(db, workspaceId, epicId, userId);
    if (state.epic === undefined) {
      await throwIfClosed(db, workspaceId);
      throw new ApiError(404, 'not_found');
    }
    if (requesterOnly && state.epic.requesterUserId !== actorUserId) throw new ApiError(403, 'forbidden');
    if (state.activeName === undefined) {
      await throwIfClosed(db, workspaceId);
      throw new ApiError(404, 'not_found');
    }
    if (state.epic.finished) {
      await throwIfClosed(db, workspaceId);
      throw new ApiError(409, 'conflict');
    }
    if (state.epic.via !== null) {
      // 既に討伐隊にいれば何も書かない。書くものが無くても、閉じたワークスペースは断る
      await throwIfClosed(db, workspaceId);
      return { changed: false };
    }

    const at = now();
    const joinedAt = at.toISOString();
    const results = await db.batch([
      db.statement((q) =>
        q
          .insertInto('epic_party_members')
          .columns(['epic_id', 'user_id', 'joined_via', 'added_by', 'joined_at'])
          .expression(
            q
              .selectNoFrom((eb) => [
                eb.val(epicId).as('epic_id'),
                eb.val(userId).as('user_id'),
                eb.val(via).as('joined_via'),
                eb.val(actorUserId).as('added_by'),
                eb.val(joinedAt).as('joined_at'),
              ])
              .where((eb) =>
                eb.and([
                  eb.exists(liveEpic(eb, workspaceId, epicId)),
                  eb.exists(openWorkspace(eb, organizationId, workspaceId)),
                  eb.exists(activeMemberName(eb, organizationId, workspaceId, userId)),
                  ...(requesterOnly
                    ? [eb.exists(liveEpic(eb, workspaceId, epicId).where('epics.requester_user_id', '=', actorUserId))]
                    : []),
                ]),
              ),
          )
          .onConflict((oc) => oc.doNothing()),
      ),
      // 直前の INSERT が行を足したときだけ履歴を書く（既にいた、条件で落ちたときは書かない）
      partyLogStatement(db, {
        workspaceId,
        actorUserId,
        epicId,
        at,
        change: [null, { id: userId, name: state.activeName, via }],
      }),
    ]);
    if ((results[0]?.changes ?? 0) > 0) return { changed: true };
    await throwIfClosed(db, workspaceId);
  }
  throw new ApiError(409, 'conflict');
}

export const epicPartyJoinOperation = implement(epicPartyJoin, async ({ db, actor, workspace, input }) =>
  addToParty({ db, actor, workspace, epicId: input.epic_id, userId: actorUserIdOf(actor), via: 'self' }),
);

export const epicPartyAssignOperation = implement(epicPartyAssign, async ({ db, actor, workspace, input }) =>
  addToParty({ db, actor, workspace, epicId: input.epic_id, userId: input.user_id, via: 'assigned' }),
);

// 呼んだ人の行を消す。読んだ入り方のまま、進行中のエピック、閉じていないワークスペースを条件に消し、
// 消したときだけ履歴（抜けた人の名前と、消した行の入り方）を書く。消せなかったら読み直して決め直す
export const epicPartyLeaveOperation = implement(epicPartyLeave, async ({ db, actor, workspace, input }) => {
  const actorUserId = actorUserIdOf(actor);
  const organizationId = db.organizationId;
  const workspaceId = workspace.workspaceId;
  const epicId = input.epic_id;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const state = await readPartyState(db, workspaceId, epicId, actorUserId);
    if (state.epic === undefined) {
      await throwIfClosed(db, workspaceId);
      throw new ApiError(404, 'not_found');
    }
    if (state.epic.finished) {
      await throwIfClosed(db, workspaceId);
      throw new ApiError(409, 'conflict');
    }
    const via = state.epic.via;
    if (via === null) {
      // 討伐隊にいなければ何も書かない。書くものが無くても、閉じたワークスペースは断る
      await throwIfClosed(db, workspaceId);
      return { changed: false };
    }

    const at = now();
    const results = await db.batch([
      db.statement((q) =>
        q.deleteFrom('epic_party_members').where((eb) =>
          eb.and([
            eb('epic_party_members.epic_id', '=', epicId),
            eb('epic_party_members.user_id', '=', actorUserId),
            // 読んだ入り方のまま（履歴の「前」がずれないように）
            eb('epic_party_members.joined_via', '=', via),
            eb.exists(liveEpic(q, workspaceId, epicId)),
            eb.exists(openWorkspace(q, organizationId, workspaceId)),
          ]),
        ),
      ),
      partyLogStatement(db, {
        workspaceId,
        actorUserId,
        epicId,
        at,
        change: [{ id: actorUserId, name: state.name ?? '', via }, null],
      }),
    ]);
    if ((results[0]?.changes ?? 0) > 0) return { changed: true };
    await throwIfClosed(db, workspaceId);
  }
  throw new ApiError(409, 'conflict');
});

// タスクの親のストーリーの親の、進行中のエピック（ストーリーもエピックも同じワークスペースの削除していないもの）を、
// そのタスクの担当が assigneeId で、タスクの更新の時刻が updatedAt（この要求が書いた行）のときだけ引く
function taskEpic(
  from: Pick<QueryCreator<Tables>, 'selectFrom'>,
  workspaceId: string,
  taskId: string,
  assigneeId: string,
  updatedAt: string,
) {
  return from
    .selectFrom('tasks')
    .innerJoin('stories', (join) =>
      join
        .onRef('stories.id', '=', 'tasks.story_id')
        .on('stories.workspace_id', '=', workspaceId)
        .on('stories.deleted_at', 'is', null),
    )
    .innerJoin('epics', (join) =>
      join
        .onRef('epics.id', '=', 'stories.epic_id')
        .on('epics.workspace_id', '=', workspaceId)
        .on('epics.deleted_at', 'is', null)
        .on('epics.completed_at', 'is', null)
        .on('epics.canceled_at', 'is', null),
    )
    .where('tasks.id', '=', taskId)
    .where('tasks.workspace_id', '=', workspaceId)
    .where('tasks.deleted_at', 'is', null)
    .where('tasks.assignee_user_id', '=', assigneeId)
    .where('tasks.updated_at', '=', updatedAt);
}

// 担当を付けたタスク（task-assign、担当つきの task-create）の担当を、タスクの親のストーリーの親のエピックの討伐隊に task_assignee で
// 足す2つの文。タスクを書く文と、その履歴の文の直後に、同じ batch() に並べる。
// 1. epic_party_members: 直前の文（タスクの履歴）が行を足した（= タスクの書き込みが通った）ことと、タスクの行が今この要求の書いた
//    担当と時刻であることを条件に、INSERT ... SELECT ... ON CONFLICT DO NOTHING（既に討伐隊にいれば、入り方を問わず何もしない）。
//    親のないタスク、エピックの下でないストーリー、終わったエピックでは、SELECT が行を返さないので何も入らない
// 2. change_logs: 1 が行を足したときだけ、エピックの履歴（{"party_member": [null, {id, name, via: "task_assignee"}]}）を書く。
//    した人は担当を替えた人
export function taskAssigneePartyStatements(
  db: OrganizationDb,
  params: {
    workspaceId: string;
    taskId: string;
    assignee: { id: string; name: string };
    actorUserId: string;
    at: Date;
    taskUpdatedAt: string;
  },
) {
  const { workspaceId, taskId, assignee, actorUserId, at, taskUpdatedAt } = params;
  const organizationId = db.organizationId;
  const joinedAt = at.toISOString();
  const log: PartyMemberLog = { id: assignee.id, name: assignee.name, via: 'task_assignee' };
  return [
    db.statement((q) =>
      q
        .insertInto('epic_party_members')
        .columns(['epic_id', 'user_id', 'joined_via', 'added_by', 'joined_at'])
        .expression(
          taskEpic(q, workspaceId, taskId, assignee.id, taskUpdatedAt)
            .select((eb) => [
              eb.ref('epics.id').as('epic_id'),
              eb.val(assignee.id).as('user_id'),
              eb.val('task_assignee').as('joined_via'),
              eb.val(actorUserId).as('added_by'),
              eb.val(joinedAt).as('joined_at'),
            ])
            .where(previousStatementChanged),
        )
        .onConflict((oc) => oc.doNothing()),
    ),
    db.statement((q) =>
      q
        .insertInto('change_logs')
        .columns(changeLogColumns)
        .expression(
          taskEpic(q, workspaceId, taskId, assignee.id, taskUpdatedAt)
            .select((eb) => [
              eb.val(uuidv7(at)).as('id'),
              eb.val(organizationId).as('organization_id'),
              eb.val(workspaceId).as('workspace_id'),
              eb.val(actorUserId).as('actor_user_id'),
              eb.val('epic').as('entity_type'),
              eb.ref('epics.id').as('entity_id'),
              eb.val('update').as('action'),
              eb.val(JSON.stringify({ party_member: [null, log] })).as('changes_json'),
              eb.val(joinedAt).as('created_at'),
            ])
            .where(previousStatementChanged),
        ),
    ),
  ] as const;
}
