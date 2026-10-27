import { describe, expect, test } from 'vitest';
import { backlogQueryProblem } from '../shared/backlog-filter.ts';
import { emptyFilter, filterFromParams, filterInput, filterSearch, isFiltering, sameFilter } from './backlog-filter.ts';

describe('filterFromParams', () => {
  test('5つの問い合わせを読み、無いものはすべて（空）にする', () => {
    expect(filterFromParams(new URLSearchParams('assignee=me&category=none&epic=e1&q=api&task=t1'))).toEqual({
      assignee: 'me',
      category: 'none',
      repository: '',
      epic: 'e1',
      q: 'api',
    });
    expect(filterFromParams(new URLSearchParams(''))).toEqual(emptyFilter);
  });

  test('長すぎる ID は捨て、検索は空白をそろえて語の数と全体の長さを上限で切る', () => {
    const filter = filterFromParams(new URLSearchParams({ category: 'x'.repeat(65), q: '　a　 b c d e f  ' }));
    expect(filter.category).toBe('');
    expect(filter.q).toBe('a b c d e');
    // 1つの語の長さは切らない。全体は 100 字まで
    expect(filterFromParams(new URLSearchParams({ q: 'あ'.repeat(40) })).q).toBe('あ'.repeat(40));
    expect(filterFromParams(new URLSearchParams({ q: 'あ'.repeat(120) })).q).toBe('あ'.repeat(100));
    const long = filterFromParams(new URLSearchParams({ q: Array(5).fill('a'.repeat(30)).join(' ') })).q;
    expect([...long]).toHaveLength(100);
    expect(backlogQueryProblem(long)).toBeNull();
  });
});

describe('sameFilter', () => {
  test('5つの値がすべて同じときだけ同じ', () => {
    expect(sameFilter(emptyFilter, { ...emptyFilter })).toBe(true);
    expect(sameFilter(emptyFilter, { ...emptyFilter, q: 'api' })).toBe(false);
    expect(sameFilter({ ...emptyFilter, epic: 'none' }, emptyFilter)).toBe(false);
  });
});

describe('isFiltering', () => {
  test('どれか1つでも値があれば絞っている', () => {
    expect(isFiltering(emptyFilter)).toBe(false);
    expect(isFiltering({ ...emptyFilter, repository: 'none' })).toBe(true);
    expect(isFiltering({ ...emptyFilter, q: 'api' })).toBe(true);
  });
});

describe('filterSearch', () => {
  test('ほかの問い合わせ（引き出しの task）を残し、すべての値は問い合わせから外す', () => {
    expect(filterSearch('?task=t1&assignee=u1&q=old', { ...emptyFilter, category: 'c1', q: '返金 API' })).toBe(
      '?task=t1&q=%E8%BF%94%E9%87%91+API&category=c1',
    );
    expect(filterSearch('?assignee=u1', emptyFilter)).toBe('');
  });
});

describe('filterInput', () => {
  test('すべては渡さず、なしは null、自分と ID はそのまま渡す', () => {
    expect(filterInput(emptyFilter)).toEqual({});
    expect(filterInput({ assignee: 'me', category: 'none', repository: 'r1', epic: 'none', q: 'api' })).toEqual({
      assignee_user_id: 'me',
      category_id: null,
      repository_id: 'r1',
      epic_id: null,
      query: 'api',
    });
  });
});
