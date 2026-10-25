// 名前（ワークスペースの名前、組織の表示名）とタスクのタイトルで断り、GitHub の表示名から除く文字。名前の見え方を偽り、並びや表示を乱せるもの。
// 判定はここの1か所に置き、ワークスペースの名前とタスクのタイトル（text-rules.ts）、組織の表示名（operator/create-organization.ts）、
// ログインの手段の側の名前（server/auth/profile-fields.ts。GitHub と Google が共有する）が同じ文字を扱う。
//   - 制御文字（Cc）
//   - ゼロ幅のスペース（U+200B）
//   - 行と段落の区切り（U+2028、U+2029）
//   - 文字の向きを変える制御（U+202A〜U+202E、U+2066〜U+2069）
//   - 語結合子などの見えない演算子（U+2060〜U+2064）
//   - BOM（U+FEFF）
// 書式の文字（Cf）をまとめては扱わない。ZWJ（U+200D）でつないだ絵文字、ZWNJ（U+200C）を使うペルシア語やインド系の文字、
// 方向の印（LRM U+200E、RLM U+200F、ALM U+061C）、旗のタグ文字（U+E0020〜U+E007F）の名前を通すため。
// 画面の束にも入り、scripts/ からも読むので、Worker のコードを引かず、Node の型の除去で動く書き方に留める。
// 文字は \u{...} で書く（生の文字や \uXXXX は、行の区切りが正規表現を壊し、見えないので差分でも読めない）。
// 正規表現の文字列に \u{...} のまま渡すため、バックスラッシュを重ねて書く
const HIDDEN_CHARACTERS_SOURCE =
  '[\\p{Cc}\\u{200B}\\u{2028}\\u{2029}\\u{202A}-\\u{202E}\\u{2060}-\\u{2064}\\u{2066}-\\u{2069}\\u{FEFF}]';
const HIDDEN_CHARACTERS = new RegExp(HIDDEN_CHARACTERS_SOURCE, 'u');
const HIDDEN_CHARACTERS_GLOBAL = new RegExp(HIDDEN_CHARACTERS_SOURCE, 'gu');

export function hasHiddenCharacter(value: string): boolean {
  return HIDDEN_CHARACTERS.test(value);
}

export function stripHiddenCharacters(value: string): string {
  return value.replace(HIDDEN_CHARACTERS_GLOBAL, '');
}
