import { expect, test } from 'vitest';
import { EditBases } from './field-edit.ts';

test('編集を始めた時点の値を保存まで持ち、直している間に欄の値が替わっても読んだ値は変わらない', () => {
  const bases = new EditBases();
  // 始めたときは未記入（null）。直している間に引き出しが読み直し、別の人の値が欄に入った
  bases.begin('f1', null);
  expect(bases.readFor('f1', '別の人の値')).toBeNull();
  // 始めた値があれば、保存はそれを読んだ値として送る
  bases.begin('f2', '一次');
  expect(bases.readFor('f2', '二次')).toBe('一次');
});

test('始めた記録が無い欄は今の値を読んだ値にし、別の欄の記録に影響されない', () => {
  const bases = new EditBases();
  bases.begin('f1', '一次');
  expect(bases.readFor('f2', '今の値')).toBe('今の値');
  expect(bases.readFor('f2', null)).toBeNull();
});

test('断られて読み直した後は、読み直した値が次の読んだ値になる。保存できたら記録を捨てる', () => {
  const bases = new EditBases();
  bases.begin('f1', null);
  bases.rebase('f1', '別の人の値');
  expect(bases.readFor('f1', '別の人の値')).toBe('別の人の値');
  bases.finish('f1');
  expect(bases.readFor('f1', '次の値')).toBe('次の値');
});
