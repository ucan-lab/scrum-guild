// CI の AI レビュー（.github/workflows/ai-review.yml）に渡す PR の本文とコメントを、Markdown に整える。
// 通信はしない。ワークフローの段が gh api で落とした JSON を読み、別のディレクトリに書く。判定と整形は export した関数にして node --test にかける。
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// 公開リポジトリでは誰でもコメントできる。Claude に渡すのは、書き込みの権限を持つ人と、このワークフローの bot のものだけにする。
// MEMBER は組織に入っていることしか表さず、このリポジトリへの書き込みの権限を保証しないので含めない
const TRUSTED_ASSOCIATIONS: ReadonlySet<string> = new Set(['OWNER', 'COLLABORATOR']);
const TRUSTED_BOT_LOGIN = 'github-actions[bot]';

// Claude のコンテキストを食い尽くさないための、ファイルごとの上限（UTF-8 のバイト数）
export const MAX_FILE_BYTES = 64 * 1024;

// 1件が大きいコメントで、ほかのコメントを巻き込んで落とさないように、1件の本文は上限のこの割合までに切り詰める
const COMMENT_BODY_LIMIT_DIVISOR = 4;

const UNAVAILABLE = '取得できなかった';

export type ContextUser = { login?: string | null; type?: string | null };

export type PullRequest = { body?: string | null; user?: ContextUser | null; author_association?: string | null };

export type ContextComment = {
  id: number;
  body?: string | null;
  created_at: string;
  author_association?: string | null;
  user?: ContextUser | null;
  path?: string | null;
  line?: number | null;
  original_line?: number | null;
  in_reply_to_id?: number | null;
};

export type CommentRender = { text: string; kept: number; droppedByAssociation: number; droppedByLimit: number };

export type BodyRender = { text: string; truncated: boolean; kept: number; droppedByAssociation: number };

const encoder = new TextEncoder();
const byteLength = (text: string): number => encoder.encode(text).length;

// 上限の表示は引数の limit から作る。64KB ちょうどのときだけ KB で書く
function limitLabel(limit: number): string {
  return limit % 1024 === 0 ? `${limit / 1024}KB` : `${limit}バイト`;
}

// bot の author_association は区分の判定に使えない（bot 名を名乗る User と見分けられない）ので、login と type の両方で見る
export function isTrustedComment(comment: ContextComment): boolean {
  if (comment.user?.login === TRUSTED_BOT_LOGIN && comment.user.type === 'Bot') {
    return true;
  }
  return TRUSTED_ASSOCIATIONS.has(comment.author_association ?? '');
}

// 古い順。同時刻は id で決め、実行ごとに並びが変わらないようにする
export function sortByCreatedAt<T extends ContextComment>(comments: readonly T[]): T[] {
  return [...comments].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at) || a.id - b.id);
}

// gh api --paginate --slurp は、ページごとの配列を並べた配列を返す。--slurp は --jq と併せられないのでここでならす。
// ならした配列を渡されても同じ結果になる
export function flattenPages(json: unknown): ContextComment[] {
  if (!Array.isArray(json)) {
    throw new Error('コメントの JSON が配列ではありません');
  }
  return (json as unknown[]).flat() as ContextComment[];
}

// 文字の途中で切らない。切り口が UTF-8 の後続バイト（10xxxxxx）なら、文字の先頭まで戻る
export function truncateUtf8(text: string, maxBytes: number): string {
  const bytes = encoder.encode(text);
  if (bytes.length <= maxBytes) {
    return text;
  }
  let end = Math.max(0, maxBytes);
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) {
    end--;
  }
  return new TextDecoder().decode(bytes.subarray(0, end));
}

// NEL（U+0085）、LS（U+2028）、PS（U+2029）。LS と PS は正規表現のリテラルに直の文字では書けず、エスケープで書いても編集の過程で直の文字に変わって構文が壊れた実績があるので、コードから作る
const UNICODE_LINE_SEPARATORS = String.fromCharCode(0x85, 0x2028, 0x2029);
const LINE_BREAK = new RegExp(`\\r\\n|[\\n\\r${UNICODE_LINE_SEPARATORS}]`);
const CONTROL_OR_LINE_SEPARATOR = new RegExp(`[\\p{Cc}${UNICODE_LINE_SEPARATORS}]`, 'gu');

// 本文の中の見出しで、コメントの境目を偽装できないようにする。
// 行の区切りは、Markdown の描画や LLM が改行として読むもの（CR、NEL、LS、PS を含む）をすべて数える
export function quote(body: string): string {
  return body
    .split(LINE_BREAK)
    .map((line) => (line === '' ? '>' : `> ${line}`))
    .join('\n');
}

