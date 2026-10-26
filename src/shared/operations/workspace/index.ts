// ワークスペースの作成、一覧、枠、閉じると開き直し、メンバーの招待と、届いた招待の一覧、承諾、辞退が使う操作の定義
import type { AnyOperationDefinition } from '../define.ts';
import { invitationAccept } from './invitation-accept.ts';
import { invitationCreate } from './invitation-create.ts';
import { invitationDecline } from './invitation-decline.ts';
import { invitationList } from './invitation-list.ts';
import { invitationRevoke } from './invitation-revoke.ts';
import { inviteeResolve } from './invitee-resolve.ts';
import { memberList } from './member-list.ts';
import { workspaceInfo } from './workspace.ts';
import { workspaceClose } from './workspace-close.ts';
import { workspaceCreate } from './workspace-create.ts';
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
  workspaceClose,
  workspaceCreate,
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
  workspaceClose,
  workspaceReopen,
  inviteeResolve,
  invitationCreate,
  invitationRevoke,
  invitationList,
  invitationAccept,
  invitationDecline,
];
