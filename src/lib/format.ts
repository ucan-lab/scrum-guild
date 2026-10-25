// 日時の出し方。日時は UTC で持ち、画面ではブラウザのタイムゾーンで出す（docs/requirements.md の「技術の前提」）

const dateFormatter = new Intl.DateTimeFormat('sv-SE', { year: 'numeric', month: '2-digit', day: '2-digit' });

// UTC の ISO 8601 を、ブラウザのタイムゾーンの YYYY-MM-DD にする。読めない値は元のまま返す
export function formatLocalDate(iso: string): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? iso : dateFormatter.format(at);
}

// このブラウザのタイムゾーンの名前。取れないときは UTC
export function browserTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}
