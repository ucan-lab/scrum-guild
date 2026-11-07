// GitHub の取り込み元の、担当の Issue の取得と変換。偽物の GitHub に fetcher を差し、実装を直に呼ぶ
import { describe, expect, test } from 'vitest';
import { ImportSourceError, importSourceOf } from '../../src/server/import/index.ts';
import type { FetchAssignedParams, ImportSourceFailure } from '../../src/server/import/index.ts';
import { FAKE_FAILURE_MARK, createFakePatGithub, fakeIssue, fakePat } from './fake-github-pat.ts';

const source = importSourceOf('github');
const PAT = fakePat('Gamma');
const OWNER = { type: 'User', id: 4242, login: 'fake-ranger' };
const REPO_A = { id: '1001', name: 'guild-fake/alpha' };
const REPO_B = { id: '1002', name: 'guild-fake/beta' };

function setup() {
  const fake = createFakePatGithub();
  fake.addAccount(PAT, OWNER);
  return fake;
}

function params(overrides: Partial<FetchAssignedParams> = {}): FetchAssignedParams {
  return { assignee: 'fake-ranger', scopes: [REPO_A], since: null, maxRequests: 10, cursor: null, ...overrides };
}

async function failureOf(work: Promise<unknown>): Promise<ImportSourceError> {
  try {
    await work;
  } catch (error) {
    expect(error).toBeInstanceOf(ImportSourceError);
    return error as ImportSourceError;
  }
  throw new Error('失敗するはずが成功した');
}

describe('完了条件: 担当者が自分の未完了の Issue だけ', () => {
  const mixed = () => [
    fakeIssue(REPO_A.name, 1),
    fakeIssue(REPO_A.name, 2, { state: 'closed' }),
    fakeIssue(REPO_A.name, 3, { assignees: ['fake-other'] }),
    fakeIssue(REPO_A.name, 4, { pr: true }),
    fakeIssue(REPO_A.name, 5, { assignees: ['fake-other', 'fake-ranger'] }),
  ];

  test('閉じた Issue、他人の担当、PR は返らない', async () => {
    const fake = setup();
    fake.addIssues(1001, mixed());
    const { items, nextCursor } = await source.fetchAssignedItems(PAT, params(), fake.fetcher);
    expect(items.map((i) => i.key)).toEqual(['guild-fake/alpha#1', 'guild-fake/alpha#5']);
    expect(nextCursor).toBeNull();
  });

  test('絞り込みを無視する応答でも、実装側で同じに絞る', async () => {
    const fake = setup();
    fake.addIssues(1001, mixed());
    fake.ignoreIssueFilters();
    const { items } = await source.fetchAssignedItems(PAT, params(), fake.fetcher);
    expect(items.map((i) => i.key)).toEqual(['guild-fake/alpha#1', 'guild-fake/alpha#5']);
  });

  test('範囲の外のリポジトリは問い合わせない', async () => {
    const fake = setup();
    fake.addIssues(1001, [fakeIssue(REPO_A.name, 1)]);
    fake.addIssues(1002, [fakeIssue(REPO_B.name, 2)]);
    const { items } = await source.fetchAssignedItems(PAT, params(), fake.fetcher);
    expect(items.map((i) => i.scopeId)).toEqual(['1001']);
    expect(fake.calls.every((c) => c.url.includes('/repositories/1001/'))).toBe(true);
  });

  test('ログイン名の大文字小文字は区別しない', async () => {
    const fake = setup();
    fake.addIssues(1001, [fakeIssue(REPO_A.name, 1, { assignees: ['Fake-Ranger'] })]);
    fake.ignoreIssueFilters();
    const { items } = await source.fetchAssignedItems(PAT, params(), fake.fetcher);
    expect(items).toHaveLength(1);
  });

  test('取り込み元を問わない形に変換する', async () => {
    const fake = setup();
    fake.addIssues(1001, [
      fakeIssue(REPO_A.name, 7, { id: 9_000_000_007, number: 42, dueOn: '2026-03-01T00:00:00Z', title: '架空の題' }),
    ]);
    const { items } = await source.fetchAssignedItems(PAT, params(), fake.fetcher);
    expect(items).toEqual([
      {
        kind: 'issue',
        externalId: '9000000007',
        key: 'guild-fake/alpha#42',
        url: 'https://github.com/guild-fake/alpha/issues/42',
        scopeId: '1001',
        scopeName: 'guild-fake/alpha',
        state: 'open',
        dueAt: '2026-03-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:07:00.000Z',
        title: '架空の題',
        completed: false,
      },
    ]);
  });

  test('期限が無ければ null', async () => {
    const fake = setup();
    fake.addIssues(1001, [fakeIssue(REPO_A.name, 1)]);
    const { items } = await source.fetchAssignedItems(PAT, params(), fake.fetcher);
    expect(items[0]?.dueAt).toBeNull();
  });
});

