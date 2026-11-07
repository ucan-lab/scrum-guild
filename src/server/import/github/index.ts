// GitHub の取り込み元（fine-grained PAT）。通信先は固定の URL で、設定から読まない。
// GitHub に固有の値と処理は、このディレクトリの外に出さない。
// 通信の作法はログインの auth/github.ts と同じ（固定の URL、redirect: 'manual'、時間切れ、固定の文のエラー）
//
// 人が差分を読む領域（docs/development.md の「マージの判定」）
import {
  ImportSourceError,
  type CredentialOwner,
  type FetchPageInput,
  type FetchPageResult,
  type ImportSource,
  type ImportSourceFailure,
  type ScopeCandidate,
} from '../source.ts';

const USER_URL = 'https://api.github.com/user';
const REPOS_URL = 'https://api.github.com/user/repos';
const REQUEST_TIMEOUT_MS = 10_000;
const API_VERSION = '2022-11-28';
const USER_AGENT = 'scrum-guild';

const PAGE_SIZE = 100;
// 頁送りの上限。超える（100頁目まで満杯で続く）ときは、止まらずに回り続けないよう断る
const MAX_PAGES = 100;
// 候補の一覧の期限。各頁を始める前に判定するので、最悪は、これに1回分の時間切れ（10秒）を足した時間になる
const LIST_DEADLINE_MS = 60_000;

// fine-grained PAT: `github_pat_` + 英数字とアンダースコア。全体で255文字まで
const PAT_PATTERN = /^github_pat_[A-Za-z0-9_]{22,244}$/;
// リポジトリの `owner/name`。GitHub の名前の文字（英数字、`_`、`.`、`-`）と長さに絞る（画面と DB に入る値のため）
const FULL_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,80}\/[A-Za-z0-9_.-]{1,100}$/;
const LOGIN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;

// メッセージは固定の文だけにする。PAT、応答の本文、URL、例外の message を入れない
const MESSAGES: Record<ImportSourceFailure, string> = {
  invalid_format: '認証情報の形が GitHub の fine-grained PAT に合わない',
  unauthorized: 'GitHub が認証情報を受け付けなかった（401）',
  forbidden: 'GitHub が認証情報の権限を認めなかった（403）',
  unavailable: 'GitHub に届かないか、応答が想定と違う',
};

function fail(failure: ImportSourceFailure): ImportSourceError {
  return new ImportSourceError(failure, MESSAGES[failure]);
}

function isShape(credential: unknown): credential is string {
  return typeof credential === 'string' && PAT_PATTERN.test(credential);
}

function requireShape(credential: unknown): string {
  if (!isShape(credential)) throw fail('invalid_format');
  return credential;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function idOf(value: unknown): string {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) throw fail('unavailable');
  return String(value);
}

// 読まない応答の本文を捨てる。持ったままにすると、接続が解放されない
async function discard(res: Response): Promise<void> {
  await res.body?.cancel().catch(() => {});
}

async function getJson(url: string, credential: string, fetcher: typeof fetch): Promise<unknown> {
  let res: Response;
  try {
    // リダイレクトは追わない。3xx は res.ok が偽なので失敗になる
    res = await fetcher(url, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        Authorization: `Bearer ${credential}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': USER_AGENT,
        'X-GitHub-Api-Version': API_VERSION,
      },
    });
  } catch {
    // 例外の message に URL や接続の詳細が混ざりうるので、読まない
    throw fail('unavailable');
  }
  if (!res.ok) {
    await discard(res);
    if (res.status === 401) throw fail('unauthorized');
    if (res.status === 403 || res.status === 429) throw fail('forbidden');
    throw fail('unavailable');
  }
  return res.json().catch(() => {
    throw fail('unavailable');
  });
}

async function verifyCredential(credential: string, fetcher: typeof fetch): Promise<CredentialOwner> {
  const pat = requireShape(credential);
  const body = await getJson(USER_URL, pat, fetcher);
  if (!isRecord(body)) throw fail('unavailable');
  const id = idOf(body.id);
  const name = body.login;
  if (typeof name !== 'string' || !LOGIN_PATTERN.test(name)) throw fail('unavailable');
  if (body.type !== 'User' && body.type !== 'Organization') throw fail('unavailable');
  return { kind: body.type === 'User' ? 'user' : 'organization', id, name };
}

async function listScopeCandidates(credential: string, fetcher: typeof fetch): Promise<ScopeCandidate[]> {
  const pat = requireShape(credential);
  const found = new Map<string, ScopeCandidate>();
  const deadline = Date.now() + LIST_DEADLINE_MS;
  // 101頁目は、100頁目まで満杯だったときに続きが無いことを確かめるためだけに取る
  for (let page = 1; page <= MAX_PAGES + 1; page++) {
    if (Date.now() > deadline) throw fail('unavailable');
    const body = await getJson(`${REPOS_URL}?per_page=${PAGE_SIZE}&page=${page}`, pat, fetcher);
    if (!Array.isArray(body)) throw fail('unavailable');
    if (page > MAX_PAGES && body.length > 0) throw fail('unavailable');
    for (const item of body as unknown[]) {
      if (!isRecord(item)) throw fail('unavailable');
      const id = idOf(item.id);
      const name = item.full_name;
      if (typeof name !== 'string' || !FULL_NAME_PATTERN.test(name)) throw fail('unavailable');
      if (!found.has(id)) found.set(id, { id, name });
    }
    if (body.length < PAGE_SIZE) return [...found.values()];
  }
  throw fail('unavailable');
}

// 担当の Issue の取得と変換は #923 で足す。それまでは取り込み元に届かない扱いにして、同期は次で再試行する
async function fetchPage(input: FetchPageInput): Promise<FetchPageResult> {
  void input;
  throw fail('unavailable');
}

export const githubImportSource: ImportSource = {
  kind: 'github',
  scopeKind: 'repository',
  parseSettings(settings) {
    if (settings === undefined) return {};
    if (isRecord(settings) && Object.keys(settings).length === 0) return {};
    return null;
  },
  isCredentialShape: isShape,
  credentialLast4(credential) {
    return requireShape(credential).slice(-4);
  },
  verifyCredential,
  listScopeCandidates,
  fetchPage,
};
