// 取り込み元に依らない同期の仕組み（docs/requirements.md の「取り込み」、docs/data-model.md の「書き込みの単位」）。
// 接続を1つ、範囲ごとに続きの位置で頁を取り、頁ごとに1回の batch() で、新しい項目をタスクと task_sources に書く。
// 「今すぐ同期」と、後の定期処理が同じ関数を呼ぶ。取り込み元ごとの違いは ImportSource の実装の中に閉じ、ここは取り込み元の名前を知らない。
// このタスクの範囲は新しい項目を入れるまで。取り込み済みの項目の属性の更新と完了の印、応答の保存はしない。
//
// 人が差分を読む領域（docs/development.md の「マージの判定」）
import { generateNKeysBetween } from 'fractional-indexing';
import {
  importTaskStatements,
  readInboxTailPosition,
  readRepositoriesByContainer,
  readSyncConnection,
  syncOutcomeStatement,
  type ImportedTask,
  type OrganizationDb,
  type SyncOutcome,
} from '../db/index.ts';
import { decryptCredential } from '../crypto/credential.ts';
import { uuidv7 } from '../uuid.ts';
import { stripHiddenCharacters } from '../../shared/hidden-characters.ts';
import { TASK_TITLE_MAX_LENGTH } from '../../shared/task.ts';
import { BLANK_CHARACTERS } from '../../shared/text-rules.ts';
import { importSourceOf, isImportSourceKind } from './index.ts';
import { ImportSourceError, type ImportItem, type ImportSource, type ImportSourceFailure } from './source.ts';

// 1回の同期で取る頁の数の上限。超えたら続きの位置を保存して止め、次の同期で続ける
export const DEFAULT_MAX_PAGES = 10;
// 1頁の項目の数の上限。超える応答は想定と違うものとして断る（1回の batch() の文を抑える）
export const MAX_ITEMS_PER_PAGE = 100;
// 続きの位置の長さの上限（取り込み元が返した値をそのまま保存するため）
const MAX_CURSOR_LENGTH = 2000;
const MAX_FIELD_LENGTH = 2000;

// connections.last_error_message に書く固定の文。取り込み元や例外の message は書かない（認証情報や URL が混ざりうるため）
const FAILURE_MESSAGES: Record<ImportSourceFailure, string> = {
  invalid_format: '認証情報が使えない形になっている',
  unauthorized: '取り込み元が認証情報を受け付けなかった',
  forbidden: '取り込み元が権限を認めなかった',
  unavailable: '取り込み元に届かないか、応答が想定と違う',
};
const CREDENTIAL_UNAVAILABLE_MESSAGE = '認証情報を取り出せなかった';
const UNKNOWN_FAILURE_MESSAGE = '同期で想定外の失敗が起きた';

export type SyncOptions = {
  // 取り込み元の実装。省くと接続の種類から引く（テストが偽の取り込み元を差す）
  source?: ImportSource;
  fetcher?: typeof fetch;
  now?: () => Date;
  maxPages?: number;
};

export type SyncResult =
  // 接続が無い（別の組織、別のワークスペース、削除済み）か、閉じたワークスペース
  | { outcome: 'not_found' }
  // 止まっている接続は同期しない
  | { outcome: 'stopped' }
  // 範囲が空で、取り込み元に問い合わせていない
  | { outcome: 'no_scope' }
  // imported: 今回入れたタスクの数。more: 上限で止め、続きの位置を保存した
  | { outcome: 'success'; imported: number; more: boolean }
  // imported: 失敗するまでに入れた数
  | { outcome: 'auth_failed' | 'error'; imported: number };

type SyncState = { resume: { scope: string; cursor: string | null } | null };

function parseSyncState(json: string): SyncState {
  try {
    const value: unknown = JSON.parse(json);
    if (typeof value === 'object' && value !== null && 'resume' in value) {
      const resume = (value as { resume: unknown }).resume;
      if (typeof resume === 'object' && resume !== null) {
        const { scope, cursor } = resume as { scope?: unknown; cursor?: unknown };
        if (typeof scope === 'string' && (cursor === null || typeof cursor === 'string')) {
          return { resume: { scope, cursor } };
        }
      }
    }
  } catch {
    // 壊れた状態は最初からやり直す
  }
  return { resume: null };
}

function parseSettings(json: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(json);
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch {
    // 壊れた設定は空として扱う
  }
  return {};
}

// 手で入れるタイトルと同じ整え方: 見えない文字を除いて前後の空白を落とし、200字（コードポイント）で切る。
// 改行とタブは語をつなげないよう、除く前に空白にする。何も残らなければ取り込み元のキーを使う
export function importedTitle(raw: string, fallback: string): string {
  const cleaned = stripHiddenCharacters(raw.replace(/[\t\n\r]+/g, ' ')).trim();
  // 手で入れるタイトルと同じく、空白や幅の無い文字だけのタイトルは空と同じ扱いにする
  const blank = (text: string) => text.replace(BLANK_CHARACTERS, '') === '';
  const title = blank(cleaned) ? stripHiddenCharacters(fallback).trim() : cleaned;
  return blank(title) ? '' : [...title].slice(0, TASK_TITLE_MAX_LENGTH).join('').trim();
}

