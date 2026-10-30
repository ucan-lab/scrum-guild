// スプリントの列の一覧、作成、名前の変更、並べ替え、削除の操作の定義
import type { AnyOperationDefinition } from '../define.ts';
import { columnCreate } from './column-create.ts';
import { columnDelete } from './column-delete.ts';
import { columnList } from './column-list.ts';
import { columnMove } from './column-move.ts';
import { columnUpdate } from './column-update.ts';

export { columnCreate, columnDelete, columnList, columnMove, columnUpdate };
export * from './column.ts';

export const columnOperations: readonly AnyOperationDefinition[] = [
  columnList,
  columnCreate,
  columnUpdate,
  columnMove,
  columnDelete,
];