// path は作成者が決められる文字列で、改行を入れると見出しを偽装できる。改行の類と制御文字は空白にする
function sanitizeInline(text: string): string {
  return text.replace(CONTROL_OR_LINE_SEPARATOR, ' ');
}

function location(comment: ContextComment): string | undefined {
  if (comment.path == null) {
    return undefined;
  }
  const path = sanitizeInline(comment.path);
  if (comment.line != null) {
    return `${path}:${comment.line}`;
  }
  if (comment.original_line != null) {
    return `${path}:${comment.original_line}（古い版の行）`;
  }
  return `${path}（ファイル単位）`;
}

// maxBodyBytes を超える本文は、引用にした後の大きさで切り詰め、見出しに書く
export function commentEntry(comment: ContextComment, maxBodyBytes: number = Infinity): string {
  const login = comment.user?.login ?? '(不明)';
  const association = comment.author_association ?? 'NONE';
  const kind = comment.user?.type === 'Bot' ? `${association}, Bot` : association;
  const lines = [`## ${login} [${kind}] id=${comment.id} ${comment.created_at}`];
  const place = location(comment);
  if (place !== undefined) {
    const reply = comment.in_reply_to_id == null ? '' : ` in_reply_to_id=${comment.in_reply_to_id}`;
    lines.push(`場所: ${place}${reply}`);
  }
  const raw = comment.body ?? '';
  let quoted = quote(raw);
  if (byteLength(quoted) > maxBodyBytes) {
    lines.push(`本文を切り詰めた（元は ${byteLength(raw)} バイト。引用にして ${maxBodyBytes} バイトまでで切った）`);
    quoted = truncateUtf8(quoted, maxBodyBytes);
  }
  return `\n${lines.join('\n')}\n\n${quoted}\n`;
}

function commentHeader(
  title: string,
  kept: number,
  droppedByAssociation: number,
  droppedByLimit: number,
  limit: number,
  unavailable: boolean,
): string {
  return [
    `# ${title}`,
    '',
    ...(unavailable ? [`- ${UNAVAILABLE}: 取得に失敗したので、コメントがあるかどうかは分からない`] : []),
    `- 残した件数: ${kept}`,
    `- 区分で落とした件数: ${droppedByAssociation}`,
    `- 上限（${limitLabel(limit)}）で落とした件数: ${droppedByLimit}`,
    '',
  ].join('\n');
}

// 区分で絞り、古い順に並べ、冒頭の表示を含めた出力が上限に収まる先頭の分だけを残す。
// 後ろ（新しい側）を落とすのは、pr-create が最初に付ける意図の説明を残すため
export function renderComments(
  title: string,
  comments: readonly ContextComment[],
  limit: number = MAX_FILE_BYTES,
  unavailable = false,
): CommentRender {
  const trusted = sortByCreatedAt(comments.filter(isTrustedComment));
  const droppedByAssociation = comments.length - trusted.length;
  const maxBodyBytes = Math.floor(limit / COMMENT_BODY_LIMIT_DIVISOR);
  const entries = trusted.map((comment) => commentEntry(comment, maxBodyBytes));
  const header = (kept: number) =>
    commentHeader(title, kept, droppedByAssociation, entries.length - kept, limit, unavailable);

  const prefixBytes = [0];
  for (const entry of entries) {
    prefixBytes.push(prefixBytes[prefixBytes.length - 1]! + byteLength(entry));
  }

  let kept = entries.length;
  while (kept > 0 && byteLength(header(kept)) + prefixBytes[kept]! > limit) {
    kept--;
  }

  return {
    text: header(kept) + entries.slice(0, kept).join(''),
    kept,
    droppedByAssociation,
    droppedByLimit: entries.length - kept,
  };
}

function bodyHeader(login: string, kept: number, droppedByAssociation: number, truncation: string): string {
  return [
    '# PR の本文',
    '',
    `- 作成者: ${login}`,
    `- 残した件数: ${kept}`,
    `- 区分で落とした件数: ${droppedByAssociation}`,
    `- 切り詰め: ${truncation}`,
    '',
    '',
  ].join('\n');
}

// 同じリポジトリのブランチの PR は、書き込みの権限を持たない人も開ける。作成者が OWNER か COLLABORATOR でなければ、
// 本文は書き換えられるものとして渡さない。渡すときも、見出しを偽装されないよう全行を引用にする
export function renderBody(pr: PullRequest, limit: number = MAX_FILE_BYTES): BodyRender {
  const login = pr.user?.login ?? '(不明)';
  if (!TRUSTED_ASSOCIATIONS.has(pr.author_association ?? '')) {
    const text = `${bodyHeader(login, 0, 1, 'なし')}作成者が書き込みの権限を持たないので本文を渡さない\n`;
    return { text, truncated: false, kept: 0, droppedByAssociation: 1 };
  }

  const raw = pr.body ?? '';
  const quoted = raw === '' ? '' : quote(raw);
  const full = bodyHeader(login, 1, 0, 'なし') + quoted;
  if (byteLength(full) <= limit) {
    return { text: full, truncated: false, kept: 1, droppedByAssociation: 0 };
  }

  const header = bodyHeader(
    login,
    1,
    0,
    `あり（元の本文は ${byteLength(raw)} バイト。出力が上限 ${limit} バイトに収まるまでで切った）`,
  );
  return {
    text: header + truncateUtf8(quoted, limit - byteLength(header)),
    truncated: true,
    kept: 1,
    droppedByAssociation: 0,
  };
}

