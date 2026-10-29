// スプリントの共通の値と日付の計算。作る操作・変える操作と、計画の画面のダイアログが同じ決まりを使う。
// 日付はタイムゾーンを持たない暦の日（YYYY-MM-DD）として扱う。今日の日付と週の始まりはワークスペースの値を呼び出し側が渡す。
// 画面の束にも入り、scripts/ からも読むので、Worker のコードを引かない
import { z } from 'zod';
import './zod-config.ts';
import { isCalendarDate } from './due.ts';
import { hasHiddenCharacter } from './hidden-characters.ts';
import { BLANK_CHARACTERS, shortTextProblem } from './text-rules.ts';

// 長さは 1〜28 日（DB の CHECK と同じ）。前のスプリントが無いときの初期値は 14 日
export const SPRINT_MIN_LENGTH = 1;
export const SPRINT_MAX_LENGTH = 28;
export const SPRINT_DEFAULT_LENGTH = 14;

// 名前は任意。前後の空白を除いて 0〜100 字（コードポイントで数える）。断る文字は workspaces.name と同じ（text-rules.ts）
export const SPRINT_NAME_MAX_LENGTH = 100;

export type SprintNameProblem = 'too_long' | 'invalid_character';

// 前後の空白を除く。空白（と見えない空白）だけの名前は空と同じで、null にそろえる
export function normalizeSprintName(raw: string): string | null {
  const value = raw.trim();
  return value.replace(BLANK_CHARACTERS, '') === '' ? null : value;
}

// value は normalizeSprintName を通した後の値。空（null）は名前なしで、誤りではない
export function sprintNameProblem(value: string | null): SprintNameProblem | null {
  if (value === null) return null;
  const problem = shortTextProblem(value, SPRINT_NAME_MAX_LENGTH);
  return problem === 'required' ? null : problem;
}

export const sprintNameSchema = z
  .string()
  .transform((raw, ctx) => {
    const value = normalizeSprintName(raw);
    const problem = sprintNameProblem(value);
    if (problem !== null) {
      ctx.addIssue({ code: 'custom', message: `スプリントの名前が使えない（${problem}）` });
      return z.NEVER;
    }
    return value;
  })
  .nullable();

// ゴール（始めるときに書く、任意の文）。前後の空白を除いて 0〜200 字（コードポイントで数える）。改行は入れられる（LF にそろえる）。
// 断る文字は名前と同じ（hidden-characters.ts）が、改行（LF）と字下げのタブは通す
export const SPRINT_GOAL_MAX_LENGTH = 200;

export type SprintGoalProblem = 'too_long' | 'invalid_character';

// 前後の空白を除き、改行を LF にそろえる。空白（と見えない空白）だけのゴールは空と同じで、null にそろえる
export function normalizeSprintGoal(raw: string): string | null {
  const value = raw.replace(/\r\n?/g, '\n').trim();
  return value.replace(BLANK_CHARACTERS, '') === '' ? null : value;
}

// value は normalizeSprintGoal を通した後の値。空（null）はゴールなしで、誤りではない
export function sprintGoalProblem(value: string | null): SprintGoalProblem | null {
  if (value === null) return null;
  if (hasHiddenCharacter(value.replace(/[\n\t]/g, ' '))) return 'invalid_character';
  if ([...value].length > SPRINT_GOAL_MAX_LENGTH) return 'too_long';
  return null;
}

export const sprintGoalSchema = z
  .string()
  .transform((raw, ctx) => {
    const value = normalizeSprintGoal(raw);
    const problem = sprintGoalProblem(value);
    if (problem !== null) {
      ctx.addIssue({ code: 'custom', message: `スプリントのゴールが使えない（${problem}）` });
      return z.NEVER;
    }
    return value;
  })
  .nullable();

export const sprintLengthSchema = z.number().int().min(SPRINT_MIN_LENGTH).max(SPRINT_MAX_LENGTH);

