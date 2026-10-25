// テストが組織の中の入口を使えるよう、組織を確かめた結果を確かめずに作る口。test/ からだけ import する。
// src/ の下から import すると ESLint が落とす（eslint.config.js）。Worker は src/server/index.ts から辿るので、ここは束に入らない
import { VerifiedOrganization } from './verify-organization.ts';

export function verifiedOrganizationForTest(organizationId: string): VerifiedOrganization {
  return VerifiedOrganization.issue(organizationId);
}
