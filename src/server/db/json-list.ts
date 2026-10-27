import { sql, type Expression, type RawBuilder } from 'kysely';

// 値の一覧を、1つの値（JSON の配列）で渡す IN の右辺（SELECT value FROM json_each(?)）。並べる数によらず bind は1つなので、
// 一覧が長くても D1 の1文あたりの bind の上限（100）に当たらない。空の一覧は、何も当たらない右辺になる
export function jsonList(values: readonly string[]): RawBuilder<string> {
  return sql<string>`(select value from json_each(${JSON.stringify(values)}))`;
}

// 鍵と値の組の一覧（[鍵, 値] の JSON の配列）から、key に当たる値を引く副問い合わせ。無ければ NULL。
// 行ごとに違う値を1つの UPDATE で書くとき（スプリントに入れるタスクごとの列の中の位置）に使う。bind は jsonList と同じく1つ。
// 鍵を列の名前でなく式で渡す点が jsonLookup（json-lookup.ts。キーごとの値をオブジェクトで渡す）と違う
export function jsonPairLookup(
  pairs: readonly (readonly [string, string])[],
  key: Expression<unknown>,
): RawBuilder<string> {
  return sql<string>`(select json_extract(value, '$[1]') from json_each(${JSON.stringify(pairs)}) where json_extract(value, '$[0]') = ${key})`;
}

// スプリントから外れた変更の履歴（{"sprint": [前, null]}、JSON）。前は alias の表の今の名前（sprintLogRefSql）
export function sprintLeftLogSql(alias: string): RawBuilder<string> {
  return sql<string>`json_object('sprint', json_array(${sprintLogRefSql(alias)}, null))`;
}

// 変更の履歴に残すスプリントの値（{"id", "name"}、JSON）。alias の表（sprints の別名）の行が無ければ NULL。
// 名前が空のスプリントは、期間（YYYY-MM-DD〜YYYY-MM-DD）を名前にする。書くときの今の名前を引くので、読んでから書くまでに
// 名前が変わっても、履歴は書いた時点の名前になる。
// json() で包み、CASE を通しても JSON として json_array に入れる
export function sprintLogRefSql(alias: string): RawBuilder<string | null> {
  const ref = (column: string) => sql.ref(`${alias}.${column}`);
  return sql<
    string | null
  >`json(case when ${ref('id')} is null then null else json_object('id', ${ref('id')}, 'name', coalesce(${ref('name')}, ${ref('start_on')} || ${'〜'} || ${ref('end_on')})) end)`;
}
