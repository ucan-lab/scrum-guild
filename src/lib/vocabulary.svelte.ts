import {
  defaultVocabularies,
  word,
  type DictionaryKey,
  type TemplateParams,
  type Vocabularies,
  type Vocabulary,
} from '../shared/vocabulary.ts';

// 今の言葉づかい。組織の枠が、組織の操作の結果を入れる（organization.svelte.ts）。入るまでは既定のスクラムの言葉
export const vocabularies: Vocabularies = $state({ ...defaultVocabularies });

// ワークスペースの中の画面が、そのワークスペースの言葉づかいでワークスペースの言葉を上書きする（src/routes/[slug]/w/[id]/+layout.svelte）。
// 組織の値を入れ直す処理（applyOrganization）が先に走っても、ワークスペースの中にいる間はこちらを使う
let workspaceOverride: Vocabulary | null = $state(null);

function effective(): Vocabularies {
  return workspaceOverride === null ? vocabularies : { ...vocabularies, workspace: workspaceOverride };
}

// テンプレートから呼ぶと、言葉づかいが変わったときに描き直される。{名前} を持つ項目は params で埋める
export function t(key: DictionaryKey, params?: TemplateParams): string {
  return word(key, effective(), params);
}

// 今の言葉づかいとは別の言葉づかいで引く。ワークスペースを作るダイアログが、選んだ言葉づかいの列の名前などを見せるのに使う
export function tIn(key: DictionaryKey, scopes: Partial<Vocabularies>, params?: TemplateParams): string {
  return word(key, { ...effective(), ...scopes }, params);
}

const VALUES: readonly unknown[] = ['game', 'scrum'];

// API の JSON をそのまま渡されても、決まった2つのキーと値だけを入れる
export function setVocabularies(next: Partial<Vocabularies>): void {
  for (const scope of ['workspace', 'organization'] as const) {
    const value = next[scope];
    if (VALUES.includes(value)) vocabularies[scope] = value as Vocabularies[typeof scope];
  }
}

// null でワークスペースの外に戻す（組織の値に従う）
export function setWorkspaceVocabulary(value: unknown): void {
  workspaceOverride = VALUES.includes(value) ? (value as Vocabulary) : null;
}
