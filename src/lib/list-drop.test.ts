import { describe, expect, test } from 'vitest';
import { insertAround, insertAtEnd } from './list-drop.ts';

describe('insertAround', () => {
  const ids = ['a', 'b', 'c', 'd'];

  test('行の前に落とすと、動かす行を除いた並びでその前の行が直前になる', () => {
    expect(insertAround(ids, 'a', 'd', 'before')).toEqual({ afterId: 'c', index: 2, atEnd: false });
    expect(insertAround(ids, 'd', 'b', 'before')).toEqual({ afterId: 'a', index: 1, atEnd: false });
  });

  test('先頭の行の前は、直前の行が null（先頭）', () => {
    expect(insertAround(ids, 'c', 'a', 'before')).toEqual({ afterId: null, index: 0, atEnd: false });
  });

  test('行の後ろに落とすと、その行が直前になる', () => {
    expect(insertAround(ids, 'a', 'c', 'after')).toEqual({ afterId: 'c', index: 2, atEnd: false });
    expect(insertAround(ids, 'a', 'd', 'after')).toEqual({ afterId: 'd', index: 3, atEnd: false });
  });

  test('元と同じ位置と、自分の行は null', () => {
    expect(insertAround(ids, 'b', 'a', 'after')).toBeNull();
    expect(insertAround(ids, 'b', 'c', 'before')).toBeNull();
    expect(insertAround(ids, 'b', 'b', 'before')).toBeNull();
    expect(insertAround(ids, 'b', 'b', 'after')).toBeNull();
  });

  test('並びに無い行を動かすとき（別の親から）は、位置が同じでも送る', () => {
    expect(insertAround(ids, 'x', 'b', 'after')).toEqual({ afterId: 'b', index: 2, atEnd: false });
    expect(insertAround(ids, 'x', 'a', 'before')).toEqual({ afterId: null, index: 0, atEnd: false });
  });

  test('並びに無い行の前後には落とせない', () => {
    expect(insertAround(ids, 'a', 'z', 'before')).toBeNull();
  });
});

describe('insertAtEnd', () => {
  test('末尾に落とすと、直前の行を渡さない（undefined）', () => {
    expect(insertAtEnd(['a', 'b', 'c'], 'a')).toEqual({ afterId: undefined, index: 2, atEnd: true });
    expect(insertAtEnd(['a', 'b', 'c'], 'x')).toEqual({ afterId: undefined, index: 3, atEnd: true });
    expect(insertAtEnd([], 'x')).toEqual({ afterId: undefined, index: 0, atEnd: true });
  });

  test('すでに末尾にあるときは null', () => {
    expect(insertAtEnd(['a', 'b', 'c'], 'c')).toBeNull();
    expect(insertAtEnd(['a'], 'a')).toBeNull();
  });
});
