// 取り込み元の共通の型（docs/requirements.md の「取り込み」）。取り込み元ごとの固有の処理と値は、型の実装の中に閉じる。
// この型が持つのは、登録に要る部分（認証情報の形の検査と確かめ、範囲の候補の一覧）。取得と変換は後のタスクで足す。
// 取り込み元の一覧（種類から実装への表）を知るのは index.ts だけ。
//
// 人が差分を読む領域（docs/development.md の「マージの判定」）

export type ImportSourceKind = 'github';

// 範囲の種類。範囲の候補の ID と名前が何を指すか（GitHub はリポジトリ）
export type ScopeKind = 'repository';

// 認証情報の持ち主。1接続は1人の持ち主に結ぶ。id は取り込み元の不変の ID を10進の文字列で持つ
export type CredentialOwner = { kind: 'user' | 'organization'; id: string; name: string };

// 範囲の候補。id は取り込み元の不変の ID（10進の文字列）、name は画面に出す名前（GitHub は `owner/name`）
export type ScopeCandidate = { id: string; name: string };

// 取り込む項目の種別（docs/requirements.md の「取り込み」）。この版の GitHub が返すのは issue だけ
export type ImportItemKind = 'issue' | 'pull_request' | 'review_request';

// 取り込み元を問わない、取り込む項目の形。DB への書き込みは同期の仕組みが行う
// - externalId: 取り込み元の不変の ID（10進の文字列。GitHub は Issue の GitHub の ID で、番号ではない）
// - key: 画面に出す、取り込み元でのキー（GitHub は `owner/repo#番号`。移動や改名で変わりうる）
// - scopeId / scopeName: 範囲（GitHub はリポジトリ）の不変の ID と、画面に出す名前
// - dueAt: 期限（ISO 8601）。取り込み元に無ければ null
// - updatedAt: 取り込み元での更新日時（ISO 8601、UTC）
export type ImportedItem = {
  kind: ImportItemKind;
  externalId: string;
  key: string;
  url: string;
  scopeId: string;
  scopeName: string;
  state: 'open' | 'closed';
  dueAt: string | null;
  updatedAt: string;
  title: string;
  completed: boolean;
};

// 担当の項目の取得の入力。1回の要求の数に上限を持ち、続きの位置を受け取り、返す
// - assignee: 「自分」（PAT を発行したユーザー）のログイン名
// - scopes: 取り込む範囲。続きから再開するときは、続きのリポジトリを含めて渡す（並びは変わってよい）
// - since: これ以降に更新された項目だけを取る（ISO 8601）。初回は null。続きから再開するときは前回と同じ値を渡す
// - maxRequests: 取り込み元への要求の数の上限（1以上）
// - cursor: 前回返された続きの位置（不透明な文字列）。最初は null
export type FetchAssignedParams = {
  assignee: string;
  scopes: ScopeCandidate[];
  since: string | null;
  maxRequests: number;
  cursor: string | null;
};

// items は更新日時の古い順（範囲ごと）。nextCursor が null なら取り終えた。
// 続きは更新日時の起点で持つので、境目の項目が重なる。受け取る側は externalId で重複を許す
export type FetchAssignedResult = { items: ImportedItem[]; nextCursor: string | null };

// invalid_format: 認証情報の形が合わない（取り込み元に問い合わせていない）
// unauthorized: 取り込み元が認証情報を受け付けなかった（401。無効、期限切れ、取り消し済み）
// forbidden: 取り込み元が権限を認めなかった（403。上限に当たった場合も含む）
// unavailable: 届かない、5xx、応答が想定と違う、候補が多すぎる
export type ImportSourceFailure = 'invalid_format' | 'unauthorized' | 'forbidden' | 'unavailable';

// message は固定の文だけにする。認証情報、応答の本文、URL を入れない（ログに出るため）
export class ImportSourceError extends Error {
  readonly failure: ImportSourceFailure;

  constructor(failure: ImportSourceFailure, message: string) {
    super(message);
    this.name = 'ImportSourceError';
    this.failure = failure;
  }
}

export interface ImportSource {
  readonly kind: ImportSourceKind;
  readonly scopeKind: ScopeKind;
  // 取り込み元に固有の設定の検証。受け付ける形ならそれを返し、合わなければ null。GitHub は設定を持たず、`{}` か未指定（undefined）だけを受けて `{}` を返す
  parseSettings(settings: unknown): Record<string, never> | null;
  // 認証情報の形の検査。取り込み元に問い合わせない
  isCredentialShape(credential: string): boolean;
  // 画面に出す、認証情報の末尾4文字。形が合わないときは ImportSourceError('invalid_format') を投げる
  credentialLast4(credential: string): string;
  // 認証情報を取り込み元で確かめ、持ち主を返す。形が合わなければ問い合わせずに ImportSourceError('invalid_format') を投げる
  verifyCredential(credential: string, fetcher: typeof fetch): Promise<CredentialOwner>;
  // 範囲の候補を、頁をまたいで漏れなく返す。形が合わなければ問い合わせずに ImportSourceError('invalid_format') を投げる
  listScopeCandidates(credential: string, fetcher: typeof fetch): Promise<ScopeCandidate[]>;
  // 範囲の中で、自分が担当の未完了の項目を、取り込み元を問わない形で返す。上限に達したら続きの位置を返す。
  // 形が合わなければ問い合わせずに ImportSourceError('invalid_format') を投げ、失敗は 401、403、それ以外を区別して投げる
  fetchAssignedItems(
    credential: string,
    params: FetchAssignedParams,
    fetcher: typeof fetch,
  ): Promise<FetchAssignedResult>;
}
