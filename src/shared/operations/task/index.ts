// バックログの木と、タスクの作成、読み取り、変更、担当の変更、完了、削除、移動の操作の定義
import type { AnyOperationDefinition } from '../define.ts';
import { backlogTree } from './backlog-tree.ts';
import { taskAssign } from './task-assign.ts';
import { taskComplete } from './task-complete.ts';
import { taskCreate } from './task-create.ts';
import { taskDelete } from './task-delete.ts';
import { taskDetail } from './task-detail.ts';
import { taskMove } from './task-move.ts';
import { taskUpdate } from './task-update.ts';

export { backlogTree, taskAssign, taskComplete, taskCreate, taskDelete, taskDetail, taskMove, taskUpdate };
export { taskDetailSchema, type TaskDetail } from './task.ts';

export const taskOperations: readonly AnyOperationDefinition[] = [
  taskCreate,
  backlogTree,
  taskComplete,
  taskDetail,
  taskUpdate,
  taskAssign,
  taskDelete,
  taskMove,
];
