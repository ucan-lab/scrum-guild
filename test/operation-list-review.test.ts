// operation-list の JSON Schema は定義ごとに一度だけ作り、リクエストをまたいで使い回す（組織のデータを含まないので isolate で共有してよい）
import { describe, expect, test } from 'vitest';
import { z } from 'zod';
import { defineOperation } from '../src/shared/operations/define.ts';
import { operationListOperationFor } from '../src/server/operations/operation-list.ts';

const lanternCount = defineOperation({
  name: 'lantern-count',
  description: '灯りの数を数える仮の操作',
  mode: 'read',
  permission: 'login',
  input: z.object({ color: z.string().optional() }),
  output: z.object({ count: z.number() }),
});
const lanternSet = defineOperation({
  name: 'lantern-set',
  description: '灯りの数を決める仮の操作',
  mode: 'write',
  permission: 'login',
  input: z.object({ count: z.number() }),
  output: z.object({}),
});

type Listed = { name: string; input_schema: unknown; output_schema: unknown };
type Run = (context: { tokenScope: 'read' | 'write' | undefined }) => Promise<{ operations: Listed[] }>;
const runOf = (definitions: Parameters<typeof operationListOperationFor>[0]) =>
  operationListOperationFor(definitions).handler as unknown as Run;

describe('定義ごとの JSON Schema を使い回す', () => {
  test('呼び出しをまたいでも、別の一覧の処理を作っても、同じ定義の Schema は同じ値', async () => {
    const first = await runOf([lanternCount, lanternSet])({ tokenScope: 'write' });
    const second = await runOf([lanternCount, lanternSet])({ tokenScope: 'write' });
    const byName = (list: { operations: Listed[] }, name: string) => list.operations.find((o) => o.name === name)!;
    for (const name of ['lantern-count', 'lantern-set', 'operation-list']) {
      expect(byName(second, name).input_schema).toBe(byName(first, name).input_schema);
      expect(byName(second, name).output_schema).toBe(byName(first, name).output_schema);
    }
  });

  test('トークンの範囲での絞り込みは毎回行う', async () => {
    const run = runOf([lanternCount, lanternSet]);
    const write = await run({ tokenScope: 'write' });
    const read = await run({ tokenScope: 'read' });
    expect(write.operations.map((o) => o.name)).toEqual(['lantern-count', 'lantern-set', 'operation-list']);
    expect(read.operations.map((o) => o.name)).toEqual(['lantern-count', 'operation-list']);
  });

  test('Schema の中身は z.toJSONSchema と同じ', async () => {
    const list = await runOf([lanternCount])({ tokenScope: 'write' });
    expect(list.operations.find((o) => o.name === 'lantern-count')!.input_schema).toEqual(
      z.toJSONSchema(lanternCount.input, { io: 'input' }),
    );
  });
});
