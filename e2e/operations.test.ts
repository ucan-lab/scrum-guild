import { z } from 'zod';
import { taskHistory } from '../src/shared/operations/task/task-history.ts';
import { expect, test } from './fixtures.ts';
import { droppedPaths } from './operations.ts';

// e2e/operations.ts の、出力に定義に無い項目があるかの判定。画面を開かずに確かめる
function dropped(schema: z.ZodType, given: unknown): string[] {
  return droppedPaths(given, schema.parse(given));
}

test('定義どおりの出力では、配列、record、union、nullable、optional の項目を余計な項目と数えない', () => {
  const schema = z.object({
    items: z.array(z.object({ id: z.string(), note: z.string().nullable() })),
    counts: z.record(z.string(), z.number()),
    value: z.union([z.string(), z.object({ id: z.string(), name: z.string() })]),
    optional: z.string().optional(),
  });
  expect(
    dropped(schema, {
      items: [
        { id: 'a', note: null },
        { id: 'b', note: 'x' },
      ],
      counts: { open: 1, done: 2 },
      value: { id: 'u', name: 'ミナト' },
      optional: undefined,
    }),
  ).toEqual([]);
});

test('定義に無い項目を、入れ子と配列の中まで path で拾う', () => {
  const schema = z.object({
    items: z.array(z.object({ id: z.string() })),
    next: z.object({ id: z.string() }).nullable(),
  });
  expect(
    dropped(schema, { items: [{ id: 'a' }, { id: 'b', extra: 1 }], next: { id: 'n', idx: 2 }, closed_on: 'x' }),
  ).toEqual(['items.1.extra', 'next.idx', 'closed_on']);
});

test('Object の継承した名前（constructor、toString）の項目も、定義に無ければ拾う', () => {
  const schema = z.object({ id: z.string() });
  expect(dropped(schema, { id: 'a', constructor: 'x', toString: 'y' })).toEqual(['constructor', 'toString']);
});

test('操作の定義の出力（task-history）で、定義どおりなら空、項目の名前を違えれば拾う', () => {
  const output = {
    entries: [
      {
        id: '0193a000-0000-7000-8000-000000000001',
        action: 'update',
        created_at: '2026-10-20T01:02:03.000Z',
        actor: null,
        changes: [
          { field: 'assignee', before: null, after: { id: '0193a000-0000-7000-8000-000000000002', name: 'ハルカ' } },
        ],
      },
    ],
    next: null,
    timezone: 'Asia/Tokyo',
  };
  expect(dropped(taskHistory.output, output)).toEqual([]);
  const { timezone, ...rest } = output;
  expect(
    dropped(taskHistory.output.extend({ timezone: z.string().optional() }), { ...rest, time_zone: timezone }),
  ).toEqual(['time_zone']);
});
