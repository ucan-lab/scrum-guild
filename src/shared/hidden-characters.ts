// 名前の見え方を偽れる文字。制御文字（Cc）、双方向の埋め込みと上書き（U+202A〜202E）、双方向の分離（U+2066〜2069）、
// ゼロ幅スペース（U+200B）、BOM（U+FEFF）。表示名やログイン名の並びを入れ替えたり、見えない文字で似せたりするのに使われうる。
// 絵文字の結合に要る ZWJ（U+200D）、ZWNJ（U+200C）、方向の印（LRM U+200E、RLM U+200F）は、書式文字（Cf）でも正しい名前に
// 使うので含めない。scripts/ のテストと Worker の型の検査からも読むので、Node の型の除去で動く書き方に留める。
// 正規表現のリテラルに見えない文字を直に置かないよう、エスケープを文字列で渡す
const HIDDEN_CHARACTERS_SOURCE = '[\\p{Cc}\\u202A-\\u202E\\u2066-\\u2069\\u200B\\uFEFF]';
const HIDDEN_CHARACTERS = new RegExp(HIDDEN_CHARACTERS_SOURCE, 'u');
const HIDDEN_CHARACTERS_GLOBAL = new RegExp(HIDDEN_CHARACTERS_SOURCE, 'gu');

export function hasHiddenCharacter(value: string): boolean {
  return HIDDEN_CHARACTERS.test(value);
}

export function stripHiddenCharacters(value: string): string {
  return value.replace(HIDDEN_CHARACTERS_GLOBAL, '');
}
