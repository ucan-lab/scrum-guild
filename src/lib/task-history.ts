// タスクの詳細の引き出しの「変更の履歴」の、1件ごとの見せ方（task-history の結果を、辞書の言葉の文にする）。
// 列の名前は、下の表で辞書の言葉にする（言葉づかいを切り替えると、列の名前も替わる）。
// 辞書は引数（translate）で受け取り、画面の状態に頼らない（テストで言葉づかいを替えて確かめる）
import type { TaskHistoryEntry, TaskHistoryValue } from '../shared/operations/task/index.ts';
import type { DictionaryKey, TemplateParams } from '../shared/vocabulary.ts';

export type Translate = (key: DictionaryKey, params?: TemplateParams) => string;

// 欄ごとの1行。label が null の行は、値を出さずに「何を直したか」だけを text に持つ（本文と、知らない欄）
export type HistoryLine = { label: string | null; text: string };

export type HistoryEntryView = {
  id: string;
  // 保存した日時（ISO 文字列）と、ワークスペースのタイムゾーンでの YYYY-MM-DD HH:mm
  createdAt: string;
  at: string;
  // 変えた人。null は定期処理か運用者で、actorName に辞書の言葉を入れる
  actor: { id: string; name: string } | null;
  actorName: string;
  // した操作（作成した、変えた、完了にした、削除した）
  summary: string;
  lines: HistoryLine[];
};

// 列の名前から辞書の言葉へ。ここに無い列は「そのほかの欄」として、値を出さない
const FIELD_LABELS: Readonly<Record<string, (t: Translate) => string>> = {
  title: (t) => t('fieldTitle'),
  points: (t) => t('points'),
  due_on: (t) => t('due'),
  link_url: (t) => t('fieldLink'),
  body_md: (t) => t('fieldBody'),
  assignee: (t) => t('assignee'),
  story: (t) => t('historyFieldParent', { story: t('story') }),
  category: (t) => t('category'),
  today_on: (t) => t('sectionToday'),
  completed_at: (t) => t('historyFieldCompletedAt', { done: t('done') }),
  completed_by: (t) => t('historyFieldCompletedBy', { done: t('done') }),
  deleted_at: (t) => t('historyFieldDeletedAt'),
};

// 値を出さない列（本文は長いので、API も値を返さない）
const VALUELESS_FIELDS = new Set(['body_md']);
// 日時の列。ワークスペースのタイムゾーンで出す（期日と今日やるは暦の日付なので、そのまま）
const TIMESTAMP_FIELDS = new Set(['completed_at', 'deleted_at']);
// 空の値を、それぞれの意味の言葉で出す列
const PERSON_FIELDS = new Set(['assignee', 'completed_by']);

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

// UTC の ISO 文字列を、タイムゾーンの YYYY-MM-DD HH:mm にする。読めないタイムゾーンは UTC で、読めない日時は元のまま返す
export function formatHistoryTime(iso: string, timeZone: string): string {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return iso;
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = formatterFor(timeZone);
  } catch {
    formatter = formatterFor('UTC');
  }
  const parts = Object.fromEntries(formatter.formatToParts(time).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

// 列の名前。知らない列は「そのほかの欄」
export function historyFieldLabel(field: string, t: Translate): string {
  return (FIELD_LABELS[field] ?? ((tr: Translate) => tr('historyFieldOther')))(t);
}

function valueText(field: string, value: TaskHistoryValue, timeZone: string, t: Translate): string {
  if (value === null) {
    if (field === 'points') return t('pointsUnsetTitle');
    if (PERSON_FIELDS.has(field)) return t('unassigned');
    return t('historyNone');
  }
  if (typeof value === 'object') return value.name;
  if (typeof value === 'number') return String(value);
  return TIMESTAMP_FIELDS.has(field) ? formatHistoryTime(value, timeZone) : value;
}

function lineOf(
  change: TaskHistoryEntry['changes'][number],
  created: boolean,
  timeZone: string,
  t: Translate,
): HistoryLine {
  const label = historyFieldLabel(change.field, t);
  // 本文と知らない列は、値を出さず、直したことだけを出す
  if (VALUELESS_FIELDS.has(change.field) || !(change.field in FIELD_LABELS)) {
    return { label: null, text: t('historyFieldEdited', { field: label }) };
  }
  const after = valueText(change.field, change.after, timeZone, t);
  // 作成は、作ったときの値だけを出す
  if (created) return { label, text: after };
  return { label, text: t('historyChange', { before: valueText(change.field, change.before, timeZone, t), after }) };
}

export function historyEntryView(entry: TaskHistoryEntry, timeZone: string, t: Translate): HistoryEntryView {
  const base = {
    id: entry.id,
    createdAt: entry.created_at,
    at: formatHistoryTime(entry.created_at, timeZone),
    actor: entry.actor,
    actorName: entry.actor?.name ?? t('historyActorSystem'),
  };
  // 完了と削除は、何をしたかだけを出す（日時と人は行の頭にある）
  if (entry.action === 'complete') return { ...base, summary: t('historyCompleted', { done: t('done') }), lines: [] };
  if (entry.action === 'delete') return { ...base, summary: t('historyDeleted'), lines: [] };
  const created = entry.action === 'create';
  return {
    ...base,
    summary: created ? t('historyCreated') : t('historyUpdated'),
    lines: entry.changes.map((change) => lineOf(change, created, timeZone, t)),
  };
}
