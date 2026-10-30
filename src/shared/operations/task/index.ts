// バックログの木と、タスクの作成、読み取り、変更、担当の変更、完了、完了を戻す、削除、移動、変更の履歴、コメントの操作の定義
import type { AnyOperationDefinition } from '../define.ts';
import { backlogCompletedTasks } from './backlog-completed-tasks.ts';
import { backlogTree } from './backlog-tree.ts';
import { commentCreate, commentDelete, commentList, commentUpdate } from './comment.ts';
import { taskAssign } from './task-assign.ts';
import { taskComplete } from './task-complete.ts';
import { taskCreate } from './task-create.ts';
import { taskDelete } from './task-delete.ts';
import { taskDetail } from './task-detail.ts';
import { taskHistory } from './task-history.ts';
import { taskMove } from './task-move.ts';
import { taskReopen } from './task-reopen.ts';
import { taskUpdate } from './task-update.ts';
import { thanksSend, thanksRevoke } from './thanks.ts';
export {
  thanksSend,
  thanksRevoke,
  thanksConflictReasonOf,
  thanksConflictReasons,
  type ThanksConflictReason,
} from './thanks.ts';

export {
  backlogTree,
  backlogCompletedTasks,
  taskAssign,
  taskComplete,
  taskCreate,
  taskDelete,
  taskDetail,
  taskHistory,
  taskMove,
  taskReopen,
  taskUpdate,
};
export { taskReopenConflictReasonOf, taskReopenConflictReasons, type TaskReopenConflictReason } from './task-reopen.ts';
export { taskDetailSchema, type TaskDetail } from './task.ts';
export { TASK_HISTORY_PAGE_SIZE, type TaskHistoryEntry, type TaskHistoryValue } from './task-history.ts';
export { commentCreate, commentDelete, commentList, commentUpdate };
export {
  COMMENT_PAGE_SIZE,
  commentConflictReasons,
  commentSchema,
  type Comment,
  type CommentCursor,
} from './comment.ts';

export const taskOperations: readonly AnyOperationDefinition[] = [
  taskCreate,
  backlogTree,
  backlogCompletedTasks,
  taskComplete,
  taskReopen,
  taskDetail,
  taskUpdate,
  taskAssign,
  taskDelete,
  taskMove,
  taskHistory,
  commentList,
  commentCreate,
  commentUpdate,
  commentDelete,
  thanksSend,
  thanksRevoke,
];
