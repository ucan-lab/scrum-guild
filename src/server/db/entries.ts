// 2つの入口を作る関数。D1 には、ここの commonDb と orgDb からだけ問い合わせる
import { compileOnlyKysely, DbEntry } from './entry.ts';
import { allOrganizationDatabases, commonDatabase, organizationDatabase } from './select-database.ts';
import type { CommonTables, OrganizationTables } from './tables.ts';
import type { VerifiedOrganization } from './verify-organization.ts';

const commonQueries = compileOnlyKysely<CommonTables>();
const organizationQueries = compileOnlyKysely<OrganizationTables>();

export type CommonDb = DbEntry<CommonTables, 'common'>;

// 組織の中の入口。組織で絞る処理は入口に寄せていない。呼び出し側が、organizationId（確かめた組織の ID）か、
// 確かめたワークスペース（VerifiedWorkspace）の workspaceId で自分の文を絞る
export class OrganizationDb extends DbEntry<OrganizationTables, 'organization'> {
  readonly #organizationId: string;

  constructor(d1: D1Database, organizationId: string) {
    super(d1, organizationQueries);
    this.#organizationId = organizationId;
  }

  // 確かめた組織の ID。絞り込みに使う値は、リクエストの入力ではなくここから取る
  get organizationId(): string {
    return this.#organizationId;
  }
}

// 共通の9表（accounts、account_logins、password_credentials、sessions、api_tokens、account_consents、oauth_states、rate_limits、organizations）
export function commonDb(env: Env): CommonDb {
  return new DbEntry<CommonTables, 'common'>(commonDatabase(env), commonQueries);
}

// 組織をまたいで組織の中の表を読み書きする入口。組織で絞らないので、cross-organization.ts と testing.ts だけが使う
// （index.ts は出さない）。組織の中の操作の処理には渡さない。文が自分で organization_id などの絞り込みを持つ
export function crossOrganizationEntries(env: Env): DbEntry<OrganizationTables, 'organization'>[] {
  return entriesOf(allOrganizationDatabases(env));
}

// DB の一覧から入口を作る。DB を複数にした場合をテストが確かめるのに使う（testing.ts）
export function entriesOf(databases: readonly D1Database[]): DbEntry<OrganizationTables, 'organization'>[] {
  return databases.map((d1) => new DbEntry<OrganizationTables, 'organization'>(d1, organizationQueries));
}

// 組織の中の17表。組織を確かめた結果が無いと作れない
export function orgDb(env: Env, organization: VerifiedOrganization): OrganizationDb {
  return new OrganizationDb(organizationDatabase(env, organization), organization.organizationId);
}
