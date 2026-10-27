// 組織のユーザーの管理（user-list、user-admin-update、user-disable、user-enable）。管理者だけ。
// 相手は同じ組織の login_subject のある行だけで、それ以外（別の組織の ID、Google の指名でログインを待つ行）は、無いときと同じ 404。
// 書く文には、呼んだ人が今も無効でない管理者であること（EXISTS）を入れる。登録の関数が確かめた権限は読み取りの時点の値なので、
// 読んでから書くまでに解除か無効にされた人の要求を、書く文で止める（外れたら 403）。
// 最後の管理者の条件は「同じ組織に、ほかに無効でなく login_subject のある管理者がいる」で、解除と無効化の文の EXISTS に入れる。
// D1 は書き込みを1つずつ流すので、2人が同時にお互いを解除しても、後の文はこの条件で止まり、管理者は0人にならない
import { now, todayIn } from '../../shared/clock.ts';
import { userAdminUpdate, userDisable, userEnable, userList } from '../../shared/operations/organization/index.ts';
import type { UserConflictReason } from '../../shared/operations/organization/user.ts';
import {
  jsonLookup,
  previousStatementChanged,
  uuidv7Sql,
  type OrganizationDb,
  type OrganizationTables,
  type QueryCreator,
} from '../db/index.ts';
import { ApiError } from '../errors.ts';
import { uuidv7 } from '../uuid.ts';
import { implement } from './implement.ts';
import { readSeats } from './invitation.ts';
import { createdOn } from './workspace.ts';
import { actorUserIdOf, changeLogColumns } from './write-guards.ts';

type From = Pick<QueryCreator<OrganizationTables>, 'selectFrom'>;

function conflict(reason: UserConflictReason): ApiError {
  return new ApiError(409, 'conflict', { reason });
}

// 呼んだ人が、同じ組織の無効でない管理者
function activeAdmin(from: From, organizationId: string, actorUserId: string) {
  return from
    .selectFrom('users as au')
    .select('au.id')
    .where('au.id', '=', actorUserId)
    .where('au.organization_id', '=', organizationId)
    .where('au.disabled_at', 'is', null)
    .where('au.is_admin', '=', 1);
}

// 相手のほかに、同じ組織の無効でなく login_subject のある管理者がいる（Google の指名でログインを待つ行は数えない）
function otherAdmins(from: From, organizationId: string, userId: string) {
  return from
    .selectFrom('users as oa')
    .select('oa.id')
    .where('oa.organization_id', '=', organizationId)
    .where('oa.id', '!=', userId)
    .where('oa.is_admin', '=', 1)
    .where('oa.disabled_at', 'is', null)
    .where('oa.login_subject', 'is not', null);
}

type UserRow = {
  id: string;
  is_admin: number;
  disabled_at: string | null;
  login_provider: string;
  login_subject: string;
};

// 相手。同じ組織の login_subject のある行だけ
async function readUser(db: OrganizationDb, userId: string): Promise<UserRow | undefined> {
  const row = await db.first(
    db.statement((q) =>
      q
        .selectFrom('users')
        .select(['id', 'is_admin', 'disabled_at', 'login_provider', 'login_subject'])
        .where('id', '=', userId)
        .where('organization_id', '=', db.organizationId)
        .where('login_subject', 'is not', null),
    ),
  );
  if (row === undefined || row.login_subject === null) return undefined;
  return { ...row, login_subject: row.login_subject };
}

// 書けなかったときの読み直し。書く文の EXISTS と同じ式を使う
async function isActiveAdmin(db: OrganizationDb, actorUserId: string): Promise<boolean> {
  return (await db.first(db.statement((q) => activeAdmin(q, db.organizationId, actorUserId).limit(1)))) !== undefined;
}

async function hasOtherAdmins(db: OrganizationDb, userId: string): Promise<boolean> {
  return (await db.first(db.statement((q) => otherAdmins(q, db.organizationId, userId).limit(1)))) !== undefined;
}

function stateOf(row: { id: string; is_admin: number; disabled_at: string | null }) {
  return { user_id: row.id, is_admin: row.is_admin === 1, disabled_at: row.disabled_at };
}

