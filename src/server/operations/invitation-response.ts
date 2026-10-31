// 届いた招待の一覧、承諾、辞退（招待された人の操作。permission: 'invitee'）。
// 招待は、呼んだ人のアカウントに結んだログイン（手段と ID の組）で突き合わせる。ログインは共通の表（account_logins）なので、
// 組織の道具の myLogins() から受け取り、組織の中の表の文には値として渡す（共通の表と組織の中の表を1つの SQL で結合しない）。
// 招待はワークスペースを結合して、入口の組織（db.organizationId）で絞る。別の人と別の組織の招待は、無いときと同じ 404
import { now } from '../../shared/clock.ts';
import { invitationAccept, invitationDecline, invitationList } from '../../shared/operations/workspace/index.ts';
import {
  previousStatementChanged,
  type OrganizationDb,
  type OrganizationTables,
  type QueryCreator,
} from '../db/index.ts';
import { ApiError } from '../errors.ts';
import { uuidv7 } from '../uuid.ts';
import { implement } from './implement.ts';
import type { MyLogin } from './organization-tools.ts';
import { changeLogColumns, openWorkspace } from './write-guards.ts';
import { createdOn } from './workspace.ts';

type Tables = OrganizationTables;
type From = Pick<QueryCreator<Tables>, 'selectFrom'>;
type Login = { readonly provider: string; readonly subject: string };

// 招待の (login_provider, login_subject) が、呼んだ人のログインのどれかに当たる。ログインは多くても数個（手段ごとに1つ）
function loginsOf(logins: readonly MyLogin[]): Login[] {
  return logins.map((login) => ({ provider: login.provider, subject: login.subject }));
}

// この組織の、呼んだ人のログインに当たる招待1件（状態を問わない）と、そのワークスペースの閉じた日時とタイムゾーン。
// ログインが無ければ引かない（undefined）
async function readOwnInvitation(db: OrganizationDb, invitationId: string, logins: readonly Login[]) {
  if (logins.length === 0) return undefined;
  return db.first(
    db.statement((q) =>
      q
        .selectFrom('invitations as i')
        .innerJoin('workspaces as w', 'w.id', 'i.workspace_id')
        .select([
          'i.id',
          'i.status',
          'i.workspace_id',
          'i.login_provider',
          'i.login_subject',
          'w.closed_at',
          'w.timezone',
        ])
        .where('i.id', '=', invitationId)
        .where('w.organization_id', '=', db.organizationId)
        .where((eb) =>
          eb.or(
            logins.map((login) =>
              eb.and([eb('i.login_provider', '=', login.provider), eb('i.login_subject', '=', login.subject)]),
            ),
          ),
        ),
    ),
  );
}

export const invitationListOperation = implement(invitationList, async ({ db, organization, tools }) => {
  const organizationId = db.organizationId;
  const logins = loginsOf(await tools.myLogins());
  const rows =
    logins.length === 0
      ? []
      : await db.rows(
          db.statement((q) =>
            q
              .selectFrom('invitations as i')
              .innerJoin('workspaces as w', 'w.id', 'i.workspace_id')
              // 招待した人は users の行（外部キー）。組織で絞って名前を引く
              .leftJoin('users as u', (join) =>
                join.onRef('u.id', '=', 'i.invited_by').on('u.organization_id', '=', organizationId),
              )
              .select([
                'i.id',
                'i.workspace_id',
                'w.name as workspace_name',
                'w.closed_at',
                'w.timezone',
                'i.role',
                'u.name as invited_by_name',
                'i.created_at',
              ])
              .where('w.organization_id', '=', organizationId)
              .where('i.status', '=', 'pending')
              .where((eb) =>
                eb.or(
                  logins.map((login) =>
                    eb.and([eb('i.login_provider', '=', login.provider), eb('i.login_subject', '=', login.subject)]),
                  ),
                ),
              )
              .orderBy('i.created_at')
              .orderBy('i.id'),
          ),
        );
  return {
    // theme の形は出力のスキーマ（z.enum）が検証する
    organization: { name: organization.name, theme: organization.theme },
    invitations: rows.map((row) => ({
      invitation_id: row.id,
      workspace_id: row.workspace_id,
      workspace_name: row.workspace_name,
      closed: row.closed_at !== null,
      role: row.role === 'leader' ? ('leader' as const) : ('member' as const),
      invited_by_name: row.invited_by_name ?? '',
      invited_on: createdOn(row.timezone, row.created_at, invitationList.name),
    })),
  };
});

