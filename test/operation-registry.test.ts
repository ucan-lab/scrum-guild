// 本番の操作の一覧を回して、組織の分離と権限を確かめる。新しい操作を足しても、このファイルは書き足さない。
// 組織の中の操作のテスト用の関数（test/operations/pointers.ts）が無いと落ちる
import { describe, expect, test } from 'vitest';
import { operations } from '../src/shared/operations/index.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import { assertPointersCover, defineOperationChecks } from './operations/harness.ts';
import { pointers } from './operations/pointers.ts';
import { provisionalOperations, provisionalPointers } from './operations/provisional.ts';

describe('本番の操作の一覧', () => {
  test('定義の一覧と、処理を結んだ一覧が同じ操作を持つ', () => {
    expect(implementedOperations.map((operation) => operation.definition.name).sort()).toEqual(
      operations.map((definition) => definition.name).sort(),
    );
  });

  test('組織の中のすべての操作にテスト用の関数がある', () => {
    expect(() => assertPointersCover(implementedOperations, pointers)).not.toThrow();
  });
});

describe('テスト用の関数の検査', () => {
  test('関数の無い組織の中の操作があると落ちる', () => {
    const withoutTaskTitle = Object.fromEntries(
      Object.entries(provisionalPointers).filter(([name]) => name !== 'task-title'),
    );
    expect(() => assertPointersCover(provisionalOperations, withoutTaskTitle)).toThrow(/task-title/);
  });

  test('組織の外の操作は関数が無くてもよい', () => {
    expect(() => assertPointersCover(provisionalOperations, provisionalPointers)).not.toThrow();
  });

  test('一覧に無い操作の関数があると落ちる', () => {
    expect(() =>
      assertPointersCover(provisionalOperations, { ...provisionalPointers, 'no-such': { noReference: {} } }),
    ).toThrow(/no-such/);
  });
});

// 仕組みそのもの（登録の関数、権限の検査、分離の検査）を仮の操作で確かめる
describe('仮の操作の一覧', () => {
  assertPointersCover(provisionalOperations, provisionalPointers);
  defineOperationChecks(provisionalOperations, provisionalPointers);
});

// 本番の一覧。今は空で、操作が入るとここで回る。関数の足し忘れは、ファイルの読み込みで落ちる
assertPointersCover(implementedOperations, pointers);
if (implementedOperations.length > 0) {
  describe('本番の一覧の分離と権限', () => defineOperationChecks(implementedOperations, pointers));
}
