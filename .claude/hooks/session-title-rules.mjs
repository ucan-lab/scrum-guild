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
  // 改行などの空白は先に空白へ、それ以外の制御文字と書式の文字は消してから詰める（消す前に詰めると、間に書式の文字がある空白が2つ残る）
  const oneLine = String(text ?? '')
    // U+0085（NEL）は改行の仲間だが JS の `\s` に入らないので、空白として扱う
    .replace(/[\p{Cc}\p{Cf}]/gu, (char) => (/\s/.test(char) || char === '\u0085' ? ' ' : ''))
    .replace(/\s+/g, ' ')
    .trim();
  const chars = [...oneLine];
  // 切り口が空白に当たっても、`…` の前に空白を残さない
  return chars.length > MAX_LENGTH ? `${chars.slice(0, MAX_LENGTH - 1).join('').trimEnd()}…` : oneLine;
}

// docs/development.md の「並行して作業するときの決まり」のセッション名。
// PR があれば `#<Issue番号> PR #<PR番号> <Issueの題>`、なければ `#<Issue番号> <Issueの題>`。
// Issue が無い PR は `PR #<PR番号> <PRのタイトル>`
export function titleFor({ issueNumber, issueTitle, pr }) {
  if (issueNumber === undefined) return pr && tidy(pr.title) ? tidy(`PR #${pr.number} ${pr.title}`) : '';
  // 題が書式の文字だけなどで空になるときは、番号だけの名前を出さない
  if (!tidy(issueTitle)) return '';
  if (pr) return tidy(`#${issueNumber} PR #${pr.number} ${issueTitle}`);
  return tidy(`#${issueNumber} ${issueTitle}`);
}

// ブランチの PR が複数あるとき、開いているものを先に、無ければ新しい順の先頭を使う。
// `--head` はブランチ名だけで引くので、fork の同名ブランチの PR（別の人のもの）は除く
export function pickPr(list) {
  if (!Array.isArray(list)) return undefined;
  const own = list.filter((pr) => !pr.isCrossRepository);
  return own.find((pr) => pr.state === 'OPEN') ?? own[0];
}