function invalid(): ImportSourceError {
  return new ImportSourceError('unavailable', FAILURE_MESSAGES.unavailable);
}

function isText(value: unknown, allowEmpty = false): value is string {
  return typeof value === 'string' && value.length <= MAX_FIELD_LENGTH && (allowEmpty || value !== '');
}

// 画面がリンクにする値なので http と https だけを通す
function isWebUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === 'https:' || protocol === 'http:';
  } catch {
    return false;
  }
}

function isIsoInstant(value: string): boolean {
  const time = Date.parse(value);
  return !Number.isNaN(time) && new Date(time).toISOString() === value;
}

function isDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

// 取り込み元の実装が返した項目の形を確かめる。外から来た値なので、書く前に形と長さを見る。
// 合わない項目は取り込まずに飛ばす（1件の不備で、その頁より後の頁と後ろの範囲を塞がない）
function isValidItem(item: ImportItem): boolean {
  const kinds = ['issue', 'pull_request', 'review_request'];
  if (
    typeof item !== 'object' ||
    item === null ||
    !kinds.includes(item.kind) ||
    !isText(item.sourceId) ||
    !isText(item.reviewerSourceId, true) ||
    (item.kind === 'review_request') !== (item.reviewerSourceId !== '') ||
    !isText(item.key) ||
    !isText(item.url) ||
    !isWebUrl(item.url) ||
    !isText(item.title, true) ||
    !isText(item.containerId) ||
    !isText(item.containerName) ||
    !isText(item.status) ||
    !isText(item.updatedAt) ||
    !isIsoInstant(item.updatedAt) ||
    typeof item.isDone !== 'boolean' ||
    (item.dueOn !== null && (typeof item.dueOn !== 'string' || !isDate(item.dueOn)))
  ) {
    return false;
  }
  // 見えない文字を除いて空になる欄は、表示に使えない
  return [item.key, item.containerName, item.status].every((text) => stripHiddenCharacters(text).trim() !== '');
}

type Scope = { id: string; name: string };

async function scopesOf(
  source: ImportSource,
  mode: string,
  stored: Scope[],
  credential: string,
  fetcher: typeof fetch,
): Promise<Scope[]> {
  if (mode !== 'exclude') return stored;
  // 「すべてから除外を挙げる」: 持ち主のすべての範囲の候補から、除外に挙げたものを引く
  const excluded = new Set(stored.map((scope) => scope.id));
  const candidates = await source.listScopeCandidates(credential, fetcher);
  return candidates.filter((candidate) => !excluded.has(candidate.id)).sort((a, b) => (a.id < b.id ? -1 : 1));
}

export async function syncConnection(
  env: object,
  db: OrganizationDb,
  workspaceId: string,
  connectionId: string,
  options: SyncOptions = {},
): Promise<SyncResult> {
  const fetcher = options.fetcher ?? fetch;
  const now = options.now ?? (() => new Date());
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;

  const read = await readSyncConnection(db, workspaceId, connectionId);
  if (read === undefined) return { outcome: 'not_found' };
  const { connection } = read;
  if (connection.status === 'stopped') return { outcome: 'stopped' };
  // 対象を挙げる接続で範囲が空なら、取り込み元に問い合わせない（登録した直後の状態）
  if (connection.scope_mode !== 'exclude' && read.scopes.length === 0) return { outcome: 'no_scope' };

  let imported = 0;
  // 状態の文が通らなかった（同期の最中に接続が止まった、削除された）ときは false
  const finish = async (outcome: SyncOutcome): Promise<boolean> => {
    const result = await db.run(
      syncOutcomeStatement(db, { id: connection.id, workspaceId }, outcome, now().toISOString()),
    );
    return result.changes > 0;
  };

  try {
    const source =
      options.source ?? (isImportSourceKind(connection.provider) ? importSourceOf(connection.provider) : undefined);
    if (source === undefined) throw invalid();

    const credential = await credentialOf(env, connection);
    const settings = parseSettings(connection.settings_json);
    const stored = read.scopes.map((scope) => ({ id: scope.source_id, name: scope.source_name }));
    const scopes = await scopesOf(source, connection.scope_mode, stored, credential, fetcher);
    const state = parseSyncState(connection.sync_state_json);
    const start = state.resume === null ? -1 : scopes.findIndex((scope) => scope.id === state.resume!.scope);
    const repositories = await readRepositoriesByContainer(db, workspaceId, connection.provider);

    let pages = 0;
    for (let index = Math.max(start, 0); index < scopes.length; index++) {
      const scope = scopes[index]!;
      let cursor = index === start ? state.resume!.cursor : null;
      do {
        if (pages >= maxPages) {
          const resume = { scope: scope.id, cursor };
          if (!(await finish({ kind: 'success', syncStateJson: JSON.stringify({ resume }) }))) {
            return { outcome: 'stopped' };
          }
          return { outcome: 'success', imported, more: true };
        }
        pages++;
        const page = await source.fetchPage({ credential, fetcher, settings, scope, cursor });
        if (
          typeof page !== 'object' ||
          page === null ||
          !Array.isArray(page.items) ||
          page.items.length > MAX_ITEMS_PER_PAGE ||
          (page.next !== null &&
            (typeof page.next !== 'string' || page.next === '' || page.next.length > MAX_CURSOR_LENGTH))
        ) {
          throw invalid();
        }
        // 同じ続きの位置が返り続けると回り続けるので、進まない頁は断る
        if (page.next !== null && page.next === cursor) throw invalid();
        imported += await writePage(db, connection, workspaceId, page.items, repositories, now);
        cursor = page.next;
      } while (cursor !== null);
    }
    if (!(await finish({ kind: 'success', syncStateJson: '{}' }))) return { outcome: 'stopped' };
    return { outcome: 'success', imported, more: false };
  } catch (error) {
    const failure = failureOf(error);
    // 認証の失敗（取り込み元が受け付けない、保存した認証情報が使えない形）は接続を止める。ほかは止めず、次の同期で再試行する
    if (failure.stop) {
      await finish({ kind: 'auth_failed', message: failure.message });
      return { outcome: 'auth_failed', imported };
    }
    await finish({ kind: 'error', message: failure.message });
    return { outcome: 'error', imported };
  }
}

