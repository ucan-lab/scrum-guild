import { sql } from 'kysely';

// 直前の文（INSERT、UPDATE、DELETE）が行を変えた、という条件。batch() の中の後ろの文が、前の文が通ったことに自分を結ぶ
// （履歴の INSERT ... SELECT ... WHERE <この条件>）。SQLite の changes() は、同じ接続で最後に終えた文の件数を返す。
// D1 の batch() は全部の文を1つの接続の1つのトランザクションで順に流すので、直前の文はバッチの中の1つ前の文になる。
// 行の内容や時刻の一致で「自分の更新か」を見分けると、止めた時計や同じ値を書く要求では、負けた要求も一致して二重に書く。
// この条件は、直前の文が自分の文であることだけを見る。直前の文が SELECT など行を変えない文のときは、件数が前の値のまま残るので、
// 必ず変える文の直後に置く
export const previousStatementChanged = sql<boolean>`changes() > 0`;
