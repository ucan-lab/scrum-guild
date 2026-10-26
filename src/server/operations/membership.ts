// メンバーのロールの付け替え（membership-role-update）と、ワークスペースからの離脱（membership-leave）。
// 相手は member-list に出る人（今所属し、無効でなく、login_subject がある）だけで、ワークスペースで絞り、人は組織で絞る。
// 別の組織の ID と、ほかのワークスペースの人は、無いときと同じ 404
import { now } from '../../shared/clock.ts';
import { membershipLeave, membershipRoleUpdate } from '../../shared/operations/workspace/index.ts';
import {
  previousStatementChanged,
  uuidv7Sql,
  type OrganizationDb,
  type OrganizationTables,
  type QueryCreator,
} from '../db/index.ts';
import { ApiError } from '../errors.ts';
import { uuidv7 } from '../uuid.ts';
import { implement } from './implement.ts';
import { actorUserIdOf, changeLogColumns, openWorkspace, throwIfClosed } from './write-guards.ts';
import { createdOn } from './workspace.ts';

type From = Pick<QueryCreator<OrganizationTables>, 'selectFrom'>;
type Role = 'leader' | 'member';

// 相手の今の所属。member-list の一覧に出る人と同じ条件（workspace.ts の currentMemberships）で、そのワークスペースと人に絞る
function listedMembership(from: From, organizationId: string, workspaceId: string, userId: string) {
  return from
    .selectFrom('memberships as m')
    .innerJoin('users as u', 'u.id', 'm.user_id')
    .where('m.workspace_id', '=', workspaceId)
    .where('m.user_id', '=', userId)
    .where('m.left_at', 'is', null)
    .where('u.organization_id', '=', organizationId)
    .where('u.disabled_at', 'is', null)
    .where('u.login_subject', 'is not', null);
}

// 呼んだ人が、ロールの付け替えと他人を外す権限を今も持つ: 同じ組織の無効でない管理者（admin）か、このワークスペースの今のリーダー（leader）。
// 書く文の条件（どちらかの EXISTS）と、書けなかったときの読み直しが同じ式を使う（workspace.ts の closeGuard と同じ形）。
// 登録の関数が確かめた権限は読み取りの時点の値なので、読んでから書くまでに管理者やリーダーを外された人の要求を、書く文で止める
function actorAuthority(from: From, organizationId: string, workspaceId: string, actorUserId: string) {
  return {
    admin: from
      .selectFrom('users as au')
      .select('au.id')
      .where('au.id', '=', actorUserId)
      .where('au.organization_id', '=', organizationId)
      .where('au.disabled_at', 'is', null)
      .where('au.is_admin', '=', 1),
    leader: from
      .selectFrom('memberships as am')
      .innerJoin('users as alu', 'alu.id', 'am.user_id')
      .select('am.id')
      .where('am.workspace_id', '=', workspaceId)
      .where('am.user_id', '=', actorUserId)
      .where('am.left_at', 'is', null)
      .where('am.role', '=', 'leader')
      .where('alu.organization_id', '=', organizationId)
      .where('alu.disabled_at', 'is', null),
  };
}

async function actorStillAuthorized(db: OrganizationDb, workspaceId: string, actorUserId: string): Promise<boolean> {
  const [admin, leader] = await db.batch([
    db.statement((q) => actorAuthority(q, db.organizationId, workspaceId, actorUserId).admin.limit(1)),
    db.statement((q) => actorAuthority(q, db.organizationId, workspaceId, actorUserId).leader.limit(1)),
  ] as const);
  return admin.rows.length > 0 || leader.rows.length > 0;
}

async function readMembership(db: OrganizationDb, workspaceId: string, userId: string) {
  const row = await db.first(
    db.statement((q) =>
      listedMembership(q, db.organizationId, workspaceId, userId).select(['m.id', 'm.role', 'u.name']).limit(1),
    ),
  );
  if (row === undefined) return undefined;
  // role は列の CHECK が守る値（leader か member）
  return { id: row.id, role: row.role as Role, name: row.name };
}

