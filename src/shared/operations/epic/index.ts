// エピックの読み取り（ダイアログの欄と、画面の中身）、作成、変更、並べ替え、削除の操作の定義。クリアと中止は #65 で足す
import type { AnyOperationDefinition } from '../define.ts';
import { epicCreate } from './epic-create.ts';
import { epicDelete } from './epic-delete.ts';
import { epicDetail } from './epic-detail.ts';
import { epicGet } from './epic-get.ts';
import { epicMove } from './epic-move.ts';
import { epicUpdate } from './epic-update.ts';

export { epicCreate, epicDelete, epicDetail, epicGet, epicMove, epicUpdate };
export { epicJoinedVias, type EpicJoinedVia } from './epic-detail.ts';
export { epicDetailSchema, type EpicDetail } from './epic.ts';

export const epicOperations: readonly AnyOperationDefinition[] = [
  epicCreate,
  epicGet,
  epicDetail,
  epicUpdate,
  epicMove,
  epicDelete,
];