describe('完了条件: 不変の ID', () => {
  test('externalId は GitHub の ID で、番号ではない', async () => {
    const fake = setup();
    fake.addIssues(1001, [fakeIssue(REPO_A.name, 1, { id: 777_001, number: 3 })]);
    const { items } = await source.fetchAssignedItems(PAT, params(), fake.fetcher);
    expect(items[0]?.externalId).toBe('777001');
    expect(items[0]?.key).toBe('guild-fake/alpha#3');
  });

  test('リポジトリの ID で呼ぶ（改名しても同じ）', async () => {
    const fake = setup();
    fake.addIssues(1001, []);
    await source.fetchAssignedItems(PAT, params(), fake.fetcher);
    const url = new URL(fake.calls[0]!.url);
    expect(url.pathname).toBe('/repositories/1001/issues');
    expect(url.searchParams.get('assignee')).toBe('fake-ranger');
    expect(url.searchParams.get('state')).toBe('open');
    expect(url.searchParams.get('sort')).toBe('updated');
    expect(url.searchParams.get('direction')).toBe('asc');
  });
});

describe('完了条件: 頁と続きの位置', () => {
  const many = (count: number, repo = REPO_A) => Array.from({ length: count }, (_, i) => fakeIssue(repo.name, i + 1));

  // 満杯の頁の後は最後の項目の更新日時から取り直すので、境目の1件が重なる（受け取る側が externalId で吸収する）
  test.each([0, 1, 99, 100, 101, 250])('%i 件は頁をまたいでも漏れない（重なりは境目の1件だけ）', async (count) => {
    const fake = setup();
    fake.addIssues(1001, many(count));
    const { items, nextCursor } = await source.fetchAssignedItems(PAT, params(), fake.fetcher);
    const ids = items.map((i) => i.externalId);
    expect(new Set(ids)).toEqual(new Set(many(count).map((i) => String(i.id))));
    expect(ids.length - new Set(ids).size).toBe(Math.floor(count / 100));
    expect(nextCursor).toBeNull();
  });

  test('複数のリポジトリを順に取る', async () => {
    const fake = setup();
    fake.addIssues(1001, [fakeIssue(REPO_A.name, 1)]);
    fake.addIssues(1002, [fakeIssue(REPO_B.name, 2)]);
    const { items } = await source.fetchAssignedItems(PAT, params({ scopes: [REPO_A, REPO_B] }), fake.fetcher);
    expect(items.map((i) => i.scopeId)).toEqual(['1001', '1002']);
  });

  test('上限で止めると続きの位置が返り、続きから取ると残りが返る', async () => {
    const fake = setup();
    fake.addIssues(1001, many(250));
    fake.addIssues(1002, [fakeIssue(REPO_B.name, 900)]);
    const base = params({ scopes: [REPO_A, REPO_B], maxRequests: 1 });
    const seen: string[] = [];
    let cursor: string | null = null;
    let rounds = 0;
    do {
      const result = await source.fetchAssignedItems(PAT, { ...base, cursor }, fake.fetcher);
      expect(fake.calls.length).toBe(++rounds);
      seen.push(...result.items.map((i) => i.externalId));
      cursor = result.nextCursor;
    } while (cursor !== null);
    expect(rounds).toBe(4);
    expect(new Set(seen).size).toBe(251);
  });

  test('ちょうど上限で終わるときは続きの位置が null', async () => {
    const fake = setup();
    fake.addIssues(1001, many(3));
    const result = await source.fetchAssignedItems(PAT, params({ maxRequests: 1 }), fake.fetcher);
    expect(result.items).toHaveLength(3);
    expect(result.nextCursor).toBeNull();
  });

  test('since を更新日時の絞り込みに渡す', async () => {
    const fake = setup();
    fake.addIssues(1001, many(5));
    const { items } = await source.fetchAssignedItems(PAT, params({ since: '2026-01-01T00:03:00Z' }), fake.fetcher);
    expect(new URL(fake.calls[0]!.url).searchParams.get('since')).toBe('2026-01-01T00:03:00.000Z');
    expect(items.map((i) => i.updatedAt)).toEqual([
      '2026-01-01T00:03:00.000Z',
      '2026-01-01T00:04:00.000Z',
      '2026-01-01T00:05:00.000Z',
    ]);
  });

  test('範囲が空なら問い合わせない', async () => {
    const fake = setup();
    const result = await source.fetchAssignedItems(PAT, params({ scopes: [] }), fake.fetcher);
    expect(result).toEqual({ items: [], nextCursor: null });
    expect(fake.calls).toHaveLength(0);
  });
});