// 承諾する人の users の行。組織に users の行がある人（actor.userId）はその行、無い人は招待のログインの手段と ID の行
// （承諾の最初の文が作るか、前からある行）。どちらも無効でない行だけ
function personRow(from: From, organizationId: string, userId: string | null, login: Login) {
  const base = from
    .selectFrom('users as p')
    .select('p.id')
    .where('p.organization_id', '=', organizationId)
    .where('p.disabled_at', 'is', null);
  // userId が null の人（このアカウントに結んだ users の行が無い）が同じログインの行を持つのは、account_id が空の行が残っているときだけ。
  // そうした行はログインのたびの結び直し（linkLoginToAccount）で埋まるので、残りうるのは、ログインした後にその行が作られ、
  // まだログインし直していない間だけという前提で、ログインの手段と ID で引く
  return userId !== null
    ? base.where('p.id', '=', userId)
    : base.where('p.login_provider', '=', login.provider).where('p.login_subject', '=', login.subject);
}

// 承諾する人の、そのワークスペースでの今の所属（無効かどうかは問わない）
function currentMembership(
  from: From,
  organizationId: string,
  workspaceId: string,
  userId: string | null,
  login: Login,
) {
  const base = from
    .selectFrom('memberships as cm')
    .innerJoin('users as cu', 'cu.id', 'cm.user_id')
    .select('cm.id')
    .where('cm.workspace_id', '=', workspaceId)
    .where('cm.left_at', 'is', null)
    .where('cu.organization_id', '=', organizationId);
  return userId !== null
    ? base.where('cu.id', '=', userId)
    : base.where('cu.login_provider', '=', login.provider).where('cu.login_subject', '=', login.subject);
}

// 承諾できる招待: id が一致し、承諾待ちで、ワークスペースが同じ組織で閉じておらず、招待のログインが呼んだ人のもの（読んで確かめた値）で、
// 同じ組織に同じログインか同じアカウントの無効にされた users の行が無い。承諾のどの文も、この条件を EXISTS で持つ
function acceptableInvitation(
  from: From,
  organizationId: string,
  invitationId: string,
  workspaceId: string,
  login: Login,
  accountId: string,
) {
  return from
    .selectFrom('invitations as a')
    .select('a.id')
    .where('a.id', '=', invitationId)
    .where('a.workspace_id', '=', workspaceId)
    .where('a.status', '=', 'pending')
    .where('a.login_provider', '=', login.provider)
    .where('a.login_subject', '=', login.subject)
    .where((eb) =>
      eb.and([
        eb.exists(openWorkspace(from, organizationId, workspaceId)),
        eb.not(eb.exists(disabledPerson(from, organizationId, login, accountId))),
      ]),
    );
}

// 同じ組織の、招待のログインか呼んだ人のアカウントの、無効にされた users の行。
// 組織に入るときの確かめ（enterOrganization）は、users の行がある人には招待のログインの無効な行を見ないので、承諾でも見る
function disabledPerson(from: From, organizationId: string, login: Login, accountId: string) {
  return from
    .selectFrom('users as d')
    .select('d.id')
    .where('d.organization_id', '=', organizationId)
    .where('d.disabled_at', 'is not', null)
    .where((inner) =>
      inner.or([
        inner.and([inner('d.login_provider', '=', login.provider), inner('d.login_subject', '=', login.subject)]),
        inner('d.account_id', '=', accountId),
      ]),
    );
}

