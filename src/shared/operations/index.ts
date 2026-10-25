// 本番の操作の定義の一覧。組織の分離のテストと権限のテストはこの一覧を回す（test/operation-registry.test.ts）。
// 仮の操作はテストの中で定義し、ここに入れない
import type { AnyOperationDefinition } from './define.ts';
import { operatorOperations } from './operator/index.ts';

export const operations: readonly AnyOperationDefinition[] = [...operatorOperations];