// ユーザーの変更の記録（entity_type: user、action: update、workspace_id は空）。直前の文が行を変えたときだけ入れる
function userChangeLog(
  db: OrganizationDb,
  log: { actorUserId: string; userId: string; changes: Record<string, unknown>; at: Date },
) {
  return db.statement((q) =>
    q
      .insertInto('change_logs')
      .columns(changeLogColumns)
      .expression(
        q
          .selectNoFrom((eb) => [
            eb.val(uuidv7(log.at)).as('id'),
            eb.val(db.organizationId).as('organization_id'),
            eb.val<string | null>(null).as('workspace_id'),
            eb.val(log.actorUserId).as('actor_user_id'),
            eb.val('user').as('entity_type'),
            eb.val(log.userId).as('entity_id'),
            eb.val('update').as('action'),
            eb.val(JSON.stringify(log.changes)).as('changes_json'),
            eb.val(log.at.toISOString()).as('created_at'),
          ])
          .where(previousStatementChanged),
      ),
  );
}

// 名前、ID の順に全部。所属の数は閉じていないワークスペースの今の所属。アバターは共通の表なので、組織の道具で別に引く
export const userListOperation = implement(userList, async ({ db, tools }) => {
  const organizationId = db.organizationId;
  const rows = await db.rows(
    db.statement((q) =>
      q
        .selectFrom('users as u')
        .select((eb) => [
          'u.id',
          'u.name',
          'u.is_admin',
          'u.disabled_at',
          'u.last_seen_at',
          eb
            .selectFrom('memberships as m')
            .innerJoin('workspaces as w', 'w.id', 'm.workspace_id')
            .select((count) => count.fn.countAll<number>().as('count'))
            .whereRef('m.user_id', '=', 'u.id')
            .where('m.left_at', 'is', null)
            .where('w.organization_id', '=', organizationId)
            .where('w.closed_at', 'is', null)
            .as('workspace_count'),
        ])
        .where('u.organization_id', '=', organizationId)
        .where('u.login_subject', 'is not', null)
        .orderBy('u.name')
        .orderBy('u.id'),
    ),
  );
  const avatars = await tools.avatarsOf(rows.map((row) => row.id));
  return {
    users: rows.map((row) => ({
      id: row.id,
      name: row.name,
      avatar_url: avatars.get(row.id) ?? null,
      is_admin: row.is_admin === 1,
      disabled_at: row.disabled_at,
      workspace_count: Number(row.workspace_count ?? 0),
      last_seen_at: row.last_seen_at,
    })),
  };
});

// 指名と解除。users の文の条件は、読んだ is_admin のまま、指名なら無効でないこと、解除ならほかに管理者がいること、
// 呼んだ人が今も無効でない管理者であること。記録（{"is_admin": [前, 後]}）は直前の文が行を変えたときだけ入れる
// 指名では、管理者は組織の人数に数えるので、招待の作成と同じ関数（readSeats）で人数を数え、相手がまだ数えられておらず、
// 人数が member_limit 以上なら 409（member_limit）で断る。招待の作成と同じく人数は書く文の条件に入れない
// （数えてから書くまでの間に同時に指名か招待をして超えたときは、そのまま認める。超えるのは同時に送った数まで）
export const userAdminUpdateOperation = implement(userAdminUpdate, async ({ db, actor, tools, input }) => {
  const actorUserId = actorUserIdOf(actor);
  const organizationId = db.organizationId;
  const userId = input.user_id;
  const next = input.is_admin ? 1 : 0;

  const current = await readUser(db, userId);
  if (current === undefined) throw new ApiError(404, 'not_found');
  if (current.is_admin === next) return stateOf(current);
  if (next === 1 && current.disabled_at !== null) throw conflict('disabled');
  if (next === 1) {
    const seats = await readSeats(db, tools, { provider: current.login_provider, subject: current.login_subject });
    if (!seats.counted && seats.used >= seats.limit) throw conflict('member_limit');
  }

  const at = now();
  const stamp = at.toISOString();
  const results = await db.batch([
    db.statement((q) =>
      q
        .updateTable('users')
        .set({ is_admin: next, updated_at: stamp })
        .where((eb) =>
          eb.and([
            eb('id', '=', userId),
            eb('organization_id', '=', organizationId),
            eb('login_subject', 'is not', null),
            eb('is_admin', '=', current.is_admin),
            ...(next === 1 ? [eb('disabled_at', 'is', null)] : [eb.exists(otherAdmins(q, organizationId, userId))]),
            eb.exists(activeAdmin(q, organizationId, actorUserId)),
          ]),
        ),
    ),
    userChangeLog(db, { actorUserId, userId, changes: { is_admin: [current.is_admin, next] }, at }),
  ]);
  if ((results[0]?.changes ?? 0) > 0)
    return { user_id: userId, is_admin: next === 1, disabled_at: current.disabled_at };

  // 読んでから書くまでに、相手が変わったか、呼んだ人が権限を失った。
  // 最後の管理者は、呼んだ人の権限より先に見る（2人が同時にお互いを解除したとき、後の要求は呼んだ人も解除されているが、
  // 断る理由は「最後の管理者」として返す）
  const after = await readUser(db, userId);
  if (after === undefined) throw new ApiError(404, 'not_found');
  if (next === 0 && after.is_admin === 1 && !(await hasOtherAdmins(db, userId))) {
    throw conflict('last_admin');
  }
  if (!(await isActiveAdmin(db, actorUserId))) throw new ApiError(403, 'forbidden');
  if (after.is_admin === next) return stateOf(after);
  if (next === 1 && after.disabled_at !== null) throw conflict('disabled');
  throw new ApiError(409, 'conflict');
});

