// バックログの木と、タスクの作成、完了の操作の定義
import type { AnyOperationDefinition } from '../define.ts';
import { backlogTree } from './backlog-tree.ts';
import { taskComplete } from './task-complete.ts';
import { taskCreate } from './task-create.ts';

export { backlogTree, taskComplete, taskCreate };

export const taskOperations: readonly AnyOperationDefinition[] = [taskCreate, backlogTree, taskComplete];
