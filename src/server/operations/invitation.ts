// メンバーの招待の操作（解決、作成、取り消し）と、組織の人数と上限の読み取り（数え方は src/server/db/seats.ts。
// docs/data-model.md の organizations の「人数」）。
// 招待する人のユーザー名の解決は、組織の道具の解決器を通す（共通の表とログインの手段に、処理が直に触れない）
import type { z } from 'zod';
import { WAITING_USER_NAME_IN_LOG } from '../../shared/claim-token.ts';
import { now } from '../../shared/clock.ts';
import { normalizeEmail } from '../../shared/email.ts';
import type { InvitationCreateProblem } from '../../shared/operations/workspace/invitation-create.ts';
import { invitationCreate, invitationRevoke, inviteeResolve } from '../../shared/operations/workspace/index.ts';
import {
  personKey,
  previousStatementChanged,
  seatHoldersOf,
  uuidv7Sql,
  type OrganizationDb,
  type OrganizationTables,
  type QueryCreator,
} from '../db/index.ts';
import { ApiError } from '../errors.ts';
import { uuidv7 } from '../uuid.ts';
import { newClaimSecret } from './claim-secret.ts';
import { resolveGithubUsername } from './github-invitee.ts';
import { implement, type WorkspaceContext } from './implement.ts';
import type { OrganizationTools } from './organization-tools.ts';
import { actorUserIdOf, changeLogColumns, openWorkspace, throwIfClosed } from './write-guards.ts';

type Tables = OrganizationTables;
type From = Pick<QueryCreator<Tables>, 'selectFrom'>;

type Seats = { used: number; limit: number };

// 人数に数えられているかを見る人。sub の分かる人はログインの手段と ID、Google で sub の分かる前の人はそろえたメールアドレス
// （personKey の2つの形）
type SeatLogin = Login | EmailLogin;
type EmailLogin = { provider: 'google'; email: string };

// 組織の人数と上限。login を渡すと、その人がすでに人数に数えられているか（counted）も返す。
// member-list がリーダーと管理者に返し、招待する人の解決が counted を、招待の作成が上限の判定に使う
export async function readSeats(db: OrganizationDb, tools: OrganizationTools): Promise<Seats>;
export async function readSeats(
  db: OrganizationDb,
  tools: OrganizationTools,
  login: SeatLogin,
): Promise<Seats & { counted: boolean }>;
export async function readSeats(
  db: OrganizationDb,
  tools: OrganizationTools,
  login?: SeatLogin,
): Promise<Seats & { counted?: boolean }> {
  const [people, organization] = await Promise.all([seatHoldersOf(db, now()), tools.readOrganization()]);
  const seats = { used: people.size, limit: organization.memberLimit };
  if (login === undefined) return seats;
  const key =
    'email' in login
      ? personKey({ login_provider: login.provider, login_subject: null, login_email: login.email })
      : personKey({ login_provider: login.provider, login_subject: login.subject, login_email: null });
  return { ...seats, counted: people.has(key) };
}

// ワークスペースに今所属している、無効でない、同じログインの手段と ID の人
function currentMember(from: From, organizationId: string, workspaceId: string, login: Login) {
  return from
    .selectFrom('memberships as m')
    .innerJoin('users as u', 'u.id', 'm.user_id')
    .select('m.id')
    .where('m.workspace_id', '=', workspaceId)
    .where('m.left_at', 'is', null)
    .where('u.organization_id', '=', organizationId)
    .where('u.disabled_at', 'is', null)
    .where('u.login_provider', '=', login.provider)
    .where('u.login_subject', '=', login.subject);
}

// 同じワークスペースの、同じログインの手段と ID への承諾待ちの招待
function pendingInvitation(from: From, workspaceId: string, login: Login) {
  return from
    .selectFrom('invitations')
    .select('invitations.id')
    .where('invitations.workspace_id', '=', workspaceId)
    .where('invitations.status', '=', 'pending')
    .where('invitations.login_provider', '=', login.provider)
    .where('invitations.login_subject', '=', login.subject);
}

type Login = { provider: string; subject: string };

// 所属しているか、承諾待ちの招待があれば 409。どちらも無ければ何もしない
async function throwIfMemberOrInvited(db: OrganizationDb, workspaceId: string, login: Login): Promise<void> {
  const [memberResult, pendingResult] = await db.batch([
    db.statement((q) => currentMember(q, db.organizationId, workspaceId, login).limit(1)),
    db.statement((q) => pendingInvitation(q, workspaceId, login).limit(1)),
  ] as const);
  if (memberResult.rows.length > 0) throw new ApiError(409, 'already_member');
  if (pendingResult.rows.length > 0) throw new ApiError(409, 'already_invited');
}

