// 本番に登録する操作の一覧。定義は src/shared/operations/ に、処理はここに置く（docs/development.md の「操作の定義」）。
// 仮の操作はテストの中で定義し、ここに入れない
import type { ImplementedOperation } from './implement.ts';
import { createOrganizationOperation, listOrganizationsOperation, resolveGithubUserOperation } from './operator.ts';
import { myOrganizationsOperation, organizationInfoOperation } from './organization.ts';
import { logoutOperation, meOperation } from './session.ts';
import { storyCreateOperation, storyUpdateOperation } from './story.ts';
import { backlogTreeOperation, taskCompleteOperation, taskCreateOperation } from './task.ts';
import {
  workspaceCreateOperation,
  workspaceInfoOperation,
  workspaceLeaderCandidatesOperation,
  workspaceListOperation,
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
  storyUpdateOperation,
  taskCreateOperation,
  backlogTreeOperation,
  taskCompleteOperation,
  workspaceCreateOperation,
  workspaceListOperation,
  workspaceLeaderCandidatesOperation,
  workspaceInfoOperation,
];
