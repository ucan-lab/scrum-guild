// 本番に登録する操作の一覧。定義は src/shared/operations/ に、処理はここに置く（docs/development.md の「操作の定義」）。
// 仮の操作はテストの中で定義し、ここに入れない
import type { ImplementedOperation } from './implement.ts';
import { invitationCreateOperation, invitationRevokeOperation, inviteeResolveOperation } from './invitation.ts';
import { createOrganizationOperation, listOrganizationsOperation, resolveGithubUserOperation } from './operator.ts';
import { myOrganizationsOperation, organizationInfoOperation } from './organization.ts';
import { logoutOperation, meOperation } from './session.ts';
import { storyCreateOperation, storyGetOperation, storyMoveOperation, storyUpdateOperation } from './story.ts';
import { taskAssignOperation, taskDeleteOperation, taskDetailOperation, taskUpdateOperation } from './task-edit.ts';
import { backlogTreeOperation, taskCompleteOperation, taskCreateOperation, taskMoveOperation } from './task.ts';
import {
  memberListOperation,
  workspaceCloseOperation,
  workspaceCreateOperation,
  workspaceInfoOperation,
  workspaceLeaderCandidatesOperation,
  workspaceListOperation,
  workspaceReopenOperation,
} from './workspace.ts';

export const implementedOperations: readonly ImplementedOperation[] = [
  listOrganizationsOperation,
  resolveGithubUserOperation,
  createOrganizationOperation,
  myOrganizationsOperation,
  organizationInfoOperation,
  meOperation,
  logoutOperation,
  storyCreateOperation,
  storyGetOperation,
  storyUpdateOperation,
  storyMoveOperation,
  taskCreateOperation,
  backlogTreeOperation,
  taskCompleteOperation,
  taskDetailOperation,
  taskUpdateOperation,
  taskAssignOperation,
  taskDeleteOperation,
  taskMoveOperation,
  workspaceCreateOperation,
  workspaceListOperation,
  workspaceLeaderCandidatesOperation,
  workspaceInfoOperation,
  memberListOperation,
  workspaceCloseOperation,
  workspaceReopenOperation,
  inviteeResolveOperation,
  invitationCreateOperation,
  invitationRevokeOperation,
];
