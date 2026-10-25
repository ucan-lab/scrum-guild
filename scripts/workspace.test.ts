// ワークスペースの共通の値と関数（src/shared）。Worker と画面の両方が使うので、Node でも確かめる
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { monthIn, now, todayIn } from '../src/shared/clock.ts';
import { normalizeTimezone } from '../src/shared/timezone.ts';
import { dictionary } from '../src/shared/vocabulary.ts';
import {
  WORKSPACE_NAME_MAX_LENGTH,
  defaultColumnNames,
  defaultDetailFieldNames,
  timezoneSchema,
  workspaceNameSchema,
} from '../src/shared/workspace.ts';

describe('normalizeTimezone', () => {
  test('大文字小文字を正規の名前にする', () => {
    assert.equal(normalizeTimezone('asia/tokyo'), 'Asia/Tokyo');
    assert.equal(normalizeTimezone('AMERICA/LOS_ANGELES'), 'America/Los_Angeles');
    assert.equal(normalizeTimezone('UTC'), 'UTC');
  });

  test('正式名の一覧に無い旧名も、Intl が作れれば受ける', () => {
    const resolved = normalizeTimezone('Asia/Calcutta');
    assert.ok(resolved);
    assert.doesNotMatch(resolved, /^[+-]/);
  });

  test('時差の表記は形で断る', () => {
    for (const offset of ['+09:00', '-05:00', '+0900', '-0500', '+09', '+9', '−05:00']) {
      assert.equal(normalizeTimezone(offset), undefined, offset);
    }
  });

  test('存在しない名前、空、前後に空白のある名前、長すぎる名前は断る', () => {
    for (const bad of ['Mars/Olympus', '', ' Asia/Tokyo', 'Asia/Tokyo ', 'a'.repeat(65)]) {
      assert.equal(normalizeTimezone(bad), undefined, JSON.stringify(bad));
    }
  });

  test('スキーマは、断る入力を検証で落とす', () => {
    assert.equal(timezoneSchema.safeParse('Asia/Tokyo').success, true);
    assert.equal(timezoneSchema.safeParse('+09:00').success, false);
    assert.equal(timezoneSchema.safeParse('Mars/Olympus').success, false);
  });
});

describe('今日と今月', () => {
  test('日付の境目の前後で、タイムゾーンの日付が変わる', () => {
    // 東京は UTC+9。UTC の 15:00 が東京の 0:00
    assert.equal(todayIn('Asia/Tokyo', new Date('2026-10-25T14:59:59.999Z')), '2026-10-25');
    assert.equal(todayIn('Asia/Tokyo', new Date('2026-10-25T15:00:00.000Z')), '2026-10-26');
    assert.equal(todayIn('UTC', new Date('2026-10-25T15:00:00.000Z')), '2026-10-25');
  });

  test('月の境目の前後で、タイムゾーンの月が変わる', () => {
    assert.equal(monthIn('Asia/Tokyo', new Date('2026-10-31T14:59:59.999Z')), '2026-10');
    assert.equal(monthIn('Asia/Tokyo', new Date('2026-10-31T15:00:00.000Z')), '2026-11');
    // ロサンゼルスは 2026-11-01 09:00Z まで夏時間（UTC-7）
    assert.equal(monthIn('America/Los_Angeles', new Date('2026-11-01T06:59:59.999Z')), '2026-10');
    assert.equal(todayIn('America/Los_Angeles', new Date('2026-11-01T06:59:59.999Z')), '2026-10-31');
    assert.equal(todayIn('America/Los_Angeles', new Date('2026-11-01T07:00:00.000Z')), '2026-11-01');
  });

  test('年の境目と、ゼロ埋めされない月と日', () => {
    assert.equal(todayIn('Asia/Tokyo', new Date('2026-12-31T15:00:00.000Z')), '2027-01-01');
    assert.equal(monthIn('Asia/Tokyo', new Date('2026-12-31T15:00:00.000Z')), '2027-01');
    assert.equal(todayIn('UTC', new Date('2026-03-05T00:00:00.000Z')), '2026-03-05');
  });

  test('日時を渡さなければ、今の日時を使う', () => {
    assert.ok(Math.abs(now().getTime() - Date.now()) < 1000);
    assert.equal(todayIn('UTC'), new Date().toISOString().slice(0, 10));
  });
});

describe('名前', () => {
  test('前後の空白（全角を含む）を除いて 1 字以上、上限以下', () => {
    assert.equal(workspaceNameSchema.parse('  保守チーム　'), '保守チーム');
    assert.equal(workspaceNameSchema.safeParse(' 　 ').success, false);
    assert.equal(workspaceNameSchema.safeParse('').success, false);
    assert.equal(workspaceNameSchema.safeParse('あ'.repeat(WORKSPACE_NAME_MAX_LENGTH)).success, true);
    assert.equal(workspaceNameSchema.safeParse('あ'.repeat(WORKSPACE_NAME_MAX_LENGTH + 1)).success, false);
    // 空白を除いてから数える
    assert.equal(workspaceNameSchema.safeParse(` ${'あ'.repeat(WORKSPACE_NAME_MAX_LENGTH)} `).success, true);
  });
});

describe('既定の列と決まった欄の名前', () => {
  test('決まった欄の名前は、辞書の達成条件と受け入れ基準と同じ', () => {
    assert.equal(defaultDetailFieldNames.game, dictionary.ac.game);
    assert.equal(defaultDetailFieldNames.scrum, dictionary.ac.scrum);
  });

  test('列は完了の列を除く3つで、言葉づかいごとに持つ', () => {
    assert.deepEqual(defaultColumnNames.game, ['出発前', '遂行中', '査定中']);
    assert.deepEqual(defaultColumnNames.scrum, ['未着手', '作業中', 'レビュー']);
  });
});
