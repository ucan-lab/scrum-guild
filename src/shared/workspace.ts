// ワークスペースの共通の値。作る操作と、名前を変える設定の画面（#72）が同じ値を使う。
// 画面の束にも入るので、Worker のコードを引かない。scripts/ からも読むので、Node の型の除去で動く書き方に留める
import { z } from 'zod';
import './zod-config.ts';
import { shortTextProblem, type ShortTextProblem } from './text-rules.ts';

// 名前は前後の空白を除いて 1〜50 字。字数はコードポイントで数える（絵文字も1字）
export const WORKSPACE_NAME_MAX_LENGTH = 50;

export type WorkspaceNameProblem = ShortTextProblem;

// 画面の検査と API の検証が同じ判定を使う。name は前後の空白を除いた後の値。文字の決まりは text-rules.ts
export function workspaceNameProblem(name: string): WorkspaceNameProblem | null {
  return shortTextProblem(name, WORKSPACE_NAME_MAX_LENGTH);
}

export const workspaceNameSchema = z
  .string()
  .trim()
  .superRefine((name, ctx) => {
    const problem = workspaceNameProblem(name);
    if (problem !== null) ctx.addIssue({ code: 'custom', message: `ワークスペースの名前が使えない（${problem}）` });
  });

// ワークスペースを作った直後の値（docs/requirements.md の「機能」）
export const DEFAULT_HOURS_PER_POINT = 4;
// 0 が日曜。1 は月曜
export const DEFAULT_WEEK_START = 1;

// 作るときにスクラムの言葉で名前を付け、保存する。
// 完了の列は name を空にして保存し、名前は辞書の done から出す
export const defaultColumnNames = ['未着手', '作業中', 'レビュー'] as const;

// 辞書の ac のスクラムの言葉と同じ（scripts/workspace.test.ts が突き合わせる）
export const defaultDetailFieldName = '受け入れ基準';
