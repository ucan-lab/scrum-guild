// タスクの共通の値。作る操作と、起票のダイアログが同じ値を使う。
// 画面の束にも入るので、Worker のコードを引かない。scripts/ からも読むので、Node の型の除去で動く書き方に留める
import { z } from 'zod';
import './zod-config.ts';
import { shortTextProblem, type ShortTextProblem } from './text-rules.ts';

// タイトルは前後の空白を除いて 1〜200 字。字数はコードポイントで数える
export const TASK_TITLE_MAX_LENGTH = 200;

export type TaskTitleProblem = ShortTextProblem;

// 画面の検査と API の検証が同じ判定を使う。title は前後の空白を除いた後の値
export function taskTitleProblem(title: string): TaskTitleProblem | null {
  return shortTextProblem(title, TASK_TITLE_MAX_LENGTH);
}

export const taskTitleSchema = z
  .string()
  .trim()
  .superRefine((title, ctx) => {
    const problem = taskTitleProblem(title);
    if (problem !== null) ctx.addIssue({ code: 'custom', message: `タスクのタイトルが使えない（${problem}）` });
  });

// ポイント。tasks.points の CHECK と同じ値。空は未見積もり
export const TASK_POINT_VALUES = [0, 1, 2, 3, 5, 8, 13] as const;

export const taskPointsSchema = z.union([
  z.literal(0),
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(5),
  z.literal(8),
  z.literal(13),
]);

// 起票と完了の経験値が付くのは、完了にした時点のポイントが 1 以上のタスクだけ
export const MIN_POINTS_FOR_EXPERIENCE = 1;