export const membershipRoleUpdateOperation = implement(
  membershipRoleUpdate,
  async ({ db, actor, workspace, input }) => {
    const actorUserId = actorUserIdOf(actor);
    const organizationId = db.organizationId;
    const workspaceId = workspace.workspaceId;
    const userId = input.user_id;

    const current = await readMembership(db, workspaceId, userId);
    if (current === undefined) throw new ApiError(404, 'not_found');
    // 同じロールなら何も書かない（閉じたワークスペースは登録の関数が先に止めている）
    if (current.role === input.role) return { user_id: userId, role: current.role };

    const at = now();
    const stamp = at.toISOString();
    const results = await db.batch([
      // 読んだロールのまま、今の所属で、相手が一覧に出る人で、ワークスペースが開いていて、呼んだ人が今も管理者かリーダーのときだけ書く
      db.statement((q) =>
        q
          .updateTable('memberships')
          .set({ role: input.role })
          .where((eb) => {
            const authority = actorAuthority(q, organizationId, workspaceId, actorUserId);
            return eb.and([
              eb('id', '=', current.id),
              eb('workspace_id', '=', workspaceId),
              eb('user_id', '=', userId),
              eb('left_at', 'is', null),
              eb('role', '=', current.role),
              eb.exists(listedMembership(q, organizationId, workspaceId, userId).select('m.id')),
              eb.exists(openWorkspace(q, organizationId, workspaceId)),
              eb.or([eb.exists(authority.admin), eb.exists(authority.leader)]),
            ]);
          }),
      ),
      // 直前の UPDATE が行を変えたときだけ、ロールの変更を残す
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
                eb.val('membership').as('entity_type'),
                eb.val(current.id).as('entity_id'),
                eb.val('update').as('action'),
                eb.val(JSON.stringify({ role: [current.role, input.role] })).as('changes_json'),
                eb.val(stamp).as('created_at'),
              ])
              .where(previousStatementChanged),
          ),
      ),
    ]);
    if ((results[0]?.changes ?? 0) > 0) return { user_id: userId, role: input.role };

    // 読んでから書くまでに、閉じた、抜けた（外された）、呼んだ人が権限を失った、別の要求がロールを変えた
    await throwIfClosed(db, workspaceId);
    if ((await readMembership(db, workspaceId, userId)) === undefined) throw new ApiError(404, 'not_found');
    if (!(await actorStillAuthorized(db, workspaceId, actorUserId))) throw new ApiError(403, 'forbidden');
    throw new ApiError(409, 'conflict');
  },
);

