// エピックの読み取り、作成、変更の操作の定義。クリア、中止、削除は #65 で足す
import type { AnyOperationDefinition } from '../define.ts';
import { epicCreate } from './epic-create.ts';
import { epicGet } from './epic-get.ts';
import { epicUpdate } from './epic-update.ts';

export { epicCreate, epicGet, epicUpdate };
export { epicDetailSchema, type EpicDetail } from './epic.ts';

export const epicOperations: readonly AnyOperationDefinition[] = [epicCreate, epicGet, epicUpdate];
