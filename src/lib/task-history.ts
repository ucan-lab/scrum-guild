// タスクの詳細の引き出しの「変更の履歴」の、1件ごとの見せ方（task-history の結果を、辞書の言葉の文にする）。
// 列の名前は、下の表で辞書の言葉にする。
// 辞書は引数（translate）で受け取り、画面の状態に頼らない（テストが画面なしで呼べる）
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

// 列の名前から辞書の言葉へ。ここに無い列は「そのほかの欄」として、値を出さない。
// 完了と削除の行は操作だけを出すので、その列（completed_at、completed_by、deleted_at）は表に入れない。
// 列の名前は保存した JSON のキーなので、__proto__ などで Object の持ち物を引かないよう Map で持つ
const FIELD_LABELS: ReadonlyMap<string, (t: Translate) => string> = new Map([
  ['thanks', (t: Translate) => t('thanks')],
  ['title', (t: Translate) => t('fieldTitle')],
  ['points', (t: Translate) => t('points')],
  ['due_on', (t: Translate) => t('due')],
  ['link_url', (t: Translate) => t('fieldLink')],
  ['body_md', (t: Translate) => t('fieldBody')],
  ['assignee', (t: Translate) => t('assignee')],
  ['story', (t: Translate) => t('historyFieldParent', { story: t('story') })],
  ['category', (t: Translate) => t('category')],
  ['repository', (t: Translate) => t('repository')],
  ['sprint', (t: Translate) => t('sprint')],
  ['column', (t: Translate) => t('column')],
  ['today_on', (t: Translate) => t('historyFieldToday')],
]);

// 値を出さない列（本文は長いので、API も値を返さない）
const VALUELESS_FIELDS = new Set(['body_md']);

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
  return FIELD_LABELS.get(field)?.(t) ?? t('historyFieldOther');
}

// 名前。空（読めなかった名前）は「不明」
function nameText(name: string, t: Translate): string {
  return name === '' ? t('historyUnknownName') : name;
}

function valueText(field: string, value: TaskHistoryValue, t: Translate): string {
  if (value === null) {
    if (field === 'thanks') return t('thanksNone');
    if (field === 'points') return t('pointsUnsetTitle');
    if (field === 'assignee') return t('unassigned');
    return t('historyNone');
  }
  if (typeof value === 'object') return nameText(value.name, t);
  return String(value);
}

// 作成の行に出す値か。空の値（null と空の文字）は出さない
function hasValue(value: TaskHistoryValue): boolean {
  return value !== null && value !== '';
}

function lineOf(change: TaskHistoryEntry['changes'][number], created: boolean, t: Translate): HistoryLine {
  const label = historyFieldLabel(change.field, t);
  // 本文と知らない列は、値を出さず、直したことだけを出す
  if (VALUELESS_FIELDS.has(change.field) || !FIELD_LABELS.has(change.field)) {
    return { label: null, text: t('historyFieldEdited', { field: label }) };
  }
  const after = valueText(change.field, change.after, t);
  // 作成は、作ったときの値だけを出す
  if (created) return { label, text: after };
  return { label, text: t('historyChange', { before: valueText(change.field, change.before, t), after }) };
}

export function historyEntryView(entry: TaskHistoryEntry, timeZone: string, t: Translate): HistoryEntryView {
  const base = {
    id: entry.id,
    createdAt: entry.created_at,
    at: formatHistoryTime(entry.created_at, timeZone),
    actor: entry.actor,
    actorName: entry.actor === null ? t('historyActorSystem') : nameText(entry.actor.name, t),
  };
  // 完了と削除は、何をしたかだけを出す（日時と人は行の頭にある）
  if (entry.action === 'complete') return { ...base, summary: t('historyCompleted', { done: t('done') }), lines: [] };
  if (entry.action === 'delete') return { ...base, summary: t('historyDeleted'), lines: [] };
  // 完了を戻した（task-reopen）。スプリントの中なら、戻した列だけを出す。前の列は完了の列で、名前を持たない（画面は辞書の「完了」を出す）
  if (entry.action === 'reopen') {
    const lines = entry.changes
      .filter((change) => change.field === 'column')
      .map((change) => {
        const before =
          change.before !== null && typeof change.before === 'object' && change.before.name === ''
            ? t('done')
            : valueText(change.field, change.before, t);
        return {
          label: historyFieldLabel(change.field, t),
          text: t('historyChange', { before, after: valueText(change.field, change.after, t) }),
        };
      });
    return { ...base, summary: t('historyReopened', { done: t('done') }), lines };
  }
  if (entry.action === 'create') {
    // 作成は、空でない初めの値だけを出す（本文と知らない列は、直したことだけ）
    const changes = entry.changes.filter(
      (change) => !FIELD_LABELS.has(change.field) || VALUELESS_FIELDS.has(change.field) || hasValue(change.after),
    );
    return { ...base, summary: t('historyCreated'), lines: changes.map((change) => lineOf(change, true, t)) };
  }
  return {
    ...base,
    summary: t('historyUpdated'),
    lines: entry.changes.map((change) => lineOf(change, false, t)),
  };
}
