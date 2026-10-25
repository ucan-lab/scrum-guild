// ワークスペースの作成、一覧、枠が使う操作の定義
import type { AnyOperationDefinition } from '../define.ts';
import { workspaceInfo } from './workspace.ts';
import { workspaceCreate } from './workspace-create.ts';
import { workspaceLeaderCandidates } from './workspace-leader-candidates.ts';
import { workspaceList } from './workspace-list.ts';

export { workspaceCreate, workspaceInfo, workspaceLeaderCandidates, workspaceList };

export const workspaceOperations: readonly AnyOperationDefinition[] = [
  workspaceCreate,
  workspaceList,
  workspaceLeaderCandidates,
  workspaceInfo,
];
