// バックログのタスクの作成、一覧、完了の操作の定義
import type { AnyOperationDefinition } from '../define.ts';
import { taskComplete } from './task-complete.ts';
import { taskCreate } from './task-create.ts';
import { taskList } from './task-list.ts';

export { taskComplete, taskCreate, taskList };

export const taskOperations: readonly AnyOperationDefinition[] = [taskCreate, taskList, taskComplete];
