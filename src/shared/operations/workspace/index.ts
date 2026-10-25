// ワークスペースの作成、一覧、枠、閉じると開き直しが使う操作の定義
import type { AnyOperationDefinition } from '../define.ts';
import { memberList } from './member-list.ts';
import { workspaceInfo } from './workspace.ts';
import { workspaceClose } from './workspace-close.ts';
import { workspaceCreate } from './workspace-create.ts';
import { workspaceLeaderCandidates } from './workspace-leader-candidates.ts';
import { workspaceList } from './workspace-list.ts';
import { workspaceReopen } from './workspace-reopen.ts';

export {
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
];
