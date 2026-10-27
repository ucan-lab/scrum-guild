import { sql, type RawBuilder } from 'kysely';

// column（表の別名つきの列）を、SQLite が索引を選ぶときに使わない形にする（単項の + を付ける。SQLite の決まった書き方）。
// 結ぶ順を CROSS JOIN で固定した文で、絞り込みの条件の列に別の索引があると、SQLite がその索引で結ぶ側を引き直す計画を選ぶことがある。
// 例: バックログの木のストーリーの下のタスクを担当で絞ると、tasks_story の代わりに tasks_assignee_user をストーリーごとに引き、
// 5 万件で 10 秒かかった（tasks_story_open を足す前。docs/data-model.md の tasks の節）
// 列は、使う列の名前（別名つき）だけを受ける（任意の文字列を SQL の参照にしない）
export type UnindexedColumn = 'tasks.assignee_user_id';

export function unindexed(column: UnindexedColumn): RawBuilder<unknown> {
  return sql`+${sql.ref(column)}`;
}
