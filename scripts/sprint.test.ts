// スプリントの日付の計算と名前の決まり（src/shared/sprint.ts）。Worker と画面の両方が使うので、Node でも確かめる
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  addDays,
  normalizeSprintName,
  sprintDefaults,
  sprintEndOn,
  sprintLengthOf,
  sprintNameProblem,
  weekdayOf,
} from '../src/shared/sprint.ts';

describe('日付の計算', () => {
  test('日数を足し、月と年と閏日をまたぐ', () => {
    assert.equal(addDays('2026-10-26', 7), '2026-11-02');
    assert.equal(addDays('2026-12-25', 13), '2027-01-07');
    assert.equal(addDays('2028-02-28', 1), '2028-02-29');
    assert.equal(addDays('2026-02-30', 1), null);
    assert.equal(addDays('9999-12-31', 1), null);
  });

  test('最終日と長さは両端を含む', () => {
    assert.equal(sprintEndOn('2026-11-02', 14), '2026-11-15');
    assert.equal(sprintEndOn('2026-11-02', 1), '2026-11-02');
    assert.equal(sprintLengthOf('2026-11-02', '2026-11-15'), 14);
    assert.equal(sprintEndOn('9999-12-31', 2), null);
  });

  test('曜日は 0 が日曜', () => {
    assert.equal(weekdayOf('2026-10-25'), 0);
    assert.equal(weekdayOf('2026-10-26'), 1);
    assert.equal(weekdayOf('1969-12-31'), 3);
  });
});

describe('sprintDefaults', () => {
  test('前のスプリントがあれば、最終日の翌日と同じ長さ', () => {
    assert.deepEqual(sprintDefaults({ start_on: '2026-11-02', end_on: '2026-11-11' }, '2026-10-26', 1), {
      start_on: '2026-11-12',
      length: 10,
    });
  });

  test('前が無ければ、今日より後で最初の週の始まりと 14 日。今日が週の始まりなら次の週', () => {
    // 2026-10-26 は月曜
    assert.deepEqual(sprintDefaults(null, '2026-10-26', 1), { start_on: '2026-11-02', length: 14 });
    assert.deepEqual(sprintDefaults(null, '2026-10-26', 0), { start_on: '2026-11-01', length: 14 });
    assert.deepEqual(sprintDefaults(null, '2026-10-26', 2), { start_on: '2026-10-27', length: 14 });
    assert.deepEqual(sprintDefaults(null, '2026-10-31', 6), { start_on: '2026-11-07', length: 14 });
  });
});

describe('名前', () => {
  test('前後の空白を除き、空白だけなら null', () => {
    assert.equal(normalizeSprintName('  秋  '), '秋');
    assert.equal(normalizeSprintName(' 　​ '), null);
    assert.equal(normalizeSprintName(''), null);
  });

  test('100 字まで（コードポイント）で、見えない文字は断る。空は誤りでない', () => {
    assert.equal(sprintNameProblem(null), null);
    assert.equal(sprintNameProblem('😀'.repeat(100)), null);
    assert.equal(sprintNameProblem('あ'.repeat(101)), 'too_long');
    assert.equal(sprintNameProblem('a​b'), 'invalid_character');
  });
});