// 承諾を断る理由を、読んだ値から決める。無いか、この組織で無効にされた人なら 404、承諾待ちでなければ 409 の conflict、閉じていれば 409 の workspace_closed、
// そのワークスペースに今所属していれば 409 の already_member。どれでもなければ、招待と、そのログイン（呼んだ人のもの）を返す
async function acceptableOrThrow(
  db: OrganizationDb,
  invitation: Awaited<ReturnType<typeof readOwnInvitation>>,
  userId: string | null,
  accountId: string,
) {
  if (invitation === undefined || invitation.login_subject === null) throw new ApiError(404, 'not_found');
  const login: Login = { provider: invitation.login_provider, subject: invitation.login_subject };
  // この組織で無効にされた人（招待のログインか、このアカウントの行）は、組織に入れない人と同じ 404
  const disabled = await db.first(db.statement((q) => disabledPerson(q, db.organizationId, login, accountId).limit(1)));
  if (disabled !== undefined) throw new ApiError(404, 'not_found');
  if (invitation.status !== 'pending') throw new ApiError(409, 'conflict');
  if (invitation.closed_at !== null) throw new ApiError(409, 'workspace_closed');
  const workspaceId = invitation.workspace_id;
  const member = await db.first(
    db.statement((q) => currentMembership(q, db.organizationId, workspaceId, userId, login).limit(1)),
  );
  if (member !== undefined) throw new ApiError(409, 'already_member');
  return { invitation, login };
}

