// ワークスペースの区分とリポジトリ、決まった欄の一覧、作成、変更、並べ替え、削除の操作の定義
import type { AnyOperationDefinition } from '../define.ts';
import { categoryCreate, categoryDelete, categoryMove, categoryRepositoryList, categoryUpdate } from './category.ts';
import {
  detailFieldCreate,
  detailFieldDelete,
  detailFieldList,
  detailFieldMove,
  detailFieldUpdate,
} from './detail-field.ts';
import { repositoryCreate, repositoryDelete, repositoryMove, repositoryUpdate } from './repository.ts';

export {
  categoryCreate,
  categoryDelete,
  categoryMove,
  categoryRepositoryList,
  categoryUpdate,
  detailFieldCreate,
  detailFieldDelete,
  detailFieldList,
  detailFieldMove,
  detailFieldUpdate,
  repositoryCreate,
  repositoryDelete,
  repositoryMove,
  repositoryUpdate,
};
export * from './definition.ts';

export const definitionOperations: readonly AnyOperationDefinition[] = [
  categoryRepositoryList,
  categoryCreate,
  categoryUpdate,
  categoryMove,
  categoryDelete,
  repositoryCreate,
  repositoryUpdate,
  repositoryMove,
  repositoryDelete,
  detailFieldList,
  detailFieldCreate,
  detailFieldUpdate,
  detailFieldMove,
  detailFieldDelete,
];
