import type { RouteId } from '$app/types';
import type { DictionaryKey } from '../shared/vocabulary.ts';
import type { IconName } from './icons.ts';

// メニューの項目。kit.js の PAGES と同じ並びと見出し。
// href が null の項目は、画面がまだ無いので押せない形（.nav-item.is-later）で出す。画面を足したら href に経路の ID を入れる
export type NavItem = { icon: IconName; label: DictionaryKey; href: RouteId | null };

// slot は、見出しのすぐ下に置く切り替え（組織、ワークスペース）。中身は画面を作る Issue で足し、枠は置き場所だけ持つ
export type NavSection = { heading?: DictionaryKey; slot?: 'organization' | 'workspace'; items: NavItem[] };

export const navSections: NavSection[] = [
  {
    slot: 'organization',
    items: [
      { icon: 'sun', label: 'pageToday', href: '/' },
      { icon: 'bell', label: 'pageNotifications', href: null },
      { icon: 'users', label: 'pageMe', href: null },
      { icon: 'shield', label: 'pageOrgAdmin', href: null },
    ],
  },
  {
    heading: 'workspace',
    slot: 'workspace',
    items: [
      { icon: 'inbox', label: 'inbox', href: null },
      { icon: 'board', label: 'backlog', href: null },
      { icon: 'columns', label: 'sprint', href: null },
      { icon: 'calendar', label: 'plan', href: null },
      { icon: 'flag', label: 'epic', href: null },
    ],
  },
  {
    heading: 'groupRecords',
    items: [
      { icon: 'trend', label: 'capacity', href: null },
      { icon: 'check', label: 'pageRecords', href: null },
      { icon: 'archive', label: 'archive', href: null },
    ],
  },
  {
    heading: 'groupManage',
    items: [
      { icon: 'link', label: 'connection', href: null },
      { icon: 'users', label: 'pageMembers', href: null },
      { icon: 'gear', label: 'pageSettings', href: null },
      { icon: 'clock', label: 'pageHistory', href: null },
    ],
  },
];
