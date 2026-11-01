import { thanksSendOperation, thanksRevokeOperation } from './thanks.ts';
// 本番に登録する操作の一覧。定義は src/shared/operations/ に、処理はここに置く（docs/development.md の「操作の定義」）。
// 仮の操作はテストの中で定義し、ここに入れない
import type { ImplementedOperation } from './implement.ts';
import { operationListOperationFor } from './operation-list.ts';
import { backlogCompletedTasksOperation } from './backlog-completed-tasks.ts';
import { experienceGrantsOperation, experienceSummaryOperation, experienceTeamTotalOperation } from './experience.ts';
import { invitationCreateOperation, invitationRevokeOperation, inviteeResolveOperation } from './invitation.ts';
import {
  invitationAcceptOperation,
  invitationDeclineOperation,
  invitationListOperation,
} from './invitation-response.ts';
import { meThemeUpdateOperation } from './me-theme.ts';
import { membershipLeaveOperation, membershipRoleUpdateOperation } from './membership.ts';
import { createOrganizationOperation, listOrganizationsOperation, resolveGithubUserOperation } from './operator.ts';
import { organizationAdminReassignOperation } from './operator-admin.ts';
import { organizationQuotaUpdateOperation } from './operator-quota.ts';
import {
  organizationResumeOperation,
  organizationSuspendOperation,
  organizationSuspensionUpdateOperation,
} from './operator-suspension.ts';
import { createMyOrganizationOperation } from './create-my-organization.ts';
import { myOrganizationsOperation, organizationInfoOperation } from './organization.ts';
import { todayOperation } from './today.ts';
import { organizationHistoryOperation } from './organization-history.ts';
import {
  organizationHolidayAddOperation,
  organizationHolidayDeleteOperation,
  organizationHolidayListOperation,
} from './organization-holiday.ts';
import { organizationSettingsUpdateOperation } from './organization-settings.ts';
import { logoutOperation, meOperation } from './session.ts';
import { consentRecordOperation, consentStatusOperation } from './consent.ts';
import { tokenCreateOperation, tokenListOperation, tokenRevokeOperation } from './token.ts';
import { userAdminUpdateOperation, userDisableOperation, userEnableOperation, userListOperation } from './user.ts';
import { planSummaryOperation } from './plan-summary.ts';
import { sprintBoardOperation, taskColumnMoveOperation } from './sprint-board.ts';
import { sprintExtendOperation } from './sprint-extend.ts';
import { sprintCloseOperation } from './sprint-close.ts';
import {
  sprintCreateOperation,
  sprintDeleteOperation,
  sprintListOperation,
  sprintStartOperation,
  sprintTaskAddOperation,
  sprintTaskRemoveOperation,
  sprintUpdateOperation,
} from './sprint.ts';
import { epicCreateOperation, epicGetOperation, epicMoveOperation, epicUpdateOperation } from './epic.ts';
import { epicDetailOperation } from './epic-detail.ts';
import { epicPartyAssignOperation, epicPartyJoinOperation, epicPartyLeaveOperation } from './epic-party.ts';
import { epicRequesterUpdateOperation, epicRewardUpdateOperation } from './epic-reward.ts';
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
  columnCreateOperation,
  columnDeleteOperation,
  columnListOperation,
  columnMoveOperation,
  columnUpdateOperation,
} from './column.ts';
import {
  storyCompleteOperation,
  storyCreateOperation,
  storyGetOperation,
  storyMoveOperation,
  storyReopenOperation,
  storyUpdateOperation,
} from './story.ts';
import { taskAssignOperation, taskDeleteOperation, taskDetailOperation, taskUpdateOperation } from './task-edit.ts';
import { taskTodayMarkOperation } from './task-today-mark.ts';
import { taskHistoryOperation } from './task-history.ts';
import {
  commentCreateOperation,
  commentDeleteOperation,
  commentListOperation,
  commentUpdateOperation,
} from './comment.ts';
import { epicDeleteOperation, storyDeleteOperation } from './tree-delete.ts';
import { backlogTreeOperation, taskCompleteOperation, taskCreateOperation, taskMoveOperation } from './task.ts';
import { taskReopenOperation } from './task-reopen.ts';
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

// 呼べる操作の一覧（operation-list）が載せる、ほかの操作
const listedOperations: readonly ImplementedOperation[] = [
  listOrganizationsOperation,
  resolveGithubUserOperation,
  createOrganizationOperation,
  organizationSuspendOperation,
  organizationSuspensionUpdateOperation,
  organizationResumeOperation,
  organizationAdminReassignOperation,
  organizationQuotaUpdateOperation,
  myOrganizationsOperation,
  createMyOrganizationOperation,
  organizationInfoOperation,
  meThemeUpdateOperation,
  todayOperation,
  organizationHolidayListOperation,
  organizationHolidayAddOperation,
  organizationHolidayDeleteOperation,
  organizationSettingsUpdateOperation,
  organizationHistoryOperation,
  userListOperation,
  userAdminUpdateOperation,
  userDisableOperation,
  userEnableOperation,
  meOperation,
  logoutOperation,
  consentStatusOperation,
  consentRecordOperation,
  tokenCreateOperation,
  tokenListOperation,
  tokenRevokeOperation,
  epicCreateOperation,
  epicGetOperation,
  epicDetailOperation,
  epicUpdateOperation,
  epicMoveOperation,
  epicPartyJoinOperation,
  epicPartyLeaveOperation,
  epicPartyAssignOperation,
  epicRewardUpdateOperation,
  epicRequesterUpdateOperation,
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
  sprintTaskAddOperation,
  sprintTaskRemoveOperation,
  sprintStartOperation,
  sprintCloseOperation,
  sprintExtendOperation,
  sprintBoardOperation,
  planSummaryOperation,
  taskColumnMoveOperation,
  taskCreateOperation,
  backlogTreeOperation,
  backlogCompletedTasksOperation,
  taskCompleteOperation,
  taskReopenOperation,
  taskDetailOperation,
  taskUpdateOperation,
  taskAssignOperation,
  taskTodayMarkOperation,
  taskDeleteOperation,
  taskMoveOperation,
  taskHistoryOperation,
  thanksSendOperation,
  thanksRevokeOperation,
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
  columnListOperation,
  columnCreateOperation,
  columnUpdateOperation,
  columnMoveOperation,
  columnDeleteOperation,
  invitationListOperation,
  invitationAcceptOperation,
  invitationDeclineOperation,
];

export const implementedOperations: readonly ImplementedOperation[] = [
  ...listedOperations,
  operationListOperationFor(listedOperations.map((operation) => operation.definition)),
];