// already_counted は、その人がすでに組織の人数に数えられているか。人数が上限に達していても、数えられている人は招待できるので、
// 画面が「招待する」を押せるかを決めるのに使う
export const inviteeResolveOperation = implement(inviteeResolve, async ({ db, tools, input }) => {
  const invitee = await resolveGithubUsername(tools.inviteeResolver(input.provider), input.username, 'username', {
    operation: inviteeResolve.name,
    route: 'organization',
    organizationId: db.organizationId,
  });
  const seats = await readSeats(db, tools, { provider: input.provider, subject: invitee.subject });
  return {
    login_subject: invitee.subject,
    login_name: invitee.loginName,
    display_name: invitee.displayName,
    avatar_url: invitee.avatarUrl,
    already_counted: seats.counted,
  };
});

type CreateInput = z.output<typeof invitationCreate.input>;
type CreateContext<Provider extends CreateInput['provider']> = WorkspaceContext<
  Extract<CreateInput, { provider: Provider }>
>;
type CreateOutput = z.input<typeof invitationCreate.output>;

// ログインの手段で分ける。GitHub は解決し直して確かめた人を、Google はメールアドレスで待つ招待を作る
export const invitationCreateOperation = implement(invitationCreate, async (context) => {
  const { input } = context;
  return input.provider === 'google'
    ? createGoogleInvitation({ ...context, input })
    : createGithubInvitation({ ...context, input });
});

// 作る順: ユーザー名を解決し直して、画面が確かめた ID と照合する → 所属と承諾待ちの招待を読んで断る →
// 人数を数え、上限以上で、招待する人がまだ数えられていなければ断る → invitations と change_logs を1回の batch で書く。
// invitations の文は INSERT ... SELECT ... WHERE（閉じていないワークスペース、所属していない、承諾待ちの招待が無い）にし、
// change_logs は直前の文が行を入れたときだけ入れる。読んでから書くまでに条件が崩れたら、読み直して理由を返す。
// 人数は書く文の条件に入れない。数えてから書くまでの間に同時に招待されたときは、そのまま認める（超えるのは同時に送った招待の数まで）
async function createGithubInvitation({
  db,
  actor,
  workspace,
  tools,
  input,
}: CreateContext<'github'>): Promise<CreateOutput> {
  const actorUserId = actorUserIdOf(actor);
  const organizationId = db.organizationId;
  const workspaceId = workspace.workspaceId;

  const invitee = await resolveGithubUsername(tools.inviteeResolver(input.provider), input.username, 'username', {
    operation: invitationCreate.name,
    route: 'organization',
    organizationId,
  });
  if (invitee.subject !== input.login_subject) throw new ApiError(409, 'invitee_changed');
  const login: Login = { provider: input.provider, subject: invitee.subject };
  await throwIfMemberOrInvited(db, workspaceId, login);

  const seats = await readSeats(db, tools, login);
  if (!seats.counted && seats.used >= seats.limit) throw new ApiError(409, 'member_limit_reached');

  const at = now();
  const createdAt = at.toISOString();
  const invitationId = uuidv7(at);
  const results = await db.batch([
    db.statement((q) =>
      q
        .insertInto('invitations')
        .columns([
          'id',
          'workspace_id',
          'login_provider',
          'login_subject',
          'login_name',
          'role',
          'invited_by',
          'status',
          'created_at',
        ])
        .expression(
          q
            .selectNoFrom((eb) => [
              eb.val(invitationId).as('id'),
              eb.val(workspaceId).as('workspace_id'),
              eb.val(login.provider).as('login_provider'),
              eb.val(login.subject).as('login_subject'),
              eb.val(invitee.loginName).as('login_name'),
              eb.val(input.role).as('role'),
              eb.val(actorUserId).as('invited_by'),
              eb.val('pending').as('status'),
              eb.val(createdAt).as('created_at'),
            ])
            .where((eb) =>
              eb.and([
                eb.exists(openWorkspace(eb, organizationId, workspaceId)),
                eb.not(eb.exists(currentMember(eb, organizationId, workspaceId, login))),
                eb.not(eb.exists(pendingInvitation(eb, workspaceId, login))),
              ]),
            ),
        ),
    ),
    // 直前の文が招待を入れたときだけ履歴を書く
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
              eb.val('invitation').as('entity_type'),
              eb.val(invitationId).as('entity_id'),
              eb.val('create').as('action'),
              eb
                .val(
                  JSON.stringify({
                    login_provider: [null, login.provider],
                    login_subject: [null, login.subject],
                    login_name: [null, invitee.loginName],
                    role: [null, input.role],
                  }),
                )
                .as('changes_json'),
              eb.val(createdAt).as('created_at'),
            ])
            .where(previousStatementChanged),
        ),
    ),
  ]);

  // 読んでから書くまでに、閉じたか、所属したか、別の要求が先に招待した
  if ((results[0]?.changes ?? 0) === 0) {
    await throwIfClosed(db, workspaceId);
    await throwIfMemberOrInvited(db, workspaceId, login);
    throw new ApiError(404, 'not_found');
  }
  return { invitation_id: invitationId, login_name: invitee.loginName, invite: null };
}

