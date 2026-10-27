// スプリントの一覧、作成、変更、削除と、タスクの出し入れの操作の定義。開始、終了、延長は、それぞれの Issue で足す
import type { AnyOperationDefinition } from '../define.ts';
import { sprintCreate } from './sprint-create.ts';
import { sprintDelete } from './sprint-delete.ts';
import { sprintList } from './sprint-list.ts';
import { sprintTaskAdd } from './sprint-task-add.ts';
import { sprintTaskRemove } from './sprint-task-remove.ts';
import { sprintUpdate } from './sprint-update.ts';

export { sprintCreate, sprintDelete, sprintList, sprintTaskAdd, sprintTaskRemove, sprintUpdate };
export { SPRINT_TASK_ADD_MAX } from './sprint-task-add.ts';
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
];
