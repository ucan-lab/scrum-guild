// PAT（fine-grained）で呼ぶ GitHub の API の偽物。ログインの偽物（test/auth/fake-github.ts）とは別。
// GET /user と GET /user/repos だけを持つ。受けた呼び出しを記録し、次の1回の失敗や、n 頁目の失敗を差し込める。
// 例のデータはすべて架空
export const FAKE_PAT_USER_URL = 'https://api.github.com/user';
export const FAKE_PAT_REPOS_URL = 'https://api.github.com/user/repos';

// 形が合う架空の PAT（`github_pat_` + 英数字とアンダースコア）。seed が違えば別の値
export function fakePat(seed: string): string {
  return `github_pat_FAKE${seed.replaceAll(/[^A-Za-z0-9]/g, '')}0123456789abcdefABCDEF`;
}

export type FakeOwner = { type: string; id: number; login: string };
export type FakeRepo = { id: number; full_name: string };

export type FakeFailure =
  | { kind: 'status'; status: number; body?: string }
  | { kind: 'network'; message?: string }
  | { kind: 'not-json' }
  | { kind: 'redirect'; status?: number }
  | { kind: 'body'; body: unknown };

export type FakePatCall = {
  method: string;
  url: string;
  headers: Record<string, string>;
  redirect: string | undefined;
  hasSignal: boolean;
};

export const FAKE_FAILURE_MARK = 'SECRET-MARK-9f3a';

export function createFakePatGithub() {
  const accounts = new Map<string, { owner: FakeOwner; repos: unknown[] }>();
  const calls: FakePatCall[] = [];
  let next: FakeFailure | undefined;
  const pageFailures = new Map<number, FakeFailure>();
  const issuePageFailures = new Map<number, FakeFailure>();
  const issues = new Map<number, unknown[]>();
  let looseFilters = false;

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

  function fail(failure: FakeFailure): Response {
    switch (failure.kind) {
      case 'status':
        return new Response(failure.body ?? `upstream ${FAKE_FAILURE_MARK}`, { status: failure.status });
      case 'network':
        throw new Error(failure.message ?? `connection reset ${FAKE_FAILURE_MARK}`);
      case 'not-json':
        return new Response(`<html>${FAKE_FAILURE_MARK}</html>`, { status: 200 });
      case 'redirect':
        return new Response(null, {
          status: failure.status ?? 302,
          headers: { Location: `https://evil.example/${FAKE_FAILURE_MARK}` },
        });
      case 'body':
        return json(failure.body);
    }
  }

  const fetcher: typeof fetch = async (input, init) => {
    // Workers の実行環境が RequestInit を受け付けるかを確かめる（redirect の値の誤りなどは、ここで TypeError になる）
    new Request(input, init);
    const url = String(input);
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    calls.push({
      method: init?.method ?? 'GET',
      url,
      headers,
      redirect: init?.redirect,
      hasSignal: init?.signal instanceof AbortSignal,
    });

    const parsed = new URL(url);
    const page = Number(parsed.searchParams.get('page') ?? '1');
    const isRepos = parsed.origin + parsed.pathname === FAKE_PAT_REPOS_URL;

    if (next !== undefined) {
      const failure = next;
      next = undefined;
      return fail(failure);
    }
    if (isRepos) {
      const pageFailure = pageFailures.get(page);
      if (pageFailure !== undefined) {
        pageFailures.delete(page);
        return fail(pageFailure);
      }
    }

    const issuesMatch = /^\/repositories\/(\d+)\/issues$/.exec(parsed.pathname);
    if (parsed.origin === 'https://api.github.com' && issuesMatch !== null) {
      const pageFailure = issuePageFailures.get(page);
      if (pageFailure !== undefined) {
        issuePageFailures.delete(page);
        return fail(pageFailure);
      }
      if (!accounts.has((headers['authorization'] ?? '').replace(/^Bearer /, ''))) {
        return json({ message: 'Bad credentials' }, 401);
      }
      const all = (issues.get(Number(issuesMatch[1])) ?? []) as Record<string, unknown>[];
      const state = parsed.searchParams.get('state') ?? 'open';
      const assignee = parsed.searchParams.get('assignee');
      const since = parsed.searchParams.get('since');
      const asc = parsed.searchParams.get('direction') === 'asc';
      let list = all;
      if (!looseFilters) {
        list = all.filter((item) => {
          if (state !== 'all' && item.state !== state) return false;
          const assignees = (item.assignees ?? []) as { login: string }[];
          if (assignee !== null && !assignees.some((a) => a.login === assignee)) return false;
          return since === null || String(item.updated_at) >= since;
        });
      }
      list = [...list].sort((a, b) =>
        asc
          ? String(a.updated_at).localeCompare(String(b.updated_at))
          : String(b.updated_at).localeCompare(String(a.updated_at)),
      );
      const perPage = Math.min(Number(parsed.searchParams.get('per_page') ?? '30'), 100);
      return json(list.slice((page - 1) * perPage, page * perPage));
    }

    const account = accounts.get((headers['authorization'] ?? '').replace(/^Bearer /, ''));
    if (account === undefined) return json({ message: 'Bad credentials' }, 401);
    if (parsed.origin + parsed.pathname === FAKE_PAT_USER_URL) return json(account.owner);
    if (isRepos) {
      const perPage = Math.min(Number(parsed.searchParams.get('per_page') ?? '30'), 100);
      return json(account.repos.slice((page - 1) * perPage, page * perPage));
    }
    return json({ message: 'Not Found' }, 404);
  };

  return {
    fetcher,
    calls,
    // PAT ごとの持ち主とリポジトリ。repos の要素は壊れた形も入れられる
    addAccount(pat: string, owner: FakeOwner, repos: unknown[] = []): void {
      accounts.set(pat, { owner, repos });
    },
    // 次の1回の呼び出し（どの URL でも）を失敗させる
    failNext(failure: FakeFailure): void {
      next = failure;
    },
    // /user/repos の n 頁目（1回だけ）を失敗させる
    failOnPage(page: number, failure: FakeFailure): void {
      pageFailures.set(page, failure);
    },
    // GET /repositories/{id}/issues が返す Issue（GitHub の応答の形。PR は pull_request を持つ）
    addIssues(repoId: number, list: unknown[]): void {
      issues.set(repoId, list);
    },
    // /repositories/{id}/issues の n 頁目（1回だけ）を失敗させる
    failOnIssuePage(page: number, failure: FakeFailure): void {
      issuePageFailures.set(page, failure);
    },
    // assignee、state、since の絞り込みを無視して全部返す（実装側でも絞ることの確かめ用）
    ignoreIssueFilters(): void {
      looseFilters = true;
    },
  };
}

