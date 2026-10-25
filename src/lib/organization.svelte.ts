import type { OutputOf } from '../shared/operations/define.ts';
import type { organizationInfo } from '../shared/operations/organization/index.ts';
import { defaultVocabularies } from '../shared/vocabulary.ts';
import { setTheme } from './theme.svelte.ts';
import { setVocabularies, setWorkspaceVocabulary } from './vocabulary.svelte.ts';

export type OrganizationView = OutputOf<typeof organizationInfo>;

// 組織の操作の結果を画面に当てる。テーマは自分の値、なければ組織の既定（localStorage も書き直すので、次の描画の前に同じ値が当たる）。
// ワークスペースの外の画面では、ワークスペースの言葉も組織の言葉づかいに合わせる。ワークスペースの中に入る画面が、そのワークスペースの値で上書きする
export function applyOrganization(view: OrganizationView): void {
  setTheme(view.me.theme ?? view.organization.theme);
  setVocabularies({ organization: view.organization.vocabulary, workspace: view.organization.vocabulary });
}

// 組織の外の画面（組織の選択、見つからない、読み込みの失敗、運用）の既定。どの組織の値も持ち越さない。
// テーマは属性なし（シンプル（自動））にして、localStorage の値も消す
export function resetToDefaults(): void {
  setTheme(null);
  setVocabularies(defaultVocabularies);
  setWorkspaceVocabulary(null);
}
