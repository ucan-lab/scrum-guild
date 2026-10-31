import type { OutputOf } from '../shared/operations/define.ts';
import type { organizationInfo } from '../shared/operations/organization/index.ts';
import type { invitationList } from '../shared/operations/workspace/index.ts';
import { applyTheme } from '../shared/theme.ts';
import { setTheme } from './theme.svelte.ts';

export type OrganizationView = OutputOf<typeof organizationInfo>;

// 組織の操作の結果を画面に当てる。テーマは自分の値、なければ組織の既定（localStorage に書き直すので、次の描画の前に同じ値が当たる）
export function applyOrganization(view: OrganizationView): void {
  setTheme(view.me.theme ?? view.organization.theme);
}

// 承諾待ちの招待だけの人の招待の画面。organization の操作を読めないので、届いた招待の一覧（invitation-list）が返す
// 組織の既定のテーマを当てる（自分のテーマはまだ無い）。
// テーマは localStorage には覚えない（まだ入っていない組織の値を、次の描画の先当てに持ち越さない）
export function applyInvitedOrganization(view: OutputOf<typeof invitationList>['organization']): void {
  applyTheme(view.theme, document.documentElement);
}

// 組織の外の画面（組織の選択、見つからない、読み込みの失敗、運用）の既定。どの組織の値も持ち越さない。
// テーマは属性なし（シンプル（自動））にして、覚えたテーマも消す
export function resetToDefaults(): void {
  setTheme(null);
}
