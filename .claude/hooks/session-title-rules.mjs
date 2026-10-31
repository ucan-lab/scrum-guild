// session-title.mjs と rename-session の rename-line.mjs が使う判定。副作用を持たない純関数だけを置く。

const MAX_LENGTH = 80;

// ブランチ名 `<Issue番号>-<短い名前>` の Issue 番号。クラウドの `claude/*` や main は番号なし。
// 0 始まりや桁あふれの数字は、Issue の番号とみなさない
export function issueNumberOf(branch) {
  const match = /^([1-9]\d{0,8})-/.exec(branch ?? '');
  return match ? Number(match[1]) : undefined;
}

// 題は外の人が書き換えられる。端末とクリップボードに渡るので、改行と連続する空白を詰め、
// 制御文字（ESC、BEL、C1）と書式の文字（向きを変える文字、幅ゼロの文字）を取り除く。
// 長い題はコードポイント単位で切る（サロゲートペアを割らない）
function tidy(text) {
  const oneLine = String(text ?? '')
    .replace(/\s+/g, ' ')
    .replace(/[\p{Cc}\p{Cf}]/gu, '')
    .trim();
  const chars = [...oneLine];
  return chars.length > MAX_LENGTH ? `${chars.slice(0, MAX_LENGTH - 1).join('')}…` : oneLine;
}

// docs/development.md の「並行して作業するときの決まり」のセッション名。
// PR があれば `#<Issue番号> PR #<PR番号> <Issueの題>`、なければ `#<Issue番号> <Issueの題>`。
// Issue が無い PR は `PR #<PR番号> <PRのタイトル>`
export function titleFor({ issueNumber, issueTitle, pr }) {
  if (issueNumber === undefined) return pr ? tidy(`PR #${pr.number} ${pr.title}`) : '';
  if (pr) return tidy(`#${issueNumber} PR #${pr.number} ${issueTitle}`);
  return tidy(`#${issueNumber} ${issueTitle}`);
}

// ブランチの PR が複数あるとき、開いているものを先に、無ければ新しい順の先頭を使う
export function pickPr(list) {
  if (!Array.isArray(list)) return undefined;
  return list.find((pr) => pr.state === 'OPEN') ?? list[0];
}
