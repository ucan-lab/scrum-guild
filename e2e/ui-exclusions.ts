// 画面の機械の検査（axe、44px の押せる範囲、狭い幅のはみ出し）から外す要素の一覧。3つの検査で共有する（#320）。
// 規則ごと、画面ごとには切らない。1件は、検査の種類、要素のセレクタ、画面、理由、直す Issue の番号をすべて持つ。
// 直したら消す。どの要素にも当たらなくなった除外は、検査のテストが落とす（staleExclusions）

// 主な画面と、開いた状態。検査のファイルは、この名前で除外を引く
export const uiScreens = [
  'today',
  'backlog',
  'task-drawer',
  'task-dialog',
  'plan',
  'members',
  'member-remove-confirm',
  'workspace-settings',
  'admin',
] as const;
export type UiScreen = (typeof uiScreens)[number];

// 検査の種類。44px の押せる範囲か、狭い幅のはみ出しか、axe の規則の ID（color-contrast、button-name など）。
// axe-core は規則の ID の型を出さないので、axe の ID であることは e2e/a11y-check.test.ts が axe の規則の一覧と比べて確かめる
export type UiCheck = 'target-44' | 'overflow' | (string & {});
export const nonAxeChecks: readonly UiCheck[] = ['target-44', 'overflow'];
export const isAxeCheck = (check: UiCheck): boolean => !nonAxeChecks.includes(check);
// 狭い幅の検査（e2e/layout-narrow*.test.ts）が引く種類
export const isLayoutCheck = (check: UiCheck): boolean => nonAxeChecks.includes(check);

export interface UiExclusion {
  check: UiCheck;
  // 外す要素の CSS セレクタ。当たった要素そのものに一致させる（中の要素までは外さない）
  selector: string;
  screen: UiScreen;
  // 外す理由。直し方の見当も書く
  reason: string;
  // 直す Issue の番号
  issue: number;
}

// 上の帯の組織とアカウントのボタン。aria-label が見える文字（「冒険者ギルド あおば開発」、「ミナト ギルドマスター 1」）を
// 含まず、WCAG 2.5.3（見える名前を読み上げの名前に含める）に当たる。ダイアログか引き出しを開いた状態では、
// 後ろの画面が読み上げから外れるので axe も見ない。開いていない画面にだけ置く。
// 直すには辞書の文言（organizationSwitchLabel、accountMenuLabel）と、見える文字の組み方を決め直す
const HEADER_MENU_LABEL_ISSUE = 343;

export const uiExclusions: readonly UiExclusion[] = [
  ...(['today', 'backlog', 'plan', 'members', 'workspace-settings', 'admin'] as const).flatMap(
    (screen): UiExclusion[] => [
      {
        check: 'label-content-name-mismatch',
        selector: '.org-menu-button',
        screen,
        reason:
          '組織を切り替えるボタンの aria-label が、見える「冒険者ギルド」と組織の名前の並びを含まない。文言の決め直しが要る',
        issue: HEADER_MENU_LABEL_ISSUE,
      },
      {
        check: 'label-content-name-mismatch',
        selector: '.account-menu-button',
        screen,
        reason:
          'アカウントのメニューのボタンの aria-label が、見える名前、役割、レベルの数字の並びを含まない。文言の決め直しが要る',
        issue: HEADER_MENU_LABEL_ISSUE,
      },
    ],
  ),
];

// その画面とその種類の除外
export function exclusionsFor(
  screen: UiScreen,
  isCheck: (check: UiCheck) => boolean,
  list: readonly UiExclusion[] = uiExclusions,
): UiExclusion[] {
  return list.filter((exclusion) => exclusion.screen === screen && isCheck(exclusion.check));
}

// その画面を走らせても、どの要素にも当たらなかった除外。used は、その画面の検査で実際に要素を外した除外
export function staleExclusions(
  screen: UiScreen,
  isCheck: (check: UiCheck) => boolean,
  used: ReadonlySet<UiExclusion>,
  list: readonly UiExclusion[] = uiExclusions,
): UiExclusion[] {
  return exclusionsFor(screen, isCheck, list).filter((exclusion) => !used.has(exclusion));
}

// 落ちたときに出す、当たらなかった除外の一覧
export function formatStaleExclusions(stale: readonly UiExclusion[]): string {
  return [
    `当たらなくなった除外が ${stale.length} 件ある。直ったなら e2e/ui-exclusions.ts から消す:`,
    ...stale.map(
      (exclusion) => `- ${exclusion.screen} ${exclusion.check} ${exclusion.selector}（#${exclusion.issue}）`,
    ),
  ].join('\n');
}
