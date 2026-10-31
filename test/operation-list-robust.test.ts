// operation-list は、1つの定義の Schema が JSON Schema で表せなくても一覧全体を落とさず、名前の並びを実行環境のロケールに頼らない
import { describe, expect, test } from 'vitest';
import { z } from 'zod';
import { defineOperation } from '../src/shared/operations/define.ts';
import { operationListOperationFor } from '../src/server/operations/operation-list.ts';

const lanternLog = defineOperation({
  name: 'lantern-log',
  description: '灯りを点けた日時を記録する仮の操作（JSON Schema で表せない型を持つ）',
  mode: 'write',
  permission: 'login',
  input: z.object({ lit_at: z.date(), note: z.string() }),
  output: z.object({ count: z.number().transform((count) => String(count)) }),
});
const lanternHyphen = defineOperation({
  name: 'lantern-z',
  description: '名前にハイフンを含む仮の操作',
  mode: 'read',
  permission: 'login',
  input: z.object({}),
  output: z.object({}),
});
const lanternPlain = defineOperation({
  name: 'lanternb',
  description: '名前にハイフンを含まない仮の操作',
  mode: 'read',
  permission: 'login',
  input: z.object({}),
  output: z.object({}),
});

type Listed = { name: string; input_schema: { properties?: Record<string, unknown> } };
type Run = (context: { tokenScope: 'read' | 'write' | undefined }) => Promise<{ operations: Listed[] }>;
const runOf = (definitions: Parameters<typeof operationListOperationFor>[0]) =>
  operationListOperationFor(definitions).handler as unknown as Run;

describe('operation-list の頑丈さ', () => {
  test('JSON Schema で表せない型を持つ定義があっても、一覧を返し、表せる項目の Schema は残る', async () => {
    const list = await runOf([lanternLog, lanternPlain])({ tokenScope: 'write' });
    const log = list.operations.find((operation) => operation.name === 'lantern-log');
    expect(log).toBeDefined();
    expect(Object.keys(log!.input_schema.properties ?? {})).toEqual(['lit_at', 'note']);
    expect(log!.input_schema.properties!.note).toMatchObject({ type: 'string' });
    expect(list.operations.map((operation) => operation.name)).toContain('lanternb');
  });

  test('名前は文字コードの順に並べる（ロケールの照合でハイフンを無視しない）', async () => {
    const list = await runOf([lanternPlain, lanternHyphen])({ tokenScope: 'write' });
    expect(list.operations.map((operation) => operation.name)).toEqual(['lantern-z', 'lanternb', 'operation-list']);
  });
});
