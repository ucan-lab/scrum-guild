// スプリントの一覧、作成、変更、削除の操作の定義。開始、終了、延長、タスクの出し入れは、それぞれの Issue で足す
import type { AnyOperationDefinition } from '../define.ts';
import { sprintCreate } from './sprint-create.ts';
import { sprintDelete } from './sprint-delete.ts';
import { sprintList } from './sprint-list.ts';
import { sprintUpdate } from './sprint-update.ts';

export { sprintCreate, sprintDelete, sprintList, sprintUpdate };
export {
  sprintConflictReasonOf,
  sprintConflictReasons,
  sprintSummarySchema,
  type SprintConflictReason,
  type SprintSummary,
} from './sprint.ts';

export const sprintOperations: readonly AnyOperationDefinition[] = [
  sprintList,
  sprintCreate,
  sprintUpdate,
  sprintDelete,
];