async function credentialOf(
  env: object,
  connection: { id: string; credential_ciphertext: string | null; credential_key_version: number | null },
): Promise<string> {
  if (connection.credential_ciphertext === null || connection.credential_key_version === null) {
    throw new CredentialUnavailable();
  }
  try {
    return await decryptCredential(
      env,
      { ciphertext: connection.credential_ciphertext, keyVersion: connection.credential_key_version },
      connection.id,
    );
  } catch {
    throw new CredentialUnavailable();
  }
}

class CredentialUnavailable extends Error {
  constructor() {
    super(CREDENTIAL_UNAVAILABLE_MESSAGE);
    this.name = 'CredentialUnavailable';
  }
}

function failureOf(error: unknown): { stop: boolean; message: string } {
  if (error instanceof ImportSourceError) {
    const known = Object.hasOwn(FAILURE_MESSAGES, error.failure);
    return {
      stop: error.failure === 'unauthorized' || error.failure === 'invalid_format',
      message: known ? FAILURE_MESSAGES[error.failure] : UNKNOWN_FAILURE_MESSAGE,
    };
  }
  if (error instanceof CredentialUnavailable) return { stop: false, message: CREDENTIAL_UNAVAILABLE_MESSAGE };
  return { stop: false, message: UNKNOWN_FAILURE_MESSAGE };
}

// 1頁を、未完了の新しい項目だけ、1回の batch() で書く。入れたタスクの数を返す
async function writePage(
  db: OrganizationDb,
  connection: { id: string; provider: string; owner_user_id: string },
  workspaceId: string,
  items: readonly ImportItem[],
  repositories: ReadonlyMap<string, string>,
  now: () => Date,
): Promise<number> {
  // 完了した項目は入れない（取り込んでいない項目が完了していたら取り込まない）。形の合わない項目も飛ばす
  const open = items.filter((item) => isValidItem(item) && !item.isDone);
  if (open.length === 0) return 0;

  const at = now();
  const tail = await readInboxTailPosition(db, workspaceId);
  const positions = generateNKeysBetween(tail ?? null, null, open.length);
  const tasks: ImportedTask[] = open.map((item, index) => ({
    taskId: uuidv7(at),
    workspaceId,
    connectionId: connection.id,
    provider: connection.provider,
    assigneeUserId: connection.owner_user_id,
    repositoryId: repositories.get(item.containerId) ?? null,
    position: positions[index]!,
    title: importedTitle(item.title, item.key) || importedTitle(item.sourceId, '') || '(題なし)',
    kind: item.kind,
    sourceId: item.sourceId,
    reviewerSourceId: item.reviewerSourceId,
    key: stripHiddenCharacters(item.key),
    url: item.url,
    containerId: item.containerId,
    containerName: stripHiddenCharacters(item.containerName),
    status: stripHiddenCharacters(item.status),
    dueOn: item.dueOn,
    updatedAt: item.updatedAt,
  }));
  const results = await db.batch(tasks.flatMap((task) => importTaskStatements(db, task, at.toISOString())));
  // 2文ずつの組の先頭（tasks）が書いた数が、入れたタスクの数
  let imported = 0;
  for (let index = 0; index < results.length; index += 2) imported += results[index]!.changes;
  return imported;
}