describe('完了条件: 失敗の区別', () => {
  const cases: [string, number, ImportSourceFailure][] = [
    ['401', 401, 'unauthorized'],
    ['403', 403, 'forbidden'],
    ['429', 429, 'forbidden'],
    ['500', 500, 'unavailable'],
    ['502', 502, 'unavailable'],
    ['503', 503, 'unavailable'],
  ];

  test.each(cases)('%s は %s', async (_name, status, failure) => {
    const fake = setup();
    fake.addIssues(1001, []);
    fake.failNext({ kind: 'status', status });
    const error = await failureOf(source.fetchAssignedItems(PAT, params(), fake.fetcher));
    expect(error.failure).toBe(failure);
    expect(`${error.message}`).not.toContain(FAKE_FAILURE_MARK);
    expect(error.message).not.toContain(PAT);
  });

  test('2頁目の失敗でも区別できる（それまでの項目は返さず投げる）', async () => {
    const fake = setup();
    fake.addIssues(
      1001,
      Array.from({ length: 150 }, (_, i) => fakeIssue(REPO_A.name, i + 1, { updatedAt: '2026-02-02T00:00:00.000Z' })),
    );
    fake.failOnIssuePage(2, { kind: 'status', status: 403 });
    const error = await failureOf(source.fetchAssignedItems(PAT, params(), fake.fetcher));
    expect(error.failure).toBe('forbidden');
  });

  test.each([
    ['届かない', { kind: 'network' }],
    ['JSON でない', { kind: 'not-json' }],
    ['リダイレクト', { kind: 'redirect' }],
    ['配列でない', { kind: 'body', body: { message: 'x' } }],
    ['要素が壊れている', { kind: 'body', body: [1] }],
    ['id が無い', { kind: 'body', body: [{ number: 1, state: 'open', assignees: [{ login: 'fake-ranger' }] }] }],
  ] as const)('%s は unavailable', async (_name, failure) => {
    const fake = setup();
    fake.failNext(failure);
    const error = await failureOf(source.fetchAssignedItems(PAT, params(), fake.fetcher));
    expect(error.failure).toBe('unavailable');
  });

  test('html_url が github.com でない応答は断る', async () => {
    const fake = setup();
    fake.addIssues(1001, [{ ...fakeIssue(REPO_A.name, 1), html_url: 'https://evil.example/x' }]);
    const error = await failureOf(source.fetchAssignedItems(PAT, params(), fake.fetcher));
    expect(error.failure).toBe('unavailable');
  });

  test('PAT の形が合わなければ問い合わせずに invalid_format', async () => {
    const fake = setup();
    const error = await failureOf(source.fetchAssignedItems('ghp_x', params(), fake.fetcher));
    expect(error.failure).toBe('invalid_format');
    expect(fake.calls).toHaveLength(0);
  });
});

describe('入力の誤り', () => {
  test.each([
    ['maxRequests が 0', { maxRequests: 0 }],
    ['assignee が不正', { assignee: 'a/b' }],
    ['since が不正', { since: 'きのう' }],
    ['cursor が不正', { cursor: 'x' }],
    ['cursor が範囲の外', { cursor: '5:1' }],
    ['範囲の ID が不正', { scopes: [{ id: '0', name: 'guild-fake/alpha' }] }],
    ['範囲の名前が不正', { scopes: [{ id: '1', name: 'alpha' }] }],
  ] as const)('%s は問い合わせずに断る', async (_name, override) => {
    const fake = setup();
    await expect(
      source.fetchAssignedItems(PAT, params(override as Partial<FetchAssignedParams>), fake.fetcher),
    ).rejects.toThrow(TypeError);
    expect(fake.calls).toHaveLength(0);
  });
});