// 書く順: 招待を読んで断る → users（行が無い人だけ）、memberships、invitations（accepted）、change_logs 2行を1回の batch で書く。
// どの文も承諾できる招待（acceptableInvitation）を条件に持ち、後ろの文はこの要求の所属の行があることを条件にする。
// 所属の user_id は、同じ組織の users をログインの手段と ID で引き直すサブクエリ（users の行がある人はその行）。
// 前に抜けた人は users の行が残っているので、同じ ID のまま所属し、経験値（xp_grants）も同じ ID に付いたまま引き継ぐ。
// 人数の上限は見ない（承諾待ちの招待は人数に数えている）。読んでから書くまでに条件が崩れたら、読み直して理由を返す
export const invitationAcceptOperation = implement(invitationAccept, async ({ db, actor, tools, input }) => {
  const organizationId = db.organizationId;
  const invitationId = input.invitation_id;
  const myLogins = await tools.myLogins();
  const logins = loginsOf(myLogins);

  // 読んだ招待のログインは、呼んだ人のログインのどれか（readOwnInvitation の条件）
  const { invitation, login } = await acceptableOrThrow(
    db,
    await readOwnInvitation(db, invitationId, logins),
    actor.userId,
    actor.accountId,
  );
  const workspaceId = invitation.workspace_id;
  const userId = actor.userId;
  // 新しく作る users の名前は、そのログインの手段の側の名前
  const loginName = myLogins.find(
    (item) => item.provider === login.provider && item.subject === login.subject,
  )?.loginName;
  if (loginName === undefined) throw new ApiError(404, 'not_found');

  const at = now();
  const timestamp = at.toISOString();
  const membershipId = uuidv7(at);
  const acceptable = (from: From) =>
    acceptableInvitation(from, organizationId, invitationId, workspaceId, login, actor.accountId);

  // users の行が無い人だけ、同じ組織に同じログインの行も同じアカウントの行も無いときに作る
  const insertUser =
    userId === null
      ? [
          db.statement((q) =>
            q
              .insertInto('users')
              .columns([
                'id',
                'organization_id',
                'account_id',
                'login_provider',
                'login_subject',
                'name',
                'is_admin',
                'created_at',
                'updated_at',
              ])
              .expression(
                q
                  .selectNoFrom((eb) => [
                    eb.val(uuidv7(at)).as('id'),
                    eb.val(organizationId).as('organization_id'),
                    eb.val(actor.accountId).as('account_id'),
                    eb.val(login.provider).as('login_provider'),
                    eb.val(login.subject).as('login_subject'),
                    eb.val(loginName).as('name'),
                    eb.val(0).as('is_admin'),
                    eb.val(timestamp).as('created_at'),
                    eb.val(timestamp).as('updated_at'),
                  ])
                  .where((eb) =>
                    eb.and([
                      eb.exists(acceptable(q)),
                      eb.not(
                        eb.exists(
                          q
                            .selectFrom('users as e')
                            .select('e.id')
                            .where('e.organization_id', '=', organizationId)
                            .where((inner) =>
                              inner.or([
                                inner.and([
                                  inner('e.login_provider', '=', login.provider),
                                  inner('e.login_subject', '=', login.subject),
                                ]),
                                inner('e.account_id', '=', actor.accountId),
                              ]),
                            ),
                        ),
                      ),
                    ]),
                  ),
              ),
          ),
        ]
      : [];

  const results = await db.batch([
    ...insertUser,
    db.statement((q) =>
      q
        .insertInto('memberships')
        .columns(['id', 'workspace_id', 'user_id', 'role', 'joined_on', 'joined_at'])
        .expression(
          q
            .selectFrom('invitations as i')
            .select((eb) => [
              eb.val(membershipId).as('id'),
              'i.workspace_id',
              personRow(q, organizationId, userId, login).limit(1).as('user_id'),
              'i.role',
              // 参加日はワークスペースのタイムゾーンの今日
              eb.val(createdOn(invitation.timezone, timestamp, invitationAccept.name)).as('joined_on'),
              eb.val(timestamp).as('joined_at'),
            ])
            .where('i.id', '=', invitationId)
            .where((eb) =>
              eb.and([
                eb.exists(acceptable(q)),
                eb.exists(personRow(q, organizationId, userId, login)),
                eb.not(eb.exists(currentMembership(q, organizationId, workspaceId, userId, login))),
              ]),
            ),
        ),
    ),
    // この要求の所属の行があるときだけ、招待を承諾済みにする
    db.statement((q) =>
      q
        .updateTable('invitations')
        .set({ status: 'accepted', responded_at: timestamp })
        .where((eb) =>
          eb.and([
            eb('id', '=', invitationId),
            eb('workspace_id', '=', workspaceId),
            eb('status', '=', 'pending'),
            eb.exists(q.selectFrom('memberships as nm').select('nm.id').where('nm.id', '=', membershipId)),
          ]),
        ),
    ),
    // 直前の文が招待を変えたときだけ、招待の更新を残す。変えた人は、この要求の所属の人
    db.statement((q) =>
      q
        .insertInto('change_logs')
        .columns(changeLogColumns)
        .expression(
          q
            .selectFrom('memberships as lm')
            .select((eb) => [
              eb.val(uuidv7(at)).as('id'),
              eb.val(organizationId).as('organization_id'),
              eb.val(workspaceId).as('workspace_id'),
              'lm.user_id as actor_user_id',
              eb.val('invitation').as('entity_type'),
              eb.val(invitationId).as('entity_id'),
              eb.val('update').as('action'),
              eb.val(JSON.stringify({ status: ['pending', 'accepted'] })).as('changes_json'),
              eb.val(timestamp).as('created_at'),
            ])
            .where('lm.id', '=', membershipId)
            .where(previousStatementChanged),
        ),
    ),
    // この要求の所属の行があるときだけ、所属の作成を残す。人の名前とロールは、入った行から取る
    db.statement((q) =>
      q
        .insertInto('change_logs')
        .columns(changeLogColumns)
        .expression(
          q
            .selectFrom('memberships as cm')
            .innerJoin('users as cu', 'cu.id', 'cm.user_id')
            .select((eb) => [
              eb.val(uuidv7(at)).as('id'),
              eb.val(organizationId).as('organization_id'),
              eb.val(workspaceId).as('workspace_id'),
              'cm.user_id as actor_user_id',
              eb.val('membership').as('entity_type'),
              eb.val(membershipId).as('entity_id'),
              eb.val('create').as('action'),
              eb
                .fn<string>('json_object', [
                  eb.val('user'),
                  eb.fn('json_array', [
                    eb.val(null),
                    eb.fn('json_object', [eb.val('id'), 'cu.id', eb.val('name'), 'cu.name']),
                  ]),
                  eb.val('role'),
                  eb.fn('json_array', [eb.val(null), 'cm.role']),
                ])
                .as('changes_json'),
              eb.val(timestamp).as('created_at'),
            ])
            .where('cm.id', '=', membershipId)
            .where('cu.organization_id', '=', organizationId),
        ),
    ),
  ]);

  // 読んでから書くまでに、取り消し、辞退、別の要求の承諾が先に済んだ、閉じた、所属した
  const updated = results[insertUser.length + 1];
  if ((updated?.changes ?? 0) === 0) {
    await acceptableOrThrow(db, await readOwnInvitation(db, invitationId, logins), userId, actor.accountId);
    throw new ApiError(409, 'conflict');
  }
  return { workspace_id: workspaceId };
});