// 開始日は YYYY-MM-DD の暦の日付。最終日も暦に収まること（9999-12-31 を越えない）は、長さと合わせて sprintEndOn で見る
export const sprintStartOnSchema = z
  .string()
  .refine(isCalendarDate, { message: '開始日が使えない（YYYY-MM-DD の暦の日付）' });

const DAY_MS = 86_400_000;

// 暦に存在する YYYY-MM-DD の通し番号（1970-01-01 が 0）。年は 4 桁だけ
function dayNumberOf(date: string): number | null {
  if (!isCalendarDate(date)) return null;
  const at = new Date(0);
  at.setUTCFullYear(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)));
  return at.getTime() / DAY_MS;
}

function dateOf(dayNumber: number): string | null {
  const at = new Date(dayNumber * DAY_MS);
  const year = at.getUTCFullYear();
  if (year < 1 || year > 9999) return null;
  return `${String(year).padStart(4, '0')}-${String(at.getUTCMonth() + 1).padStart(2, '0')}-${String(at.getUTCDate()).padStart(2, '0')}`;
}

// 日付に日数を足す。暦に無い日付か、0001〜9999 年を外れたら null
export function addDays(date: string, days: number): string | null {
  const day = dayNumberOf(date);
  return day === null ? null : dateOf(day + days);
}

// 開始日と長さからの最終日。最終日が暦を外れたら null
export function sprintEndOn(startOn: string, length: number): string | null {
  return addDays(startOn, length - 1);
}

// 開始日から最終日までの日数（両端を含む）
export function sprintLengthOf(startOn: string, endOn: string): number {
  const start = dayNumberOf(startOn);
  const end = dayNumberOf(endOn);
  if (start === null || end === null) throw new RangeError('スプリントの期間が使えない');
  return end - start + 1;
}

// 曜日（0 が日曜）
export function weekdayOf(date: string): number {
  const day = dayNumberOf(date);
  if (day === null) throw new RangeError('日付が使えない');
  // 1970-01-01 は木曜（4）
  return (((day + 4) % 7) + 7) % 7;
}

export type SprintDefaults = { start_on: string; length: number };

// 作るときの初期値（docs/requirements.md の「スプリント」）。前のスプリント（削除していない、終了したものも含めて最終日がいちばん後のもの）が
// あれば、その最終日の翌日と同じ長さ。無ければ、今日より後で最初の週の始まりの日と 14 日。
// 前のスプリントの翌日が暦を外れるときは、前が無いときと同じ値にする
export function sprintDefaults(
  previous: { start_on: string; end_on: string } | null,
  today: string,
  weekStart: number,
): SprintDefaults {
  if (previous !== null) {
    const start = addDays(previous.end_on, 1);
    if (start !== null) return { start_on: start, length: sprintLengthOf(previous.start_on, previous.end_on) };
  }
  const ahead = (weekStart - weekdayOf(today) + 7) % 7 || 7;
  return { start_on: addDays(today, ahead) ?? today, length: SPRINT_DEFAULT_LENGTH };
}

export type SprintProgress = { day: number; length: number; remaining: number };

// 進行中のスプリントの「N 日のうち M 日目」と残りの日数。today はワークスペースのタイムゾーンでの今日。
// 残りは今日を含めて数える（見本の「残り」と同じで、最終日は残り 1 日）。
// 開始日の前に始めたときは 1 日目で残りは長さのまま、最終日を過ぎたときは最終日の日に丸めて残りは 0
export function sprintProgress(sprint: { start_on: string; end_on: string }, today: string): SprintProgress {
  const length = sprintLengthOf(sprint.start_on, sprint.end_on);
  const start = dayNumberOf(sprint.start_on)!;
  const now = dayNumberOf(today);
  const elapsed = now === null ? 1 : Math.max(now - start + 1, 1);
  return { day: Math.min(elapsed, length), length, remaining: Math.max(length - elapsed + 1, 0) };
}
