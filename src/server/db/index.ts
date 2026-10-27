// D1 への入口。D1 には、ここの commonDb と orgDb からだけ問い合わせる（docs/development.md の「入口を守る規則」）。
// src/server/db/ の外からは、このモジュール以外を import しない（ESLint が落とす）。
// 生の SQL（kysely の sql）は db/ の中だけで使うので出さない（固定の条件 previousStatementChanged と、一覧を1つの値で渡す jsonList と、
// 行ごとの ID を SQL の中で作る uuidv7Sql と、部分索引に合わせた組織の変更の履歴の条件 organizationHistoryRowFilter と、
// 複数の行を1つの文で並びの末尾に振る tailPosition と、タイトルの検索の条件 titleContainsAll と、列に索引を使わせない unindexed だけを出す）。
// 照合用の値はテストの口（testing.ts）から出す
export type { ExpressionBuilder, Insertable, QueryCreator, Selectable } from 'kysely';
export type { Statement } from './entry.ts';
export { commonDb, orgDb, type CommonDb, type OrganizationDb } from './entries.ts';
export { DatabaseUnavailableError, pingDatabase } from './ping.ts';
export { jsonList } from './json-list.ts';
export { previousStatementChanged } from './previous-statement.ts';
export { organizationHistoryRowFilter } from './organization-history-filter.ts';
export { uuidv7Sql } from './uuid-sql.ts';
export { tailPosition } from './tail-position.ts';
export { titleContainsAll } from './title-search.ts';
export { unindexed } from './unindexed.ts';
export type { CommonTables, OrganizationTables } from './tables.ts';
export type { VerifiedOrganization } from './verify-organization.ts';
export { assertVerifiedWorkspace, type VerifiedWorkspace } from './verify-workspace.ts';
export {
  enterOrganization,
  verifyWorkspace,
  isSuspendedOrganization,
  type EnteredOrganization,
  type SuspendedOrganization,
  type LoginId,
  type OrganizationActor,
  type OrganizationSummary,
} from './enter-organization.ts';
export { insertOrganization, type CreatedOrganization, type NewOrganization } from './create-organization.ts';
// 組織の人数に数える人。組織の中の処理には、確かめた組織の入口だけを受ける seatHoldersOf を出す（組織の ID の束は受けない）
export { personKey, seatHoldersOf } from './seats.ts';
// 運用者の道具（operations/operator-tools.ts）だけが import できる（eslint.config.db-entry.js）
export { appendOperatorChangeLog, type OperatorChangeLog } from './operator-change-log.ts';
export {
  readOrganizationRow,
  userAvatarsOf,
  writeOrganizationSettings,
  type OrganizationRow,
  type OrganizationSettingsChange,
  type OrganizationSettingsWrite,
} from './organization-common.ts';
export {
  // adminStatusesOf と organizationUsageOf は、運用者の道具（operations/operator-tools.ts）だけが import できる（eslint.config.db-entry.js）
  adminStatusesOf,
  organizationUsageOf,
  type OrganizationUsage,
  claimPendingLogin,
  type ClaimInput,
  type ClaimOutcome,
  hasLoginAccess,
  readLoginAccess,
  type LoginAccess,
  type LoginAccessTarget,
  linkLoginToAccount,
  listAccountOrganizations,
  type AccountOrganizations,
} from './cross-organization.ts';
