// スプリントの列（board_columns）の名前と数の決まり。作る操作・変える操作と、設定の画面が同じ決まりを使う。
// 画面の束にも入るので、Worker のコードを引かない
import { z } from 'zod';
import './zod-config.ts';
import { shortTextProblem, type ShortTextProblem } from './text-rules.ts';

// 名前は前後の空白を除いて 1〜30 字。字数はコードポイントで数え、見えない文字は断る（workspaces.name と同じ文字の決まり）。
// スプリントの画面の列は横に並ぶので、ワークスペースの名前より短くする
export const COLUMN_NAME_MAX_LENGTH = 30;

// 1つのワークスペースに置ける、削除していない完了以外の列の数。スプリントの画面の列が横に際限なく伸びるのを止める
// （完了の列は数えない。常に1つ）
export const COLUMNS_PER_WORKSPACE = 12;

export type ColumnNameProblem = ShortTextProblem;

// 画面の検査と API の検証が同じ判定を使う。name は前後の空白を除いた後の値
export function columnNameProblem(name: string): ColumnNameProblem | null {
  return shortTextProblem(name, COLUMN_NAME_MAX_LENGTH);
}

export const columnNameSchema = z
  .string()
  .trim()
  .superRefine((name, ctx) => {
    const problem = columnNameProblem(name);
    if (problem !== null) ctx.addIssue({ code: 'custom', message: `列の名前が使えない（${problem}）` });
  });
