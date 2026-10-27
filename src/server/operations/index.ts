// 本番に登録する操作の一覧。定義は src/shared/operations/ に、処理はここに置く（docs/development.md の「操作の定義」）。
// 仮の操作はテストの中で定義し、ここに入れない
import type { ImplementedOperation } from './implement.ts';
import { experienceGrantsOperation, experienceSummaryOperation, experienceTeamTotalOperation } from './experience.ts';
import { invitationCreateOperation, invitationRevokeOperation, inviteeResolveOperation } from './invitation.ts';
import {
  invitationAcceptOperation,
  invitationDeclineOperation,
  invitationListOperation,
} from './invitation-response.ts';
import { membershipLeaveOperation, membershipRoleUpdateOperation } from './membership.ts';
import { createOrganizationOperation, listOrganizationsOperation, resolveGithubUserOperation } from './operator.ts';
import {
  organizationResumeOperation,
  organizationSuspendOperation,
  organizationSuspensionUpdateOperation,
} from './operator-suspension.ts';
import { myOrganizationsOperation, organizationInfoOperation } from './organization.ts';
import { organizationHistoryOperation } from './organization-history.ts';
import {
  organizationHolidayAddOperation,
  organizationHolidayDeleteOperation,
  organizationHolidayListOperation,
} from './organization-holiday.ts';
import { organizationSettingsUpdateOperation } from './organization-settings.ts';
import { logoutOperation, meOperation } from './session.ts';
import { sprintCreateOperation, sprintDeleteOperation, sprintListOperation, sprintUpdateOperation } from './sprint.ts';
import { epicCreateOperation, epicGetOperation, epicMoveOperation, epicUpdateOperation } from './epic.ts';
import {
  categoryCreateOperation,
  categoryDeleteOperation,
  categoryMoveOperation,
  categoryRepositoryListOperation,
  categoryUpdateOperation,
  repositoryCreateOperation,
  repositoryDeleteOperation,
  repositoryMoveOperation,
  repositoryUpdateOperation,
} from './definition.ts';
import {
  storyCompleteOperation,
  storyCreateOperation,
  storyGetOperation,
  storyMoveOperation,
  storyReopenOperation,
  storyUpdateOperation,
} from './story.ts';
import { taskAssignOperation, taskDeleteOperation, taskDetailOperation, taskUpdateOperation } from './task-edit.ts';
import { taskHistoryOperation } from './task-history.ts';
import {
  commentCreateOperation,
  commentDeleteOperation,
  commentListOperation,
  commentUpdateOperation,
} from './comment.ts';
import { epicDeleteOperation, storyDeleteOperation } from './tree-delete.ts';
import { backlogTreeOperation, taskCompleteOperation, taskCreateOperation, taskMoveOperation } from './task.ts';
import {
  memberListOperation,
  workspaceCloseOperation,
  workspaceCreateOperation,
  workspaceDodUpdateOperation,
  workspaceInfoOperation,
  workspaceLeaderCandidatesOperation,
  workspaceListOperation,
  workspaceReopenOperation,
} from './workspace.ts';

export const implementedOperations: readonly ImplementedOperation[] = [
  listOrganizationsOperation,
  resolveGithubUserOperation,
  createOrganizationOperation,
  organizationSuspendOperation,
  organizationSuspensionUpdateOperation,
  organizationResumeOperation,
  myOrganizationsOperation,
  organizationInfoOperation,
  organizationHolidayListOperation,
  organizationHolidayAddOperation,
  organizationHolidayDeleteOperation,
  organizationSettingsUpdateOperation,
  organizationHistoryOperation,
  meOperation,
  logoutOperation,
  epicCreateOperation,
  epicGetOperation,
  epicUpdateOperation,
  epicMoveOperation,
  experienceSummaryOperation,
  experienceGrantsOperation,
  experienceTeamTotalOperation,
  storyCreateOperation,
  storyGetOperation,
  storyUpdateOperation,
  storyMoveOperation,
  storyCompleteOperation,
  storyReopenOperation,
  epicDeleteOperation,
  storyDeleteOperation,
  sprintListOperation,
  sprintCreateOperation,
  sprintUpdateOperation,
  sprintDeleteOperation,
  taskCreateOperation,
  backlogTreeOperation,
  taskCompleteOperation,
  taskDetailOperation,
  taskUpdateOperation,
  taskAssignOperation,
  taskDeleteOperation,
  taskMoveOperation,
  taskHistoryOperation,
  commentListOperation,
  commentCreateOperation,
  commentUpdateOperation,
  commentDeleteOperation,
  workspaceCreateOperation,
  workspaceListOperation,
  workspaceLeaderCandidatesOperation,
  workspaceInfoOperation,
  memberListOperation,
  membershipRoleUpdateOperation,
  membershipLeaveOperation,
  workspaceCloseOperation,
  workspaceReopenOperation,
  workspaceDodUpdateOperation,
  inviteeResolveOperation,
  invitationCreateOperation,
  invitationRevokeOperation,
  categoryRepositoryListOperation,
  categoryCreateOperation,
  categoryUpdateOperation,
  categoryMoveOperation,
  categoryDeleteOperation,
  repositoryCreateOperation,
  repositoryUpdateOperation,
  repositoryMoveOperation,
  repositoryDeleteOperation,
  invitationListOperation,
  invitationAcceptOperation,
  invitationDeclineOperation,
];
