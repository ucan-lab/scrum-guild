// 日時の出し方。日時は UTC で持ち、画面ではブラウザのタイムゾーンで出す（docs/requirements.md の「技術の前提」）

const dateFormatter = new Intl.DateTimeFormat('sv-SE', { year: 'numeric', month: '2-digit', day: '2-digit' });

// UTC の ISO 8601 を、ブラウザのタイムゾーンの YYYY-MM-DD にする。読めない値は元のまま返す
export function formatLocalDate(iso: string): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? iso : dateFormatter.format(at);
}

// UTC の ISO 8601 を、UTC の YYYY-MM-DD にする。ブラウザのタイムゾーンに依らない日付で、運用の画面の「停止 <日>」が、
// UTC の日付で数える「<日> に消す」（停止から30日後）と同じ基準で並ぶ。読めない値は元のまま返す
export function formatUtcDate(iso: string): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? iso : at.toISOString().slice(0, 10);
}

// 期日（YYYY-MM-DD）を 月/日 にする（kit.js の md）。期日は暦の日付で、タイムゾーンを掛けない。読めない値は元のまま返す
export function formatMonthDay(date: string): string {
  const match = /^\d{4}-(\d{2})-(\d{2})$/.exec(date);
  return match === null ? date : `${Number(match[1])}/${Number(match[2])}`;
}

// このブラウザのタイムゾーンの名前。取れないときは UTC
export function browserTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

const countFormatter = new Intl.NumberFormat('ja-JP');
const sizeFormatter = new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 1 });

// 件数を3桁ごとの区切りで出す（1,284）
export function formatCount(count: number): string {
  return countFormatter.format(count);
}

// 容量の上限の大きさと単位。1 GB（1024³ バイト）以上は GB、それ未満は MB（1024² バイト）にする。
// 1 GB 未満を GB で丸めると「0 GB」になるため。小数は1桁まで（30、1.5、512）。単位の文字は言葉の辞書の側で付ける
export function quotaSize(bytes: number): { size: string; unit: 'gb' | 'mb' } {
  if (bytes >= 1024 ** 3) return { size: sizeFormatter.format(bytes / 1024 ** 3), unit: 'gb' };
  return { size: sizeFormatter.format(bytes / 1024 ** 2), unit: 'mb' };
}
