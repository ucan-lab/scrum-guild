// session-title.mjs の判定。副作用を持たない純関数だけを置く。

const MAX_LENGTH = 80;

// ブランチ名 `<Issue番号>-<短い名前>` の Issue 番号。クラウドの `claude/*` や main は番号なし
export function issueNumberOf(branch) {
  const match = /^(\d+)-/.exec(branch ?? '');
  return match ? Number(match[1]) : undefined;
}

// 一覧で崩れないよう改行と連続する空白を詰め、長いタイトルは切る
function tidy(text) {
  const oneLine = String(text ?? '').replace(/\s+/g, ' ').trim();
  return oneLine.length > MAX_LENGTH ? `${oneLine.slice(0, MAX_LENGTH - 1)}…` : oneLine;
}

// docs/development.md の「並行して作業するときの決まり」のセッション名。
// PR があれば `#<Issue番号> PR #<PR番号> <Issueの題>`、なければ `#<Issue番号> <Issueの題>`
export function titleFor({ issueNumber, issueTitle, pr }) {
  if (pr) return tidy(`#${issueNumber} PR #${pr.number} ${issueTitle}`);
  return tidy(`#${issueNumber} ${issueTitle}`);
}
