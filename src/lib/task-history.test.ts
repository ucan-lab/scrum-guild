import { describe, expect, test } from 'vitest';
import type { TaskHistoryEntry } from '../shared/operations/task/index.ts';
import { word } from '../shared/vocabulary.ts';
import { formatHistoryTime, historyEntryView, historyFieldLabel, type Translate } from './task-history.ts';

const t: Translate = (key, params) => word(key, params);

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
      t,
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

  test('列の名前と操作の言葉は、辞書のスクラムの言葉で出る', () => {
    const changed = entry({
      changes: [
        { field: 'points', before: 3, after: 5 },
        { field: 'assignee', before: null, after: member },
        { field: 'story', before: { id: 's1', name: '見積もりの準備' }, after: null },
      ],
    });
    expect(historyEntryView(changed, 'UTC', t).lines).toEqual([
      { label: 'ポイント', text: '3 → 5' },
      { label: '担当', text: '担当なし → 若葉 湊' },
      { label: '親のストーリー', text: '見積もりの準備 → なし' },
    ]);
    expect(historyEntryView(changed, 'UTC', t).summary).toBe('変更した');
    expect(historyEntryView(entry({ action: 'complete' }), 'UTC', t).summary).toBe('完了にした');
  });

  test('作成は、作ったときの空でない値だけを出す', () => {
    const view = historyEntryView(
      entry({
        action: 'create',
        changes: [
          { field: 'title', before: null, after: '見積もりを送る' },
          { field: 'points', before: null, after: null },
          { field: 'link_url', before: null, after: '' },
          { field: 'assignee', before: null, after: member },
        ],
      }),
      'UTC',
      t,
    );
    expect(view.summary).toBe('作成した');
    expect(view.lines).toEqual([
      { label: 'タイトル', text: '見積もりを送る' },
      { label: '担当', text: '若葉 湊' },
    ]);
    expect(historyEntryView(entry({ action: 'create' }), 'UTC', t).summary).toBe('作成した');
  });

  test('完了と削除は、何をしたかだけを出す', () => {
    const changes = [{ field: 'deleted_at', before: null, after: '2026-10-26T01:02:00.000Z' }];
    expect(historyEntryView(entry({ action: 'delete', changes }), 'UTC', t)).toMatchObject({
      summary: '削除した',
      lines: [],
    });
    expect(historyEntryView(entry({ action: 'complete' }), 'UTC', t).lines).toEqual([]);
  });

  test('完了を戻したら、戻したことと、スプリントの中なら完了の列から戻した列を出す', () => {
    const changes = [
      { field: 'completed_at', before: '2026-10-25T15:05:00.000Z', after: null },
      { field: 'completed_by', before: member, after: null },
      { field: 'column', before: { id: 'c9', name: '' }, after: { id: 'c2', name: '遂行中' } },
    ];
    expect(historyEntryView(entry({ action: 'reopen', changes }), 'UTC', t)).toMatchObject({
      summary: '完了を戻した',
      lines: [{ label: '列', text: '完了 → 遂行中' }],
    });
    // スプリントの外の完了を戻したときは、戻したことだけ
    expect(historyEntryView(entry({ action: 'reopen', changes: changes.slice(0, 2) }), 'UTC', t)).toMatchObject({
      summary: '完了を戻した',
      lines: [],
    });
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
      t,
    );
    expect(view.lines).toEqual([
      { label: null, text: '本文を直した' },
      { label: null, text: 'そのほかの欄を直した' },
    ]);
    expect(historyFieldLabel('mystery', t)).toBe('そのほかの欄');
  });

  test('知らない操作は変更として出し、表に無い列（完了の日時など）は「そのほかの欄」。変えた人がいなければ定期処理か運用者', () => {
    const view = historyEntryView(
      entry({
        action: 'archive',
        actor: null,
        changes: [{ field: 'completed_at', before: '2026-10-25T15:05:00.000Z', after: null }],
      }),
      'Asia/Tokyo',
      t,
    );
    expect(view.actorName).toBe('定期処理か運用者');
    expect(view.summary).toBe('変更した');
    expect(view.lines).toEqual([{ label: null, text: 'そのほかの欄を直した' }]);
  });

  test('__proto__ などの列の名前も、知らない列として扱う', () => {
    for (const field of ['__proto__', 'constructor', 'toString']) {
      expect(historyFieldLabel(field, t)).toBe('そのほかの欄');
      expect(historyEntryView(entry({ changes: [{ field, before: 1, after: 2 }] }), 'UTC', t).lines).toEqual([
        { label: null, text: 'そのほかの欄を直した' },
      ]);
    }
  });

  test('空の名前は「不明」と出す（人、親、変えた人）', () => {
    const view = historyEntryView(
      entry({
        actor: { id: 'u9', name: '' },
        changes: [
          { field: 'assignee', before: { id: 'u1', name: '' }, after: member },
          { field: 'story', before: { id: 's1', name: '' }, after: null },
        ],
      }),
      'UTC',
      t,
    );
    expect(view.actorName).toBe('不明');
    expect(view.lines).toEqual([
      { label: '担当', text: '不明 → 若葉 湊' },
      { label: '親のストーリー', text: '不明 → なし' },
    ]);
  });
});

test('感謝の履歴は相手の名前と「なし」を出す', () => {
  expect(
    historyEntryView(entry({ changes: [{ field: 'thanks', before: null, after: member }] }), 'UTC', t).lines,
  ).toEqual([{ label: '感謝', text: `なし → ${member.name}` }]);
  expect(
    historyEntryView(entry({ changes: [{ field: 'thanks', before: member, after: null }] }), 'UTC', t).lines,
  ).toEqual([{ label: '感謝', text: `${member.name} → なし` }]);
});
