// スプリントの一覧、作成、変更、削除、開始、終了、延長と、タスクの出し入れ、スプリントの画面（列とカード）の操作の定義
import type { AnyOperationDefinition } from '../define.ts';
import { planSummary } from './plan-summary.ts';
import { sprintBoard } from './sprint-board.ts';
import { sprintClose } from './sprint-close.ts';
import { sprintCreate } from './sprint-create.ts';
import { sprintDelete } from './sprint-delete.ts';
import { sprintExtend } from './sprint-extend.ts';
import { sprintList } from './sprint-list.ts';
import { sprintStart } from './sprint-start.ts';
import { sprintTaskAdd } from './sprint-task-add.ts';
import { sprintTaskRemove } from './sprint-task-remove.ts';
import { sprintUpdate } from './sprint-update.ts';
import { taskColumnMove } from './task-column-move.ts';

export {
  planSummary,
  sprintBoard,
  sprintClose,
  sprintCreate,
  sprintDelete,
  sprintExtend,
  sprintList,
  sprintStart,
  sprintTaskAdd,
  sprintTaskRemove,
  sprintUpdate,
  taskColumnMove,
};
export {
  sprintCloseConflictReasonOf,
  sprintCloseConflictReasons,
  type SprintCloseConflictReason,
} from './sprint-close.ts';
export { SPRINT_TASK_ADD_MAX } from './sprint-task-add.ts';
export {
  planEpicSchema,
  planLaneSchema,
  planVelocitySchema,
  velocitySprintSchema,
  type PlanEpic,
  type PlanLane,
  type PlanVelocity,
  type VelocitySprint,
} from './plan-summary.ts';
export {
  columnMoveConflictReasonOf,
  columnMoveConflictReasons,
  type ColumnMoveConflictReason,
} from './task-column-move.ts';
export {
  sprintBoardColumnSchema,
  sprintBoardTaskSchema,
  type SprintBoardColumn,
  type SprintBoardTask,
} from './sprint.ts';
export {
  sprintConflictReasonOf,
  sprintConflictReasons,
  sprintPlanSchema,
  sprintRefSchema,
  sprintSummarySchema,
  sprintTaskConflictReasonOf,
  sprintTaskConflictReasons,
  sprintTaskSchema,
  type SprintConflictReason,
  type SprintPlan,
  type SprintRef,
  type SprintSummary,
  type SprintTask,
  type SprintTaskConflictReason,
} from './sprint.ts';

export const sprintOperations: readonly AnyOperationDefinition[] = [
  sprintList,
  sprintCreate,
  sprintUpdate,
  sprintDelete,
  sprintTaskAdd,
  sprintTaskRemove,
  sprintStart,
  sprintClose,
  sprintExtend,
  sprintBoard,
  taskColumnMove,
  planSummary,
];
