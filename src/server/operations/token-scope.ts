// API トークンで呼べるかの判定。呼び出しの 403（register.ts の checkTokenScope）と一覧の絞り（operation-list.ts）が同じ関数を使う
import type { AnyOperationDefinition } from '../../shared/operations/define.ts';

export function tokenAllows(definition: AnyOperationDefinition, scope: 'read' | 'write'): boolean {
  void definition;
  void scope;
  throw new Error('未実装');
}
