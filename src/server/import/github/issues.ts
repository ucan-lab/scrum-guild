// 担当の Issue を取り、取り込み元を問わない形（ImportedItem）に変える。DB には書かない。
// リポジトリごとの Issue の一覧（GET /repositories/{id}/issues）を、更新日時の古い順に取る。
// リポジトリの ID で呼ぶので、リポジトリの改名や移動に影響されない。一覧の API には検索 API の「1,000件まで」の上限が無い
// （検索 API を選ばなかった理由は docs/development.md の「取り込み元の型と GitHub の PAT」）。
// 通信の作法と失敗の区別は client.ts（401、403、それ以外）。
//
// 続きの位置は「リポジトリの ID:頁:更新日時の起点」。満杯の頁の後は、頁番号を進めず、
// 最後に読んだ項目の更新日時を新しい起点（since）にして頁を1に戻す。昇順の頁番号のまま進めると、
// 取得の間に読み終えた側の項目が更新されて末尾へ動いたとき、後ろの項目が詰まって取りこぼすため。
// 起点は含むので境目の項目は重なる（受け取る側が externalId で吸収する）。
// 同じ更新日時が1頁を超えて続くときだけ、起点を変えずに頁番号を進める。
//
// 人が差分を読む領域（docs/development.md の「マージの判定」）
import type { FetchAssignedParams, FetchAssignedResult, ImportedItem, ScopeCandidate } from '../source.ts';
import { FULL_NAME_PATTERN, LOGIN_PATTERN, PAGE_SIZE, fail, getJson, idOf, isRecord } from './client.ts';

const SCOPE_ID_PATTERN = /^[1-9][0-9]{0,15}$/;
const CURSOR_PATTERN = /^([1-9][0-9]{0,15}):([1-9][0-9]{0,5}):(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z)?$/;
const ISO_PATTERN = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,3})?(Z|[+-]\d\d:\d\d)$/;
const ISSUE_URL_PATH = /^\/[A-Za-z0-9_.-]{1,80}\/[A-Za-z0-9_.-]{1,100}\/issues\/[1-9][0-9]{0,15}$/;
// 頁の番号の上限。超えるまで同じ更新日時の満杯が続くときは断る（回り続けないため）
const MAX_PAGE = 1000;
// 1回の呼び出しの要求の数の上限（Workers の1回の処理のサブリクエストの上限より小さくする）
export const MAX_REQUESTS = 40;
// GitHub の Issue の題の上限は256文字。超える応答は想定外として断る
const MAX_TITLE_LENGTH = 256;
const MAX_URL_LENGTH = 300;

function invalidArgument(): never {
  // 呼び出す側の誤り。認証情報の失敗とは区別する
  throw new TypeError('担当の Issue の取得の入力が不正');
}

function isoOf(value: unknown): string {
  if (typeof value !== 'string') throw fail('unavailable');
  const time = Date.parse(value);
  if (Number.isNaN(time)) throw fail('unavailable');
  return new Date(time).toISOString();
}

function sameLogin(a: unknown, b: string): boolean {
  return typeof a === 'string' && a.toLowerCase() === b.toLowerCase();
}

function isAssignedTo(item: Record<string, unknown>, login: string): boolean {
  if (isRecord(item.assignee) && sameLogin(item.assignee.login, login)) return true;
  return Array.isArray(item.assignees) && item.assignees.some((a) => isRecord(a) && sameLogin(a.login, login));
}

// Issue の URL（https://github.com/owner/repo/issues/番号）から `owner/repo#番号` を作る。形が違えば null。
// 改名や移動の後も、応答の URL が今の名前を指すので、キーは範囲の名前ではなく URL から作る
function keyOfIssueUrl(url: string): string | null {
  if (url.length > MAX_URL_LENGTH) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' || parsed.host !== 'github.com' || parsed.search !== '' || parsed.hash !== '') {
    return null;
  }
  if (!ISSUE_URL_PATH.test(parsed.pathname)) return null;
  const [, owner, repo, , number] = parsed.pathname.split('/');
  return `${owner}/${repo}#${number}`;
}

