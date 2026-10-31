// 辞書の型の保証を、pnpm check で検査する。実行はしない（どこからも import しない）。
// 文字列でない項目が型で落ちなくなると、@ts-expect-error が「使われていない」と言って check が落ちる
import { defineDictionary } from './vocabulary.ts';

export const complete = defineDictionary({
  text: 'スクラムの言葉',
  withParam: '{task}を作りました',
});

export const invalid = defineDictionary({
  // @ts-expect-error 数の項目は型で落ちる
  number: 1,
  // @ts-expect-error オブジェクトの項目は型で落ちる
  object: { text: 'スクラムの言葉' },
  // @ts-expect-error 旧形式（scope と2つの言葉）の項目は型で落ちる
  legacy: { scope: 'workspace', game: 'ゲームの言葉', scrum: 'スクラムの言葉' },
});
