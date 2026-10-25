import {
  defaultVocabularies,
  word,
  type DictionaryKey,
  type TemplateParams,
  type Vocabularies,
} from '../shared/vocabulary.ts';

// 今の言葉づかい。本物の値を API から入れるのは #53（ワークスペースと組織の設定）。それまでは既定のゲームの言葉
export const vocabularies: Vocabularies = $state({ ...defaultVocabularies });

// テンプレートから呼ぶと、言葉づかいが変わったときに描き直される。{名前} を持つ項目は params で埋める
export function t(key: DictionaryKey, params?: TemplateParams): string {
  return word(key, vocabularies, params);
}

const VALUES: readonly unknown[] = ['game', 'scrum'];

// API の JSON をそのまま渡されても、決まった2つのキーと値だけを入れる
export function setVocabularies(next: Partial<Vocabularies>): void {
  for (const scope of ['workspace', 'organization'] as const) {
    const value = next[scope];
    if (VALUES.includes(value)) vocabularies[scope] = value as Vocabularies[typeof scope];
  }
}
