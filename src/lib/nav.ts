import type { DictionaryKey } from '../shared/vocabulary.ts';
import type { IconName } from './icons.ts';

// メニューの行き先。NavMenu が slug（ワークスペースの経路はワークスペースの ID も）で resolve する。
// ワークスペースの経路（WorkspaceNavRoute）は、ワークスペースの画面を開いている間だけ出す。ワークスペースの外では行き先が決まらないため
const workspaceRoutes = [
  '/[slug]/w/[id]',
  '/[slug]/w/[id]/members',
  '/[slug]/w/[id]/plan',
  '/[slug]/w/[id]/settings',
  '/[slug]/w/[id]/sprint',
] as const;
export type WorkspaceNavRoute = (typeof workspaceRoutes)[number];
export type NavRoute = '/[slug]' | '/[slug]/me' | '/[slug]/admin' | WorkspaceNavRoute;

export function isWorkspaceRoute(route: NavRoute): route is WorkspaceNavRoute {
  return (workspaceRoutes as readonly string[]).includes(route);
}

// ワークスペースの経路を resolve できる ID か。空の文字列は、/aoba/w//members のような壊れたリンクになるので ID と見ない。
// visibleNav（項目を残すか）と NavMenu（リンクを作るか）が同じ判定を使う
export function isWorkspaceId(id: string | null | undefined): id is string {
  return typeof id === 'string' && id !== '';
}

// メニューの項目。kit.js の PAGES と同じ並びと見出し。
// href が null の項目は、画面がまだ無いのでメニューに出さない（色を薄くして押せなくする形は、
// 状態が色だけに頼り、コントラストも足りないので採らない）。画面を足したら href に経路の ID を入れる。
// adminOnly の項目は管理者にだけ出す。leaderOnly の項目は、開いているワークスペースのリーダーと管理者にだけ出す
export type NavItem = {
  icon: IconName;
  label: DictionaryKey;
  href: NavRoute | null;
  adminOnly?: true;
  leaderOnly?: true;
};

// slot は、見出しのすぐ下に置く切り替え（組織、ワークスペース）。ワークスペースの画面を開いている間は、
// 項目が無くても見出しと slot の中身（今のワークスペース）を出す。
// inWorkspace は、ワークスペースの中の画面の見出し。所属するワークスペースが無い人（最初のワークスペースを作る前の管理者）には出さない
export type NavSection = {
  heading?: DictionaryKey;
  slot?: 'workspace';
  inWorkspace?: true;
  items: NavItem[];
};

export type VisibleNavItem = { icon: IconName; label: DictionaryKey; href: NavRoute };
export type VisibleNavSection = Omit<NavSection, 'items'> & { items: VisibleNavItem[] };

export type VisibleNavOptions = {
  // ワークスペースの中の見出しを出すか
  hasWorkspace?: boolean;
  isAdmin?: boolean;
  // 開いているワークスペースのリーダー
  isLeader?: boolean;
  // ワークスペースの画面を開いている。項目の無い slot の見出しも出す
  inWorkspaceScreen?: boolean;
  // 開いているワークスペースの ID。無いときは、ワークスペースの経路の項目を出さない
  workspaceId?: string | null;
};

// 画面のある項目だけを残す。項目が1つも無い見出しは、見出しごと外す（ワークスペースの画面を開いている間の slot を除く）
export function visibleNav(
  sections: NavSection[] = navSections,
  {
    hasWorkspace = true,
    isAdmin = false,
    isLeader = false,
    inWorkspaceScreen = false,
    workspaceId = null,
  }: VisibleNavOptions = {},
): VisibleNavSection[] {
  return sections
    .filter((section) => hasWorkspace || inWorkspaceScreen || !section.inWorkspace)
    .map((section) => ({
      ...section,
      items: section.items.filter(
        (item): item is VisibleNavItem =>
          item.href !== null &&
          (!item.adminOnly || isAdmin) &&
          (!item.leaderOnly || isAdmin || isLeader) &&
          (!isWorkspaceRoute(item.href) || (inWorkspaceScreen && isWorkspaceId(workspaceId))),
      ),
    }))
    .filter((section) => section.items.length > 0 || (inWorkspaceScreen && section.slot !== undefined));
}

export const navSections: NavSection[] = [
  {
    items: [
      { icon: 'sun', label: 'pageToday', href: '/[slug]' },
      { icon: 'bell', label: 'pageNotifications', href: null },
      { icon: 'users', label: 'pageMe', href: '/[slug]/me' },
      { icon: 'shield', label: 'pageOrgAdmin', href: '/[slug]/admin', adminOnly: true },
    ],
  },
  {
    heading: 'workspace',
    slot: 'workspace',
    inWorkspace: true,
    items: [
      { icon: 'inbox', label: 'inbox', href: null },
      { icon: 'board', label: 'backlog', href: '/[slug]/w/[id]' },
      { icon: 'columns', label: 'sprint', href: '/[slug]/w/[id]/sprint' },
      { icon: 'calendar', label: 'plan', href: '/[slug]/w/[id]/plan' },
      { icon: 'flag', label: 'epic', href: null },
    ],
  },
  {
    heading: 'groupRecords',
    inWorkspace: true,
    items: [
      { icon: 'trend', label: 'capacity', href: null },
      { icon: 'check', label: 'pageRecords', href: null },
      { icon: 'archive', label: 'archive', href: null },
    ],
  },
  {
    heading: 'groupManage',
    inWorkspace: true,
    items: [
      { icon: 'link', label: 'connection', href: null },
      { icon: 'users', label: 'pageMembers', href: '/[slug]/w/[id]/members' },
      { icon: 'gear', label: 'pageSettings', href: '/[slug]/w/[id]/settings', leaderOnly: true },
      { icon: 'clock', label: 'pageHistory', href: null },
    ],
  },
];
