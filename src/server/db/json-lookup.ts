import { sql, type RawBuilder } from 'kysely';

// キーごとの値を1つの値（JSON のオブジェクト）で渡し、行の列の値をキーにして引く式。無いキーは fallback にする。
// 行ごとに違う値を1つの文で書くとき（ユーザーの無効化で、ワークスペースごとのタイムゾーンの今日を離脱日にする）に使う。
// キーの数によらず bind は2つなので、D1 の1文あたりの bind の上限（100）に当たらない。
// キーは JSON のパスの "..." の中に入れるので、ID のように " と \ を含まない値に限る
export function jsonLookup(
  values: Readonly<Record<string, string>>,
  keyColumn: string,
  fallback: string,
): RawBuilder<string> {
  return sql<string>`coalesce(json_extract(${JSON.stringify(values)}, '$."' || ${sql.ref(keyColumn)} || '"'), ${fallback})`;
}
