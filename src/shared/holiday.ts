// 組織の休日の共通の値。貼り付けの解析（組織の管理の画面）と、登録の操作（organization-holiday-add）の検証が同じ決まりを使う。
// 画面の束にも入るので、Worker のコードを引かない。scripts/ からも読むので、Node の型の除去で動く書き方に留める
import { z } from 'zod';
import './zod-config.ts';
import { isCalendarDate } from './due.ts';
import { BLANK_CHARACTERS, shortTextProblem } from './text-rules.ts';

// 名前は前後の空白を除いて 40 字まで（コードポイントで数える）。DB の CHECK（length(name) BETWEEN 1 AND 40）と同じ上限
export const HOLIDAY_NAME_MAX_LENGTH = 40;
// 登録できる年の範囲。DB の CHECK（holiday_on BETWEEN '2000-01-01' AND '2099-12-31'）と同じ。年の打ち間違い（1926、2206）を止める
export const HOLIDAY_FIRST_YEAR = 2000;
export const HOLIDAY_LAST_YEAR = 2099;
// 1回の登録で送れる日数。D1 の1文の束縛（100）で区切って文を並べるので、ここは1回の batch の大きさを抑える上限
export const HOLIDAYS_PER_REQUEST = 100;

export type Holiday = { holiday_on: string; name: string | null };

// 行ごとの理由。画面は辞書を通して文にする
// - invalid_date: 日付の形（YYYY-MM-DD か YYYY/M/D）でない
// - no_such_date: 形は合うが暦に無い日付（2026-02-30）
// - out_of_range: 暦の日付だが、登録できる年（HOLIDAY_FIRST_YEAR〜HOLIDAY_LAST_YEAR）の外
// - too_long、invalid_character: 名前が長すぎる、見えない文字（制御文字、ゼロ幅のスペースなど）を含む
// - duplicate: 同じ日付が前の行にある（前の行を使う）
export type HolidayLineProblem =
  'invalid_date' | 'no_such_date' | 'out_of_range' | 'too_long' | 'invalid_character' | 'duplicate';

// YYYY-MM-DD の文字列は、同じ形どうしなら文字の順が日付の順になる
const FIRST_DAY = `${HOLIDAY_FIRST_YEAR}-01-01`;
const LAST_DAY = `${HOLIDAY_LAST_YEAR}-12-31`;

// 暦に存在する YYYY-MM-DD の日付を渡す。登録できる年の中か
export function isHolidayYearInRange(holidayOn: string): boolean {
  return holidayOn >= FIRST_DAY && holidayOn <= LAST_DAY;
}

// line は1から数えた行の番号。text は前後の空白を除いた行
export type HolidayPasteProblem = { line: number; text: string; reason: HolidayLineProblem };

export type HolidayPaste = { holidays: Holiday[]; problems: HolidayPasteProblem[] };

// 前後の空白を除き、空（空白と見えない文字だけ）なら null
export function normalizeHolidayName(raw: string): string | null {
  const name = raw.trim();
  return name.replace(BLANK_CHARACTERS, '') === '' ? null : name;
}

// normalizeHolidayName を通した後の値を渡す。空（null）は通す
export function holidayNameProblem(name: string | null): 'too_long' | 'invalid_character' | null {
  if (name === null) return null;
  const problem = shortTextProblem(name, HOLIDAY_NAME_MAX_LENGTH);
  return problem === 'required' ? null : problem;
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
// 内閣府の祝日の CSV の形（1955/1/1）
const SLASH_DATE = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/;

// 日付の形なら YYYY-MM-DD にそろえる（暦に有るかは見ない）。形でなければ null
function normalizeDate(token: string): string | null {
  const match = ISO_DATE.exec(token) ?? SLASH_DATE.exec(token);
  if (match === null) return null;
  return `${match[1]}-${match[2]!.padStart(2, '0')}-${match[3]!.padStart(2, '0')}`;
}

// 日付と名前の区切り。空白（全角の空白とタブを含む）とカンマ
function isSeparator(char: string): boolean {
  return char === ',' || /\s/u.test(char);
}

// 1行を日付の字句と名前の残りに分ける。日付の字句は最初の区切りの前まで。
// 区切りは、空白の並びか、前後に空白を置いてよいカンマ1つ（「2026-11-03, 文化の日」）。名前の先頭の空白は名前の側で除く
function splitLine(line: string): { token: string; rest: string } {
  let index = 0;
  while (index < line.length && !isSeparator(line[index]!)) index++;
  const token = line.slice(0, index);
  let rest = line.slice(index);
  const trimmed = rest.trimStart();
  if (trimmed.startsWith(',')) rest = trimmed.slice(1);
  return { token, rest };
}

// 日付の後の残りから名前を取り出す（前後の空白はまだ除かない）。
// 表計算から写した行は、列がタブで続くので、名前の中の最初のタブより後（3列目より後）は捨てる。
// CSV の名前は、前後の二重引用符を1組だけ外す（"文化の日" は 文化の日）
function nameFromRest(rest: string): string {
  const leading = rest.trimStart();
  const tab = leading.indexOf('\t');
  const name = (tab === -1 ? leading : leading.slice(0, tab)).trim();
  return name.length >= 2 && name.startsWith('"') && name.endsWith('"') ? name.slice(1, -1) : name;
}

// 貼り付けた文字を、1行に1日として読む。空の行は飛ばす。同じ日付が重なれば、前の行を使い、後の行を duplicate にする。
// 正しい行が HOLIDAYS_PER_REQUEST を超えても、ここでは切らない（画面が分けて送るよう示す）
export function parseHolidayPaste(text: string): HolidayPaste {
  const holidays: Holiday[] = [];
  const problems: HolidayPasteProblem[] = [];
  const seen = new Set<string>();
  const lines = text.split(/\r\n|\r|\n/);
  lines.forEach((raw, index) => {
    const line = raw.trim();
    if (line === '') return;
    const problem = (reason: HolidayLineProblem) => problems.push({ line: index + 1, text: line, reason });
    const { token, rest } = splitLine(line);
    const holidayOn = normalizeDate(token);
    if (holidayOn === null) return problem('invalid_date');
    if (!isCalendarDate(holidayOn)) return problem('no_such_date');
    if (!isHolidayYearInRange(holidayOn)) return problem('out_of_range');
    const name = normalizeHolidayName(nameFromRest(rest));
    const nameProblem = holidayNameProblem(name);
    if (nameProblem !== null) return problem(nameProblem);
    if (seen.has(holidayOn)) return problem('duplicate');
    seen.add(holidayOn);
    holidays.push({ holiday_on: holidayOn, name });
  });
  return { holidays, problems };
}

// 日付は YYYY-MM-DD の暦の日付で、登録できる年の中だけ（API は解析済みの値を受けるので、YYYY/M/D は受けない）
export const holidayOnSchema = z.string().refine((value) => isCalendarDate(value) && isHolidayYearInRange(value), {
  message: `休日の日付が使えない（YYYY-MM-DD の暦の日付で ${HOLIDAY_FIRST_YEAR}〜${HOLIDAY_LAST_YEAR} 年）`,
});

// 名前は前後の空白を除き、空（空白だけを含む）は null にそろえる。null はそのまま通す
export const holidayNameSchema = z
  .string()
  .transform((raw, ctx) => {
    const name = normalizeHolidayName(raw);
    const problem = holidayNameProblem(name);
    if (problem !== null) {
      ctx.addIssue({ code: 'custom', message: `休日の名前が使えない（${problem}）` });
      return z.NEVER;
    }
    return name;
  })
  .nullable();