// Google の招待（docs/data-model.md の「メールアドレスで待つ指名と招待」）。sub が分からないので所属と承諾待ちの招待は読まない
// （所属の検査は招待の URL から結ぶときに行う）。
// 作る順: メールアドレスをそろえる（そろえられなければ 400）→ 人数を数え、上限以上で、その人（(google, そろえたメールアドレス)）が
// まだ数えられていなければ断る（招待し直しは前の招待で数えられているので通る。前の招待が期限切れなら数えられていないので断る）→
// 招待の URL の秘密を作る → 1回の batch で、1. 同じワークスペースの同じメールアドレスの承諾待ちの招待（sub を埋める前のもの）ごとの
// 取り消しの記録、2. その招待の取り消し、3. 新しい招待、4. 作成の記録（3 が入れたときだけ）を書く。
// 取り消しは読んだ ID でなく、書く時点の同じメールアドレスの承諾待ちに当てる（同時に招待し直しても一意の索引に当たらない）。
// 1〜3 はどれも閉じていないワークスペースを条件にする。記録にはメールアドレス、login_subject、秘密を入れず、login_name は仮の名前にする
async function createGoogleInvitation({
  db,
  actor,
  workspace,
  tools,
  input,
}: CreateContext<'google'>): Promise<CreateOutput> {
  const actorUserId = actorUserIdOf(actor);
  const organizationId = db.organizationId;
  const workspaceId = workspace.workspaceId;

  const email = normalizeEmail(input.email);
  if (email === undefined) {
    const problem: InvitationCreateProblem = 'email_invalid';
    throw new ApiError(400, 'invalid_input', [
      { path: 'email', code: problem, message: 'メールアドレスの形に合わない' },
    ]);
  }

  const seats = await readSeats(db, tools, { provider: 'google', email });
  if (!seats.counted && seats.used >= seats.limit) throw new ApiError(409, 'member_limit_reached');

  const at = now();
  const createdAt = at.toISOString();
  const invitationId = uuidv7(at);
  const secret = await newClaimSecret(at);
  // 書く前に作る（道具が使えない人の操作なら、書く前に止まる）
  const inviteUrl = tools.inviteUrl(secret.claimToken);

  const results = await db.batch([
    // 1. 取り消しの記録。招待の取り消し（invitation-revoke）と同じ形。当てるのは、同じワークスペースの、同じメールアドレスで待つ
    // 承諾待ちの招待（sub を埋めたものは含めない）
    db.statement((q) =>
      q
        .insertInto('change_logs')
        .columns(changeLogColumns)
        .expression(
          q
            .selectFrom('invitations as i')
            .select((eb) => [
              uuidv7Sql(at).as('id'),
              eb.val(organizationId).as('organization_id'),
              eb.ref('i.workspace_id').as('workspace_id'),
              eb.val(actorUserId).as('actor_user_id'),
              eb.val('invitation').as('entity_type'),
              eb.ref('i.id').as('entity_id'),
              eb.val('update').as('action'),
              eb.val(JSON.stringify({ status: ['pending', 'revoked'] })).as('changes_json'),
              eb.val(createdAt).as('created_at'),
            ])
            .where('i.workspace_id', '=', workspaceId)
            .where('i.status', '=', 'pending')
            .where('i.login_provider', '=', 'google')
            .where('i.login_subject', 'is', null)
            .where('i.login_email', '=', email)
            .where((eb) => eb.exists(openWorkspace(q, organizationId, workspaceId))),
        ),
    ),
    // 2. 取り消し。条件は 1 と同じ
    db.statement((q) =>
      q
        .updateTable('invitations')
        .set({ status: 'revoked', responded_at: createdAt })
        .where((eb) =>
          eb.and([
            eb('workspace_id', '=', workspaceId),
            eb('status', '=', 'pending'),
            eb('login_provider', '=', 'google'),
            eb('login_subject', 'is', null),
            eb('login_email', '=', email),
            eb.exists(openWorkspace(q, organizationId, workspaceId)),
          ]),
        ),
    ),
    // 3. 新しい招待
    db.statement((q) =>
      q
        .insertInto('invitations')
        .columns([
          'id',
          'workspace_id',
          'login_provider',
          'login_subject',
          'login_email',
          'claim_token_hash',
          'claim_expires_at',
          'login_name',
          'role',
          'invited_by',
          'status',
          'created_at',
        ])
        .expression(
          q
            .selectNoFrom((eb) => [
              eb.val(invitationId).as('id'),
              eb.val(workspaceId).as('workspace_id'),
              eb.val('google').as('login_provider'),
              eb.lit(null).as('login_subject'),
              eb.val(email).as('login_email'),
              eb.val(secret.claimTokenHash).as('claim_token_hash'),
              eb.val(secret.claimExpiresAt).as('claim_expires_at'),
              eb.val(email).as('login_name'),
              eb.val(input.role).as('role'),
              eb.val(actorUserId).as('invited_by'),
              eb.val('pending').as('status'),
              eb.val(createdAt).as('created_at'),
            ])
            .where((eb) => eb.exists(openWorkspace(eb, organizationId, workspaceId))),
        ),
    ),
    // 4. 作成の記録。直前の文が招待を入れたときだけ書く
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
              eb.val('invitation').as('entity_type'),
              eb.val(invitationId).as('entity_id'),
              eb.val('create').as('action'),
              eb
                .val(
                  JSON.stringify({
                    login_provider: [null, 'google'],
                    login_name: [null, WAITING_USER_NAME_IN_LOG],
                    role: [null, input.role],
                  }),
                )
                .as('changes_json'),
              eb.val(createdAt).as('created_at'),
            ])
            .where(previousStatementChanged),
        ),
    ),
  ]);

  // 読んでから書くまでに閉じた
  if ((results[2]?.changes ?? 0) === 0) {
    await throwIfClosed(db, workspaceId);
    throw new ApiError(404, 'not_found');
  }
  return {
    invitation_id: invitationId,
    login_name: email,
    invite: { url: inviteUrl, expires_at: secret.claimExpiresAt },
  };
}

