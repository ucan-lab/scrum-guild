// 本番の一覧の検査（defineOperationChecks）を、操作の名前で決まる塊に分けて、塊ごとに別のファイルで回す。
// 1つのファイルで回すと、ほかのファイルが終わった後に1つのワーカーで長く走る尾になり、test ジョブが長くなるため。
// 塊のファイルは test/operation-registry-production-<番号>.test.ts（番号は 1 から productionChunkCount まで）。
// 塊の数を変えるときは、この定数とファイルの数を同じ PR で合わせる（test/operation-registry.test.ts が突き合わせる）
import { describe } from 'vitest';
import type { ImplementedOperation } from '../../src/server/operations/implement.ts';
import { implementedOperations } from '../../src/server/operations/index.ts';
import { defineOperationChecks } from './harness.ts';
import { operatorGithub, pointers } from './pointers.ts';

export const productionChunkCount = 6;

// 操作を名前で並べ、i 番目を i % count の塊に入れる（番号は 0 から）。重い操作は名前の並びに偏りにくく、
// 一覧に操作が増えても決まった割り方で塊が決まる。塊の中も名前の順
export function operationChunk(
  operations: readonly ImplementedOperation[],
  index: number,
  count: number,
): ImplementedOperation[] {
  if (!Number.isInteger(count) || count < 1) throw new Error(`塊の数が正の整数でない: ${count}`);
  if (!Number.isInteger(index) || index < 0 || index >= count)
    throw new Error(`塊の番号が範囲外: ${index}（0〜${count - 1}）`);
  return [...operations]
    .sort((a, b) => (a.definition.name < b.definition.name ? -1 : a.definition.name > b.definition.name ? 1 : 0))
    .filter((_, i) => i % count === index);
}

// 本番の一覧の塊 number（1 から）を、Cookie と API トークンの2通りで回す。
// 運用者の操作は、差し替えた GitHub に問い合わせる。トークンでも、組織の分離と権限は Cookie と同じ結果になる
export function defineProductionChunk(number: number): void {
  const chunk = operationChunk(implementedOperations, number - 1, productionChunkCount);
  describe('本番の一覧の分離と権限', () => defineOperationChecks(chunk, pointers, { fetcher: operatorGithub.fetcher }));
  describe('本番の一覧の分離と権限（API トークン）', () =>
    defineOperationChecks(chunk, pointers, { fetcher: operatorGithub.fetcher, credential: 'bearer' }));
}
