import { defaultVocabularies, word, type DictionaryKey, type TemplateParams } from '../shared/vocabulary.ts';

// 画面の文言はスクラムの言葉で出す。言葉づかいは選べないので、組織やワークスペースの値は読まない。
// {名前} を持つ項目は params で埋める
export function t(key: DictionaryKey, params?: TemplateParams): string {
  return word(key, defaultVocabularies, params);
}