// 書く順: 所属を読んで断る → memberships（left_on、left_at）、所属の change_logs、担当を外すタスクごとの change_logs、tasks を1回の batch で書く。
// 所属の文の条件は今の所属と開いているワークスペースで、所属の履歴は直前の文が行を変えたときだけ入れる。
// タスクの2文は「この要求で所属が終わった（その所属の行の left_at がこの要求の時刻）」を条件にし、履歴を UPDATE より先に置く
// （区分の削除の、振っていた行を戻す書き方と同じ。件数によらず文の数は決まっている）。
// 完了したタスク、完了の記録（completions）、経験値（xp_grants）は変えない。
// 討伐隊（epic_party_members）と接続（connections）は、表を足す Issue で、この batch に文を足す
export const membershipLeaveOperation = implement(
  membershipLeave,
  async ({ db, actor, workspace, tools, defer, input }) => {
    const actorUserId = actorUserIdOf(actor);
    const organizationId = db.organizationId;
    const workspaceId = workspace.workspaceId;
    const userId = input.user_id;

    const current = await readMembership(db, workspaceId, userId);
    if (current === undefined) throw new ApiError(404, 'not_found');
    // 他人を外せるのは、そのワークスペースのリーダーと管理者だけ。書く文でも同じ条件を確かめる（自分が抜けるときは確かめない）
    const removingOther = userId !== actorUserId;
    if (removingOther && !actor.isAdmin && workspace.actorRole !== 'leader') {
      throw new ApiError(403, 'forbidden');
    }

    const timezone = (
      await db.first(
        db.statement((q) =>
          q
            .selectFrom('workspaces')
            .select('timezone')
            .where('id', '=', workspaceId)
            .where('organization_id', '=', organizationId),
        ),
      )
    )?.timezone;
    if (timezone === undefined) throw new ApiError(404, 'not_found');

    const at = now();
    const leftAt = at.toISOString();
    // 離脱日はワークスペースのタイムゾーンの今日
    const leftOn = createdOn(timezone, leftAt, membershipLeave.name);
    const membershipId = current.id;
    // この要求で終わった所属の行。後ろの文はこれがあることを条件にする
    const endedHere = (from: From) =>
      from
        .selectFrom('memberships as em')
        .select('em.id')
        .where('em.id', '=', membershipId)
        .where('em.workspace_id', '=', workspaceId)
        .where('em.left_at', '=', leftAt);

    const results = await db.batch([
      db.statement((q) =>
        q
          .updateTable('memberships')
          .set({ left_on: leftOn, left_at: leftAt })
          .where((eb) => {
            const authority = actorAuthority(q, organizationId, workspaceId, actorUserId);
            return eb.and([
              eb('id', '=', membershipId),
              eb('workspace_id', '=', workspaceId),
              eb('user_id', '=', userId),
              eb('left_at', 'is', null),
              eb.exists(openWorkspace(q, organizationId, workspaceId)),
              // 他人を外すときは、呼んだ人が今も管理者かリーダーであること
              ...(removingOther ? [eb.or([eb.exists(authority.admin), eb.exists(authority.leader)])] : []),
            ]);
          }),
      ),
      // 直前の UPDATE が行を変えたときだけ、所属の終わりを残す。所属の作成（{"user": [null, 人], "role": [null, ロール]}）と対にし、
      // 人（そのときの名前）とロールは、終えた行から取る
      db.statement((q) =>
        q
          .insertInto('change_logs')
          .columns(changeLogColumns)
          .expression(
            q
              .selectFrom('memberships as lm')
              .innerJoin('users as lu', 'lu.id', 'lm.user_id')
              .select((eb) => [
                eb.val(uuidv7(at)).as('id'),
                eb.val(organizationId).as('organization_id'),
                eb.val(workspaceId).as('workspace_id'),
                eb.val(actorUserId).as('actor_user_id'),
                eb.val('membership').as('entity_type'),
                eb.val(membershipId).as('entity_id'),
                eb.val('delete').as('action'),
                eb
                  .fn<string>('json_object', [
                    eb.val('user'),
                    eb.fn('json_array', [
                      eb.fn('json_object', [eb.val('id'), 'lu.id', eb.val('name'), 'lu.name']),
                      eb.lit(null),
                    ]),
                    eb.val('role'),
                    eb.fn('json_array', ['lm.role', eb.lit(null)]),
                  ])
                  .as('changes_json'),
                eb.val(leftAt).as('created_at'),
              ])
              .where('lm.id', '=', membershipId)
              .where('lm.workspace_id', '=', workspaceId)
              .where('lu.organization_id', '=', organizationId)
              .where(previousStatementChanged),
          ),
      ),
      // 担当を外すタスクの履歴。task-assign の担当の変更と同じ形（{"assignee": [人, null]}、今日やるの印があれば "today_on": [日付, null]）。
      // ID は行ごとに SQL の中で UUIDv7 の形に作り、人の名前は users の今の値（そのときの名前）
      db.statement((q) =>
        q
          .insertInto('change_logs')
          .columns(changeLogColumns)
          .expression(
            q
              .selectFrom('tasks as t')
              .innerJoin('users as tu', (join) =>
                join.onRef('tu.id', '=', 't.assignee_user_id').on('tu.organization_id', '=', organizationId),
              )
              .select((eb) => {
                const assignee = eb.fn('json_array', [
                  eb.fn('json_object', [eb.val('id'), 'tu.id', eb.val('name'), 'tu.name']),
                  eb.lit(null),
                ]);
                return [
                  uuidv7Sql(at).as('id'),
                  eb.val(organizationId).as('organization_id'),
                  eb.val(workspaceId).as('workspace_id'),
                  eb.val(actorUserId).as('actor_user_id'),
                  eb.val('task').as('entity_type'),
                  eb.ref('t.id').as('entity_id'),
                  eb.val('update').as('action'),
                  eb
                    .case()
                    .when('t.today_on', 'is', null)
                    .then(eb.fn<string>('json_object', [eb.val('assignee'), assignee]))
                    .else(
                      eb.fn<string>('json_object', [
                        eb.val('assignee'),
                        assignee,
                        eb.val('today_on'),
                        eb.fn('json_array', ['t.today_on', eb.lit(null)]),
                      ]),
                    )
                    .end()
                    .as('changes_json'),
                  eb.val(leftAt).as('created_at'),
                ];
              })
              .where('t.workspace_id', '=', workspaceId)
              .where('t.assignee_user_id', '=', userId)
              .where('t.completed_at', 'is', null)
              .where('t.deleted_at', 'is', null)
              .where((eb) => eb.exists(endedHere(q))),
          ),
      ),
      // 担当を外す。条件は履歴の文と同じ。今日やるの印も消す（task-assign と同じ）
      db.statement((q) =>
        q
          .updateTable('tasks')
          .set({ assignee_user_id: null, today_on: null, updated_at: leftAt })
          .where((eb) =>
            eb.and([
              eb('workspace_id', '=', workspaceId),
              eb('assignee_user_id', '=', userId),
              eb('completed_at', 'is', null),
              eb('deleted_at', 'is', null),
              eb.exists(endedHere(q)),
            ]),
          ),
      ),
    ]);

    if ((results[0]?.changes ?? 0) === 0) {
      // 読んでから書くまでに、閉じたか、先に抜けた（外された）か、他人を外す人が権限を失った
      await throwIfClosed(db, workspaceId);
      if ((await readMembership(db, workspaceId, userId)) === undefined) throw new ApiError(404, 'not_found');
      if (removingOther && !(await actorStillAuthorized(db, workspaceId, actorUserId))) {
        throw new ApiError(403, 'forbidden');
      }
      throw new ApiError(404, 'not_found');
    }
    // 入れる組織を失った人のセッションを、応答を待たせずに消す（組織に入れるかはリクエストのたびに確かめるので、消し損ねても入れない）
    defer(() => tools.endSessionsIfLoginLost(userId));
    return { user_id: userId };
  },
);