export type FakePatGithub = ReturnType<typeof createFakePatGithub>;

export type FakeIssueOptions = {
  id?: number;
  number?: number;
  assignees?: string[];
  state?: 'open' | 'closed';
  pr?: boolean;
  updatedAt?: string;
  dueOn?: string | null;
  title?: string;
};

// 架空の Issue（GitHub の応答の形）。n が違えば id、番号、更新日時（n 分）が変わる
export function fakeIssue(repoFullName: string, n: number, options: FakeIssueOptions = {}) {
  const number = options.number ?? n;
  const logins = options.assignees ?? ['fake-ranger'];
  return {
    id: options.id ?? 500_000 + n,
    number,
    title: options.title ?? `架空の課題 ${n}`,
    state: options.state ?? 'open',
    html_url: `https://github.com/${repoFullName}/issues/${number}`,
    assignees: logins.map((login) => ({ login })),
    assignee: logins[0] === undefined ? null : { login: logins[0] },
    updated_at: options.updatedAt ?? new Date(Date.UTC(2026, 0, 1, 0, 0, 0) + n * 60_000).toISOString(),
    milestone: options.dueOn === undefined || options.dueOn === null ? null : { due_on: options.dueOn },
    ...(options.pr ? { pull_request: { url: `https://api.github.com/repos/${repoFullName}/pulls/${number}` } } : {}),
  };
}

// 架空のリポジトリの一覧。id は offset から連番
export function fakeRepos(count: number, offset = 1000): FakeRepo[] {
  return Array.from({ length: count }, (_, i) => ({
    id: offset + i,
    full_name: `guild-fake/repo-${offset + i}`,
  }));
}
