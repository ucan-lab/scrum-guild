// D1 への入口。D1 には、ここの commonDb と orgDb からだけ問い合わせる（docs/development.md の「入口を守る規則」）。
// src/server/db/ の外からは、このモジュール以外を import しない（ESLint が落とす）
import { compileOnlyKysely, DbEntry } from './entry.ts';
import { commonDatabase, organizationDatabase } from './select-database.ts';
import { commonTableColumns, organizationTableColumns, type CommonTables, type OrganizationTables } from './tables.ts';
import type { VerifiedOrganization } from './verify-organization.ts';

export { sql } from 'kysely';
export type { Insertable, Selectable, Updateable } from 'kysely';
export type { ColumnSpec } from './column-spec.ts';
export type { DbEntry, Statement, StatementResult } from './entry.ts';
export { commonTableColumns, organizationTableColumns };
export type { CommonTables, OrganizationTables };
export type { VerifiedOrganization };

export type CommonDb = DbEntry<CommonTables, 'common'>;
export type OrganizationDb = DbEntry<OrganizationTables, 'organization'>;

const commonQueries = compileOnlyKysely<CommonTables>();
const organizationQueries = compileOnlyKysely<OrganizationTables>();

// 共通の6表（accounts、account_logins、sessions、oauth_states、rate_limits、organizations）
export function commonDb(env: Env): CommonDb {
  return new DbEntry(commonDatabase(env), 'common', commonQueries);
}

// 組織の中の16表。組織を確かめた結果が無いと作れない
export function orgDb(env: Env, organization: VerifiedOrganization): OrganizationDb {
  return new DbEntry(organizationDatabase(env, organization), 'organization', organizationQueries);
}
