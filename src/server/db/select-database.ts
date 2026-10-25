// リクエストの組織から DB を選ぶ関数（docs/data-model.md の「読み書きの入口」）。今はどの組織でも同じ DB を返す。
// 組織を分けるときは、ここだけを組織の置き場所の列を見る形に直す
import { VerifiedOrganization } from './verify-organization.ts';

export function organizationDatabase(env: Env, organization: VerifiedOrganization): D1Database {
  if (!VerifiedOrganization.is(organization)) throw new Error('組織を確かめた結果ではない');
  return env.DB;
}

// 共通の表の DB。組織の DB を分けても、共通の表は1つの DB に残る
export function commonDatabase(env: Env): D1Database {
  return env.DB;
}
