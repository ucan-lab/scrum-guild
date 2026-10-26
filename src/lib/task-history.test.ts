import { describe, expect, test } from 'vitest';
import type { TaskHistoryEntry } from '../shared/operations/task/index.ts';
import { word, type Vocabulary } from '../shared/vocabulary.ts';
import { formatHistoryTime, historyEntryView, historyFieldLabel, type Translate } from './task-history.ts';

const translate =
  (vocabulary: Vocabulary): Translate =>
  (key, params) =>
    word(key, { workspace: vocabulary, organization: 'game' }, params);
const game = translate('game');
const scrum = translate('scrum');

const member = { id: 'u1', name: '若葉 湊' };
const leader = { id: 'u2', name: '朝霧 楓' };

function entry(overrides: Partial<TaskHistoryEntry>): TaskHistoryEntry {
  return {
    id: 'h1',
    action: 'update',
    created_at: '2026-10-26T01:02:00.000Z',
    actor: member,
    changes: [],
    ...overrides,
  };
}

describe('formatHistoryTime', () => {
  test('ワークスペースのタイムゾーンの YYYY-MM-DD HH:mm で出す', () => {
    expect(formatHistoryTime('2026-10-26T01:02:00.000Z', 'Asia/Tokyo')).toBe('2026-10-26 10:02');
    expect(formatHistoryTime('2026-10-26T01:02:00.000Z', 'America/Los_Angeles')).toBe('2026-10-25 18:02');
    // 0 時は 24 時にしない
    expect(formatHistoryTime('2026-10-25T15:05:00.000Z', 'Asia/Tokyo')).toBe('2026-10-26 00:05');
  });

  test('読めないタイムゾーンは UTC、読めない日時は元のまま', () => {
    expect(formatHistoryTime('2026-10-26T01:02:00.000Z', 'Not/AZone')).toBe('2026-10-26 01:02');
    expect(formatHistoryTime('きのう', 'Asia/Tokyo')).toBe('きのう');
  });
});

describe('historyEntryView', () => {
  test('変更は、列の名前と前と後を出す。空の値は列ごとの言葉', () => {
    const view = historyEntryView(
      entry({
        changes: [
          { field: 'points', before: 3, after: null },
          { field: 'assignee', before: member, after: leader },
          { field: 'due_on', before: null, after: '2026-10-30' },
          { field: 'today_on', before: '2026-10-25', after: null },
          { field: 'assignee', before: leader, after: null },
        ],
      }),
      'Asia/Tokyo',
      scrum,
    );
    expect(view).toEqual({
      id: 'h1',
      createdAt: '2026-10-26T01:02:00.000Z',
      at: '2026-10-26 10:02',
      actor: member,
      actorName: '若葉 湊',
      summary: '変更した',
      lines: [
        { label: 'ポイント', text: '3 → 未見積もり' },
        { label: '担当', text: '若葉 湊 → 朝霧 楓' },
        { label: '期日', text: 'なし → 2026-10-30' },
        { label: '今日やる', text: '2026-10-25 → なし' },
        { label: '担当', text: '朝霧 楓 → 担当なし' },
      ],
    });
  });

  test('言葉づかいを替えると、列の名前と操作の言葉も替わる', () => {
    const changed = entry({
      changes: [
        { field: 'points', before: 3, after: 5 },
        { field: 'assignee', before: null, after: member },
        { field: 'story', before: { id: 's1', name: '見積もりの準備' }, after: null },
      ],
    });
    expect(historyEntryView(changed, 'UTC', game).lines).toEqual([
      { label: '難易度', text: '3 → 5' },
      { label: '担い手', text: '担い手なし → 若葉 湊' },
      { label: '親の達成目標', text: '見積もりの準備 → なし' },
    ]);
    expect(historyEntryView(changed, 'UTC', game).summary).toBe('書き換えた');
    expect(historyEntryView(changed, 'UTC', scrum).lines.map((line) => line.label)).toEqual([
      'ポイント',
      '担当',
      '親のストーリー',
    ]);
    expect(historyEntryView(entry({ action: 'complete' }), 'UTC', game).summary).toBe('完遂にした');
    expect(historyEntryView(entry({ action: 'complete' }), 'UTC', scrum).summary).toBe('完了にした');
  });

  test('作成は、作ったときの値だけを出す', () => {
    const view = historyEntryView(
      entry({
        action: 'create',
        changes: [
          { field: 'title', before: null, after: '見積もりを送る' },
          { field: 'points', before: null, after: null },
          { field: 'assignee', before: null, after: member },
        ],
      }),
      'UTC',
      scrum,
    );
    expect(view.summary).toBe('作成した');
    expect(view.lines).toEqual([
      { label: 'タイトル', text: '見積もりを送る' },
      { label: 'ポイント', text: '未見積もり' },
      { label: '担当', text: '若葉 湊' },
    ]);
    expect(historyEntryView(entry({ action: 'create' }), 'UTC', game).summary).toBe('依頼を出した');
  });

  test('完了と削除は、何をしたかだけを出す', () => {
    const changes = [{ field: 'deleted_at', before: null, after: '2026-10-26T01:02:00.000Z' }];
    expect(historyEntryView(entry({ action: 'delete', changes }), 'UTC', scrum)).toMatchObject({
      summary: '削除した',
      lines: [],
    });
    expect(historyEntryView(entry({ action: 'complete' }), 'UTC', scrum).lines).toEqual([]);
  });

  test('本文は値を出さずに直したことだけを、知らない列は「そのほかの欄」を出す', () => {
    const view = historyEntryView(
      entry({
        changes: [
          { field: 'body_md', before: null, after: null },
          { field: 'mystery', before: null, after: null },
        ],
      }),
      'UTC',
      scrum,
    );
    expect(view.lines).toEqual([
      { label: null, text: '本文を直した' },
      { label: null, text: 'そのほかの欄を直した' },
    ]);
    expect(historyFieldLabel('mystery', game)).toBe('そのほかの欄');
  });

  test('日時の列はタイムゾーンで出す。変えた人がいなければ定期処理か運用者', () => {
    const view = historyEntryView(
      entry({
        action: 'reopen',
        actor: null,
        changes: [{ field: 'completed_at', before: '2026-10-25T15:05:00.000Z', after: null }],
      }),
      'Asia/Tokyo',
      scrum,
    );
    expect(view.actorName).toBe('定期処理か運用者');
    expect(view.summary).toBe('変更した');
    expect(view.lines).toEqual([{ label: '完了した日時', text: '2026-10-26 00:05 → なし' }]);
  });
});
