// CI の AI レビュー（.github/workflows/ai-review.yml）で、Claude が書いたまとめのファイルを、PR に付けるコメントの本文にする。
// Claude にはコメントを書く道具を許さないので、action の後の段がこの本文を gh pr comment --body-file で付ける。通信はしない
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

// GitHub のコメントの本文の上限（文字数）
export const MAX_COMMENT_LENGTH = 65536;

export const MISSING_SUMMARY =
  'AI レビューがまとめを書かずに終わった。インラインの指摘が付いていれば、それだけが結果になる。ワークフローの実行のログを見る。\n';

export const TRUNCATED_NOTE = '\n\n---\n\nまとめが GitHub のコメントの上限を超えたので、ここで切り詰めた。\n';

// 上限は UTF-16 の長さで測る（コードポイントの数より短くならないので、上限を超えない側に倒れる）。
// 切り口でサロゲートペアを割らない
export function summaryBody(summary: string | undefined): string {
  if (summary === undefined || summary.trim() === '') {
    return MISSING_SUMMARY;
  }
  if (summary.length <= MAX_COMMENT_LENGTH) {
    return summary;
  }
  let head = summary.slice(0, MAX_COMMENT_LENGTH - TRUNCATED_NOTE.length);
  const last = head.charCodeAt(head.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) {
    head = head.slice(0, -1);
  }
  return head + TRUNCATED_NOTE;
}

if (import.meta.main) {
  const [summaryFile, bodyFile] = process.argv.slice(2);
  if (!summaryFile || !bodyFile) {
    console.error(
      '使い方: node scripts/ai-review-summary.ts <Claude が書いたまとめのファイル> <書き出す本文のファイル>',
    );
    process.exit(1);
  }
  const summary = existsSync(summaryFile) ? readFileSync(summaryFile, 'utf8') : undefined;
  const body = summaryBody(summary);
  writeFileSync(bodyFile, body);
  console.log(
    body === MISSING_SUMMARY
      ? 'まとめが無いので、その旨を付ける'
      : `まとめを付ける（${body.length} 文字${body.endsWith(TRUNCATED_NOTE) ? '、切り詰めた' : ''}）`,
  );
}
