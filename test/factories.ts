// テストごとに要る行だけを作るファクトリー（docs/development.md の「架空のデータ」）。入口を通して書く。
// 名前は架空。ID は UUIDv7 の形で、呼ぶたびに新しい値になるので、同じテストファイルの前のテストの行とぶつからない
import { env } from 'cloudflare:workers';
import {
  commonDb,
  orgDb,
  type CommonTables,
  type OrganizationTables,
  type Selectable,
  type VerifiedOrganization,
} from '../src/server/db/index.ts';
import { PRIVACY_VERSION, TERMS_VERSION } from '../src/lib/legal/versions.ts';
import { hashSessionToken } from '../src/server/auth/session.ts';
import { uuidv7 as newUuidv7 } from '../src/server/uuid.ts';
import { verifiedOrganizationForTest } from '../src/server/db/testing.ts';

export const AT = '2026-10-20T00:00:00.000Z';

const HEX = (bytes: Uint8Array) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

export function uuidv7(now: number = Date.now()): string {
  return newUuidv7(new Date(now));
}

// sessions.token_hash などの SHA-256 の小文字の16進64文字の形
export function hash64(): string {
  return HEX(crypto.getRandomValues(new Uint8Array(32)));
}

// GitHub のユーザー ID の形（数字の文字列）。一意の索引（組織とログインの ID）にぶつからないよう、呼ぶたびに進める
let loginSubject = 1000000;
function nextLoginSubject(): string {
  return String(loginSubject++);
}

type Row<Tables, Table extends keyof Tables> = Selectable<Tables[Table]>;

export type OrganizationFixture = Row<CommonTables, 'organizations'> & {
  // 組織の中の入口に渡す、組織を確かめた結果（確かめずにテストが作る）
  verified: VerifiedOrganization;
};

export async function createOrganization(overrides: Partial<Row<CommonTables, 'organizations'>> = {}) {
  const id = overrides.id ?? uuidv7();
  // 作った人のアカウントとお試しの期限は、渡さなければ列を省いて NULL にする（運用者が作った組織の形）
  const row: Omit<Row<CommonTables, 'organizations'>, 'created_by_account_id' | 'trial_ends_on'> &
    Partial<Pick<Row<CommonTables, 'organizations'>, 'created_by_account_id' | 'trial_ends_on'>> = {
    id,
    slug: `org-${id.slice(-8)}`,
    name: '青葉工房',
    // 列は残っているので、言葉づかいを選べた頃の 'game' の行を模す（画面も API もこの値を読まない）
    vocabulary: 'game',
    theme: 'simple',
    suspended_at: null,
    purge_on: null,
    member_limit: 15,
    attachment_quota_bytes: 32212254720,
    attachment_quota_warned_at: null,
    stores_source_payload: 0,
    created_by_operator: 'github:9000000000000001',
    created_at: AT,
    updated_at: AT,
    ...overrides,
  };
  const db = commonDb(env);
  await db.run(db.statement((q) => q.insertInto('organizations').values(row)));
  return {
    created_by_account_id: null,
    trial_ends_on: null,
    ...row,
    verified: verifiedOrganizationForTest(row.id),
  } satisfies OrganizationFixture;
}

// createAccount が足す同意の行の日時
export const CONSENTED_AT = '2026-10-31T00:00:00.000Z';

// 既定で今の版の同意の行を足す（未同意の人は、同意するまで操作できない）。未同意の人を作るときは { consented: false }
export async function createAccount(
  overrides: Partial<Row<CommonTables, 'accounts'>> = {},
  options: { consented?: boolean } = {},
) {
  const row: Row<CommonTables, 'accounts'> = {
    id: uuidv7(),
    last_login_at: null,
    created_at: AT,
    updated_at: AT,
    ...overrides,
  };
  const db = commonDb(env);
  await db.run(db.statement((q) => q.insertInto('accounts').values(row)));
  if (options.consented ?? true) {
    await db.run(
      db.statement((q) =>
        q.insertInto('account_consents').values({
          account_id: row.id,
          terms_version: TERMS_VERSION,
          privacy_version: PRIVACY_VERSION,
          consented_at: CONSENTED_AT,
        }),
      ),
    );
  }
  return row;
}

export async function createAccountLogin(
  accountId: string,
  overrides: Partial<Row<CommonTables, 'account_logins'>> = {},
) {
  const row: Row<CommonTables, 'account_logins'> = {
    login_provider: 'github',
    login_subject: nextLoginSubject(),
    account_id: accountId,
    login_name: 'mio-hoshino',
    display_name: '星野 澪',
    avatar_url: null,
    created_at: AT,
    updated_at: AT,
    ...overrides,
  };
  const db = commonDb(env);
  await db.run(db.statement((q) => q.insertInto('account_logins').values(row)));
  return row;
}

