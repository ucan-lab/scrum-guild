// 呼べる操作の一覧の処理（定義は src/shared/operations/session/operation-list.ts）。
// 渡した定義と自分自身を、呼び手のトークンの範囲で絞って返す。登録した操作から作るので、定義を足すと一覧に載る
import { z } from 'zod';
import type { AnyOperationDefinition } from '../../shared/operations/define.ts';
import { isOutsideOperation, isWorkspaceOperation } from '../../shared/operations/define.ts';
import { operationList } from '../../shared/operations/session/index.ts';
import { implement, type ImplementedOperation } from './implement.ts';
import { tokenAllows } from './token-scope.ts';

// 定義ごとの JSON Schema。定義は固定で組織のデータを含まないので、リクエストをまたいで isolate で共有してよい（変換は呼び出しのたびに行うと重い）
type JsonSchemas = { input_schema: Record<string, unknown>; output_schema: Record<string, unknown> };
const schemasOf = new WeakMap<AnyOperationDefinition, JsonSchemas>();

function schemasFor(definition: AnyOperationDefinition) {
  let schemas = schemasOf.get(definition);
  if (schemas === undefined) {
    // 表せない型（z.date() など）は {}（何でもよい）にする。既定は例外で、1つの定義が一覧全体を 500 にし、CLI がすべて止まるため
    schemas = {
      input_schema: z.toJSONSchema(definition.input, { io: 'input', unrepresentable: 'any' }),
      output_schema: z.toJSONSchema(definition.output, { io: 'output', unrepresentable: 'any' }),
    };
    schemasOf.set(definition, schemas);
  }
  return schemas;
}

export function operationListOperationFor(definitions: readonly AnyOperationDefinition[]): ImplementedOperation {
  const all = [...definitions.filter((definition) => definition.name !== operationList.name), operationList];
  return implement(operationList, async ({ tokenScope }) => {
    const scope = tokenScope ?? 'write';
    const operations = all
      .filter((definition) => {
        return tokenAllows(definition, scope);
      })
      .map((definition) => ({
        name: definition.name,
        description: definition.description,
        mode: definition.mode,
        scope: (isOutsideOperation(definition)
          ? 'outside'
          : isWorkspaceOperation(definition)
            ? 'workspace'
            : 'organization') as 'outside' | 'organization' | 'workspace',
        permission: definition.permission,
        ...schemasFor(definition),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return { operations };
  });
}
