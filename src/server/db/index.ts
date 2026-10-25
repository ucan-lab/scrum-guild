// D1 への入口。D1 には、ここの commonDb と orgDb からだけ問い合わせる（docs/development.md の「入口を守る規則」）。
// src/server/db/ の外からは、このモジュール以外を import しない（ESLint が落とす）。
// 生の SQL（kysely の sql）は db/ の中だけで使うので出さない（固定の条件 previousStatementChanged だけを、値として出す）。
// 照合用の値はテストの口（testing.ts）から出す
export type { Insertable, QueryCreator, Selectable } from 'kysely';
export type { Statement } from './entry.ts';
export { commonDb, orgDb, type CommonDb, type OrganizationDb } from './entries.ts';
export { DatabaseUnavailableError, pingDatabase } from './ping.ts';
export { previousStatementChanged } from './previous-statement.ts';
export type { CommonTables, OrganizationTables } from './tables.ts';
export type { VerifiedOrganization } from './verify-organization.ts';
export { assertVerifiedWorkspace, type VerifiedWorkspace } from './verify-workspace.ts';
export {
  enterOrganization,
  verifyWorkspace,
  ORGANIZATION_SUSPENDED,
  type EnteredOrganization,
  type LoginId,
  type OrganizationActor,
  type OrganizationSummary,
} from './enter-organization.ts';
export { insertOrganization, type CreatedOrganization, type NewOrganization } from './create-organization.ts';
export { openOrganizationAsOperator } from './operator-organization.ts';
export {
  readOrganizationRow,
  userAvatarsOf,
  writeOrganizationSettings,
  type OrganizationRow,
  type OrganizationSettingsChange,
} from './organization-common.ts';
export {
  adminStatusesOf,
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