describe('続きの位置の堅さ', () => {
  const list250 = () => Array.from({ length: 250 }, (_, i) => fakeIssue(REPO_A.name, i + 1));

  test('再開の間に先頭の Issue が更新されても、漏れない（重複は許す）', async () => {
    const fake = setup();
    fake.addIssues(1001, list250());
    const base = params({ maxRequests: 1 });
    const first = await source.fetchAssignedItems(PAT, base, fake.fetcher);
    expect(first.nextCursor).not.toBeNull();
    // 1件目にコメントが付き、更新日時が最新になって末尾へ動く
    fake.addIssues(
      1001,
      list250().map((issue) => (issue.number === 1 ? { ...issue, updated_at: '2026-06-01T00:00:00.000Z' } : issue)),
    );
    const seen = new Set(first.items.map((i) => i.externalId));
    let cursor = first.nextCursor;
    let guard = 0;
    while (cursor !== null && guard++ < 10) {
      const next = await source.fetchAssignedItems(PAT, { ...base, cursor }, fake.fetcher);
      next.items.forEach((i) => seen.add(i.externalId));
      cursor = next.nextCursor;
    }
    expect(cursor).toBeNull();
    expect(seen.size).toBe(250);
  });

  test('同じ更新日時が1頁を超えて続いても、先へ進んで漏れない', async () => {
    const fake = setup();
    const same = Array.from({ length: 230 }, (_, i) =>
      fakeIssue(REPO_A.name, i + 1, { updatedAt: '2026-02-02T00:00:00.000Z' }),
    );
    fake.addIssues(1001, same);
    const { items, nextCursor } = await source.fetchAssignedItems(PAT, params(), fake.fetcher);
    expect(nextCursor).toBeNull();
    expect(new Set(items.map((i) => i.externalId)).size).toBe(230);
  });

  test('範囲の並びが変わっても、続きは同じリポジトリから始まる', async () => {
    const fake = setup();
    fake.addIssues(1001, [fakeIssue(REPO_A.name, 1)]);
    fake.addIssues(1002, [fakeIssue(REPO_B.name, 2)]);
    const first = await source.fetchAssignedItems(
      PAT,
      params({ scopes: [REPO_A, REPO_B], maxRequests: 1 }),
      fake.fetcher,
    );
    expect(first.nextCursor?.startsWith('1002:')).toBe(true);
    const second = await source.fetchAssignedItems(
      PAT,
      params({ scopes: [REPO_B, REPO_A], cursor: first.nextCursor }),
      fake.fetcher,
    );
    expect(second.items.map((i) => i.scopeId)).toEqual(['1002', '1001']);
  });

  test('続きの位置の範囲が scopes に無ければ断る', async () => {
    const fake = setup();
    await expect(source.fetchAssignedItems(PAT, params({ cursor: '1002:1:' }), fake.fetcher)).rejects.toThrow(
      TypeError,
    );
  });

  test.each([
    ['年だけ', '2026'],
    ['数字だけ', '1'],
    ['タイムゾーン無し', '2026-01-01 00:00'],
  ])('since が ISO 8601 でない（%s）と断る', async (_name, since) => {
    const fake = setup();
    await expect(source.fetchAssignedItems(PAT, params({ since }), fake.fetcher)).rejects.toThrow(TypeError);
  });

  test('maxRequests が上限を超えると断る', async () => {
    const fake = setup();
    await expect(source.fetchAssignedItems(PAT, params({ maxRequests: 10_000 }), fake.fetcher)).rejects.toThrow(
      TypeError,
    );
  });
});

describe('応答の検証', () => {
  test.each([
    ['題が空', { title: '' }],
    ['題が長すぎる', { title: 'あ'.repeat(257) }],
    ['URL が別のホスト', { html_url: 'https://github.com.evil.example/guild-fake/alpha/issues/1' }],
    ['URL が http', { html_url: 'http://github.com/guild-fake/alpha/issues/1' }],
    ['URL が Issue の形でない', { html_url: 'https://github.com/guild-fake/alpha/pull/1' }],
    ['URL にクエリ', { html_url: 'https://github.com/guild-fake/alpha/issues/1?x=1' }],
    ['updated_at が不正', { updated_at: 'きのう' }],
    ['期限が不正', { milestone: { due_on: 'あした' } }],
  ])('%s は unavailable', async (_name, patch) => {
    const fake = setup();
    fake.addIssues(1001, [{ ...fakeIssue(REPO_A.name, 1), ...patch }]);
    const error = await failureOf(source.fetchAssignedItems(PAT, params(), fake.fetcher));
    expect(error.failure).toBe('unavailable');
  });

  test('キーは応答の URL の今のリポジトリ名から作る（改名後も食い違わない）', async () => {
    const fake = setup();
    fake.addIssues(1001, [
      { ...fakeIssue(REPO_A.name, 1), html_url: 'https://github.com/guild-fake/alpha-renamed/issues/9' },
    ]);
    const { items } = await source.fetchAssignedItems(PAT, params(), fake.fetcher);
    expect(items[0]?.key).toBe('guild-fake/alpha-renamed#9');
    expect(items[0]?.scopeId).toBe('1001');
  });
});

describe('通信の作法', () => {
  test('固定のホスト、Bearer、redirect: manual、時間切れ付き', async () => {
    const fake = setup();
    fake.addIssues(1001, []);
    await source.fetchAssignedItems(PAT, params(), fake.fetcher);
    const call = fake.calls[0]!;
    expect(new URL(call.url).origin).toBe('https://api.github.com');
    expect(call.headers['authorization']).toBe(`Bearer ${PAT}`);
    expect(call.redirect).toBe('manual');
    expect(call.hasSignal).toBe(true);
  });
});
