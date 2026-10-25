// 辞書の型の保証を、pnpm check で検査する。実行はしない（どこからも import しない）。
// 片方の言葉が欠けた項目が型で落ちなくなると、@ts-expect-error が「使われていない」と言って check が落ちる
import { defineDictionary, organization, workspace } from './vocabulary.ts';

export const complete = defineDictionary({
  both: workspace('ゲームの言葉', 'スクラムの言葉'),
  orgBoth: organization('ゲームの言葉', 'スクラムの言葉'),
});

export const missing = defineDictionary({
  // @ts-expect-error scrum が無い項目は型で落ちる
  noScrum: { scope: 'workspace', game: 'ゲームの言葉' },
  // @ts-expect-error game が無い項目は型で落ちる
  noGame: { scope: 'workspace', scrum: 'スクラムの言葉' },
  // @ts-expect-error scope が無い項目は型で落ちる
  noScope: { game: 'ゲームの言葉', scrum: 'スクラムの言葉' },
});

// @ts-expect-error 引数が1つの項目の組み立ては型で落ちる
export const oneWord = workspace('ゲームの言葉');
