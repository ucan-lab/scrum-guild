// 期日（YYYY-MM-DD）の判定。ストーリーとタスクの行の期日の印が使う。
// 日付はタイムゾーンを持たない暦の日として扱う。今日の日付と週の始まりはワークスペースの値を呼び出し側が渡す
// （ブラウザの時計とタイムゾーンに頼らない）。画面の束にも入り、scripts/ からも読むので、Node の型の除去で動く書き方に留める

export type DueStatus = 'overdue' | 'today' | 'this_week' | 'later';

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;

// 暦に存在する YYYY-MM-DD のとき、その日の通し番号（1970-01-01 が 0）を返す。存在しない日付は null。
// Date.UTC は 0〜99 年を 1900 年代に読むので、setUTCFullYear で年を入れる
function dayNumberOf(date: string): number | null {
  const match = DATE_PATTERN.exec(date);
  if (match === null) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const at = new Date(0);
  at.setUTCFullYear(year, month - 1, day);
  if (at.getUTCFullYear() !== year || at.getUTCMonth() !== month - 1 || at.getUTCDate() !== day) return null;
  return at.getTime() / DAY_MS;
}

// 暦に存在する日付か（2026-02-30 は偽）。DB の CHECK（due_on IS date(due_on)）と同じ判定
export function isCalendarDate(value: string): boolean {
  return dayNumberOf(value) !== null;
}

// 週の始まり（0〜6、0 が日曜）から数えた、今日までの日数（0〜6）
function daysIntoWeek(todayNumber: number, weekStart: number): number {
  // 1970-01-01 は木曜（4）
  const weekday = (((todayNumber + 4) % 7) + 7) % 7;
  return (weekday - weekStart + 7) % 7;
}

// 今週は、週の始まりの日からの7日間。今日を含む週の最終日（YYYY-MM-DD）を返す
export function weekEndOf(today: string, weekStart: number): string {
  const todayNumber = dayNumberOf(today);
  if (todayNumber === null || !Number.isInteger(weekStart) || weekStart < 0 || weekStart > 6) {
    throw new RangeError('今日の日付か週の始まりが使えない');
  }
  const end = new Date((todayNumber + 6 - daysIntoWeek(todayNumber, weekStart)) * DAY_MS);
  return end.toISOString().slice(0, 10).padStart(10, '0');
}

// 暦の日付に日数を足した日付（YYYY-MM-DD。引くなら負の数）。暦に存在しない日付は RangeError
export function addDays(date: string, days: number): string {
  const dayNumber = dayNumberOf(date);
  if (dayNumber === null || !Number.isInteger(days)) throw new RangeError('日付か日数が使えない');
  return new Date((dayNumber + days) * DAY_MS).toISOString().slice(0, 10).padStart(10, '0');
}

// 期日が今日より前なら overdue、今日なら today、今日を含む週の終わりまでなら this_week、それより先は later。
// 完了したタスクの色を付けない扱いは呼び出し側で決める
export function dueStatus(dueOn: string, today: string, weekStart: number): DueStatus {
  if (dayNumberOf(dueOn) === null) throw new RangeError('期日が使えない');
  const weekEnd = weekEndOf(today, weekStart);
  // 暦に存在する YYYY-MM-DD は、文字列の比較が日付の前後と一致する
  if (dueOn < today) return 'overdue';
  if (dueOn === today) return 'today';
  return dueOn <= weekEnd ? 'this_week' : 'later';
}
