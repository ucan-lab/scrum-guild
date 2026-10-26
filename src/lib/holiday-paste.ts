// 組織の休日の貼り付けの欄（HolidaysSetting.svelte）が、送った後に欄へ残す文と、出す理由の数を決める。
// 部品から外し、DOM なしで確かめられるようにする
import type { HolidayPasteProblem } from '../shared/holiday.ts';

// 理由の一覧に出す行の数。超えた分は「ほか n 行」にまとめる（長い貼り付けで欄の下が埋まらないようにする）
export const VISIBLE_PROBLEM_LINES = 10;
// 理由に添える行の文字の上限（コードポイント）。超えたら切って「…」を付ける
export const PROBLEM_TEXT_MAX_LENGTH = 40;

// 送れた後に欄へ残す文。送った時点の解析の結果（problems）から作る（送っている間に欄が変わっても、送った内容に合わせる）。
// 直せば登録できる行だけを残し、同じ日付が前の行にあった行は、その日付を登録したので落とす
export function remainingPasteText(problems: readonly HolidayPasteProblem[]): string {
  return problems
    .filter((problem) => problem.reason !== 'duplicate')
    .map((problem) => problem.text)
    .join('\n');
}

// 理由に添える行の文字。長ければ切って「…」を付ける
export function problemLineText(text: string): string {
  const chars = [...text];
  return chars.length > PROBLEM_TEXT_MAX_LENGTH ? `${chars.slice(0, PROBLEM_TEXT_MAX_LENGTH).join('')}…` : text;
}

// 一覧に出す理由と、出さずにまとめる数
export function visibleProblems(problems: readonly HolidayPasteProblem[]): {
  shown: readonly HolidayPasteProblem[];
  hidden: number;
} {
  return {
    shown: problems.slice(0, VISIBLE_PROBLEM_LINES),
    hidden: Math.max(0, problems.length - VISIBLE_PROBLEM_LINES),
  };
}
