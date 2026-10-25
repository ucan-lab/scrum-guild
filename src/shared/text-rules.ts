// 名前やタイトルのように、1行で見える短い文字列に共通の文字の決まり。ワークスペースの名前とタスクのタイトルが使う。
// 画面の束にも入り、scripts/ からも読むので、Node の型の除去で動く書き方に留める。
// 断る文字（制御文字、ゼロ幅のスペース、行と段落の区切り、向きを変える制御、見えない演算子、BOM）の決まりは、
// 組織の表示名と GitHub の表示名と同じで、hidden-characters.ts の1か所に置く
import { hasHiddenCharacter } from './hidden-characters.ts';

// 空白、書式の文字、幅を持たない（または空白に見える）文字。これらを除いて何も残らない名前は、空の名前と同じ扱いにする
// （U+3164 と U+FFA0 はハングルの詰め物、U+115F と U+1160 はハングルの字母の詰め物、U+2800 は点字の空白）
export const BLANK_CHARACTERS = /[\p{White_Space}\p{Cf}\u{3164}\u{2800}\u{115F}\u{1160}\u{FFA0}]/gu;

export type ShortTextProblem = 'required' | 'too_long' | 'invalid_character';

// 前後の空白を除いた後の値を渡す。字数はコードポイントで数える（絵文字も1字）
export function shortTextProblem(value: string, maxLength: number): ShortTextProblem | null {
  if (value.replace(BLANK_CHARACTERS, '') === '') return 'required';
  if (hasHiddenCharacter(value)) return 'invalid_character';
  if ([...value].length > maxLength) return 'too_long';
  return null;
}
