// バックログの木と、タスクの作成、読み取り、変更、完了、削除の操作の定義
import type { AnyOperationDefinition } from '../define.ts';
import { backlogTree } from './backlog-tree.ts';
import { taskComplete } from './task-complete.ts';
import { taskCreate } from './task-create.ts';
import { taskDelete } from './task-delete.ts';
import { taskDetail } from './task-detail.ts';
import { taskUpdate } from './task-update.ts';

export { backlogTree, taskComplete, taskCreate, taskDelete, taskDetail, taskUpdate };
export { taskDetailSchema, type TaskDetail } from './task.ts';

export const taskOperations: readonly AnyOperationDefinition[] = [
  taskCreate,
  backlogTree,
  taskComplete,
  taskDetail,
  taskUpdate,
  taskDelete,
];
