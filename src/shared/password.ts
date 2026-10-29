// パスワードのそろえ方（Issue #256、docs/requirements.md の「メンバーと権限」）。NFC にそろえ、そろえた後のコードポイントの数が
// 12〜128なら返す。対になっていないサロゲートを含む入力は断る。合わなければ undefined（照合せずに、違うパスワードと同じ応答にする）。
// 長さは UTF-16 の単位ではなくコードポイントで数える（サロゲートペアの1文字を2文字と数えない）

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

export function normalizePassword(input: string): string | undefined {
  // 極端に長い入力を NFC にそろえない（そろえても長さは数倍にしか縮まない）。本文は 4KiB までなので大きくはならない
  if (input.length > PASSWORD_MAX_LENGTH * 4) return undefined;
  // 対になっていないサロゲートは、UTF-8 にするときに U+FFFD に置き換わり、別の文字列が同じパスワードとして通るので断る
  if (!input.isWellFormed()) return undefined;
  const normalized = input.normalize('NFC');
  // 文字列の反復はコードポイントごと
  const length = [...normalized].length;
  return length < PASSWORD_MIN_LENGTH || length > PASSWORD_MAX_LENGTH ? undefined : normalized;
}
