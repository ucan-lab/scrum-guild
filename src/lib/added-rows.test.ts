import { expect, test } from 'vitest';
import { keepAddedRow } from './added-rows.ts';

const base = { inLoadedTree: false, completed: false, treeLoaded: true, loadedAt: 100 };

test('足した後に始まった読み直しの木に無い行は捨てる（別の人の削除、親ごとの消失）', () => {
  expect(keepAddedRow({ at: 99 }, base)).toBe(false);
});

test('足す前に始まった読み直しが遅れて届いても、木に無い行は残す', () => {
  expect(keepAddedRow({ at: 101 }, base)).toBe(true);
});

test('足した時刻と読み直しを始めた時刻が同じなら残す', () => {
  expect(keepAddedRow({ at: 100 }, base)).toBe(true);
});

test('木を読めていないときは、足した後に始まった読み直しでも残す', () => {
  expect(keepAddedRow({ at: 99 }, { ...base, treeLoaded: false })).toBe(true);
});

test('読み直した木に入った行は捨てる', () => {
  expect(keepAddedRow({ at: 101 }, { ...base, inLoadedTree: true })).toBe(false);
});

test('完了にした行は、木に無くても残さない', () => {
  expect(keepAddedRow({ at: 101 }, { ...base, completed: true })).toBe(false);
});
