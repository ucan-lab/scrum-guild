// 呼べる操作の一覧の処理（定義は src/shared/operations/session/operation-list.ts）。
// 渡した定義と自分自身を、呼び手のトークンの範囲で絞って返す。登録した操作から作るので、定義を足すと一覧に載る
import type { AnyOperationDefinition } from '../../shared/operations/define.ts';
import { operationList } from '../../shared/operations/session/index.ts';
import { implement, type ImplementedOperation } from './implement.ts';

export function operationListOperationFor(definitions: readonly AnyOperationDefinition[]): ImplementedOperation {
  void definitions;
  return implement(operationList, async () => {
    throw new Error('未実装');
  });
}
