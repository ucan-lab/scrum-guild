// メールアドレスをそろえる関数（docs/data-model.md の「メールアドレスで待つ指名と招待」）。
// 招待と指名の入力（login_email に入れる値）と、ID トークンの email の両方に、この1つの関数を通して比べる。
// 前後の ASCII の空白を除き、ASCII の英大文字だけを小文字に直す。ASCII の外の文字（全角の空白、NBSP、日本語のアドレス）を含むものと、
// 印字できない文字や途中の空白を含むものは受け付けない。ドットや `+` 以降は読み替えない（本人が Google に登録した綴りのまま）。
// DB の CHECK（login_email = lower(trim(login_email))）は、SQLite の lower と trim が ASCII だけを扱うので、この結果を必ず通る

export const EMAIL_MAX_LENGTH = 254;

const ASCII_WHITESPACE_AROUND = /^[\t\n\v\f\r ]+|[\t\n\v\f\r ]+$/g;
// 印字できる ASCII（空白を除く）
const PRINTABLE_ASCII = /^[!-~]+$/;
const ASCII_UPPER = /[A-Z]/g;

// そろえられないときは undefined（形の合わない入力、メールアドレスの無い ID トークン）
export function normalizeEmail(input: string): string | undefined {
  const trimmed = input.replace(ASCII_WHITESPACE_AROUND, '');
  if (trimmed === '' || trimmed.length > EMAIL_MAX_LENGTH || !PRINTABLE_ASCII.test(trimmed)) return undefined;
  // `@` は1つだけで、前後に1文字以上ある
  const at = trimmed.indexOf('@');
  if (at < 1 || at !== trimmed.lastIndexOf('@') || at === trimmed.length - 1) return undefined;
  return trimmed.replace(ASCII_UPPER, (letter) => letter.toLowerCase());
}