export async function createSession(accountId: string, overrides: Partial<Row<CommonTables, 'sessions'>> = {}) {
  const row: Row<CommonTables, 'sessions'> = {
    token_hash: hash64(),
    account_id: accountId,
    created_at: AT,
    last_used_at: AT,
    expires_at: '2026-11-19T00:00:00.000Z',
    ...overrides,
  };
  const db = commonDb(env);
  await db.run(db.statement((q) => q.insertInto('sessions').values(row)));
  return row;
}

// Cookie に入れるトークンと、DB の行を作る。トークンは本物と同じ base64url の43文字
export async function createSessionWithToken(
  accountId: string,
  overrides: Partial<Row<CommonTables, 'sessions'>> = {},
) {
  const token = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
  const row = await createSession(accountId, { token_hash: await hashSessionToken(token), ...overrides });
  return { token, row };
}

export async function createInvitation(
  organization: OrganizationFixture,
  workspaceId: string,
  invitedBy: string,
  login: { provider: string; subject: string },
  overrides: Partial<Row<OrganizationTables, 'invitations'>> = {},
) {
  const row: Row<OrganizationTables, 'invitations'> = {
    id: uuidv7(),
    workspace_id: workspaceId,
    login_provider: login.provider,
    login_subject: login.subject,
    login_email: null,
    claim_token_hash: null,
    claim_expires_at: null,
    login_name: 'haruka-aoi',
    role: 'member',
    invited_by: invitedBy,
    status: 'pending',
    responded_at: null,
    created_at: AT,
    ...overrides,
  };
  const db = orgDb(env, organization.verified);
  await db.run(db.statement((q) => q.insertInto('invitations').values(row)));
  return row;
}

export async function createUser(
  organization: OrganizationFixture,
  overrides: Partial<Row<OrganizationTables, 'users'>> = {},
) {
  const row: Row<OrganizationTables, 'users'> = {
    id: uuidv7(),
    organization_id: organization.id,
    account_id: null,
    login_provider: 'github',
    login_subject: nextLoginSubject(),
    login_email: null,
    claim_token_hash: null,
    claim_expires_at: null,
    name: '星野 澪',
    is_admin: 0,
    work_start_on: null,
    work_end_on: null,
    disabled_at: null,
    last_seen_at: null,
    theme: null,
    created_at: AT,
    updated_at: AT,
    ...overrides,
  };
  const db = orgDb(env, organization.verified);
  await db.run(db.statement((q) => q.insertInto('users').values(row)));
  return row;
}

export async function createWorkspace(
  organization: OrganizationFixture,
  createdBy: string,
  overrides: Partial<Row<OrganizationTables, 'workspaces'>> = {},
) {
  const row: Row<OrganizationTables, 'workspaces'> = {
    id: uuidv7(),
    organization_id: organization.id,
    name: '青葉チーム',
    timezone: 'Asia/Tokyo',
    week_start: 1,
    // 列は残っているので、言葉づかいを選べた頃の 'game' の行を模す（画面も API もこの値を読まない）
    vocabulary: 'game',
    definition_of_done_md: null,
    closed_at: null,
    created_by: createdBy,
    created_at: AT,
    updated_at: AT,
    ...overrides,
  };
  const db = orgDb(env, organization.verified);
  await db.run(db.statement((q) => q.insertInto('workspaces').values(row)));
  return row;
}

export async function createMembership(
  organization: OrganizationFixture,
  workspaceId: string,
  userId: string,
  overrides: Partial<Row<OrganizationTables, 'memberships'>> = {},
) {
  const row: Row<OrganizationTables, 'memberships'> = {
    id: uuidv7(),
    workspace_id: workspaceId,
    user_id: userId,
    role: 'member',
    joined_on: '2026-10-01',
    left_on: null,
    joined_at: AT,
    left_at: null,
    ...overrides,
  };
  const db = orgDb(env, organization.verified);
  await db.run(db.statement((q) => q.insertInto('memberships').values(row)));
  return row;
}

// 組織の休日の日付。主キー（組織と日付）にぶつからないよう、呼ぶたびに1日進める（2040-01-01 から）
let holidayDay = 0;
function nextHolidayOn(): string {
  return new Date(Date.UTC(2040, 0, 1 + holidayDay++)).toISOString().slice(0, 10);
}

