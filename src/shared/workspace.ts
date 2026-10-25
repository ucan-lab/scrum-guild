// ワークスペースの共通の値。作る操作と、名前を変える設定の画面（#72）が同じ値を使う。
// 画面の束にも入るので、Worker のコードを引かない。scripts/ からも読むので、Node の型の除去で動く書き方に留める
import { z } from 'zod';
import './zod-config.ts';
import type { Vocabulary } from './vocabulary.ts';

// 名前は前後の空白を除いて 1〜50 字。字数はコードポイントで数える（絵文字も1字）
export const WORKSPACE_NAME_MAX_LENGTH = 50;

// 制御文字（Cc）と書式の文字（Cf。ゼロ幅の文字、向きを変える文字など）。見えないまま名前に紛れるため断る
const INVISIBLE_CHARACTERS = /[\p{Cc}\p{Cf}]/u;

export type WorkspaceNameProblem = 'required' | 'too_long' | 'invalid_character';

// 画面の検査と API の検証が同じ判定を使う。name は前後の空白を除いた後の値
export function workspaceNameProblem(name: string): WorkspaceNameProblem | null {
  if (INVISIBLE_CHARACTERS.test(name)) return 'invalid_character';
  const length = [...name].length;
  if (length === 0) return 'required';
  if (length > WORKSPACE_NAME_MAX_LENGTH) return 'too_long';
  return null;
}

export const workspaceNameSchema = z
  .string()
  .trim()
  .superRefine((name, ctx) => {
    const problem = workspaceNameProblem(name);
    if (problem !== null) ctx.addIssue({ code: 'custom', message: `ワークスペースの名前が使えない（${problem}）` });
  });

export const workspaceVocabularySchema = z.enum(['game', 'scrum']);

// ワークスペースを作った直後の値（docs/requirements.md の「機能」）
export const DEFAULT_HOURS_PER_POINT = 4;
// 0 が日曜。1 は月曜
export const DEFAULT_WEEK_START = 1;

// 列と決まった欄に付けた名前は、言葉づかいを切り替えても訳さない。作るときの言葉づかいで名前を決める。
// 完了の列は name を空にして保存し、言葉づかいに合わせた名前を辞書の done から出す
export const defaultColumnNames = {
  game: ['出発前', '遂行中', '査定中'],
  scrum: ['未着手', '作業中', 'レビュー'],
} as const satisfies Record<Vocabulary, readonly [string, string, string]>;

// 辞書の ac と同じ言葉（scripts/workspace.test.ts が突き合わせる）
export const defaultDetailFieldNames = {
  game: '達成条件',
  scrum: '受け入れ基準',
} as const satisfies Record<Vocabulary, string>;