// 承諾待ちの招待だけを取り消す。invitations の文の条件は id、workspace_id、status = 'pending'、閉じていないワークスペースで、
// change_logs は直前の文が行を変えたときだけ入れる（同時に取り消しても、履歴は1行）
export const invitationRevokeOperation = implement(invitationRevoke, async ({ db, actor, workspace, input }) => {
  const actorUserId = actorUserIdOf(actor);
  const organizationId = db.organizationId;
  const workspaceId = workspace.workspaceId;
  const invitationId = input.invitation_id;

  // ワークスペースで絞る（別のワークスペース、別の組織の招待は、無いときと同じ 404）
  const readStatus = async () =>
    (
      await db.first(
        db.statement((q) =>
          q
            .selectFrom('invitations')
            .select('invitations.status')
            .where('invitations.id', '=', invitationId)
            .where('invitations.workspace_id', '=', workspaceId),
        ),
      )
    )?.status;

  const status = await readStatus();
  if (status === undefined) throw new ApiError(404, 'not_found');
  if (status !== 'pending') throw new ApiError(409, 'conflict');

  const at = now();
  const respondedAt = at.toISOString();
  const results = await db.batch([
    db.statement((q) =>
      q
        .updateTable('invitations')
        .set({ status: 'revoked', responded_at: respondedAt })
        .where((eb) =>
          eb.and([
            eb('id', '=', invitationId),
            eb('workspace_id', '=', workspaceId),
            eb('status', '=', 'pending'),
            eb.exists(openWorkspace(q, organizationId, workspaceId)),
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
              eb.val(actorUserId).as('actor_user_id'),
              eb.val('invitation').as('entity_type'),
              eb.val(invitationId).as('entity_id'),
              eb.val('update').as('action'),
              eb.val(JSON.stringify({ status: ['pending', 'revoked'] })).as('changes_json'),
              eb.val(respondedAt).as('created_at'),
            ])
            .where(previousStatementChanged),
        ),
    ),
  ]);

  // 読んでから書くまでに、閉じたか、承諾、辞退、取り消しが先に済んだ
  if ((results[0]?.changes ?? 0) === 0) {
    await throwIfClosed(db, workspaceId);
    if ((await readStatus()) === undefined) throw new ApiError(404, 'not_found');
    throw new ApiError(409, 'conflict');
  }
  return { invitation_id: invitationId };
});