export function renderBodyUnavailable(): BodyRender {
  return {
    text: `# PR の本文\n\n- ${UNAVAILABLE}: 取得に失敗したので、本文は渡さない\n`,
    truncated: false,
    kept: 0,
    droppedByAssociation: 0,
  };
}

export type ContextReport = {
  file: string;
  kept: number;
  droppedByAssociation: number;
  droppedByLimit: number;
  note?: string;
};

// ワークフローのログに出す。コメントの本文は出さない
export function formatReport(report: ContextReport): string {
  const note = report.note === undefined ? '' : ` ${report.note}`;
  return `${report.file}: 残した ${report.kept} 件、区分で落とした ${report.droppedByAssociation} 件、上限で落とした ${report.droppedByLimit} 件${note}`;
}

export function formatUnreadableWarning(source: string): string {
  return `::warning::${source} を読めなかった`;
}

export type ContextResult = { reports: ContextReport[]; unreadable: string[] };

// 無い、壊れている、形が違うものは読めなかったものとして undefined を返す。例外の文には JSON の一部が入りうるので、ログに出さない
function readJson<T>(dir: string, name: string, parse: (json: unknown) => T): T | undefined {
  try {
    return parse(JSON.parse(readFileSync(join(dir, name), 'utf8')));
  } catch {
    return undefined;
  }
}

function asPullRequest(json: unknown): PullRequest {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    throw new Error('PR の JSON がオブジェクトではありません');
  }
  return json as PullRequest;
}

// rawDir の pr.json、issue-comments.json、review-comments.json を読み、outDir に body.md、comments.md、review-comments.md を書く。
// 絞る前の JSON を Claude が読む outDir に置かないため、2つのディレクトリを分ける。
// 読めなかったものは空として扱い、読めたものだけで書く（取得の一部が落ちても、AI レビューは差分と残りで続けるため）
export function writeContext(rawDir: string, outDir: string): ContextResult {
  const pr = readJson(rawDir, 'pr.json', asPullRequest);
  const issueComments = readJson(rawDir, 'issue-comments.json', flattenPages);
  const reviewComments = readJson(rawDir, 'review-comments.json', flattenPages);

  mkdirSync(outDir, { recursive: true });
  const body = pr === undefined ? renderBodyUnavailable() : renderBody(pr);
  const issue = renderComments('PR 全体のコメント', issueComments ?? [], MAX_FILE_BYTES, issueComments === undefined);
  const review = renderComments(
    'インラインのレビューコメント',
    reviewComments ?? [],
    MAX_FILE_BYTES,
    reviewComments === undefined,
  );
  writeFileSync(join(outDir, 'body.md'), body.text);
  writeFileSync(join(outDir, 'comments.md'), issue.text);
  writeFileSync(join(outDir, 'review-comments.md'), review.text);

  const unreadable = [
    ...(pr === undefined ? ['pr.json'] : []),
    ...(issueComments === undefined ? ['issue-comments.json'] : []),
    ...(reviewComments === undefined ? ['review-comments.json'] : []),
  ];
  const bodyNote = pr === undefined ? `(${UNAVAILABLE})` : body.truncated ? '(上限で切り詰めた)' : '(切り詰めなし)';
  return {
    reports: [
      {
        file: 'body.md',
        kept: body.kept,
        droppedByAssociation: body.droppedByAssociation,
        droppedByLimit: 0,
        note: bodyNote,
      },
      { file: 'comments.md', ...issue },
      { file: 'review-comments.md', ...review },
    ],
    unreadable,
  };
}

if (import.meta.main) {
  const [rawDir, outDir] = process.argv.slice(2);
  if (!rawDir || !outDir) {
    console.error('使い方: node scripts/ai-review-context.ts <取得した JSON のディレクトリ> <書き出すディレクトリ>');
    process.exit(1);
  }
  const { reports, unreadable } = writeContext(rawDir, outDir);
  for (const source of unreadable) {
    console.log(formatUnreadableWarning(source));
  }
  for (const report of reports) {
    console.log(formatReport(report));
  }
}
