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
import { verifiedOrganizationForTest } from '../src/server/db/testing.ts';

export const AT = '2026-10-20T00:00:00.000Z';

const HEX = (bytes: Uint8Array) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

export function uuidv7(now: number = Date.now()): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  // 先頭の48ビットはミリ秒の時刻
  for (let i = 0; i < 6; i++) bytes[i] = Math.floor(now / 2 ** (8 * (5 - i))) % 256;
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = HEX(bytes);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
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
  const row: Row<CommonTables, 'organizations'> = {
    id,
    slug: `org-${id.slice(-8)}`,
    name: '青葉工房',
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
  return { ...row, verified: verifiedOrganizationForTest(row.id) } satisfies OrganizationFixture;
}

export async function createAccount(overrides: Partial<Row<CommonTables, 'accounts'>> = {}) {
  const row: Row<CommonTables, 'accounts'> = {
    id: uuidv7(),
    last_login_at: null,
    created_at: AT,
    updated_at: AT,
    ...overrides,
  };
  const db = commonDb(env);
  await db.run(db.statement((q) => q.insertInto('accounts').values(row)));
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