export async function createOrganizationHoliday(
  organization: OrganizationFixture,
  createdBy: string,
  overrides: Partial<Row<OrganizationTables, 'organization_holidays'>> = {},
) {
  const row: Row<OrganizationTables, 'organization_holidays'> = {
    organization_id: organization.id,
    holiday_on: nextHolidayOn(),
    name: '創立記念日',
    created_by: createdBy,
    created_at: AT,
    ...overrides,
  };
  const db = orgDb(env, organization.verified);
  await db.run(db.statement((q) => q.insertInto('organization_holidays').values(row)));
  return row;
}

// 変更の履歴の1行。既定は組織の変更（workspace_id が空）で、運用者の操作でも人の操作でもない行
export async function createChangeLog(
  organization: OrganizationFixture,
  overrides: Partial<Row<OrganizationTables, 'change_logs'>> = {},
) {
  const row: Row<OrganizationTables, 'change_logs'> = {
    id: uuidv7(),
    organization_id: organization.id,
    workspace_id: null,
    actor_user_id: null,
    operator: null,
    entity_type: 'organization',
    entity_id: organization.id,
    action: 'update',
    changes_json: '{}',
    created_at: AT,
    ...overrides,
  };
  const db = orgDb(env, organization.verified);
  await db.run(db.statement((q) => q.insertInto('change_logs').values(row)));
  return row;
}

export async function createCategory(
  organization: OrganizationFixture,
  workspaceId: string,
  overrides: Partial<Row<OrganizationTables, 'categories'>> = {},
) {
  const row: Row<OrganizationTables, 'categories'> = {
    id: uuidv7(),
    workspace_id: workspaceId,
    name: '保守',
    is_billed_monthly: 0,
    position: 'a0',
    deleted_at: null,
    created_at: AT,
    updated_at: AT,
    ...overrides,
  };
  const db = orgDb(env, organization.verified);
  await db.run(db.statement((q) => q.insertInto('categories').values(row)));
  return row;
}

export async function createRepository(
  organization: OrganizationFixture,
  workspaceId: string,
  overrides: Partial<Row<OrganizationTables, 'repositories'>> = {},
) {
  const row: Row<OrganizationTables, 'repositories'> = {
    id: uuidv7(),
    workspace_id: workspaceId,
    name: 'shop-api',
    provider: null,
    source_container_id: null,
    source_container_name: null,
    position: 'a0',
    deleted_at: null,
    created_at: AT,
    updated_at: AT,
    ...overrides,
  };
  const db = orgDb(env, organization.verified);
  await db.run(db.statement((q) => q.insertInto('repositories').values(row)));
  return row;
}

// エピック。依頼主と作った人が要る
export async function createEpic(
  organization: OrganizationFixture,
  workspaceId: string,
  createdBy: string,
  overrides: Partial<Row<OrganizationTables, 'epics'>> = {},
) {
  const row: Row<OrganizationTables, 'epics'> = {
    id: uuidv7(),
    workspace_id: workspaceId,
    title: '会員ポイント制度を公開する',
    body_md: null,
    category_id: null,
    due_on: null,
    link_url: null,
    reward_tier: 'small',
    requester_user_id: createdBy,
    created_by: createdBy,
    completed_at: null,
    completed_by: null,
    canceled_at: null,
    canceled_by: null,
    position: 'a0',
    deleted_at: null,
    created_at: AT,
    updated_at: AT,
    ...overrides,
  };
  const db = orgDb(env, organization.verified);
  await db.run(db.statement((q) => q.insertInto('epics').values(row)));
  return row;
}

// エピックの下に入っていないストーリー。作った人が要る
export async function createStory(
  organization: OrganizationFixture,
  workspaceId: string,
  createdBy: string,
  overrides: Partial<Row<OrganizationTables, 'stories'>> = {},
) {
  const row: Row<OrganizationTables, 'stories'> = {
    id: uuidv7(),
    workspace_id: workspaceId,
    epic_id: null,
    title: '見積もりを整える',
    acceptance_criteria_md: null,
    body_md: null,
    category_id: null,
    due_on: null,
    link_url: null,
    created_by: createdBy,
    completed_at: null,
    completed_by: null,
    position: 'a0',
    deleted_at: null,
    created_at: AT,
    updated_at: AT,
    ...overrides,
  };
  const db = orgDb(env, organization.verified);
  await db.run(db.statement((q) => q.insertInto('stories').values(row)));
  return row;
}

