// CI の AI レビュー（.github/workflows/ai-review.yml）に渡す PR の本文とコメントを、Markdown に整える。
// 通信はしない。ワークフローの段が gh api で落とした JSON を読み、同じディレクトリに書く。判定と整形は export した関数にして node --test にかける。
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// 公開リポジトリでは誰でもコメントできる。Claude に渡すのは、書き込みの権限を持つ人と、このワークフローの bot のものだけにする
const TRUSTED_ASSOCIATIONS: ReadonlySet<string> = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
const TRUSTED_BOT_LOGIN = 'github-actions[bot]';

// Claude のコンテキストを食い尽くさないための、ファイルごとの上限（UTF-8 のバイト数）
export const MAX_FILE_BYTES = 64 * 1024;

export type ContextUser = { login?: string | null; type?: string | null };

export type PullRequest = { body?: string | null; user?: ContextUser | null };

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

export type BodyRender = { text: string; truncated: boolean };

const encoder = new TextEncoder();
const byteLength = (text: string): number => encoder.encode(text).length;

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

// 本文の中の見出しで、コメントの境目を偽装できないようにする
function quote(body: string): string {
  return body
    .split(/\r?\n/)
    .map((line) => (line === '' ? '>' : `> ${line}`))
    .join('\n');
}

function location(comment: ContextComment): string | undefined {
  if (comment.path == null) {
    return undefined;
  }
  if (comment.line != null) {
    return `${comment.path}:${comment.line}`;
  }
  if (comment.original_line != null) {
    return `${comment.path}:${comment.original_line}（古い版の行）`;
  }
  return `${comment.path}（ファイル単位）`;
}

export function commentEntry(comment: ContextComment): string {
  const login = comment.user?.login ?? '(不明)';
  const association = comment.author_association ?? 'NONE';
  const kind = comment.user?.type === 'Bot' ? `${association}, Bot` : association;
  const lines = [`## ${login} [${kind}] id=${comment.id} ${comment.created_at}`];
  const place = location(comment);
  if (place !== undefined) {
    const reply = comment.in_reply_to_id == null ? '' : ` in_reply_to_id=${comment.in_reply_to_id}`;
    lines.push(`場所: ${place}${reply}`);
  }
  return `\n${lines.join('\n')}\n\n${quote(comment.body ?? '')}\n`;
}

function commentHeader(title: string, kept: number, droppedByAssociation: number, droppedByLimit: number): string {
  return [
    `# ${title}`,
    '',
    `- 残した件数: ${kept}`,
    `- 区分で落とした件数: ${droppedByAssociation}`,
    `- 上限（${MAX_FILE_BYTES / 1024}KB）で落とした件数: ${droppedByLimit}`,
    '',
  ].join('\n');
}

// 区分で絞り、古い順に並べ、上限に収まる先頭の分だけを残す。後ろ（新しい側）を落とすのは、pr-create が最初に付ける意図の説明を残すため
export function renderComments(
  title: string,
  comments: readonly ContextComment[],
  limit: number = MAX_FILE_BYTES,
): CommentRender {
  const trusted = sortByCreatedAt(comments.filter(isTrustedComment));
  const droppedByAssociation = comments.length - trusted.length;
  const entries = trusted.map(commentEntry);

  const prefixBytes = [0];
  for (const entry of entries) {
    prefixBytes.push(prefixBytes[prefixBytes.length - 1]! + byteLength(entry));
  }

  let kept = entries.length;
  while (kept > 0) {
    const header = commentHeader(title, kept, droppedByAssociation, entries.length - kept);
    if (byteLength(header) + prefixBytes[kept]! <= limit) {
      break;
    }
    kept--;
  }

  const droppedByLimit = entries.length - kept;
  const header = commentHeader(title, kept, droppedByAssociation, droppedByLimit);
  return { text: header + entries.slice(0, kept).join(''), kept, droppedByAssociation, droppedByLimit };
}

// 本文は区分で絞らない。AI レビューが走るのは同じリポジトリのブランチの PR だけで、本文を書き換えられるのは作成者と書き込みの権限を持つ人に限られる
export function renderBody(pr: PullRequest, limit: number = MAX_FILE_BYTES): BodyRender {
  const body = pr.body ?? '';
  const original = byteLength(body);
  const truncated = original > limit;
  const header = [
    '# PR の本文',
    '',
    `- 作成者: ${pr.user?.login ?? '(不明)'}`,
    `- 残した件数: 1`,
    `- 区分で落とした件数: 0`,
    truncated ? `- 切り詰め: あり（元は ${original} バイト。上限 ${limit} バイトまでで切った）` : '- 切り詰め: なし',
    '',
    '',
  ].join('\n');
  const text = header + (truncated ? truncateUtf8(body, limit - byteLength(header)) : body);
  return { text, truncated };
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

function readJson(dir: string, name: string): unknown {
  return JSON.parse(readFileSync(join(dir, name), 'utf8'));
}

// rawDir の pr.json、issue-comments.json、review-comments.json を読み、outDir に body.md、comments.md、review-comments.md を書く。
// 絞る前の JSON を Claude が読む outDir に置かないため、2つのディレクトリを分ける
export function writeContext(rawDir: string, outDir: string): ContextReport[] {
  const pr = readJson(rawDir, 'pr.json') as PullRequest;
  const issueComments = flattenPages(readJson(rawDir, 'issue-comments.json'));
  const reviewComments = flattenPages(readJson(rawDir, 'review-comments.json'));

  mkdirSync(outDir, { recursive: true });
  const body = renderBody(pr);
  const issue = renderComments('PR 全体のコメント', issueComments);
  const review = renderComments('インラインのレビューコメント', reviewComments);
  writeFileSync(join(outDir, 'body.md'), body.text);
  writeFileSync(join(outDir, 'comments.md'), issue.text);
  writeFileSync(join(outDir, 'review-comments.md'), review.text);

  return [
    {
      file: 'body.md',
      kept: 1,
      droppedByAssociation: 0,
      droppedByLimit: 0,
      note: body.truncated ? '(上限で切り詰めた)' : '(切り詰めなし)',
    },
    { file: 'comments.md', ...issue },
    { file: 'review-comments.md', ...review },
  ];
}

if (import.meta.main) {
  const [rawDir, outDir] = process.argv.slice(2);
  if (!rawDir || !outDir) {
    console.error('使い方: node scripts/ai-review-context.ts <取得した JSON のディレクトリ> <書き出すディレクトリ>');
    process.exit(1);
  }
  for (const report of writeContext(rawDir, outDir)) {
    console.log(formatReport(report));
  }
}