// 承諾待ちの招待だけを辞退する。閉じたワークスペースへの招待も辞退できる。invitations の文の条件は id、status = 'pending'、
// 招待のログイン（呼んだ人のもの）、組織のワークスペースで、change_logs は直前の文が行を変えたときだけ入れる
export const invitationDeclineOperation = implement(invitationDecline, async ({ db, actor, tools, input }) => {
  const organizationId = db.organizationId;
  const invitationId = input.invitation_id;
  const logins = loginsOf(await tools.myLogins());

  const invitation = await readOwnInvitation(db, invitationId, logins);
  if (invitation === undefined || invitation.login_subject === null) throw new ApiError(404, 'not_found');
  if (invitation.status !== 'pending') throw new ApiError(409, 'conflict');
  const login: Login = { provider: invitation.login_provider, subject: invitation.login_subject };
  const workspaceId = invitation.workspace_id;

  const at = now();
  const respondedAt = at.toISOString();
  const results = await db.batch([
    db.statement((q) =>
      q
        .updateTable('invitations')
        .set({ status: 'declined', responded_at: respondedAt })
        .where((eb) =>
          eb.and([
            eb('id', '=', invitationId),
            eb('workspace_id', '=', workspaceId),
            eb('status', '=', 'pending'),
            eb('login_provider', '=', login.provider),
            eb('login_subject', '=', login.subject),
            eb.exists(
              eb
                .selectFrom('workspaces as w')
                .select('w.id')
                .where('w.id', '=', workspaceId)
                .where('w.organization_id', '=', organizationId),
            ),
          ]),
        ),
    ),
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
              // 承諾待ちの招待だけの人は users の行を持たないので空
              eb.val(actor.userId).as('actor_user_id'),
              eb.val('invitation').as('entity_type'),
              eb.val(invitationId).as('entity_id'),
              eb.val('update').as('action'),
              eb.val(JSON.stringify({ status: ['pending', 'declined'] })).as('changes_json'),
              eb.val(respondedAt).as('created_at'),
            ])
            .where(previousStatementChanged),
        ),
    ),
  ]);

  // 読んでから書くまでに、承諾、辞退、取り消しが先に済んだ
  if ((results[0]?.changes ?? 0) === 0) {
    if ((await readOwnInvitation(db, invitationId, logins)) === undefined) throw new ApiError(404, 'not_found');
    throw new ApiError(409, 'conflict');
  }
  return { invitation_id: invitationId };
});
