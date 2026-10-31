import { word, type DictionaryKey, type TemplateParams } from '../shared/vocabulary.ts';

// 画面の文言は、辞書（キーごとにスクラムの言葉の文字列1つ）から引く。{名前} を持つ項目は params で埋める
export function t(key: DictionaryKey, params?: TemplateParams): string {
  return word(key, params);
}