// 手で作ったバックログのタスク。起票した人が要る
export async function createTask(
  organization: OrganizationFixture,
  workspaceId: string,
  createdBy: string,
  overrides: Partial<Row<OrganizationTables, 'tasks'>> = {},
) {
  const row: Row<OrganizationTables, 'tasks'> = {
    id: uuidv7(),
    workspace_id: workspaceId,
    is_imported: 0,
    tray: 'backlog',
    title: '見積もりを送る',
    body_md: null,
    link_url: null,
    story_id: null,
    category_id: null,
    repository_id: null,
    sprint_id: null,
    column_id: null,
    assignee_user_id: null,
    points: null,
    due_on: null,
    today_on: null,
    completed_at: null,
    completed_by: null,
    position: 'a0',
    column_position: null,
    created_by: createdBy,
    created_at: AT,
    updated_at: AT,
    deleted_at: null,
    ...overrides,
  };
  const db = orgDb(env, organization.verified);
  await db.run(db.statement((q) => q.insertInto('tasks').values(row)));
  return row;
}

// タスクのコメント。既定は消していないコメントで、時刻は呼ぶたびに後ろへずらす（書いた順に並ぶ）
let commentClock = Date.UTC(2026, 9, 20);
export async function createComment(
  organization: OrganizationFixture,
  workspaceId: string,
  taskId: string,
  authorUserId: string,
  overrides: Partial<Row<OrganizationTables, 'comments'>> = {},
) {
  const at = commentClock++;
  const row: Row<OrganizationTables, 'comments'> = {
    id: uuidv7(at),
    workspace_id: workspaceId,
    task_id: taskId,
    author_user_id: authorUserId,
    body_md: '確認しました。手順の 2 番目から進めます。',
    edited_at: null,
    deleted_at: null,
    deleted_by: null,
    created_at: new Date(at).toISOString(),
    ...overrides,
  };
  const db = orgDb(env, organization.verified);
  await db.run(db.statement((q) => q.insertInto('comments').values(row)));
  return row;
}

// 先のスプリント（planned）。期間の重なりは操作が断るもので、ここでは確かめない（重ねたいテストは期間を渡す）
export async function createSprint(
  organization: OrganizationFixture,
  workspaceId: string,
  overrides: Partial<Row<OrganizationTables, 'sprints'>> = {},
) {
  const row: Row<OrganizationTables, 'sprints'> = {
    id: uuidv7(),
    workspace_id: workspaceId,
    name: null,
    goal: null,
    start_on: '2026-11-02',
    end_on: '2026-11-15',
    status: 'planned',
    extended_days: 0,
    is_goal_achieved: null,
    started_at: null,
    started_by: null,
    closed_at: null,
    closed_by: null,
    deleted_at: null,
    created_at: AT,
    updated_at: AT,
    ...overrides,
  };
  const db = orgDb(env, organization.verified);
  await db.run(db.statement((q) => q.insertInto('sprints').values(row)));
  return row;
}

// ワークスペースの列。既定は完了でない列（名前あり）。完了の列は is_done: 1 と name: null を渡す（ワークスペースに1つ）
export async function createBoardColumn(
  organization: OrganizationFixture,
  workspaceId: string,
  overrides: Partial<Row<OrganizationTables, 'board_columns'>> = {},
) {
  const row: Row<OrganizationTables, 'board_columns'> = {
    id: uuidv7(),
    workspace_id: workspaceId,
    name: '出発前',
    is_done: 0,
    position: 'a0',
    deleted_at: null,
    created_at: AT,
    updated_at: AT,
    ...overrides,
  };
  const db = orgDb(env, organization.verified);
  await db.run(db.statement((q) => q.insertInto('board_columns').values(row)));
  return row;
}

export async function createDetailField(
  organization: OrganizationFixture,
  workspaceId: string,
  overrides: Partial<Row<OrganizationTables, 'detail_fields'>> = {},
) {
  const row: Row<OrganizationTables, 'detail_fields'> = {
    id: uuidv7(),
    workspace_id: workspaceId,
    name: '影響範囲',
    position: 'a0',
    deleted_at: null,
    created_at: AT,
    updated_at: AT,
    ...overrides,
  };
  const db = orgDb(env, organization.verified);
  await db.run(db.statement((q) => q.insertInto('detail_fields').values(row)));
  return row;
}

