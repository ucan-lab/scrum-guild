import type { OutputOf } from '../shared/operations/define.ts';
import type { organizationInfo } from '../shared/operations/organization/index.ts';
import type { invitationList } from '../shared/operations/workspace/index.ts';
import { applyTheme } from '../shared/theme.ts';
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

// 承諾待ちの招待だけの人の招待の画面。organization の操作を読めないので、届いた招待の一覧（invitation-list）が返す
// 組織の言葉づかいと既定のテーマを当てる（自分のテーマはまだ無い）。ワークスペースの言葉も組織の言葉づかいに合わせる。
// テーマは属性だけを当て、localStorage には覚えない（まだ入っていない組織の値を、次の描画の先当てに持ち越さない）
export function applyInvitedOrganization(view: OutputOf<typeof invitationList>['organization']): void {
  applyTheme(view.theme, document.documentElement);
  setVocabularies({ organization: view.vocabulary, workspace: view.vocabulary });
  setWorkspaceVocabulary(null);
}

// 組織の外の画面（組織の選択、見つからない、読み込みの失敗、運用）の既定。どの組織の値も持ち越さない。
// テーマは属性なし（シンプル（自動））にして、localStorage の値も消す
export function resetToDefaults(): void {
  setTheme(null);
  setVocabularies(defaultVocabularies);
  setWorkspaceVocabulary(null);
}
