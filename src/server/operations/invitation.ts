// メンバーの招待の操作（解決、作成、取り消し）と、組織の人数の数え方（docs/data-model.md の organizations の「人数」）。
// 招待する人のユーザー名の解決は、組織の道具の解決器を通す（共通の表とログインの手段に、処理が直に触れない）
import { now } from '../../shared/clock.ts';
import { invitationCreate, invitationRevoke, inviteeResolve } from '../../shared/operations/workspace/index.ts';
import {
  previousStatementChanged,
  type OrganizationDb,
  type OrganizationTables,
  type QueryCreator,
} from '../db/index.ts';
import { ApiError } from '../errors.ts';
import { uuidv7 } from '../uuid.ts';
import { resolveGithubUsername } from './github-invitee.ts';
import { implement } from './implement.ts';
import type { OrganizationTools } from './organization-tools.ts';
import { actorUserIdOf, changeLogColumns, openWorkspace, throwIfClosed } from './write-guards.ts';

type Tables = OrganizationTables;
type From = Pick<QueryCreator<Tables>, 'selectFrom'>;

// 1人の見分け方。sub の行は (login_provider, login_subject)、Google で待つ行は (login_provider, login_email) で1人
// （docs/data-model.md の「メールアドレスで待つ指名と招待」）
function personKey(row: { login_provider: string; login_subject: string | null; login_email: string | null }): string {
  return row.login_subject !== null
    ? `${row.login_provider}:subject:${row.login_subject}`
    : `${row.login_provider}:email:${row.login_email ?? ''}`;
}

// 組織の人数に数える人（personKey の集合）。無効にしていない人のうち、管理者か、いずれかのワークスペースに今所属している人と、
// 承諾待ちの招待（まだアカウントのない人への招待を含む）を持つ人を、同じ人は1人として数える。招待のうち、期限の過ぎた Google の招待、
// 閉じたワークスペースへの招待、同じ組織で無効にされた人（同じログインの手段と ID）への招待は数えない。
// 保存せず、招待のたびと、メンバーの画面を開くたびに数える。数える人は member_limit でおおよそ抑えられ、読む行もワークスペースの所属と
// 承諾待ちの招待（1つのワークスペースで数十件の想定）なので、件数で区切らずに読み、アプリで重なりと期限切れを除く
async function seatHolders(db: OrganizationDb, at: Date): Promise<Set<string>> {
  const organizationId = db.organizationId;
  const [userResult, invitationResult] = await db.batch([
    db.statement((q) =>
      q
        .selectFrom('users')
        .select(['users.login_provider', 'users.login_subject', 'users.login_email'])
        .where('users.organization_id', '=', organizationId)
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
                .where('w.organization_id', '=', organizationId),
            ),
          ]),
        ),
    ),
    db.statement((q) =>
      q
        .selectFrom('invitations as i')
        .innerJoin('workspaces as w', 'w.id', 'i.workspace_id')
        .select(['i.login_provider', 'i.login_subject', 'i.login_email', 'i.claim_expires_at'])
        .where('w.organization_id', '=', organizationId)
        .where('w.closed_at', 'is', null)
        .where('i.status', '=', 'pending')
        .where((eb) =>
          eb.not(
            eb.exists(
              eb
                .selectFrom('users as d')
                .select('d.id')
                .where('d.organization_id', '=', organizationId)
                .where('d.disabled_at', 'is not', null)
                .whereRef('d.login_provider', '=', 'i.login_provider')
                .whereRef('d.login_subject', '=', 'i.login_subject'),
            ),
          ),
        ),
    ),
  ] as const);
  const people = new Set(userResult.rows.map(personKey));
  const time = at.getTime();
  for (const row of invitationResult.rows) {
    // 期限の判定は member-list の expired と同じく時刻で比べる
    if (row.claim_expires_at !== null && Date.parse(row.claim_expires_at) <= time) continue;
    people.add(personKey(row));
  }
  return people;
}

type Seats = { used: number; limit: number };

// 組織の人数と上限。login を渡すと、その人がすでに人数に数えられているか（counted）も返す。
// member-list がリーダーと管理者に返し、招待する人の解決が counted を、招待の作成が上限の判定に使う
export async function readSeats(db: OrganizationDb, tools: OrganizationTools): Promise<Seats>;
export async function readSeats(
  db: OrganizationDb,
  tools: OrganizationTools,
  login: Login,
): Promise<Seats & { counted: boolean }>;
export async function readSeats(
  db: OrganizationDb,
  tools: OrganizationTools,
  login?: Login,
): Promise<Seats & { counted?: boolean }> {
  const [people, organization] = await Promise.all([seatHolders(db, now()), tools.readOrganization()]);
  const seats = { used: people.size, limit: organization.memberLimit };
  if (login === undefined) return seats;
  return {
    ...seats,
    counted: people.has(personKey({ login_provider: login.provider, login_subject: login.subject, login_email: null })),
  };
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

// 作る順: ユーザー名を解決し直して、画面が確かめた ID と照合する → 所属と承諾待ちの招待を読んで断る →
// 人数を数え、上限以上で、招待する人がまだ数えられていなければ断る → invitations と change_logs を1回の batch で書く。
// invitations の文は INSERT ... SELECT ... WHERE（閉じていないワークスペース、所属していない、承諾待ちの招待が無い）にし、
// change_logs は直前の文が行を入れたときだけ入れる。読んでから書くまでに条件が崩れたら、読み直して理由を返す。
// 人数は書く文の条件に入れない。数えてから書くまでの間に同時に招待されたときは、そのまま認める（超えるのは同時に送った招待の数まで）
export const invitationCreateOperation = implement(invitationCreate, async ({ db, actor, workspace, tools, input }) => {
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
  return { invitation_id: invitationId, login_name: invitee.loginName };
});

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
