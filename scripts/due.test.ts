// 期日の判定（src/shared/due.ts）。Worker と画面の両方が使うので、Node でも確かめる
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { daysBetween, dueStatus, isCalendarDate, weekEndOf } from '../src/shared/due.ts';

describe('isCalendarDate', () => {
  test('暦に存在する日付だけ通す', () => {
    for (const ok of ['2026-10-26', '2028-02-29', '0001-01-01', '2026-12-31']) assert.ok(isCalendarDate(ok), ok);
    for (const ng of [
      '2026-02-29',
      '2026-02-30',
      '2026-13-01',
      '2026-00-10',
      '2026-10-32',
      '2026-1-1',
      '',
      '2026/10/26',
      '2026-10-26T00:00',
    ]) {
      assert.ok(!isCalendarDate(ng), ng);
    }
  });
});

describe('weekEndOf', () => {
  // 2026-10-26 は月曜
  test('週の始まりが月曜なら、月曜の今日の週は日曜まで', () => {
    assert.equal(weekEndOf('2026-10-26', 1), '2026-11-01');
    assert.equal(weekEndOf('2026-11-01', 1), '2026-11-01');
    assert.equal(weekEndOf('2026-10-31', 1), '2026-11-01');
  });

  test('週の始まりが日曜なら、日曜からの7日間は土曜まで', () => {
    assert.equal(weekEndOf('2026-10-25', 0), '2026-10-31');
    assert.equal(weekEndOf('2026-10-26', 0), '2026-10-31');
    assert.equal(weekEndOf('2026-10-31', 0), '2026-10-31');
    // 日曜の今日は、月曜始まりでは前の週の最終日
    assert.equal(weekEndOf('2026-10-25', 1), '2026-10-25');
  });

  test('今日が週の始まりの日なら、その日から7日間', () => {
    for (let start = 0; start <= 6; start++) {
      // 2026-10-25 は日曜（0）。start の曜日の日を今日にする
      const day = 25 + start;
      const today = `2026-10-${day}`;
      const end = new Date(Date.UTC(2026, 9, day + 6)).toISOString().slice(0, 10);
      assert.equal(weekEndOf(today, start), end, `start=${start}`);
    }
  });

  test('年末年始と閏日をまたぐ', () => {
    // 2026-12-31 は木曜
    assert.equal(weekEndOf('2026-12-31', 1), '2027-01-03');
    assert.equal(weekEndOf('2026-12-31', 0), '2027-01-02');
    assert.equal(weekEndOf('2026-12-31', 4), '2027-01-06');
    // 2028-02-27 は日曜。閏日の 2028-02-29 を含む
    assert.equal(weekEndOf('2028-02-27', 1), '2028-02-27');
    assert.equal(weekEndOf('2028-02-28', 1), '2028-03-05');
    assert.equal(weekEndOf('2027-01-01', 1), '2027-01-03');
  });

  test('使えない今日の日付と週の始まりは例外', () => {
    assert.throws(() => weekEndOf('2026-02-30', 1), RangeError);
    assert.throws(() => weekEndOf('2026-10-26', 7), RangeError);
    assert.throws(() => weekEndOf('2026-10-26', -1), RangeError);
    assert.throws(() => weekEndOf('2026-10-26', 1.5), RangeError);
  });
});

describe('daysBetween', () => {
  test('to が後なら正、同じ日なら 0、前なら負', () => {
    assert.equal(daysBetween('2026-10-26', '2026-10-27'), 1);
    assert.equal(daysBetween('2026-10-26', '2026-10-26'), 0);
    assert.equal(daysBetween('2026-10-27', '2026-10-26'), -1);
  });

  test('月、年、閏日をまたぐ', () => {
    assert.equal(daysBetween('2026-10-31', '2026-11-01'), 1);
    assert.equal(daysBetween('2026-12-31', '2027-01-01'), 1);
    assert.equal(daysBetween('2028-02-28', '2028-03-01'), 2);
    assert.equal(daysBetween('2027-02-28', '2027-03-01'), 1);
  });

  test('遠い過去でも通し番号の差で求める', () => {
    assert.equal(daysBetween('0001-01-01', '2026-11-01'), 739_920);
  });

  test('暦に存在しない日付は例外', () => {
    assert.throws(() => daysBetween('2026-02-30', '2026-03-01'), RangeError);
    assert.throws(() => daysBetween('2026-03-01', 'x'), RangeError);
  });
});

describe('dueStatus', () => {
  test('今日より前は overdue、今日は today', () => {
    assert.equal(dueStatus('2026-10-25', '2026-10-26', 1), 'overdue');
    assert.equal(dueStatus('2025-01-01', '2026-10-26', 1), 'overdue');
    assert.equal(dueStatus('2026-10-26', '2026-10-26', 1), 'today');
  });

  test('週の始まりが月曜: 今日（月曜）の翌日から日曜までが this_week、その先は later', () => {
    assert.equal(dueStatus('2026-10-27', '2026-10-26', 1), 'this_week');
    assert.equal(dueStatus('2026-11-01', '2026-10-26', 1), 'this_week');
    assert.equal(dueStatus('2026-11-02', '2026-10-26', 1), 'later');
  });

  test('週の始まりが日曜: 同じ月曜でも土曜までが this_week', () => {
    assert.equal(dueStatus('2026-10-31', '2026-10-26', 0), 'this_week');
    assert.equal(dueStatus('2026-11-01', '2026-10-26', 0), 'later');
  });

  test('週の境目: 日曜が今日のとき、月曜始まりなら翌日はもう次の週', () => {
    assert.equal(dueStatus('2026-10-26', '2026-10-25', 1), 'later');
    assert.equal(dueStatus('2026-10-26', '2026-10-25', 0), 'this_week');
  });

  test('年末年始', () => {
    assert.equal(dueStatus('2027-01-01', '2026-12-31', 1), 'this_week');
    assert.equal(dueStatus('2027-01-03', '2026-12-31', 1), 'this_week');
    assert.equal(dueStatus('2027-01-04', '2026-12-31', 1), 'later');
    assert.equal(dueStatus('2027-01-03', '2026-12-31', 0), 'later');
    assert.equal(dueStatus('2026-12-31', '2027-01-01', 1), 'overdue');
  });

  test('使えない期日は例外', () => {
    assert.throws(() => dueStatus('2026-02-30', '2026-10-26', 1), RangeError);
    assert.throws(() => dueStatus('', '2026-10-26', 1), RangeError);
  });
});