// null は、返さない項目（PR、閉じた Issue、担当が他人）
function convert(raw: unknown, scope: ScopeCandidate, login: string): ImportedItem | null {
  if (!isRecord(raw)) throw fail('unavailable');
  // 一覧は PR も返す。PR は次のストーリーで扱う
  if (raw.pull_request !== undefined) return null;
  if (raw.state !== 'open' && raw.state !== 'closed') throw fail('unavailable');
  if (raw.state !== 'open') return null;
  if (!isAssignedTo(raw, login)) return null;

  const id = idOf(raw.id);
  idOf(raw.number); // 番号は応答の URL から読む。形だけ確かめる
  const { title, html_url: url } = raw;
  if (typeof title !== 'string' || title.length === 0 || title.length > MAX_TITLE_LENGTH) throw fail('unavailable');
  const key = typeof url === 'string' ? keyOfIssueUrl(url) : null;
  if (typeof url !== 'string' || key === null) throw fail('unavailable');

  let dueAt: string | null = null;
  if (isRecord(raw.milestone) && raw.milestone.due_on !== null && raw.milestone.due_on !== undefined) {
    dueAt = isoOf(raw.milestone.due_on);
  }
  return {
    kind: 'issue',
    // 不変の ID は GitHub の ID。番号は移動で変わるので使わない
    externalId: id,
    key,
    url,
    scopeId: scope.id,
    scopeName: scope.name,
    state: 'open',
    dueAt,
    updatedAt: isoOf(raw.updated_at),
    title,
    completed: false,
  };
}

type Position = { repo: number; page: number; since: string | null };

function validate(params: FetchAssignedParams): Position {
  if (!LOGIN_PATTERN.test(params.assignee)) invalidArgument();
  if (!Number.isSafeInteger(params.maxRequests) || params.maxRequests < 1 || params.maxRequests > MAX_REQUESTS) {
    invalidArgument();
  }
  if (params.since !== null && !ISO_PATTERN.test(params.since)) invalidArgument();
  if (params.since !== null && Number.isNaN(Date.parse(params.since))) invalidArgument();
  for (const scope of params.scopes) {
    if (!SCOPE_ID_PATTERN.test(scope.id) || !FULL_NAME_PATTERN.test(scope.name)) invalidArgument();
  }
  const since = params.since === null ? null : new Date(params.since).toISOString();
  if (params.cursor === null) return { repo: 0, page: 1, since };
  const match = CURSOR_PATTERN.exec(params.cursor);
  if (match === null) invalidArgument();
  // 位置は範囲の ID で持つ。再開の間に範囲の並びが変わっても、別のリポジトリを指さない
  const repo = params.scopes.findIndex((scope) => scope.id === match[1]);
  const page = Number(match[2]);
  if (repo < 0 || page > MAX_PAGE) invalidArgument();
  return { repo, page, since: match[3] ?? since };
}

function urlOf(scope: ScopeCandidate, assignee: string, since: string | null, page: number): string {
  const query = new URLSearchParams({
    state: 'open',
    assignee,
    sort: 'updated',
    direction: 'asc',
    per_page: String(PAGE_SIZE),
    page: String(page),
  });
  if (since !== null) query.set('since', since);
  return `https://api.github.com/repositories/${scope.id}/issues?${query.toString()}`;
}

export async function fetchAssignedIssues(
  credential: string,
  params: FetchAssignedParams,
  fetcher: typeof fetch,
): Promise<FetchAssignedResult> {
  let { repo, page, since } = validate(params);
  const baseSince = params.since === null ? null : new Date(params.since).toISOString();
  const items: ImportedItem[] = [];
  let requests = 0;
  while (repo < params.scopes.length) {
    // 上限に達したら、次の要求の位置を返す
    if (requests >= params.maxRequests) {
      const anchor = since !== baseSince && since !== null ? since : '';
      return { items, nextCursor: `${params.scopes[repo]!.id}:${page}:${anchor}` };
    }
    const scope = params.scopes[repo]!;
    const body = await getJson(urlOf(scope, params.assignee, since, page), credential, fetcher);
    requests++;
    if (!Array.isArray(body)) throw fail('unavailable');
    for (const raw of body as unknown[]) {
      const item = convert(raw, scope, params.assignee);
      if (item !== null) items.push(item);
    }
    if (body.length < PAGE_SIZE) {
      repo++;
      page = 1;
      since = baseSince;
      continue;
    }
    const last: unknown = body[body.length - 1];
    if (!isRecord(last)) throw fail('unavailable');
    const lastUpdated = isoOf(last.updated_at);
    if (lastUpdated === since) {
      // 同じ更新日時が1頁を超えて続いている
      page++;
      if (page > MAX_PAGE) throw fail('unavailable');
    } else {
      since = lastUpdated;
      page = 1;
    }
  }
  return { items, nextCursor: null };
}
