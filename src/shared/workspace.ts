// ワークスペースの共通の値。作る操作と、名前を変える設定の画面（#72）が同じ値を使う。
// 画面の束にも入るので、Worker のコードを引かない。scripts/ からも読むので、Node の型の除去で動く書き方に留める
import { z } from 'zod';
import './zod-config.ts';
import type { Vocabulary } from './vocabulary.ts';

// 名前は前後の空白を除いて 1〜50 字。字数はコードポイントで数える（絵文字も1字）
export const WORKSPACE_NAME_MAX_LENGTH = 50;

// 断る文字: 制御文字（Cc）、ゼロ幅のスペース（U+200B）、行と段落の区切り（U+2028、U+2029）、
// 文字の向きを変える制御（U+202A〜U+202E、U+2066〜U+2069）、BOM（U+FEFF）。見えないまま名前に紛れ、並びや表示を乱すため。
// 書式の文字（Cf）をまとめては断らない。ZWJ（U+200D）でつないだ絵文字、ZWNJ（U+200C）を使うペルシア語やインド系の文字、
// 旗のタグ文字（U+E0020 以降）の名前を通すため。
// 文字は \u{...} で書く（生の文字や \uXXXX は、行の区切りが正規表現を壊し、見えないので差分でも読めない）
const REJECTED_CHARACTERS = /[\p{Cc}\u{200B}\u{2028}\u{2029}\u{202A}-\u{202E}\u{2066}-\u{2069}\u{FEFF}]/u;

// 空白、書式の文字、幅を持たない（または空白に見える）文字。これらを除いて何も残らない名前は、空の名前と同じ扱いにする
// （U+3164 と U+FFA0 はハングルの詰め物、U+115F と U+1160 はハングルの字母の詰め物、U+2800 は点字の空白）
const BLANK_CHARACTERS = /[\p{White_Space}\p{Cf}\u{3164}\u{2800}\u{115F}\u{1160}\u{FFA0}]/gu;

export type WorkspaceNameProblem = 'required' | 'too_long' | 'invalid_character';

// 画面の検査と API の検証が同じ判定を使う。name は前後の空白を除いた後の値
export function workspaceNameProblem(name: string): WorkspaceNameProblem | null {
  if (name.replace(BLANK_CHARACTERS, '') === '') return 'required';
  if (REJECTED_CHARACTERS.test(name)) return 'invalid_character';
  const length = [...name].length;
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
