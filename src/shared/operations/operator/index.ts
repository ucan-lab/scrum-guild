// 運用者だけの操作の定義（permission: 'operator'）。運用者の権限を決める定義なので、人が差分を読む領域（docs/development.md の「マージの判定」）。
// 運用者は組織の中に特権を持たない。ここの操作の応答に、組織の中のデータ（人の名前など）を入れない
import type { AnyOperationDefinition } from '../define.ts';
import { createOrganization } from './create-organization.ts';
import { listOrganizations } from './list-organizations.ts';
import { organizationAdminReassign } from './organization-admin-reassign.ts';
import { organizationQuotaUpdate } from './organization-quota-update.ts';
import { organizationResume } from './organization-resume.ts';
import { organizationSuspend } from './organization-suspend.ts';
import { organizationSuspensionUpdate } from './organization-suspension-update.ts';
import { resolveGithubUser } from './resolve-github-user.ts';

export {
  createOrganization,
  listOrganizations,
  organizationAdminReassign,
  organizationQuotaUpdate,
  organizationResume,
  organizationSuspend,
  organizationSuspensionUpdate,
  resolveGithubUser,
};
export { reassignAdminProblems, type ReassignAdminProblem } from './organization-admin-reassign.ts';
export { ATTACHMENT_QUOTA_MAX_BYTES, MEMBER_LIMIT_MAX, QUOTA_GIB, quotaTiers } from './organization-quota-update.ts';
export { PURGE_AFTER_DAYS, purgeDateOf, suspensionKinds, type SuspensionKind } from './organization-suspend.ts';
export {
  adminNomineeInput,
  createOrganizationProblems,
  hasHiddenCharacter,
  ORGANIZATION_NAME_MAX_LENGTH,
  type CreateOrganizationProblem,
} from './create-organization.ts';
export { GITHUB_USERNAME_MAX_LENGTH } from './resolve-github-user.ts';
export { adminStatuses, type AdminStatus } from './list-organizations.ts';

export const operatorOperations: readonly AnyOperationDefinition[] = [
  listOrganizations,
  resolveGithubUser,
  createOrganization,
  organizationSuspend,
  organizationSuspensionUpdate,
  organizationResume,
  organizationAdminReassign,
  organizationQuotaUpdate,
];
