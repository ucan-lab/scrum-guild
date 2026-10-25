import type { OutputOf } from '../shared/operations/define.ts';
import type { organizationInfo } from '../shared/operations/organization/index.ts';
import { setTheme } from './theme.svelte.ts';
import { setVocabularies } from './vocabulary.svelte.ts';

export type OrganizationView = OutputOf<typeof organizationInfo>;

// 組織の操作の結果を画面に当てる。テーマは自分の値、なければ組織の既定（localStorage も書き直すので、次の描画の前に同じ値が当たる）。
// ワークスペースの外の画面では、ワークスペースの言葉も組織の言葉づかいに合わせる。ワークスペースの中に入る画面が、そのワークスペースの値で上書きする
export function applyOrganization(view: OrganizationView): void {
  setTheme(view.me.theme ?? view.organization.theme);
  setVocabularies({ organization: view.organization.vocabulary, workspace: view.organization.vocabulary });
}
