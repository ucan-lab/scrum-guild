import { defaultVocabularies, word, type DictionaryKey, type Vocabularies } from '../shared/vocabulary.ts';

// 今の言葉づかい。本物の値を API から入れるのは #53（ワークスペースと組織の設定）。それまでは既定のゲームの言葉
export const vocabularies: Vocabularies = $state({ ...defaultVocabularies });

// テンプレートから呼ぶと、言葉づかいが変わったときに描き直される
export function t(key: DictionaryKey): string {
  return word(key, vocabularies);
}

export function setVocabularies(next: Partial<Vocabularies>): void {
  Object.assign(vocabularies, next);
}
