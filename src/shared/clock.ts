// 今の日時と、タイムゾーンでの今日・今月。Worker の処理は、日時をここから取る。
// 開発用の値での差し替えは、ここ1か所に足す

export function now(): Date {
  return new Date();
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timezone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timezone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    formatters.set(timezone, formatter);
  }
  return formatter;
}

function datePartsIn(timezone: string, at: Date): { year: string; month: string; day: string } {
  const parts = Object.fromEntries(
    formatterFor(timezone)
      .formatToParts(at)
      .map((part) => [part.type, part.value]),
  );
  return { year: String(parts.year).padStart(4, '0'), month: String(parts.month), day: String(parts.day) };
}

// タイムゾーンでの日付（YYYY-MM-DD）。timezone は normalizeTimezone を通した名前
export function todayIn(timezone: string, at: Date = now()): string {
  const { year, month, day } = datePartsIn(timezone, at);
  return `${year}-${month}-${day}`;
}

// タイムゾーンでの月（YYYY-MM）
export function monthIn(timezone: string, at: Date = now()): string {
  const { year, month } = datePartsIn(timezone, at);
  return `${year}-${month}`;
}
