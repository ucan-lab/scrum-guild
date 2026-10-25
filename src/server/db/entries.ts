// 2つの入口を作る関数。D1 には、ここの commonDb と orgDb からだけ問い合わせる
import { compileOnlyKysely, DbEntry } from './entry.ts';
import { commonDatabase, organizationDatabase } from './select-database.ts';
import type { CommonTables, OrganizationTables } from './tables.ts';
import type { VerifiedOrganization } from './verify-organization.ts';

const commonQueries = compileOnlyKysely<CommonTables>();
const organizationQueries = compileOnlyKysely<OrganizationTables>();

export type CommonDb = DbEntry<CommonTables, 'common'>;

// 組織の中の入口。組織で絞る処理は入口に寄せていない。呼び出し側が、organizationId（確かめた組織の ID）か、
// 組織を確かめた workspace_id で自分の文を絞る。絞り込みを入口に寄せるかは #51 で決める
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

// 共通の6表（accounts、account_logins、sessions、oauth_states、rate_limits、organizations）
export function commonDb(env: Env): CommonDb {
  return new DbEntry<CommonTables, 'common'>(commonDatabase(env), commonQueries);
}

// 組織の中の16表。組織を確かめた結果が無いと作れない
export function orgDb(env: Env, organization: VerifiedOrganization): OrganizationDb {
  return new OrganizationDb(organizationDatabase(env, organization), organization.organizationId);
}
