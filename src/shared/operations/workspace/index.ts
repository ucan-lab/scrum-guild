// ワークスペースの作成、一覧、枠、閉じると開き直し、完成の定義、メンバーの招待と、届いた招待の一覧、承諾、辞退、ロールの付け替え、離脱が使う操作の定義
import type { AnyOperationDefinition } from '../define.ts';
import { invitationAccept } from './invitation-accept.ts';
import { invitationCreate } from './invitation-create.ts';
import { invitationDecline } from './invitation-decline.ts';
import { invitationList } from './invitation-list.ts';
import { invitationRevoke } from './invitation-revoke.ts';
import { inviteeResolve } from './invitee-resolve.ts';
import { memberList } from './member-list.ts';
import { membershipLeave } from './membership-leave.ts';
import { membershipRoleUpdate } from './membership-role-update.ts';
import { workspaceInfo } from './workspace.ts';
import { workspaceClose } from './workspace-close.ts';
import { workspaceCreate } from './workspace-create.ts';
import { workspaceDodUpdate } from './workspace-dod-update.ts';
import { workspaceLeaderCandidates } from './workspace-leader-candidates.ts';
import { workspaceList } from './workspace-list.ts';
import { workspaceReopen } from './workspace-reopen.ts';

export {
  invitationAccept,
  invitationCreate,
  invitationDecline,
  invitationList,
  invitationRevoke,
  inviteeResolve,
  memberList,
  membershipLeave,
  membershipRoleUpdate,
  workspaceClose,
  workspaceCreate,
  workspaceDodUpdate,
  workspaceInfo,
  workspaceLeaderCandidates,
  workspaceList,
  workspaceReopen,
};

export const workspaceOperations: readonly AnyOperationDefinition[] = [
  workspaceCreate,
  workspaceList,
  workspaceLeaderCandidates,
  workspaceInfo,
  memberList,
  membershipRoleUpdate,
  membershipLeave,
  workspaceClose,
  workspaceReopen,
  workspaceDodUpdate,
  inviteeResolve,
  invitationCreate,
  invitationRevoke,
  invitationList,
  invitationAccept,
  invitationDecline,
];
