// ログイン後に戻る画面のパス（`/login?return_to=` と `oauth_states.return_to`）。自分のサイトのパスだけを受け付け、
// 受け付けない値は `/` に直す。DB の CHECK（docs/data-model.md の `oauth_states`）と同じ検査を、アプリでも行う。
// 画面（ログインの画面が開始の URL に渡す値）と Worker（開始と戻り先）が同じ関数を使う

export const DEFAULT_RETURN_TO = '/';

const MAX_LENGTH = 2000;

// 印字できる ASCII だけ。ブラウザは URL のタブと改行を取り除くので、`/<タブ>/evil.example` が `//evil.example` になる
const PRINTABLE_PATH = /^\/[ -~]*$/;

// 戻り先にしない最初の1区分。API の応答（JSON）やログインの画面そのものへ戻すと、ログインが終わらない
const EXCLUDED_FIRST_SEGMENTS = new Set(['api', 'login']);

// `.` と `..`（`%2e` で書いたものを含む）。URL の解決が区間を畳むので、`/.//evil.example` は `//evil.example` になる
const DOT_SEGMENT = /^(?:\.|%2e){1,2}$/i;

export function safeReturnTo(value: unknown): string {
  if (typeof value !== 'string' || value.length > MAX_LENGTH || !PRINTABLE_PATH.test(value)) return DEFAULT_RETURN_TO;
  // `//host` は別のサイトへの移動になる
  if (value.startsWith('//')) return DEFAULT_RETURN_TO;
  const path = value.split(/[?#]/, 1)[0] ?? '';
  // ブラウザはパスの `\` を `/` として扱うので（`/\host` は `//host`）、パスには受け付けない。クエリとフラグメントの `\` は区切りにならない
  if (path.includes('\\')) return DEFAULT_RETURN_TO;
  const segments = path.slice(1).split('/');
  if (segments.some((segment) => DOT_SEGMENT.test(segment))) return DEFAULT_RETURN_TO;
  // 最初の区間は、デコードしてから比べる（`/%61pi/x` は `/api/x`）。デコードできない値（不正な `%`）は受け付けない
  let first: string;
  try {
    first = decodeURIComponent(segments[0] ?? '');
  } catch {
    return DEFAULT_RETURN_TO;
  }
  if (EXCLUDED_FIRST_SEGMENTS.has(first.toLowerCase())) return DEFAULT_RETURN_TO;
  return value;
}

// URL の解決で正規化した後の値を、もう一度同じ検査に通す（第2の検査）。safeReturnTo を通った値を渡す前提だが、
// これ単体でも、検査を抜ける書き方が残っていて解決後に別のサイトのパスになる値を、自分のサイトのパスだけにする。
// 解決に使う基準の URL はオリジンだけで、パスは持たない
export function resolvedReturnTo(value: string, origin: string): string {
  const url = new URL(value, origin);
  if (url.origin !== origin) return DEFAULT_RETURN_TO;
  const resolved = `${url.pathname}${url.search}${url.hash}`;
  return safeReturnTo(resolved) === resolved ? resolved : DEFAULT_RETURN_TO;
}