// 無効化。書く順（1回の batch）:
// 1. users（disabled_at、管理者なら is_admin = 0、updated_at）。条件は、同じ組織の login_subject のある行で、無効でなく、
//    読んだ is_admin のまま、自分でなく、管理者ならほかに管理者がいて、呼んだ人が今も無効でない管理者であること
// 2. user の記録（{"disabled_at": [null, 日時]}、管理者なら "is_admin": [1, 0] も）。1 が行を変えたときだけ
// 3, 4. その人のログイン（手段と ID）への承諾待ちの招待を、組織のすべてのワークスペースで取り消す（招待の取り消しと同じ記録を先に書く）
// 5. 所属の終わりの記録（離脱と同じ形）  6. 担当を外すタスクの記録（担当の変更と同じ形）  7. tasks の担当と今日やるの印を外す
// 8. memberships（left_on はワークスペースのタイムゾーンの今日、left_at）
// 3〜8 は閉じたワークスペースも含めたすべてのワークスペースに当て、「この要求で無効になった（disabled_at がこの要求の時刻）」を条件にする。
// 記録はどれも、変える文より前に置く（変えた後では対象の行を選べない）。行の ID は SQL の中で作るので、件数によらず文の数は決まっている。
// 完了したタスク、完了の記録、経験値は変えない。討伐隊（epic_party_members）と接続（connections）は、表を足す Issue（#267、#67）で
// この batch に文を足す
export const userDisableOperation = implement(userDisable, async ({ db, actor, tools, defer, input }) => {
  const actorUserId = actorUserIdOf(actor);
  const organizationId = db.organizationId;
  const userId = input.user_id;

  const current = await readUser(db, userId);
  if (current === undefined) throw new ApiError(404, 'not_found');
  if (userId === actorUserId) throw conflict('self');
  if (current.disabled_at !== null) return stateOf(current);

  const at = now();
  const stamp = at.toISOString();

  // 離脱日はワークスペースのタイムゾーンの今日。SQLite はタイムゾーンを扱えないので、今の所属のワークスペースのタイムゾーンを先に読み、
  // ワークスペースの ID ごとの日付を1つの JSON の値で文に渡す（文の数も束縛の数も、所属の数で増えない）。
  // 読んだ後に足された所属（承諾が割り込んだ）は JSON に無いので、UTC の今日にする（参加日より前にはしない）
  const timezones = await db.rows(
    db.statement((q) =>
      q
        .selectFrom('memberships as m')
        .innerJoin('workspaces as w', 'w.id', 'm.workspace_id')
        .select(['m.workspace_id', 'w.timezone'])
        .where('m.user_id', '=', userId)
        .where('m.left_at', 'is', null)
        .where('w.organization_id', '=', organizationId),
    ),
  );
  const leftOnByWorkspace = Object.fromEntries(
    timezones.map((row) => [row.workspace_id, createdOn(row.timezone, stamp, userDisable.name)]),
  );
  const fallbackLeftOn = todayIn('UTC', at);

  // この要求で無効になった。後ろの文はこれがあることを条件にする
  const disabledHere = (from: From) =>
    from
      .selectFrom('users as du')
      .select('du.id')
      .where('du.id', '=', userId)
      .where('du.organization_id', '=', organizationId)
      .where('du.disabled_at', '=', stamp);
  const organizationWorkspaces = (from: From) =>
    from.selectFrom('workspaces as ow').select('ow.id').where('ow.organization_id', '=', organizationId);

  const changes: Record<string, unknown> =
    current.is_admin === 1 ? { disabled_at: [null, stamp], is_admin: [1, 0] } : { disabled_at: [null, stamp] };

  const results = await db.batch([
    // 1
    db.statement((q) =>
      q
        .updateTable('users')
        .set({ disabled_at: stamp, is_admin: 0, updated_at: stamp })
        .where((eb) =>
          eb.and([
            eb('id', '=', userId),
            eb('id', '!=', actorUserId),
            eb('organization_id', '=', organizationId),
            eb('login_subject', 'is not', null),
            eb('disabled_at', 'is', null),
            eb('is_admin', '=', current.is_admin),
            ...(current.is_admin === 1 ? [eb.exists(otherAdmins(q, organizationId, userId))] : []),
            eb.exists(activeAdmin(q, organizationId, actorUserId)),
          ]),
        ),
    ),
    // 2
    userChangeLog(db, { actorUserId, userId, changes, at }),
    // 3. 招待の取り消しの記録（invitation-revoke と同じ {"status": ["pending", "revoked"]}）
    db.statement((q) =>
      q
        .insertInto('change_logs')
        .columns(changeLogColumns)
        .expression(
          q
            .selectFrom('invitations as i')
            .innerJoin('workspaces as iw', 'iw.id', 'i.workspace_id')
            .select((eb) => [
              uuidv7Sql(at).as('id'),
              eb.val(organizationId).as('organization_id'),
              eb.ref('i.workspace_id').as('workspace_id'),
              eb.val(actorUserId).as('actor_user_id'),
              eb.val('invitation').as('entity_type'),
              eb.ref('i.id').as('entity_id'),
              eb.val('update').as('action'),
              eb.val(JSON.stringify({ status: ['pending', 'revoked'] })).as('changes_json'),
              eb.val(stamp).as('created_at'),
            ])
            .where('iw.organization_id', '=', organizationId)
            .where('i.status', '=', 'pending')
            .where('i.login_provider', '=', current.login_provider)
            .where('i.login_subject', '=', current.login_subject)
            .where((eb) => eb.exists(disabledHere(q))),
        ),
    ),
    // 4
    db.statement((q) =>
      q
        .updateTable('invitations')
        .set({ status: 'revoked', responded_at: stamp })
        .where((eb) =>
          eb.and([
            eb('status', '=', 'pending'),
            eb('login_provider', '=', current.login_provider),
            eb('login_subject', '=', current.login_subject),
            eb('workspace_id', 'in', organizationWorkspaces(q)),
            eb.exists(disabledHere(q)),
          ]),
        ),
    ),
    // 5. 所属の終わり。離脱（membership-leave）と同じ {"user": [{"id", "name"}, null], "role": [前のロール, null]}
    db.statement((q) =>
      q
        .insertInto('change_logs')
        .columns(changeLogColumns)
        .expression(
          q
            .selectFrom('memberships as lm')
            .innerJoin('workspaces as lw', 'lw.id', 'lm.workspace_id')
            .innerJoin('users as lu', 'lu.id', 'lm.user_id')
            .select((eb) => [
              uuidv7Sql(at).as('id'),
              eb.val(organizationId).as('organization_id'),
              eb.ref('lm.workspace_id').as('workspace_id'),
              eb.val(actorUserId).as('actor_user_id'),
              eb.val('membership').as('entity_type'),
              eb.ref('lm.id').as('entity_id'),
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
              eb.val(stamp).as('created_at'),
            ])
            .where('lm.user_id', '=', userId)
            .where('lm.left_at', 'is', null)
            .where('lw.organization_id', '=', organizationId)
            .where('lu.organization_id', '=', organizationId)
            .where((eb) => eb.exists(disabledHere(q))),
        ),
    ),
    // 6. 担当を外すタスクの記録。task-assign の担当の変更と同じ形（今日やるの印があれば "today_on": [日付, null] も）
    db.statement((q) =>
      q
        .insertInto('change_logs')
        .columns(changeLogColumns)
        .expression(
          q
            .selectFrom('tasks as t')
            .innerJoin('workspaces as tw', 'tw.id', 't.workspace_id')
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
                eb.ref('t.workspace_id').as('workspace_id'),
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
                eb.val(stamp).as('created_at'),
              ];
            })
            .where('tw.organization_id', '=', organizationId)
            .where('t.assignee_user_id', '=', userId)
            .where('t.completed_at', 'is', null)
            .where('t.deleted_at', 'is', null)
            .where((eb) => eb.exists(disabledHere(q))),
        ),
    ),
    // 7. 担当を外す。条件は 6 と同じ。今日やるの印も消す（task-assign と同じ）
    db.statement((q) =>
      q
        .updateTable('tasks')
        .set({ assignee_user_id: null, today_on: null, updated_at: stamp })
        .where((eb) =>
          eb.and([
            eb('assignee_user_id', '=', userId),
            eb('completed_at', 'is', null),
            eb('deleted_at', 'is', null),
            eb('workspace_id', 'in', organizationWorkspaces(q)),
            eb.exists(disabledHere(q)),
          ]),
        ),
    ),
    // 8. 所属を終える
    db.statement((q) =>
      q
        .updateTable('memberships')
        .set((eb) => ({
          left_at: stamp,
          // 参加日より前にはしない（memberships の CHECK (left_on >= joined_on)）
          left_on: eb.fn<string>('max', [
            eb.ref('joined_on'),
            jsonLookup(leftOnByWorkspace, 'workspace_id', fallbackLeftOn),
          ]),
        }))
        .where((eb) =>
          eb.and([
            eb('user_id', '=', userId),
            eb('left_at', 'is', null),
            eb('workspace_id', 'in', organizationWorkspaces(q)),
            eb.exists(disabledHere(q)),
          ]),
        ),
    ),
  ]);

  if ((results[0]?.changes ?? 0) === 0) {
    // 読んでから書くまでに、相手が変わったか、呼んだ人が権限を失った
    const after = await readUser(db, userId);
    if (after === undefined) throw new ApiError(404, 'not_found');
    if (after.is_admin === 1 && !(await hasOtherAdmins(db, userId))) {
      throw conflict('last_admin');
    }
    if (!(await isActiveAdmin(db, actorUserId))) throw new ApiError(403, 'forbidden');
    // 別の要求が先に無効にした
    if (after.disabled_at !== null) return stateOf(after);
    throw new ApiError(409, 'conflict');
  }
  // 入れる組織を失った人のセッションを、応答を待たせずに消す（組織に入れるかはリクエストのたびに確かめるので、消し損ねても入れない）
  defer(() => tools.endSessionsIfLoginLost(userId));
  return { user_id: userId, is_admin: false, disabled_at: stamp };
});