// ポイントあたりの時間。主キー（ワークスペースと月）にぶつかるなら月を渡す
export async function createWorkspacePointRate(
  organization: OrganizationFixture,
  workspaceId: string,
  overrides: Partial<Row<OrganizationTables, 'workspace_point_rates'>> = {},
) {
  const row: Row<OrganizationTables, 'workspace_point_rates'> = {
    workspace_id: workspaceId,
    effective_month: '2026-10',
    hours_per_point: 2,
    created_at: AT,
    ...overrides,
  };
  const db = orgDb(env, organization.verified);
  await db.run(db.statement((q) => q.insertInto('workspace_point_rates').values(row)));
  return row;
}

// タスクの完了の記録。完了した人が要る
export async function createCompletion(
  organization: OrganizationFixture,
  workspaceId: string,
  taskId: string,
  completedBy: string,
  overrides: Partial<Row<OrganizationTables, 'completions'>> = {},
) {
  const row: Row<OrganizationTables, 'completions'> = {
    id: uuidv7(),
    workspace_id: workspaceId,
    task_id: taskId,
    completed_at: AT,
    completed_by: completedBy,
    points: null,
    assignee_user_id: null,
    sprint_id: null,
    previous_column_id: null,
    category_id: null,
    billing_month: null,
    created_at: AT,
    updated_at: AT,
    ...overrides,
  };
  const db = orgDb(env, organization.verified);
  await db.run(db.statement((q) => q.insertInto('completions').values(row)));
  return row;
}

// タスクがスプリントに入った行。既定は入っている間の行（ended_at と outcome が空）。タスクの sprint_id と column_id は呼ぶ側がそろえる
export async function createSprintEntry(
  organization: OrganizationFixture,
  workspaceId: string,
  sprintId: string,
  taskId: string,
  addedBy: string,
  overrides: Partial<Row<OrganizationTables, 'sprint_entries'>> = {},
) {
  const row: Row<OrganizationTables, 'sprint_entries'> = {
    id: uuidv7(),
    workspace_id: workspaceId,
    sprint_id: sprintId,
    task_id: taskId,
    added_at: AT,
    added_by: addedBy,
    ended_at: null,
    outcome: null,
    ...overrides,
  };
  const db = orgDb(env, organization.verified);
  await db.run(db.statement((q) => q.insertInto('sprint_entries').values(row)));
  return row;
}

// 経験値の明細の1行。既定は起票の 10 で、dedupe_key は呼ぶたびに別の値にする。打ち消しは amount を負にして reverses_grant_id で元を指す
export async function createXpGrant(
  organization: OrganizationFixture,
  workspaceId: string,
  userId: string,
  overrides: Partial<Row<OrganizationTables, 'xp_grants'>> = {},
) {
  const id = overrides.id ?? uuidv7();
  const row: Row<OrganizationTables, 'xp_grants'> = {
    id,
    workspace_id: workspaceId,
    user_id: userId,
    action: 'task_created',
    task_id: null,
    story_id: null,
    epic_id: null,
    completion_id: null,
    thank_id: null,
    helper_sender_user_id: null,
    amount: 10,
    reverses_grant_id: null,
    dedupe_key: `test:${id}`,
    confirmed_at: AT,
    ...overrides,
  };
  const db = orgDb(env, organization.verified);
  await db.run(db.statement((q) => q.insertInto('xp_grants').values(row)));
  return row;
}

// エピックの討伐隊の1人。既定は受注（joined_via が self、入れたのは本人）
export async function createEpicPartyMember(
  organization: OrganizationFixture,
  epicId: string,
  userId: string,
  overrides: Partial<Row<OrganizationTables, 'epic_party_members'>> = {},
) {
  const row: Row<OrganizationTables, 'epic_party_members'> = {
    epic_id: epicId,
    user_id: userId,
    joined_via: 'self',
    added_by: userId,
    joined_at: AT,
    ...overrides,
  };
  const db = orgDb(env, organization.verified);
  await db.run(db.statement((q) => q.insertInto('epic_party_members').values(row)));
  return row;
}

// 感謝の1行。送る人と受け取る人は別の人にする
export async function createThanks(
  organization: OrganizationFixture,
  workspaceId: string,
  taskId: string,
  senderUserId: string,
  recipientUserId: string,
  overrides: Partial<Row<OrganizationTables, 'thanks'>> = {},
) {
  const row: Row<OrganizationTables, 'thanks'> = {
    id: uuidv7(),
    workspace_id: workspaceId,
    task_id: taskId,
    sender_user_id: senderUserId,
    recipient_user_id: recipientUserId,
    created_at: AT,
    ...overrides,
  };
  const db = orgDb(env, organization.verified);
  await db.run(db.statement((q) => q.insertInto('thanks').values(row)));
  return row;
}
