import { sql, type Expression, type RawBuilder } from 'kysely';

// 並び（position）の末尾に、複数の行を1つの文で元の並びのまま振る値（エピックとストーリーの削除で配下を移すとき）。
// 値は「移す先の最後の値（無ければ a0。fractional-indexing の generateKeyBetween(null, null) と同じ）」の後ろに、
// 元の並びの順番（1 始まり）を、行の数の桁にそろえた10進数で足し、V で閉じたもの。
//   - 最後の値が接頭辞なので、どの値も移す先の既存の行より後ろになる（同じ値の行も、接頭辞の方が前）
//   - 順番の桁をそろえるので、文字列の比較でも元の並びのまま
//   - 小数の部分が '0' で終わらない（V で閉じる）ので、fractional-indexing の鍵としてそのまま前後と間に値を作れる
// last は移す先の最後の値を1行だけ返す副問い合わせ（ORDER BY position DESC LIMIT 1）、rank は row_number() OVER (元の並び)、
// total は count(*) OVER ()。続けて削除すると、値は毎回この分だけ伸びる（次の generateKeyBetween で短い値に戻る）
export function tailPosition(
  last: Expression<unknown>,
  rank: Expression<unknown>,
  total: Expression<unknown>,
): RawBuilder<string> {
  return sql<string>`(coalesce(${last}, ${sql.lit('a0')}) || printf('%0*d', length(${total}), ${rank}) || ${sql.lit('V')})`;
}
