// バックログの絞り込みを URL の問い合わせに持つ形（docs/design.md のバックログの画面）。
// `?assignee=&category=&repository=&epic=&q=` の5つで、どれも無ければ絞らない。値は ID か「なし」（none）、担当だけは「自分」（me）も。
// リンクを受け取った人には、me はその人自身になる。引き出しの `?task=` など、ほかの問い合わせはそのまま残す
import { BACKLOG_QUERY_MAX_LENGTH, BACKLOG_QUERY_MAX_WORDS, searchWordsOf } from '../shared/backlog-filter.ts';
import { ID_MAX_LENGTH } from '../shared/id.ts';

export const FILTER_NONE = 'none';
export const FILTER_ME = 'me';

// '' は「すべて」（絞らない）
export type BacklogFilter = { assignee: string; category: string; repository: string; epic: string; q: string };

export const emptyFilter: BacklogFilter = { assignee: '', category: '', repository: '', epic: '', q: '' };

const selectKeys = ['assignee', 'category', 'repository', 'epic'] as const;

export type FilterSelectKey = (typeof selectKeys)[number];

// 手で書き換えた URL でも API に断られない形にそろえる。長すぎる値は捨て、検索は前後の空白を外し、語の数と全体の長さを上限で切る
function cleanQuery(raw: string): string {
  const words = searchWordsOf(raw.trim()).slice(0, BACKLOG_QUERY_MAX_WORDS);
  return [...words.join(' ')].slice(0, BACKLOG_QUERY_MAX_LENGTH).join('').trim();
}

export function filterFromParams(params: URLSearchParams): BacklogFilter {
  const value = (key: FilterSelectKey) => {
    const raw = params.get(key) ?? '';
    return raw.length > ID_MAX_LENGTH ? '' : raw;
  };
  return {
    assignee: value('assignee'),
    category: value('category'),
    repository: value('repository'),
    epic: value('epic'),
    q: cleanQuery(params.get('q') ?? ''),
  };
}

export function sameFilter(a: BacklogFilter, b: BacklogFilter): boolean {
  return selectKeys.every((key) => a[key] === b[key]) && a.q === b.q;
}

export function isFiltering(filter: BacklogFilter): boolean {
  return selectKeys.some((key) => filter[key] !== '') || filter.q !== '';
}

// 帯の値を、今の問い合わせ（location.search の形）に当てた問い合わせの文字列（先頭の ? を含む。空なら ''）。絞らない値は問い合わせから外す
export function filterSearch(current: string, filter: BacklogFilter): string {
  const next = new URLSearchParams(current);
  for (const key of [...selectKeys, 'q'] as const) {
    if (filter[key] === '') next.delete(key);
    else next.set(key, filter[key]);
  }
  const text = next.toString();
  return text === '' ? '' : `?${text}`;
}

// backlog-tree に渡す絞り込みの引数。すべて（''）は渡さない。なし（none）は null
export function filterInput(filter: BacklogFilter): {
  assignee_user_id?: string | null;
  category_id?: string | null;
  repository_id?: string | null;
  epic_id?: string | null;
  query?: string;
} {
  const ref = (value: string) => (value === FILTER_NONE ? null : value);
  return {
    ...(filter.assignee === '' ? {} : { assignee_user_id: ref(filter.assignee) }),
    ...(filter.category === '' ? {} : { category_id: ref(filter.category) }),
    ...(filter.repository === '' ? {} : { repository_id: ref(filter.repository) }),
    ...(filter.epic === '' ? {} : { epic_id: ref(filter.epic) }),
    ...(filter.q === '' ? {} : { query: filter.q }),
  };
}
