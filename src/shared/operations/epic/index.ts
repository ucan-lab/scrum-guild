// エピックの読み取り、作成、変更、削除の操作の定義。クリアと中止は #65 で足す
import type { AnyOperationDefinition } from '../define.ts';
import { epicCreate } from './epic-create.ts';
import { epicDelete } from './epic-delete.ts';
import { epicGet } from './epic-get.ts';
import { epicUpdate } from './epic-update.ts';

export { epicCreate, epicDelete, epicGet, epicUpdate };
export { epicDetailSchema, type EpicDetail } from './epic.ts';

export const epicOperations: readonly AnyOperationDefinition[] = [epicCreate, epicGet, epicUpdate, epicDelete];
