import { sql, type RawBuilder } from 'kysely';

// 値の一覧を、1つの値（JSON の配列）で渡す IN の右辺（SELECT value FROM json_each(?)）。並べる数によらず bind は1つなので、
// 一覧が長くても D1 の1文あたりの bind の上限（100）に当たらない。空の一覧は、何も当たらない右辺になる
export function jsonList(values: readonly string[]): RawBuilder<string> {
  return sql<string>`(select value from json_each(${JSON.stringify(values)}))`;
}
