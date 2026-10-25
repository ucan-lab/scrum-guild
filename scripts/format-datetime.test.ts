import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { formatDateTime } from '../src/lib/format-datetime.ts';

describe('日時の表示', () => {
  test('UTC の ISO 文字列を、指したタイムゾーンの日付と時刻で出す', () => {
    assert.equal(formatDateTime('2026-10-01T09:30:00.000Z', 'Asia/Tokyo'), '2026/10/01 18:30');
    assert.equal(formatDateTime('2026-10-01T09:30:00.000Z', 'UTC'), '2026/10/01 09:30');
  });

  test('日付をまたぐときは、日付も指したタイムゾーンのものになる', () => {
    assert.equal(formatDateTime('2026-10-01T20:05:00.000Z', 'Asia/Tokyo'), '2026/10/02 05:05');
  });

  test('読めない値は、そのまま返す', () => {
    assert.equal(formatDateTime('not a date'), 'not a date');
  });
});
