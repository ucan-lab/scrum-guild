// 今の日時と、タイムゾーンでの今日・今月。Worker の処理は、日時をここから取る。
// 開発用の時計（DEV_NOW）は、Worker のミドルウェア（src/server/dev-clock.ts）が setFixedNow で渡す。
// このファイルは scripts/ からも読むので、cloudflare:workers を import しない

let fixedAt: Date | undefined;

// 渡すと、now() はその時刻を返し続ける（時刻を止める）。undefined で本物の時計に戻す
export function setFixedNow(at: Date | undefined): void {
  fixedAt = at;
}

export function now(): Date {
  return fixedAt === undefined ? new Date() : new Date(fixedAt);
}

export type DevNow = { ok: true; at: Date } | { ok: false };

const DEV_NOW_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|([+-])(\d{2}):(\d{2}))$/;

// DEV_NOW の値（ISO 8601、時差付き。例 2026-10-26T10:00:00+09:00）を解釈する。時差の無い値と、存在しない日時
// （2026-02-30、24 時）は解釈できないものとして扱う。Date.parse は日付の繰り上がりを黙って通すので、読み戻して突き合わせる
export function parseDevNow(raw: unknown): DevNow {
  if (typeof raw !== 'string') return { ok: false };
  const match = DEV_NOW_PATTERN.exec(raw);
  if (match === null) return { ok: false };
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  const sign = match[8] === '-' ? -1 : 1;
  const offsetMinutes = match[7] === 'Z' ? 0 : sign * (Number(match[9]) * 60 + Number(match[10]));
  const at = new Date(raw);
  if (Number.isNaN(at.getTime())) return { ok: false };
  const local = new Date(at.getTime() + offsetMinutes * 60_000);
  const same =
    local.getUTCFullYear() === year &&
    local.getUTCMonth() + 1 === month &&
    local.getUTCDate() === day &&
    local.getUTCHours() === hour &&
    local.getUTCMinutes() === minute &&
    local.getUTCSeconds() === second;
  return same ? { ok: true, at } : { ok: false };
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