// 有効に戻す。disabled_at だけを空にし、所属と管理者は戻さない。記録は {"disabled_at": [前の日時, null]}
export const userEnableOperation = implement(userEnable, async ({ db, actor, input }) => {
  const actorUserId = actorUserIdOf(actor);
  const organizationId = db.organizationId;
  const userId = input.user_id;

  const current = await readUser(db, userId);
  if (current === undefined) throw new ApiError(404, 'not_found');
  const disabledAt = current.disabled_at;
  if (disabledAt === null) return stateOf(current);

  const at = now();
  const stamp = at.toISOString();
  const results = await db.batch([
    db.statement((q) =>
      q
        .updateTable('users')
        .set({ disabled_at: null, updated_at: stamp })
        .where((eb) =>
          eb.and([
            eb('id', '=', userId),
            eb('organization_id', '=', organizationId),
            eb('login_subject', 'is not', null),
            eb('disabled_at', '=', disabledAt),
            eb.exists(activeAdmin(q, organizationId, actorUserId)),
          ]),
        ),
    ),
    userChangeLog(db, { actorUserId, userId, changes: { disabled_at: [disabledAt, null] }, at }),
  ]);
  if ((results[0]?.changes ?? 0) > 0) return { user_id: userId, is_admin: current.is_admin === 1, disabled_at: null };

  const after = await readUser(db, userId);
  if (after === undefined) throw new ApiError(404, 'not_found');
  if (!(await isActiveAdmin(db, actorUserId))) throw new ApiError(403, 'forbidden');
  // 別の要求が先に有効に戻した
  if (after.disabled_at === null) return stateOf(after);
  throw new ApiError(409, 'conflict');
});
