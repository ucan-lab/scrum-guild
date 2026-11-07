// GitHub の API を PAT で呼ぶ共通の部品（固定の URL、redirect: 'manual'、時間切れ、固定の文のエラー）。
// message は固定の文だけにする。PAT、応答の本文、URL、例外の message を入れない
//
// 人が差分を読む領域（docs/development.md の「マージの判定」）
import { ImportSourceError, type ImportSourceFailure } from '../source.ts';

const REQUEST_TIMEOUT_MS = 10_000;
const API_VERSION = '2022-11-28';
const USER_AGENT = 'scrum-guild';

export const PAGE_SIZE = 100;
// リポジトリの `owner/name`。GitHub の名前の文字（英数字、`_`、`.`、`-`）と長さに絞る（画面と DB に入る値のため）
export const FULL_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,80}\/[A-Za-z0-9_.-]{1,100}$/;
export const LOGIN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;

const MESSAGES: Record<ImportSourceFailure, string> = {
  invalid_format: '認証情報の形が GitHub の fine-grained PAT に合わない',
  unauthorized: 'GitHub が認証情報を受け付けなかった（401）',
  forbidden: 'GitHub が認証情報の権限を認めなかった（403）',
  unavailable: 'GitHub に届かないか、応答が想定と違う',
};

export function fail(failure: ImportSourceFailure): ImportSourceError {
  return new ImportSourceError(failure, MESSAGES[failure]);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function idOf(value: unknown): string {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) throw fail('unavailable');
  return String(value);
}

// 読まない応答の本文を捨てる。持ったままにすると、接続が解放されない
async function discard(res: Response): Promise<void> {
  await res.body?.cancel().catch(() => {});
}

export async function getJson(url: string, credential: string, fetcher: typeof fetch): Promise<unknown> {
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
